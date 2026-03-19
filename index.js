const express = require('express')
const puppeteer = require('puppeteer-core')
const ffmpeg = require('fluent-ffmpeg')
const path = require('path')
const fs = require('fs')
const { PassThrough } = require('stream')
const { spawnSync } = require('child_process')
const os = require('os')

const app = express()

// ─── Config ──────────────────────────────────────────────────────────────────

const VERSION = '4.6'
const WS4KP_HOST = process.env.WS4KP_HOST || 'localhost'
const WS4KP_PORT = process.env.WS4KP_PORT || '8080'
const STREAM_PORT = process.env.STREAM_PORT || '9798'
const WS4KP_URL = `http://${WS4KP_HOST}:${WS4KP_PORT}`
const CAPTURE_RATE = parseInt(process.env.FRAME_RATE || '10') // screenshot & output fps
const CHANNEL_NUM = process.env.CHANNEL_NUMBER || '900'
const ZIP_CODE = process.env.ZIP_CODE || ''

// ─── Channel & EPG metadata ─────────────────────────────────────────────────
const CHANNEL_ID = process.env.CHANNEL_ID || 'weatherStar4000'
const CHANNEL_NAME = process.env.CHANNEL_NAME || 'WeatherStar 4000'
const CHANNEL_LOGO = process.env.CHANNEL_LOGO || 'ws4000.png'
const PROGRAM_TITLE = process.env.PROGRAM_TITLE || 'Local Weather'
const PROGRAM_DESC = process.env.PROGRAM_DESC || 'Enjoy your local weather with a touch of nostalgia.'
const PROGRAM_LOGO = process.env.PROGRAM_LOGO || CHANNEL_LOGO

let IDLE_TIMEOUT_MS = parseInt(process.env.IDLE_TIMEOUT_SECONDS || '300', 10) * 1000
if (Number.isNaN(IDLE_TIMEOUT_MS) || IDLE_TIMEOUT_MS < 0) IDLE_TIMEOUT_MS = 0
const DEBUG_SLEEP_MS = Math.max(0, parseInt(process.env.DEBUG_SLEEP || '0', 10)) * 1000

// ─── Video encoding config ────────────────────────────────────────────────────
// VIDEO_OPTIONS env var:
//   "default"  → Software x264
//   "qsv"      → Intel Quick Sync (requires /dev/dri passthrough)
//   "vaapi"    → VA-API (requires /dev/dri passthrough)
//   Custom     → e.g. "-c:v h264_nvenc -b:v 2000k"
const VIDEO_OPTIONS_RAW = process.env.VIDEO_OPTIONS || 'default'

const VIDEO_PRESETS = {
	default: {
		codec: 'libx264',
		outputArgs: ['-preset', 'ultrafast', '-b:v', '500k'],
		inputArgs: [],
		vf: 'scale=1280:720,format=yuv420p',
	},
	qsv: {
		codec: 'h264_qsv',
		outputArgs: ['-b:v', '500k', '-global_quality', '25'],
		inputArgs: ['-init_hw_device', 'qsv=hw', '-filter_hw_device', 'hw'],
		vf: 'scale=1280:720,format=nv12,hwupload=extra_hw_frames=64',
	},
	vaapi: {
		codec: 'h264_vaapi',
		outputArgs: ['-b:v', '500k'],
		inputArgs: ['-vaapi_device', '/dev/dri/renderD128'],
		vf: 'scale=1280:720,format=nv12,hwupload',
	},
}

function getVideoConfig() {
	const key = VIDEO_OPTIONS_RAW.toLowerCase().trim()
	if (VIDEO_PRESETS[key]) return { ...VIDEO_PRESETS[key], preset: key }
	const opts = VIDEO_OPTIONS_RAW.trim().split(/\s+/)
	const codecIndex = opts.indexOf('-c:v')
	const codec = codecIndex !== -1 ? opts[codecIndex + 1] : 'libx264'
	const extra = opts.filter((_, i) => i !== codecIndex && i !== codecIndex + 1)
	return { codec, outputArgs: extra, inputArgs: [], vf: 'scale=1280:720,format=yuv420p', preset: 'custom' }
}

const VIDEO_CONFIG = getVideoConfig()
const HLS_SEGMENT_DURATION = 2

// ─── Paths ───────────────────────────────────────────────────────────────────

