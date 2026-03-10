const express = require('express')
const puppeteer = require('puppeteer')
const ffmpeg = require('fluent-ffmpeg')
const path = require('path')
const fs = require('fs')
const { PassThrough } = require('stream')
const { spawnSync } = require('child_process')
const os = require('os')

const app = express()

// ─── Config ──────────────────────────────────────────────────────────────────

const VERSION = '4.2'
const WS4KP_HOST = process.env.WS4KP_HOST || 'localhost'
const WS4KP_PORT = process.env.WS4KP_PORT || '8080'
const STREAM_PORT = process.env.STREAM_PORT || '9798'
const WS4KP_URL = `http://${WS4KP_HOST}:${WS4KP_PORT}`
const FRAME_RATE = parseInt(process.env.FRAME_RATE || '10')
const CHANNEL_NUM = process.env.CHANNEL_NUMBER || '275'

const IDLE_TIMEOUT_MS = parseInt(process.env.IDLE_TIMEOUT_SECONDS || '120') * 1000

// Hardware transcoding — set VIDEO_OPTIONS env var:
//   NVIDIA NVENC : -c:v h264_nvenc -pix_fmt yuv420p -b:v 2000k
//   Intel QSV    : -c:v h264_qsv -b:v 1000k
//   AMD VAAPI    : -vaapi_device /dev/dri/renderD128 -c:v h264_vaapi -b:v 1000k -vf format=nv12,hwupload
//   Software     : (default) -c:v libx264 -preset ultrafast -b:v 500k
const VIDEO_OPTIONS = process.env.VIDEO_OPTIONS || '-c:v libx264 -preset ultrafast -b:v 500k'

// ─── Paths ───────────────────────────────────────────────────────────────────

const OUTPUT_DIR = path.join(__dirname, 'output')
const AUDIO_DIR = path.join(__dirname, 'music')
const LOGO_DIR = path.join(__dirname, 'logo')
const HLS_FILE = path.join(OUTPUT_DIR, 'stream.m3u8')
const WARMUP_IMAGE = path.join(LOGO_DIR, 'warmup.jpg')
const WARMUP_DIR = path.join(__dirname, 'warmup_hls')
const AUDIO_LIST = path.join(__dirname, 'audio_list.txt')

;[OUTPUT_DIR, AUDIO_DIR, LOGO_DIR, WARMUP_DIR].forEach(dir => {
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
})

app.use('/logo', express.static(LOGO_DIR))

// ─── State ───────────────────────────────────────────────────────────────────

let ffmpegProc = null
let ffmpegStream = null
let browser = null
let page = null
let captureInterval = null
let isStreamReady = false
let isBrowserReady = false
let isStartingBrowser = false
let idleTimer = null
let restartDelay = 1000

const waitFor = ms => new Promise(resolve => setTimeout(resolve, ms))

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getContainerLimits() {
	let cpus = os.cpus().length
	let memory = os.totalmem()
	try {
		const [quota, period] = fs.readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim().split(' ')
		if (quota !== 'max') cpus = parseFloat((parseInt(quota) / parseInt(period)).toFixed(2))
	} catch {}
	try {
		const raw = fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim()
		if (raw !== 'max') memory = parseInt(raw)
	} catch {}
	return { cpus, memoryMB: Math.round(memory / (1024 * 1024)) }
}

function createAudioInputFile() {
	const defaultMp3s = [
		'01 Weatherscan Track 26.mp3',
		'02 Weatherscan Track 3.mp3',
		'03 Tropical Breeze.mp3',
		'04 Late Nite Cafe.mp3',
		'05 Care Free.mp3',
		'06 Weatherscan Track 14.mp3',
		'07 Weatherscan Track 18.mp3',
	]
	let files = []
	try {
		files = fs.readdirSync(AUDIO_DIR).filter(f => f.toLowerCase().endsWith('.mp3'))
		if (!files.length) throw new Error('no mp3s')
	} catch {
		files = defaultMp3s
	}
	for (let i = files.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1))
		;[files[i], files[j]] = [files[j], files[i]]
	}
	fs.writeFileSync(AUDIO_LIST, files.map(f => `file '${path.join(AUDIO_DIR, f)}'`).join('\n'))
	console.log(`[ws4channels] Loaded ${files.length} music files`)
}

function parseVideoOptions() {
	const opts = VIDEO_OPTIONS.trim().split(/\s+/)
	const codecIndex = opts.indexOf('-c:v')
	const codec = codecIndex !== -1 ? opts[codecIndex + 1] : 'libx264'
	const extra = opts.filter((_, i) => i !== codecIndex && i !== codecIndex + 1)
	return { codec, extra }
}

