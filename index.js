const express = require('express')
const puppeteer = require('puppeteer')
const ffmpeg = require('fluent-ffmpeg')
const path = require('path')
const fs = require('fs')
const { PassThrough } = require('stream')
const os = require('os')

const app = express()

// ─── Config ──────────────────────────────────────────────────────────────────

const VERSION = '3.0'
const ZIP_CODE = process.env.ZIP_CODE || '90210'
const WS4KP_HOST = process.env.WS4KP_HOST || 'localhost'
const WS4KP_PORT = process.env.WS4KP_PORT || '8080'
const STREAM_PORT = process.env.STREAM_PORT || '9798'
const WS4KP_URL = `http://${WS4KP_HOST}:${WS4KP_PORT}`
const FRAME_RATE = parseInt(process.env.FRAME_RATE || '10')
const CHANNEL_NUM = process.env.CHANNEL_NUMBER || '275'
// const HLS_SETUP_DELAY = 2000
const HLS_SETUP_DELAY = 800

// Idle shutdown: stop the pipeline after this many seconds with no viewers.
// Set to 0 to disable (always-on, original behavior).
const IDLE_TIMEOUT_MS = parseInt(process.env.IDLE_TIMEOUT_SECONDS || '120') * 1000

// Hardware transcoding examples (set via environment variable):
//   NVIDIA NVENC : -c:v h264_nvenc -pix_fmt yuv420p -b:v 2000k
//   Intel QSV    : -c:v h264_qsv -b:v 1000k
//   AMD VAAPI    : -vaapi_device /dev/dri/renderD128 -c:v h264_vaapi -b:v 1000k -vf format=nv12,hwupload
//   Software     : (default) -c:v libx264 -preset ultrafast -b:v 1000k
const VIDEO_OPTIONS = process.env.VIDEO_OPTIONS || '-c:v libx264 -preset ultrafast -b:v 1000k'

// ─── Paths ───────────────────────────────────────────────────────────────────

const OUTPUT_DIR = path.join(__dirname, 'output')
const AUDIO_DIR = path.join(__dirname, 'music')
const LOGO_DIR = path.join(__dirname, 'logo')
const HLS_FILE = path.join(OUTPUT_DIR, 'stream.m3u8')

;[OUTPUT_DIR, AUDIO_DIR, LOGO_DIR].forEach(dir => {
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
let isStarting = false
let idleTimer = null
let restartDelay = 1000 // exponential backoff for error restarts

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
	// Shuffle
	for (let i = files.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1))
		;[files[i], files[j]] = [files[j], files[i]]
	}
	const audioList = files.map(f => `file '${path.join(AUDIO_DIR, f)}'`).join('\n')
	fs.writeFileSync(path.join(__dirname, 'audio_list.txt'), audioList)
	console.log(`[ws4channels] Loaded ${files.length} music files`)
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

// ─── Idle timer ──────────────────────────────────────────────────────────────
// Called every time a viewer fetches a segment. Resets the countdown.

function resetIdleTimer() {
	if (IDLE_TIMEOUT_MS <= 0) return // disabled
	if (idleTimer) clearTimeout(idleTimer)
	idleTimer = setTimeout(async () => {
		console.log('[ws4channels] No viewers — shutting down pipeline to save resources.')
		await stopTranscoding()
	}, IDLE_TIMEOUT_MS)
}

// ─── Browser ─────────────────────────────────────────────────────────────────