const OUTPUT_DIR = path.join(__dirname, 'output')
const AUDIO_DIR = path.join(__dirname, 'music')
const LOGO_DIR = path.join(__dirname, 'logo')
const HLS_FILE = path.join(OUTPUT_DIR, 'stream.m3u8')
const WARMUP_IMAGE = path.join(LOGO_DIR, 'warmup.png')
const AUDIO_LIST = path.join(__dirname, 'audio_list.txt')

;[OUTPUT_DIR, AUDIO_DIR, LOGO_DIR].forEach(dir => {
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
})

app.use('/logo', express.static(LOGO_DIR))

// ─── State ───────────────────────────────────────────────────────────────────

// One ffmpeg process runs at all times. Its input pipe is swapped between
// warmup frames (from the looping image capture) and live frames (from Puppeteer).
let ffmpegProc = null // the single persistent ffmpeg process
let inputPipe = null // current active PassThrough being written to ffmpeg stdin
let warmupFeeder = null // setInterval pushing warmup frames into inputPipe
let browser = null
let page = null
let captureInterval = null
let isStreamReady = false
let isLive = false // true when Puppeteer frames are the source
let isBrowserFrozen = false
let isStartingBrowser = false
let isLaunching = false
let isInitialising = false // guard against concurrent initStream calls
let idleTimer = null
let restartDelay = 1000
let seqNumber = 0 // HLS sequence counter, increments across restarts

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

function resolveLogoUrl(baseUrl, logo) {
	if (logo.startsWith('http://') || logo.startsWith('https://')) return logo
	return `${baseUrl}/logo/${logo}`
}