function generateXMLTV(host) {
	const now = new Date()
	const baseUrl = `http://${host}`
	let xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE tv SYSTEM "xmltv.dtd">
<tv>
<channel id="WS4000">
  <display-name>WeatherStar 4000</display-name>
  <icon src="${baseUrl}/logo/ws4000.png" />
</channel>`
	for (let i = 0; i < 24; i++) {
		const start = new Date(now.getTime() + i * 3600 * 1000)
		const stop = new Date(start.getTime() + 3600 * 1000)
		const fmt = d => d.toISOString().replace(/[-:T]/g, '').split('.')[0] + ' +0000'
		xml += `
<programme start="${fmt(start)}" stop="${fmt(stop)}" channel="WS4000">
  <title lang="en">Local Weather</title>
  <desc lang="en">Enjoy your local weather with a touch of nostalgia.</desc>
  <icon src="${baseUrl}/logo/ws4000.png" />
</programme>`
	}
	return xml + '\n</tv>'
}

// ─── Pre-rendered warmup HLS ─────────────────────────────────────────────────
// At boot, generate a few static HLS segments from the warmup image.
// These are served directly as static files — no ffmpeg process running.
// When the browser is ready, live ffmpeg overwrites the playlist.

function ensureWarmupImage() {
	if (fs.existsSync(WARMUP_IMAGE)) return
	console.log('[ws4channels] No warmup.jpg found — generating a placeholder image')
	spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=0x1a1a2e:size=1280x720:rate=1', '-vframes', '1', '-q:v', '2', WARMUP_IMAGE])
}

function generateWarmupHLS() {
	ensureWarmupImage()

	const warmupM3U8 = path.join(WARMUP_DIR, 'stream.m3u8')

	// Only regenerate if not already cached
	if (fs.existsSync(warmupM3U8)) {
		console.log('[ws4channels] Using cached warmup HLS segments')
		deployWarmup()
		return
	}

	console.log('[ws4channels] Pre-rendering warmup HLS segments...')
	const { codec, extra } = parseVideoOptions()

	// Generate 4 seconds (2 segments) of static warmup video
	const result = spawnSync(
		'ffmpeg',
		[
			'-y',
			'-loop',
			'1',
			'-framerate',
			String(FRAME_RATE),
			'-i',
			WARMUP_IMAGE,
			'-an',
			'-vf',
			'scale=1280:720,format=yuv420p',
			'-c:v',
			codec,
			...extra,
			'-t',
			'8',
			'-f',
			'hls',
			'-hls_time',
			'2',
			'-hls_list_size',
			'0',
			'-hls_segment_filename',
			path.join(WARMUP_DIR, 'warmup%d.ts'),
			warmupM3U8,
		],
		{ timeout: 30000 },
	)

	if (result.status !== 0) {
		console.error('[ws4channels] Warmup HLS generation failed:', result.stderr?.toString())
		return
	}

	console.log('[ws4channels] Warmup HLS segments ready')
	deployWarmup()
}

function deployWarmup() {
	const warmupSegments = fs
		.readdirSync(WARMUP_DIR)
		.filter(f => f.endsWith('.ts'))
		.sort()
	if (!warmupSegments.length) return

	// Copy segment files to output
	for (const seg of warmupSegments) {
		fs.copyFileSync(path.join(WARMUP_DIR, seg), path.join(OUTPUT_DIR, seg))
	}

	// Write a live-type playlist. No EXT-X-ENDLIST so the player keeps polling.
	// The playlist stays static — same segments, same sequence number.
	// The player will poll, see no changes, and hold on the last frame.
	// When live ffmpeg starts, it overwrites this file with real segments.
	const m3u8 = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:3
#EXT-X-MEDIA-SEQUENCE:0
${warmupSegments.map(s => `#EXTINF:2.000,\n${s}`).join('\n')}
`
	fs.writeFileSync(HLS_FILE, m3u8)

	isStreamReady = true
	console.log(`[ws4channels] Warmup deployed (${warmupSegments.length} segments)`)
}

// ─── FFmpeg: live mode ────────────────────────────────────────────────────────
// Starts ffmpeg reading JPEG screenshots from pipe. Video only, no audio.
// Overwrites the warmup playlist with live content.

function switchToLiveFFmpeg() {
	return new Promise((resolve, reject) => {
		console.log('[ws4channels] Starting live ffmpeg...')

		// Kill any existing live ffmpeg (e.g. from a previous session)
		if (ffmpegProc) {
			try {
				ffmpegProc.kill('SIGINT')
			} catch {}
			ffmpegProc = null
		}

		ffmpegStream = new PassThrough()
		const { codec, extra } = parseVideoOptions()

		ffmpegProc = ffmpeg()
			.input(ffmpegStream)
			.inputFormat('image2pipe')
			.inputOptions(['-c:v mjpeg', `-framerate ${FRAME_RATE}`])
			.outputOptions([
				'-an',
				'-vf',
				'scale=1280:720,format=yuv420p',
				'-g',
				String(FRAME_RATE * 2),
				'-keyint_min',
				String(FRAME_RATE),
				'-force_key_frames',
				`expr:gte(t,n_forced*2)`,
				'-flush_packets',
				'1',
				...extra,
				'-f hls',
				'-hls_time',
				'2',
				'-hls_list_size',
				'3',
				'-hls_flags',
				'delete_segments+discont_start',
				'-hls_init_time',
				'1',
			])
			.videoCodec(codec)
			.output(HLS_FILE)
			.on('start', () => {
				console.log('[ws4channels] Live ffmpeg started')
				isBrowserReady = true
				restartDelay = 1000
				resolve()
			})
			.on('error', async err => {
				console.error('[ws4channels] Live FFmpeg error:', err.message)
				isBrowserReady = false
				ffmpegProc = null
				if (ffmpegStream) {
					ffmpegStream.destroy()
					ffmpegStream = null
				}
				// Fall back to static warmup
				console.log(`[ws4channels] Falling back to warmup, retrying in ${restartDelay / 1000}s`)
				deployWarmup()
				await waitFor(restartDelay)
				restartDelay = Math.min(restartDelay * 2, 30000)
				if (browser) startBrowserCapture()
			})
			.on('end', () => {
				ffmpegProc = null
				ffmpegStream = null
				isBrowserReady = false
			})

		ffmpegProc.run()
	})
}

// ─── Browser ─────────────────────────────────────────────────────────────────

async function launchBrowser() {
	if (browser) await browser.close().catch(() => {})
	browser = await puppeteer.launch({
		headless: 'new',
		args: [
			'--no-sandbox',
			'--disable-setuid-sandbox',
			'--disable-dev-shm-usage',
			'--disable-infobars',
			'--ignore-certificate-errors',
			'--window-size=1280,720',
			'--no-first-run',
			'--no-zygote',
			'--disable-extensions',
		],
		defaultViewport: null,
	})
	page = await browser.newPage()
	await page.goto(WS4KP_URL, { waitUntil: 'domcontentloaded', timeout: 15000 })
	try {
		await page.waitForSelector('div#container', { timeout: 15000 })
		await waitFor(2000)
	} catch {
		console.warn('[ws4channels] Container element not found, capturing anyway')
	}
	await page.setViewport({ width: 1280, height: 720 })
	await page.screenshot({ path: path.join(OUTPUT_DIR, 'debug.png'), fullPage: true }).catch(() => {})
	console.log('[ws4channels] Browser ready')
}

async function startBrowserCapture() {
	if (isStartingBrowser) return
	isStartingBrowser = true
	console.log('[ws4channels] Starting browser...')

	try {
		if (!browser) await launchBrowser()
		await switchToLiveFFmpeg()

		captureInterval = setInterval(async () => {
			if (!ffmpegProc || !ffmpegStream || !page) return
			try {
				if (page.isClosed()) {
					await launchBrowser()
					return
				}
				const screenshot = await page.screenshot({
					type: 'jpeg',
					quality: 80,
					clip: { x: 4, y: 50, width: 840, height: 470 },
				})
				if (ffmpegStream?.writable) ffmpegStream.write(screenshot)
			} catch (err) {
				console.warn('[ws4channels] Capture error:', err.message)
				await launchBrowser().catch(() => {})
			}
		}, 1000 / FRAME_RATE)
	} catch (err) {
		console.error('[ws4channels] Browser startup failed:', err.message)
		await shutdownBrowser()
	} finally {
		isStartingBrowser = false
	}
}

async function shutdownBrowser() {
	console.log('[ws4channels] Shutting down browser (idle). Deploying warmup.')
	isBrowserReady = false
	isStartingBrowser = false

	if (idleTimer) {
		clearTimeout(idleTimer)
		idleTimer = null
	}
	if (captureInterval) {
		clearInterval(captureInterval)
		captureInterval = null
	}
	if (ffmpegStream) {
		ffmpegStream.destroy()
		ffmpegStream = null
	}
	if (browser) {
		await browser.close().catch(() => {})
		browser = null
		page = null
	}
	if (ffmpegProc) {
		try {
			ffmpegProc.kill('SIGINT')
		} catch {}
		ffmpegProc = null
		await waitFor(500)
	}

	// Restore static warmup files
	deployWarmup()
}

async function stopEverything() {
	if (idleTimer) {
		clearTimeout(idleTimer)
		idleTimer = null
	}
	if (captureInterval) {
		clearInterval(captureInterval)
		captureInterval = null
	}
	if (ffmpegStream) {
		ffmpegStream.destroy()
		ffmpegStream = null
	}
	if (ffmpegProc) {
		try {
			ffmpegProc.kill('SIGINT')
		} catch {}
		ffmpegProc = null
	}
	if (browser) {
		await browser.close().catch(() => {})
		browser = null
		page = null
	}
	isStreamReady = isBrowserReady = false
	try {
		fs.readdirSync(OUTPUT_DIR)
			.filter(f => f.endsWith('.ts') || f.endsWith('.m3u8'))
			.forEach(f => fs.unlinkSync(path.join(OUTPUT_DIR, f)))
	} catch {}
	console.log('[ws4channels] Fully stopped.')
}

// ─── Idle timer ───────────────────────────────────────────────────────────────

function resetIdleTimer() {
	if (IDLE_TIMEOUT_MS <= 0 || !browser) return
	if (idleTimer) clearTimeout(idleTimer)
	idleTimer = setTimeout(() => shutdownBrowser(), IDLE_TIMEOUT_MS)
}

// ─── On-demand wake-up middleware ─────────────────────────────────────────────

app.use('/stream', async (req, res, next) => {
	if (req.path.endsWith('.ts')) {
		resetIdleTimer()
		if (!browser && !isStartingBrowser) {
			console.log('[ws4channels] Viewer detected — waking browser...')
			startBrowserCapture()
		}
	}

	if (!isStreamReady) {
		let waited = 0
		while (!isStreamReady && waited < 8000) {
			await waitFor(200)
			waited += 200
		}
	}

	next()
})

app.use('/stream', express.static(OUTPUT_DIR))

// ─── Routes ──────────────────────────────────────────────────────────────────

app.get('/playlist.m3u', (req, res) => {
	const host = req.headers.host || `localhost:${STREAM_PORT}`
	const baseUrl = `http://${host}`
	res.set('Content-Type', 'application/x-mpegURL')
	res.send(
		`#EXTM3U
#EXTINF:-1 channel-id="weatherStar4000" tvg-id="weatherStar4000" tvg-channel-no="${CHANNEL_NUM}" tvc-guide-placeholders="3600" tvc-guide-title="Local Weather" tvc-guide-description="Enjoy your local weather with a touch of nostalgia." tvc-guide-art="${baseUrl}/logo/ws4000.png" tvg-logo="${baseUrl}/logo/ws4000.png",WeatherStar 4000
${baseUrl}/stream/stream.m3u8
`,
	)
})