async function startBrowser() {
	if (browser) await browser.close().catch(() => {})
	browser = await puppeteer.launch({
		headless: true,
		args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-infobars', '--ignore-certificate-errors', '--window-size=1280,720'],
		defaultViewport: null,
	})
	page = await browser.newPage()
	// await page.goto(WS4KP_URL, { waitUntil: 'networkidle2', timeout: 30000 })
	await page.goto(WS4KP_URL, { waitUntil: 'domcontentloaded', timeout: 15000 })
	// try {
	// 	const zipInput = await page.waitForSelector('input[placeholder="Zip or City, State"], input', { timeout: 5000 })
	// 	if (zipInput) {
	// 		await zipInput.type(ZIP_CODE, { delay: 100 })
	// 		await waitFor(1000)
	// 		await page.keyboard.press('ArrowDown')
	// 		await waitFor(500)
	// 		const goButton = await page.$('button[type="submit"]')
	// 		if (goButton) await goButton.click()
	// 		else await zipInput.press('Enter')
	// 		await page.waitForSelector('div.weather-display, #weather-content', { timeout: 30000 })
	// 	}
	// } catch {
	// 	/* page may already show weather */
	// }
	await page.setViewport({ width: 1280, height: 720 })
}

// ─── Pipeline start / stop ───────────────────────────────────────────────────

async function startTranscoding() {
	if (isStarting || ffmpegProc) return
	isStarting = true
	console.log('[ws4channels] Starting pipeline...')

	try {
		await startBrowser()
		createAudioInputFile()

		// Parse VIDEO_OPTIONS into an array so fluent-ffmpeg handles them correctly.
		// A plain string like "-c:v h264_nvenc -b:v 2000k" must become ["-c:v","h264_nvenc",…]
		const videoOpts = VIDEO_OPTIONS.trim().split(/\s+/)
		// Separate codec flag (-c:v …) from everything else (bitrate, pix_fmt, hwupload filters…)
		// We'll pass the whole lot as outputOptions after removing -c:v which goes to .videoCodec()
		const codecIndex = videoOpts.indexOf('-c:v')
		const codec = codecIndex !== -1 ? videoOpts[codecIndex + 1] : 'libx264'
		// Build remaining options without the -c:v pair
		const extraVideoOpts = videoOpts.filter((_, i) => i !== codecIndex && i !== codecIndex + 1)

		ffmpegStream = new PassThrough()

		ffmpegProc = ffmpeg()
			.input(ffmpegStream)
			.inputFormat('image2pipe')
			.inputOptions([`-framerate ${FRAME_RATE}`])
			.input(path.join(__dirname, 'audio_list.txt'))
			.inputOptions(['-f concat', '-safe 0', '-stream_loop -1'])
			.complexFilter(['[0:v]scale=1280:720[v]', '[1:a]volume=0.5[a]'])
			.outputOptions([
				'-map [v]',
				'-map [a]',
				'-c:a aac',
				'-b:a 128k',
				...extraVideoOpts, // hardware-specific flags (pix_fmt, bitrate, etc.)
				'-f hls',
				'-hls_time 2',
				'-hls_list_size 3',
				'-hls_flags delete_segments+append_list',
			])
			.videoCodec(codec) // respects hw codec string
			.output(HLS_FILE)
			.on('start', cmd => {
				console.log(`[ws4channels] v${VERSION} — ffmpeg started`)
				console.log(`[ws4channels] codec: ${codec}  extra: ${extraVideoOpts.join(' ') || '(none)'}`)
				setTimeout(() => {
					isStreamReady = true
				}, HLS_SETUP_DELAY)
				restartDelay = 1000 // reset backoff on successful start
			})
			.on('error', async err => {
				console.error('[ws4channels] FFmpeg error:', err.message)
				await stopTranscoding()
				// Exponential backoff: 1s → 2s → 4s … up to 30s
				console.log(`[ws4channels] Restarting in ${restartDelay / 1000}s…`)
				await waitFor(restartDelay)
				restartDelay = Math.min(restartDelay * 2, 30000)
				startTranscoding()
			})
			.on('end', () => {
				ffmpegProc = null
				ffmpegStream = null
				isStreamReady = false
			})

		captureInterval = setInterval(async () => {
			if (!ffmpegProc || !ffmpegStream || !page) return
			try {
				if (page.isClosed()) {
					await startBrowser()
					return
				}
				const screenshot = await page.screenshot({
					type: 'jpeg',
					clip: { x: 4, y: 50, width: 840, height: 470 },
				})
				ffmpegStream.write(screenshot)
			} catch (err) {
				console.warn('[ws4channels] Capture error, retrying:', err.message)
				await startBrowser()
			}
		}, 1000 / FRAME_RATE)

		ffmpegProc.run()
	} catch (err) {
		console.error('[ws4channels] Failed to start pipeline:', err)
		isStarting = false
		await stopTranscoding()
		await waitFor(restartDelay)
		restartDelay = Math.min(restartDelay * 2, 30000)
		startTranscoding()
		return
	}

	isStarting = false
}

