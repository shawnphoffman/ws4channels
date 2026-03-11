# Always-Available Streams and Single-Muxer Options

This document captures the design behind ws4channels’ “warmup” (always-available) behavior, how it compares to MediaMTX, and hypothetical options for moving to a single-stream / single-muxer architecture. It is for future reference when evolving the streaming pipeline.

---

## 1. How MediaMTX Handles Always-Available Streams

References:

- [MediaMTX docs: Always-available streams](https://mediamtx.org/docs/other/always-available)
- [MediaMTX stream.go (always-available logic)](https://github.com/bluenviron/mediamtx/blob/622513cb2416f172aec9c09ac95e0e393d38df0b/internal/stream/stream.go)

**Goal:** When the publisher/source is offline, the server fills the gap with an **offline segment** played on repeat so **readers never disconnect**. When a publisher comes back, offline and live are **concatenated without re-encoding** (same codec).

**Config:**

- `alwaysAvailable: true`
- Either **track-based:** `alwaysAvailableTracks` — list of codecs (H264, VP9, Opus, AAC, etc.) so the server knows the stream format with no source; optional `alwaysAvailableFile` omitted → built-in “STREAM IS OFFLINE” segment.
- Or **file-based:** `alwaysAvailableFile: "./h264.mp4"` — custom MP4 used as the offline loop (parsed for codec/SPS/PPS so format matches).

**Mechanics:**

- On init, the stream has no `Desc` yet; it builds an **offline session description** from the file or from `alwaysAvailableTracks`, then clones it into `Desc` so the path always has a well-defined format.
- An **offline substream** (`offlineSubStream`) plays the offline segment on repeat at the RTP level (no re-encode).
- When a publisher connects, the server switches from the offline substream to the live one; formats match, so handoff is clean.

**Architecture:** One process, one logical “stream” object. The HLS (and other) muxers are consumers of that stream; they receive packets from whichever source is currently active (offline loop or live publisher). So there is literally **one muxer and one segment namespace**; only the feeder changes.

---

## 2. How ws4channels Warmup Works (Current)

Implemented in `index.js`.

1. **Pre-render (at boot)**  
   FFmpeg generates a short HLS clip from the warmup image + silent AAC into `warmup_hls/`. Format matches live: H264, AAC, 1280×720, same frame rate, and **segment duration** aligned with live via `HLS_SEGMENT_DURATION` (e.g. 2s).

2. **Deploy**  
   `deployWarmup()` copies warmup `.ts` files into `OUTPUT_DIR`. Used after idle shutdown or FFmpeg error.

3. **Serving `stream.m3u8`**  
   - **Live:** Serve the real `OUTPUT_DIR/stream.m3u8` written by the live FFmpeg process.  
   - **Warmup:** Serve a **synthetic** playlist that:
     - Lists one warmup segment per response and increments `warmupSeq` so the next request gets a new sequence number.
     - Includes `#EXT-X-DISCONTINUITY` so when live takes over, the client re-initializes the decoder for the next segment.

4. **Live handoff**  
   Live FFmpeg is started with `-start_number warmupSeq` so segment numbering continues from the last warmup sequence. Clients see a continuous sequence with one discontinuity at the warmup→live boundary.

So: **one URL**, sometimes synthetic warmup playlist, sometimes real live playlist; format alignment by construction (same encoder settings and segment duration for warmup and live).

---

## 3. Comparison

| Aspect | MediaMTX | ws4channels |
|--------|----------|-------------|
| One URL | Yes | Yes |
| No re-encode at handoff | Yes (same codec, RTP passthrough) | Yes (same codec, HLS DISCONTINUITY) |
| Offline source | One MP4 (or built-in) looped | Pre-rendered HLS segments; synthetic playlist rotates one segment per request |
| Format definition | From `alwaysAvailableFile` or `alwaysAvailableTracks` | Warmup generator matches live (resolution, codec, segment duration) |
| Single muxer | Yes (one stream object, one muxer) | No (two segment sources; Node chooses which playlist/segments to serve) |

The **mechanism** for “no re-encode” differs (RTP passthrough vs HLS DISCONTINUITY), but both achieve correct handoff. No change is required for that row; the difference is protocol-level (RTP vs HLS).

---

## 4. Implemented: Comparable Loading Video from Warmup Image

We do **not** accept a user-provided loading video. We **generate** a loading clip from the warmup image at deploy so the channel behaves like an always-available stream.

- **Ready at deploy:** `generateWarmupHLS()` runs at boot; warmup is ready before first viewer.
- **One asset, looped:** One (or a small number of) warmup segment(s), repeated via the synthetic playlist.
- **Same format as live:** Same resolution, frame rate, codec (H264), audio (AAC), and **segment duration** (`HLS_SEGMENT_DURATION`) so handoff is seamless.
- **Optional format check:** `verifyWarmupFormat()` probes the first warmup segment and logs a warning if it is not H264 1280×720.

Warmup does **not** use `VIDEO_OPTIONS`; it always uses software (libx264) so it runs without hardware at boot. Live can use qsv/vaapi/custom; both outputs are H264, so there are no encoding pipeline issues with variable `VIDEO_OPTIONS`.

---

## 5. Why We Use `#EXT-X-DISCONTINUITY`

MediaMTX switches at the RTP level; their HLS muxer may not need to inject a discontinuity in the same way. In ws4channels we have **two separate segment sources** (warmup .ts files and live FFmpeg output). Per the HLS spec and player behavior:

- `#EXT-X-DISCONTINUITY` is used when encoding parameters, timestamp sequence, or track setup changes.
- Players **re-initialize the decoder** when they see it (re-apply codec/SPS/PPS for the following segments).
- Without it, switching from warmup to live (which can have different SPS/PPS even though both are H.264) can cause decode errors or glitches.

So for our design, DISCONTINUITY is the **correct and standard** way to get a proper handoff. We do not need a different mechanism.

---

## 6. Hypothetical: Single Stream, One HLS Muxer (MediaMTX-Style)

Making ws4channels “more like MediaMTX” would mean: **one** logical stream and **one** HLS muxer that handles the switch, instead of two segment sources and a synthetic playlist.

### 6.1 Why This Is a Refactor

- **MediaMTX:** One process; the “stream” receives RTP from either the offline loop or the live publisher. The HLS muxer is a consumer of that stream and keeps writing one continuous playlist/segment set.
- **ws4channels:** Two producers (warmup pre-rendered segments + live FFmpeg writing segments). Node decides which playlist/segments to serve. FFmpeg cannot “switch input at runtime” in the sense of one process that is told “now take warmup instead of live” without restarting or changing what feeds it.

So getting a true single-muxer design requires a real architectural change, not a small tweak.

### 6.2 Option A: One Muxer FFmpeg + Switchable Feeders (Medium Effort)

**Idea:** One long-running FFmpeg that **only muxes** (e.g. input = one pipe of MPEG-TS or H.264+AAC, output = HLS to disk). Two possible **feeder** processes (only one active at a time):

- **Warmup:** e.g. `ffmpeg -stream_loop -1 -i warmup.ts -c copy -f mpegts -` → pipe into the muxer.
- **Live:** Current encode (browser + audio) but output to a pipe (e.g. `-f mpegts -`) instead of writing HLS directly → same pipe into the muxer.

**Changes:**

- Add a persistent “muxer” process (stdin → HLS).
- Refactor live to output to a pipe instead of directly to HLS files.
- Implement “switch”: tear down one feeder, start the other, reconnect the pipe to the muxer (or restart the muxer on switch for a clean segment boundary and a single DISCONTINUITY).
- Handle muxer behavior when the pipe stream changes (format/codec params); you may still emit one DISCONTINUITY at the warmup→live boundary, but the playlist and segment set would come from a single muxer.

**Effort:** Medium. No need to implement HLS muxing yourself; FFmpeg remains the muxer.

### 6.3 Option B: HLS Muxer in Node (Large Effort)

**Idea:** Implement (or use a library for) HLS muxing in Node: accept H.264 NALs + AAC (and timing), write `.ts` segments and `stream.m3u8`. Warmup and live would both feed this single muxer; Node would switch the input source.

**Effort:** Large. You need (or integrate) segment writing, playlist updates, segment rotation, and correct handling of codec switches (and likely one DISCONTINUITY when switching).

**Known libraries and tools (as of 2025):**

- **hlss** ([streamer45/hlss](https://github.com/streamer45/hlss)) — Node.js HLS segmenter; creates m3u8 playlists and .ts segments. Good candidate for a “segmenter” that could sit in front of a single output.
- **hls-maker** ([npm](https://www.npmjs.com/package/hls-maker)) — TypeScript; creates HLS segments from source files, configurable duration, manifest generation, stream concatenation/insertion. Promise/async API.
- **hls-parser** ([npm](https://www.npmjs.com/package/hls-parser)) — Parse and stringify M3U8 playlists (read/write manifest). Does **not** create segments from elementary streams; useful for playlist logic, not full muxing.
- **node-hls-server** ([npm](https://www.npmjs.com/package/node-hls-server)) — HLS server that remuxes sources into HLS; typically uses FFmpeg under the hood. Useful for a “server” layer, not a pure in-process muxer from NALs.
- **mux.js** ([videojs/mux.js](https://github.com/videojs/mux.js)) — Transmuxes **MPEG-TS → fMP4** (for MSE playback). Parses H.264 and AAC; does **not** create MPEG-TS segments from elementary streams. Helpful for client-side or fMP4 workflows, not for building .ts from NALs in Node.
- **mpegts.js** ([npm](https://www.npmjs.com/package/mpegts.js)) — Player-side: transmuxes MPEG-TS for playback (e.g. in browser). Not a server-side segment creator.
- **node-ts-fragmenter** ([monyone/node-ts-fragmenter](https://github.com/monyone/node-ts-fragmenter)) — Converts MPEG-TS to fragments for low-latency HLS (LL-HLS). Fragmenter/orchestrator, not a full “elementary stream → TS” muxer.

**Summary for Option B:** There is no drop-in “feed H.264 NALs + AAC, get .ts + m3u8” library in Node that is as mature as FFmpeg. You would likely combine: something that can produce or parse TS (e.g. hlss, hls-maker, or FFmpeg for encoding), plus playlist logic (e.g. hls-parser), and possibly custom glue for segment boundaries and DISCONTINUITY when switching sources. So Option B remains a **large** change.

---

## 7. Recommendation

- **Current design** (two segment sources, synthetic playlist, DISCONTINUITY at handoff) is correct for HLS and does not need to change for correctness or “seamlessness” in the spec sense.
- If the goal is to **converge on a single-muxer architecture** for operational or conceptual simplicity:
  - **Option A** (one muxer FFmpeg + switchable feeders) is the most practical: medium effort, no custom muxer.
  - **Option B** (HLS muxer in Node) is possible but large, and would rely on a combination of libraries plus custom logic rather than a single off-the-shelf muxer.

This document can be updated as new Node HLS muxing libraries appear or as the project’s requirements evolve.
