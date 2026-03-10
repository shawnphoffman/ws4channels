const express = require('express')
const puppeteer = require('puppeteer')
const ffmpeg = require('fluent-ffmpeg')
const path = require('path')
const fs = require('fs')
const { PassThrough } = require('stream')
const os = require('os')

const app = express()

// ─── Config ──────────────────────────────────────────────────────────────────

const VERSION = '4.0'
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
const AUDIO_LIST = path.join(__dirname, 'audio_list.txt')

;[OUTPUT_DIR, AUDIO_DIR, LOGO_DIR].forEach(dir => {
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
})

app.use('/logo', express.static(LOGO_DIR))

// ─── State ───────────────────────────────────────────────────────────────────

let ffmpegProc = null // single ffmpeg process, always running
let ffmpegStream = null // PassThrough pipe feeding frames to ffmpeg
let browser = null // null when idle
let page = null
let warmupInterval = null // pumps warmup image frames into the pipe
let captureInterval = null // pumps browser screenshots into the pipe
let isStreamReady = false
let isBrowserReady = false // true once live screenshots are flowing
let isStartingBrowser = false
let idleTimer = null
let restartDelay = 1000
let warmupScaledData = null // pre-loaded JPEG buffer of the warmup image

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

// ─── Warmup image ────────────────────────────────────────────────────────────

function ensureWarmupImage() {
	if (!fs.existsSync(WARMUP_IMAGE)) {
		console.log('[ws4channels] No warmup.jpg found — generating a placeholder image')
		require('child_process').spawnSync('ffmpeg', [
			'-y',
			'-f',
			'lavfi',
			'-i',
			'color=c=0x1a1a2e:size=1280x720:rate=1',
			'-vframes',
			'1',
			'-q:v',
			'2',
			WARMUP_IMAGE,
		])
	}
	// Scale warmup to 1280x720 JPEG for pipe consistency with live screenshots
	console.log('[ws4channels] Preparing warmup image at 1280x720')
	const WARMUP_SCALED = path.join(LOGO_DIR, 'warmup_scaled.jpg')
	require('child_process').spawnSync('ffmpeg', [
		'-y',
		'-i',
		WARMUP_IMAGE,
		'-vf',
		'scale=1280:720',
		'-vframes',
		'1',
		'-q:v',
		'5',
		WARMUP_SCALED,
	])
	// Overwrite the warmup reference to use the scaled version
	warmupScaledData = fs.readFileSync(WARMUP_SCALED)
}

// ─── Single FFmpeg pipeline ──────────────────────────────────────────────────
// One ffmpeg process runs for the entire lifetime of the app.
// It reads PNG frames from a PassThrough pipe + looped audio.
// We swap what gets written to the pipe: warmup image frames or live screenshots.
// No process restarts, no HLS discontinuities, seamless transitions.

function startFFmpeg() {
	return new Promise((resolve, reject) => {
		if (ffmpegProc) {
			resolve()
			return
		}

		ensureWarmupImage()
		ffmpegStream = new PassThrough()
		const { codec, extra } = parseVideoOptions()

		ffmpegProc = ffmpeg()
			.input(ffmpegStream)
			.inputFormat('image2pipe')
			.inputOptions(['-re', '-c:v mjpeg', `-framerate ${FRAME_RATE}`, '-thread_queue_size 16'])
			.input(AUDIO_LIST)
			.inputOptions(['-f concat', '-safe 0', '-stream_loop -1', '-thread_queue_size 512'])
			.complexFilter(['[0:v]scale=1280:720,format=yuv420p[v]', '[1:a]volume=0.5[a]'])
			.outputOptions([
				'-map [v]',
				'-map [a]',
				'-c:a aac',
				'-b:a 128k',
				'-shortest',
				'-fflags +genpts',
				...extra,
				'-f hls',
				'-hls_time 2',
				'-hls_list_size 3',
				'-hls_flags delete_segments',
			])
			.videoCodec(codec)
			.output(HLS_FILE)
			.on('start', cmd => {
				console.log('[ws4channels] FFmpeg pipeline started')
				console.log('[ws4channels] FFmpeg cmd:', cmd)
				// Begin pumping warmup frames immediately
				startWarmupFrames()
				setTimeout(() => {
					isStreamReady = true
					resolve()
				}, 2000)
			})
			.on('stderr', line => {
				console.log('[ffmpeg]', line)
			})
			.on('error', err => {
				console.error('[ws4channels] FFmpeg error:', err.message)
				ffmpegProc = null
				isStreamReady = false
				isBrowserReady = false
				stopWarmupFrames()
				stopCaptureFrames()
				if (ffmpegStream) {
					ffmpegStream.destroy()
					ffmpegStream = null
				}
				// Attempt restart
				setTimeout(() => {
					console.log('[ws4channels] Restarting FFmpeg pipeline...')
					startFFmpeg()
						.then(() => {
							if (browser) switchToLiveCapture()
						})
						.catch(() => {})
				}, restartDelay)
				restartDelay = Math.min(restartDelay * 2, 30000)
			})
			.on('end', () => {
				console.log('[ws4channels] FFmpeg ended unexpectedly')
				ffmpegProc = null
				ffmpegStream = null
				isStreamReady = false
				isBrowserReady = false
			})

		ffmpegProc.run()
	})
}