async function stopTranscoding() {
	if (idleTimer) {
		clearTimeout(idleTimer)
		idleTimer = null
	}
	if (captureInterval) {
		clearInterval(captureInterval)
		captureInterval = null
	}
	isStreamReady = false

	if (ffmpegProc) {
		try {
			ffmpegProc.kill('SIGINT')
		} catch {}
		ffmpegProc = null
	}
	if (ffmpegStream) {
		try {
			ffmpegStream.destroy()
		} catch {}
		ffmpegStream = null
	}
	if (browser) {
		await browser.close().catch(() => {})
		browser = null
		page = null
	}

	// Clean up stale HLS segments so the next start isn't confusing to players
	try {
		fs.readdirSync(OUTPUT_DIR)
			.filter(f => f.endsWith('.ts') || f.endsWith('.m3u8'))
			.forEach(f => fs.unlinkSync(path.join(OUTPUT_DIR, f)))
	} catch {}

	console.log('[ws4channels] Pipeline stopped.')
}

// ─── On-demand wake-up middleware ─────────────────────────────────────────────
// Any request for the stream wakes the pipeline if it's sleeping,
// and resets the idle countdown.

app.use('/stream', async (req, res, next) => {
	// Only count segment fetches (.ts files) as real viewer activity,
	// not the playlist poll that Channels DVR does every few seconds.
	if (req.path.endsWith('.ts')) {
		resetIdleTimer()
	}

	if (!ffmpegProc && !isStarting) {
		console.log('[ws4channels] Viewer detected — waking pipeline...')
		startTranscoding() // intentionally not awaited; respond after segments appear
	}

	// If pipeline is still spinning up, wait briefly before serving
	if (!isStreamReady) {
		let waited = 0
		while (!isStreamReady && waited < 12000) {
			await waitFor(300)
			waited += 300
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
		pipeline: !!ffmpegProc,
		codec: VIDEO_OPTIONS,
		version: VERSION,
	})
})

// ─── Boot ─────────────────────────────────────────────────────────────────────

const { cpus, memoryMB } = getContainerLimits()
console.log(`[ws4channels] v${VERSION} | ${cpus} CPU cores | ${memoryMB}MB RAM`)
console.log(`[ws4channels] Video codec config: ${VIDEO_OPTIONS}`)
if (IDLE_TIMEOUT_MS > 0) {
	console.log(`[ws4channels] Idle shutdown enabled: ${IDLE_TIMEOUT_MS / 1000}s`)
} else {
	console.log(`[ws4channels] Idle shutdown disabled (always-on mode)`)
}

app.listen(STREAM_PORT, () => {
	console.log(`[ws4channels] Server listening on :${STREAM_PORT}`)

	// If idle shutdown is disabled, start immediately (original behavior).
	// Otherwise, wait for the first viewer to trigger startup.
	if (IDLE_TIMEOUT_MS <= 0) {
		startTranscoding()
	} else {
		console.log('[ws4channels] Waiting for first viewer before starting pipeline...')
	}
})

process.on('SIGINT', async () => {
	console.log('SIGINT')
	await stopTranscoding()
	process.exit()
})
process.on('SIGTERM', async () => {
	console.log('SIGTERM')
	await stopTranscoding()
	process.exit()
})