function generateXMLTV(host) {
	const now = new Date()
	const baseUrl = `http://${host}`
	const channelLogoUrl = resolveLogoUrl(baseUrl, CHANNEL_LOGO)
	const programLogoUrl = resolveLogoUrl(baseUrl, PROGRAM_LOGO)

	// Floor to current hour so programs always start/end on the hour
	const hourStart = new Date(now)
	hourStart.setMinutes(0, 0, 0)

	const fmt = d => d.toISOString().replace(/[-:T]/g, '').split('.')[0] + ' +0000'

	let xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE tv SYSTEM "xmltv.dtd">
<tv>
<channel id="${CHANNEL_ID}">
  <display-name>${CHANNEL_NAME}</display-name>
  <icon src="${channelLogoUrl}" />
</channel>`
	for (let i = 0; i < 24; i++) {
		const start = new Date(hourStart.getTime() + i * 3600 * 1000)
		const stop = new Date(start.getTime() + 3600 * 1000)
		xml += `
<programme start="${fmt(start)}" stop="${fmt(stop)}" channel="${CHANNEL_ID}">
  <title lang="en">${PROGRAM_TITLE}</title>
  <desc lang="en">${PROGRAM_DESC}</desc>
  <icon src="${programLogoUrl}" />
</programme>`
	}
	return xml + '\n</tv>'
}

const WARMUP_JPEG = path.join(OUTPUT_DIR, 'warmup.jpg')

function ensureWarmupImage() {
	if (!fs.existsSync(WARMUP_IMAGE)) {
		console.log('[ws4channels] No warmup image found — generating placeholder')
		spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=0x1a1a2e:size=1280x720:rate=1', '-vframes', '1', '-q:v', '2', WARMUP_IMAGE])
	}
	// Convert to JPEG for image2pipe (which expects MJPEG, not PNG)
	const result = spawnSync('ffmpeg', ['-y', '-i', WARMUP_IMAGE, '-vframes', '1', '-q:v', '2', WARMUP_JPEG])
	if (result.status !== 0) {
		console.error('[ws4channels] Failed to convert warmup image to JPEG')
	} else {
		console.log(`[ws4channels] Warmup image ready: ${fs.statSync(WARMUP_JPEG).size} bytes JPEG`)
	}
}

// Clean stale HLS segments from previous runs
function cleanOutputDir() {
	try {
		for (const f of fs.readdirSync(OUTPUT_DIR)) {
			if (f.endsWith('.ts') || f.endsWith('.m3u8')) fs.unlinkSync(path.join(OUTPUT_DIR, f))
		}
	} catch {}
}

// ─── Audio ──────────────────────────────────────────────────────────────────
// Music is fed directly as a second input to the main ffmpeg process (concat
// demuxer with infinite loop). One process, one clock — no A/V sync drift.

function hasAudioFiles() {
	return fs.existsSync(AUDIO_LIST)
}

// ─── Warmup frame feeder ──────────────────────────────────────────────────────
// Reads the warmup image from disk and pushes JPEG frames into the input pipe
// at CAPTURE_RATE. This is the "warmup source" — same pipe ffmpeg always reads from,
// just different content than live Puppeteer frames.

function startWarmupFeeder() {
	stopWarmupFeeder()
	if (!fs.existsSync(WARMUP_JPEG)) {
		console.warn('[ws4channels] Warmup JPEG not found:', WARMUP_JPEG)
		return
	}

	const imageData = fs.readFileSync(WARMUP_JPEG)
	console.log(`[ws4channels] Warmup feeder started (${imageData.length} bytes JPEG, ${CAPTURE_RATE}fps → pipe)`)

	let frameCount = 0
	warmupFeeder = setInterval(() => {
		if (inputPipe?.writable) {
			inputPipe.write(imageData)
			frameCount++
			// Log first frame and then every 300 frames (~30s at 10fps)
			if (frameCount === 1) console.log('[ws4channels] Warmup: first frame written to pipe')
			else if (frameCount % 300 === 0) console.log(`[ws4channels] Warmup: ${frameCount} frames written`)
		} else if (frameCount === 0) {
			console.warn('[ws4channels] Warmup: pipe not writable, skipping frame')
		}
	}, 1000 / CAPTURE_RATE)
}

function stopWarmupFeeder() {
	if (warmupFeeder) {
		clearInterval(warmupFeeder)
		warmupFeeder = null
	}
}

// ─── Persistent ffmpeg ────────────────────────────────────────────────────────
// Starts once and runs forever. Reads JPEG frames from inputPipe (a PassThrough)
// and music directly via concat demuxer. The source of frames written to inputPipe
// changes between warmup and live — ffmpeg never notices or cares.
// Single process = single clock = no A/V sync drift.

async function startFFmpeg() {
	if (ffmpegProc) {
		try {
			ffmpegProc.kill('SIGINT')
		} catch {}
		ffmpegProc = null
	}

	// Create a fresh pipe for this ffmpeg instance
	inputPipe = new PassThrough()

	const { codec, outputArgs, inputArgs, vf } = VIDEO_CONFIG
	const audioReady = hasAudioFiles()
	const proc = ffmpeg()

	if (inputArgs.length) proc.outputOptions(inputArgs)

	proc
		.input(inputPipe)
		.inputFormat('image2pipe')
		.inputOptions(['-c:v mjpeg', `-framerate ${CAPTURE_RATE}`])

	if (audioReady) {
		// Feed music directly as a second input — same process, same clock
		proc.input(AUDIO_LIST).inputOptions(['-re', '-f', 'concat', '-safe', '0', '-stream_loop', '-1'])
		console.log('[ws4channels] Audio: music playlist (direct input)')
	} else {
		proc.input('anullsrc=channel_layout=stereo:sample_rate=44100').inputOptions(['-f', 'lavfi'])
		console.log('[ws4channels] Audio: silent')
	}

	const audioFilter = audioReady ? 'volume=0.5' : 'anull'

	proc
		.outputOptions([
			'-vf',
			vf,
			'-af',
			audioFilter,
			'-c:a',
			'aac',
			'-b:a',
			'128k',
			'-g',
			String(CAPTURE_RATE * 2),
			'-keyint_min',
			String(CAPTURE_RATE),
			'-force_key_frames',
			'expr:gte(t,n_forced*2)',
			'-flush_packets',
			'1',
			...outputArgs,
			'-f',
			'hls',
			'-hls_time',
			String(HLS_SEGMENT_DURATION),
			'-hls_list_size',
			'5',
			'-hls_flags',
			'delete_segments+append_list',
			'-hls_init_time',
			'1',
			'-start_number',
			String(seqNumber),
		])
		.videoCodec(codec)
		.output(HLS_FILE)
		.on('start', cmd => {
			console.log('[ws4channels] ffmpeg started')
			console.log(`[ws4channels] ffmpeg cmd: ${cmd}`)
		})
		.on('stderr', line => {
			// Log ffmpeg progress/status lines for debugging
			if (line.includes('Error') || line.includes('error') || line.includes('Opening') || line.includes('Output #')) {
				console.log(`[ws4channels] ffmpeg: ${line.trim()}`)
			}
		})
		.on('error', async err => {
			// Ignore intentional kills
			if (err.message.includes('SIGINT') || err.message.includes('255')) return
			console.error('[ws4channels] ffmpeg error:', err.message)
			isStreamReady = false
			isLive = false
			ffmpegProc = null
			inputPipe = null
			stopWarmupFeeder()
			// Restart after backoff
			await waitFor(restartDelay)
			restartDelay = Math.min(restartDelay * 2, 30000)
			initStream()
		})
		.on('end', () => {
			ffmpegProc = null
			inputPipe = null
			isStreamReady = false
			isLive = false
		})

	ffmpegProc = proc
	proc.run()

	// Start feeding frames IMMEDIATELY so video and audio PTS stay in sync.
	// Without this, audio (-re) races ahead while video pipe is empty → PTS
	// mismatch → ffmpeg stalls and never produces HLS segments.
	startWarmupFeeder()

	// Wait for ffmpeg to start and produce the first HLS segment
	let waited = 0
	while (!isStreamReady && waited < 15000) {
		try {
			const content = fs.readFileSync(HLS_FILE, 'utf8')
			if (content.includes('.ts')) {
				isStreamReady = true
				break
			}
		} catch {}
		await waitFor(250)
		waited += 250
	}

	if (isStreamReady) {
		console.log(`[ws4channels] HLS stream ready (${waited}ms)`)
	} else {
		isStreamReady = true
		console.warn('[ws4channels] HLS stream timeout — marking ready anyway')
	}
}

// ─── Stream init ──────────────────────────────────────────────────────────────
// Called once at boot (and after errors). Starts audio, ffmpeg, and warmup feeder.

async function initStream() {
	if (isInitialising) return
	isInitialising = true
	try {
		console.log('[ws4channels] Initialising stream...')
		ensureWarmupImage()
		await startFFmpeg()
		// warmup feeder is started inside startFFmpeg() right after proc.run()
		// so video frames flow immediately — keeping PTS in sync with audio
		restartDelay = 1000
		console.log('[ws4channels] Stream live on warmup image')
	} finally {
		isInitialising = false
	}
}

// ─── Switch to live ───────────────────────────────────────────────────────────
// Stop warmup feeder, start pushing Puppeteer screenshots into the same pipe.
// ffmpeg sees a continuous stream of JPEG frames — no restart needed.

function startLiveCapture() {
	stopWarmupFeeder()
	isLive = true
	console.log('[ws4channels] Switched to live browser capture')

	let liveFrameCount = 0
	captureInterval = setInterval(async () => {
		if (!inputPipe?.writable || !page) {
			if (liveFrameCount === 0) console.warn('[ws4channels] Live: pipe not writable or page missing')
			return
		}
		try {
			if (page.isClosed()) {
				console.warn('[ws4channels] Live: page closed, relaunching browser')
				await launchBrowser()
				return
			}
			const frame = await page.screenshot({ type: 'jpeg', quality: 80 })
			inputPipe.write(frame)
			liveFrameCount++
			if (liveFrameCount === 1) console.log(`[ws4channels] Live: first frame captured (${frame.length} bytes)`)
			else if (liveFrameCount % 300 === 0) console.log(`[ws4channels] Live: ${liveFrameCount} frames captured`)
		} catch (err) {
			if (!isLive) return
			console.warn('[ws4channels] Capture error:', err.message)
			await launchBrowser().catch(() => {})
		}
	}, 1000 / CAPTURE_RATE)
}

// ─── Switch to warmup ─────────────────────────────────────────────────────────
// Stop Puppeteer capture, resume looping the image into the same pipe.

function switchToWarmup() {
	if (captureInterval) {
		clearInterval(captureInterval)
		captureInterval = null
	}
	isLive = false
	startWarmupFeeder()
	console.log('[ws4channels] Switched back to warmup image')
}

// ─── Browser freeze / thaw ────────────────────────────────────────────────────

function getBrowserPid() {
	return browser?.process()?.pid ?? null
}

function freezeBrowser() {
	const pid = getBrowserPid()
	if (!pid || isBrowserFrozen) return
	try {
		process.kill(-pid, 'SIGSTOP')
	} catch {
		try {
			process.kill(pid, 'SIGSTOP')
		} catch {}
	}
	isBrowserFrozen = true
	console.log(`[ws4channels] Browser frozen (PID ${pid}) — zero CPU`)
}

function thawBrowser() {
	const pid = getBrowserPid()
	if (!pid || !isBrowserFrozen) return
	try {
		process.kill(-pid, 'SIGCONT')
	} catch {
		try {
			process.kill(pid, 'SIGCONT')
		} catch {}
	}
	isBrowserFrozen = false
	console.log(`[ws4channels] Browser thawed (PID ${pid})`)
}

// ─── Browser ─────────────────────────────────────────────────────────────────

function buildWS4KPUrl() {
	if (ZIP_CODE) return `${WS4KP_URL}/?zip=${encodeURIComponent(ZIP_CODE)}`
	return WS4KP_URL
}

async function launchBrowser() {
	if (isLaunching) return
	isLaunching = true
	try {
		if (browser) await browser.close().catch(() => {})
		browser = await puppeteer.launch({
			headless: true,
			executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
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
		await page.setCacheEnabled(false)
		await page.goto(buildWS4KPUrl(), { waitUntil: 'domcontentloaded', timeout: 15000 })
		try {
			await page.waitForSelector('div#container', { timeout: 15000 })
			await waitFor(1000)
		} catch {
			console.warn('[ws4channels] Container not found, capturing anyway')
		}
		await page.setViewport({ width: 1280, height: 720 })
		isBrowserFrozen = false
		console.log(`[ws4channels] Browser ready (PID ${getBrowserPid()})`)
	} finally {
		isLaunching = false
	}
}

async function startBrowserCapture() {
	if (isStartingBrowser) return
	isStartingBrowser = true
	try {
		if (isBrowserFrozen) {
			thawBrowser()
			await waitFor(200)
			// Reload page after thaw — ws4kp's JS timers and fetches are stale
			if (page && !page.isClosed()) {
				console.log('[ws4channels] Reloading page after thaw...')
				await page.goto(buildWS4KPUrl(), { waitUntil: 'domcontentloaded', timeout: 15000 })
				try {
					await page.waitForSelector('div#container', { timeout: 15000 })
					await waitFor(1000)
				} catch {
					console.warn('[ws4channels] Container not found after thaw, capturing anyway')
				}
			} else {
				await launchBrowser()
			}
		} else if (!browser) {
			await launchBrowser()
		}

		// DEBUG_SLEEP: keep warmup visible for N seconds after viewer triggers go-live
		if (DEBUG_SLEEP_MS > 0) {
			console.log(`[ws4channels] DEBUG_SLEEP: showing warmup for ${DEBUG_SLEEP_MS / 1000}s before switching to live...`)
			await waitFor(DEBUG_SLEEP_MS)
		}

		startLiveCapture()
	} catch (err) {
		console.error('[ws4channels] Browser startup failed:', err.message)
		switchToWarmup()
		freezeBrowser()
	} finally {
		isStartingBrowser = false
	}
}

async function idleBrowser() {
	console.log('[ws4channels] No viewers — switching to warmup, freezing browser')
	switchToWarmup()
	freezeBrowser()
}

async function stopEverything() {
	if (idleTimer) {
		clearTimeout(idleTimer)
		idleTimer = null
	}
	stopWarmupFeeder()
	if (captureInterval) {
		clearInterval(captureInterval)
		captureInterval = null
	}
	if (isBrowserFrozen) thawBrowser()
	if (browser) {
		await browser.close().catch(() => {})
		browser = null
		page = null
	}
	if (ffmpegProc) {
		// Record sequence number so a restart would continue from where we left off
		try {
			const m3u8 = fs.readFileSync(HLS_FILE, 'utf8')
			const match = m3u8.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/)
			if (match) seqNumber = parseInt(match[1]) + 5
		} catch {}
		try {
			ffmpegProc.kill('SIGINT')
		} catch {}
		ffmpegProc = null
	}
	if (inputPipe) {
		inputPipe.destroy()
		inputPipe = null
	}
	isStreamReady = isLive = isBrowserFrozen = false
	console.log('[ws4channels] Fully stopped.')
}

// ─── Idle timer ───────────────────────────────────────────────────────────────

function resetIdleTimer() {
	if (IDLE_TIMEOUT_MS <= 0) return
	if (idleTimer) clearTimeout(idleTimer)
	idleTimer = setTimeout(() => idleBrowser(), IDLE_TIMEOUT_MS)
}

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use('/stream', async (req, res, next) => {
	if (req.path.endsWith('.ts') || req.path.endsWith('.m3u8')) {
		resetIdleTimer()
		if (!isLive && !isStartingBrowser) {
			console.log(`[ws4channels] Viewer request: ${req.path} — triggering go-live (isLive=${isLive}, isStarting=${isStartingBrowser}, isReady=${isStreamReady})`)
			startBrowserCapture()
		}
	}

	if (!isStreamReady) {
		console.log(`[ws4channels] Stream not ready, waiting... (${req.path})`)
		let waited = 0
		while (!isStreamReady && waited < 15000) {
			await waitFor(250)
			waited += 250
		}
		if (!isStreamReady) {
			console.warn(`[ws4channels] Stream still not ready after ${waited}ms — serving anyway`)
		}
	}

	next()
})

app.use('/stream', express.static(OUTPUT_DIR))

// ─── Routes ──────────────────────────────────────────────────────────────────

app.get('/playlist.m3u', (req, res) => {
	const host = req.headers.host || `localhost:${STREAM_PORT}`
	const baseUrl = `http://${host}`
	const channelLogoUrl = resolveLogoUrl(baseUrl, CHANNEL_LOGO)
	const programLogoUrl = resolveLogoUrl(baseUrl, PROGRAM_LOGO)
	res.set('Content-Type', 'application/x-mpegURL')
	res.send(`#EXTM3U
#EXTINF:-1 channel-id="${CHANNEL_ID}" tvg-id="${CHANNEL_ID}" tvg-channel-no="${CHANNEL_NUM}" tvc-guide-placeholders="3600" tvc-guide-title="${PROGRAM_TITLE}" tvc-guide-description="${PROGRAM_DESC}" tvc-guide-art="${programLogoUrl}" tvg-logo="${channelLogoUrl}",${CHANNEL_NAME}
${baseUrl}/stream/stream.m3u8
`)
})