// ─── Frame sources ───────────────────────────────────────────────────────────
// Only one source writes to the pipe at a time: warmup OR live capture.

function startWarmupFrames() {
	stopWarmupFrames()
	if (!warmupScaledData) {
		console.error('[ws4channels] No warmup data loaded!')
		return
	}
	console.log('[ws4channels] Pumping warmup frames')
	warmupInterval = setInterval(() => {
		if (ffmpegStream?.writable) ffmpegStream.write(warmupScaledData)
	}, 1000 / FRAME_RATE)
}

function stopWarmupFrames() {
	if (warmupInterval) {
		clearInterval(warmupInterval)
		warmupInterval = null
	}
}

function startCaptureFrames() {
	stopCaptureFrames()
	console.log('[ws4channels] Pumping live browser frames')
	captureInterval = setInterval(async () => {
		if (!ffmpegStream?.writable || !page) return
		try {
			if (page.isClosed()) {
				console.warn('[ws4channels] Page closed, relaunching browser...')
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
}

function stopCaptureFrames() {
	if (captureInterval) {
		clearInterval(captureInterval)
		captureInterval = null
	}
}

// Seamless switch: stop warmup frames, start live capture frames.
// Same pipe, same ffmpeg — no discontinuity.
function switchToLiveCapture() {
	stopWarmupFrames()
	startCaptureFrames()
	isBrowserReady = true
	restartDelay = 1000
	console.log('[ws4channels] Switched to live capture (seamless)')
}

// Switch back to warmup frames when browser shuts down.
function switchToWarmupCapture() {
	stopCaptureFrames()
	isBrowserReady = false
	startWarmupFrames()
	console.log('[ws4channels] Switched to warmup frames (seamless)')
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
		await waitFor(2000) // let weather data load and render
	} catch {
		console.warn('[ws4channels] Container element not found, capturing anyway')
	}
	await page.setViewport({ width: 1280, height: 720 })
	// Save a debug screenshot for troubleshooting
	await page.screenshot({ path: path.join(OUTPUT_DIR, 'debug.png'), fullPage: true }).catch(() => {})
	console.log('[ws4channels] Browser ready')
}

async function startBrowserAndCapture() {
	if (isStartingBrowser) return
	isStartingBrowser = true
	console.log('[ws4channels] Starting browser...')

	try {
		if (!browser) await launchBrowser()
		switchToLiveCapture()
	} catch (err) {
		console.error('[ws4channels] Browser startup failed:', err.message)
		// Stay on warmup frames — no disruption to the stream
	} finally {
		isStartingBrowser = false
	}
}

async function shutdownBrowser() {
	console.log('[ws4channels] Shutting down browser (idle)')
	isStartingBrowser = false

	if (idleTimer) {
		clearTimeout(idleTimer)
		idleTimer = null
	}

	// Switch pipe back to warmup — no ffmpeg restart needed
	switchToWarmupCapture()

	if (browser) {
		await browser.close().catch(() => {})
		browser = null
		page = null
	}
}

async function stopEverything() {
	if (idleTimer) {
		clearTimeout(idleTimer)
		idleTimer = null
	}
	stopWarmupFrames()
	stopCaptureFrames()
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
			startBrowserAndCapture()
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

	// Start the single ffmpeg pipeline — it pumps warmup frames immediately
	await startFFmpeg().catch(err => {
		console.error('[ws4channels] FFmpeg start failed:', err.message)
	})

	// If idle timeout is disabled, launch browser right away
	if (IDLE_TIMEOUT_MS <= 0) {
		await startBrowserAndCapture()
	} else {
		console.log('[ws4channels] Ready. Browser starts on first viewer; warmup image is live now.')
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