app.get('/guide.xml', (req, res) => {
	const host = req.headers.host || `localhost:${STREAM_PORT}`
	res.set('Content-Type', 'application/xml')
	res.send(generateXMLTV(host))
})

app.get('/health', (req, res) => {
	res.status(isStreamReady ? 200 : 503).json({
		ready: isStreamReady,
		mode: isBrowserReady ? 'live' : 'warmup',
		browser: !!browser,
		version: VERSION,
		codec: VIDEO_OPTIONS,
	})
})

// ─── Boot ─────────────────────────────────────────────────────────────────────

const { cpus, memoryMB } = getContainerLimits()
console.log(`[ws4channels] v${VERSION} | ${cpus} CPU cores | ${memoryMB}MB RAM`)
console.log(`[ws4channels] Video: ${VIDEO_OPTIONS}`)
console.log(`[ws4channels] Idle timeout: ${IDLE_TIMEOUT_MS > 0 ? IDLE_TIMEOUT_MS / 1000 + 's' : 'disabled'}`)

app.listen(STREAM_PORT, async () => {
	console.log(`[ws4channels] Listening on :${STREAM_PORT}`)
	createAudioInputFile()

	// Pre-render warmup HLS once (cached across restarts), deploy to output
	generateWarmupHLS()

	if (IDLE_TIMEOUT_MS <= 0) {
		await startBrowserCapture()
	} else {
		console.log('[ws4channels] Ready. Browser starts on first viewer; warmup is live now.')
	}
})

process.on('SIGINT', async () => {
	await stopEverything()
	process.exit()
})
process.on('SIGTERM', async () => {
	await stopEverything()
	process.exit()
})