app.get('/guide.xml', (req, res) => {
	const host = req.headers.host || `localhost:${STREAM_PORT}`
	res.set('Content-Type', 'application/xml')
	res.send(generateXMLTV(host))
})

app.get('/health', (req, res) => {
	const mode = isLive ? 'live' : isBrowserFrozen ? 'frozen' : browser ? 'starting' : 'warmup'
	res.status(isStreamReady ? 200 : 503).json({
		ready: isStreamReady,
		mode,
		frozen: isBrowserFrozen,
		browserPid: getBrowserPid(),
		version: VERSION,
		encoder: `${VIDEO_CONFIG.preset} (${VIDEO_CONFIG.codec})`,
	})
})

// ─── Boot ─────────────────────────────────────────────────────────────────────

const { cpus, memoryMB } = getContainerLimits()
console.log(`[ws4channels] v${VERSION} | ${cpus} CPU cores | ${memoryMB}MB RAM`)
console.log(`[ws4channels] Encoder: ${VIDEO_CONFIG.preset} (${VIDEO_CONFIG.codec})`)
console.log(`[ws4channels] Idle timeout: ${IDLE_TIMEOUT_MS > 0 ? IDLE_TIMEOUT_MS / 1000 + 's' : 'disabled'}`)
if (ZIP_CODE) console.log(`[ws4channels] ZIP: ${ZIP_CODE}`)
if (DEBUG_SLEEP_MS > 0) console.log(`[ws4channels] DEBUG_SLEEP: ${DEBUG_SLEEP_MS / 1000}s`)

app.listen(STREAM_PORT, async () => {
	console.log(`[ws4channels] Listening on :${STREAM_PORT}`)
	createAudioInputFile()

	// Clean stale segments from previous runs
	cleanOutputDir()

	// Start the persistent ffmpeg pipeline with warmup feeder.
	// Uses the SAME encoder as live (no codec mismatch).
	// Warmup is immediately playable once ffmpeg produces the first HLS segment.
	await initStream()

	// Pre-launch browser so it's ready when first viewer connects
	if (IDLE_TIMEOUT_MS <= 0) {
		// Always-on: launch browser and go live immediately
		await launchBrowser()
		startLiveCapture()
	} else {
		// Launch browser, freeze it, wait for first viewer to trigger go-live
		console.log('[ws4channels] Launching browser to pre-load, then freezing...')
		await launchBrowser()
		freezeBrowser()
		console.log('[ws4channels] Ready. Warmup streaming. Browser frozen until first viewer.')
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
