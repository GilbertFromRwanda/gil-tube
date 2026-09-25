# How Gil Tube's components fit together

Gil Tube is six small services, each in its own container, plus two
clients: a static web page and an Android app (Expo / React Native). Both
clients talk to the same `api`. Nothing talks to YouTube directly except the
extractor (the players embed YouTube's own iframe, which is the one
exception); nothing writes files to disk except the downloader. Here's the
wiring.

## The pieces

| Component      | Language           | Talks on          | Job |
|-----------------|--------------------|--------------------|-----|
| `web/`          | HTML/CSS/JS (static) | served on `:3000` by `start.sh` | Browser UI: search, preview, kick off downloads, show progress |
| `mobile/`       | Expo SDK 57 / React Native (TypeScript) | installed as an APK | Phone client: same search / preview / download as the web, plus a bottom-sheet player with mini bar, next / previous / autoplay, audio-only and background audio, and saving to a chosen folder. Finds the server by scanning a QR code shown in the web UI |
| `api/`          | Go (gin)           | `:8081` → container `:8080` | Front door. Validates requests, proxies to the extractor, writes jobs to Postgres, publishes to NATS, proxies file downloads/progress from the downloader, and resolves an audio-only stream URL for the phone |
| `extractor/`    | Python (Flask + yt-dlp, gunicorn) | `:9000` | Resolves a YouTube URL (or search query) into real, direct CDN media URLs via yt-dlp. Caches results in Redis |
| `downloader/`   | Rust (axum)        | `:8000` | Actually fetches the media bytes from the CDN URL(s), in parallel byte-range chunks, muxes video+audio with ffmpeg, serves the finished file |
| `worker/`       | Go                 | no inbound port | Listens for `jobs.ready` on NATS, calls the downloader synchronously, writes the terminal status back to Postgres |
| `postgres`      | Postgres 16        | `:5432` | Source of truth for job records (`jobs` table) |
| `redis`         | Redis 7            | `:6379` | Cache for extraction/search results (`extract:*`, `search:*` keys); the `search:*` keys double as the store of past queries for typing suggestions |
| `nats`          | NATS 2.10 (JetStream flag on) | `:4222` (`:8222` monitoring) | Message bus between `api` and `worker` — just two subjects: `jobs.ready`, `jobs.cancelled` |

All of this is defined in [docker-compose.yml](docker-compose.yml) and
brought up together by [start.sh](start.sh), which also serves `web/` and
waits on each service's `/health` before opening the browser.

## Request flow 1 — searching / browsing

```
browser or phone
   │  POST /api/v1/search  { query, limit, offset, refresh? }
   ▼
api (Go)
   │  forwards to extractor, unchanged
   ▼
extractor (Python)
   │  cache hit?  → return cached JSON (Redis, prefix "search:", one key per page)
   │  cache miss? → yt-dlp (extract_flat, fast) → cache it (TTL 6h) → return
   │     page 0:  `ytsearchN:<query>`
   │     deeper:  YouTube's results URL with `playliststart/playlistend`
   │  depth is capped at 300 results (deeper pages get slow and irrelevant)
   ▼
api → client: { results: [{id, title, thumbnail, duration, ...}], has_more, next_offset }
```

`GET /api/v1/cached-searches` is a variant of this: the extractor scans all
`search:*` Redis keys, flattens/dedupes the videos across every past query,
and returns a page of them (`offset`/`limit`) — this is what the clients
load on first paint, before the user has typed anything.

**Endless scroll.** The clients chain those two sources into one list that
never dead-ends: cached videos first, then — when the cache runs out — live
`/search` pages for the query being shown (or the default one), each fetched
with the `next_offset` the last one returned. They drop repeats, fetch the next
page ahead of the scroll, and stop when `has_more` is false. On the phone this
is `mobile/src/feed/feedEngine.ts`; on the web it is the "The feed" block of
`web/index.html`.

`GET /api/v1/search-suggestions?prefix=` scans the same `search:*` keys for
past queries starting with what has been typed, for the "recent searches"
dropdown in both clients.

When the browser renders the top few search results, it also fires
background `POST /api/v1/preview` calls for the top 3 (see "prewarming"
below) so clicking one feels instant instead of waiting on yt-dlp's full
extraction.

## Request flow 2 — previewing a video (clicking a result / pasting a link)

```
browser
   │  POST /api/v1/preview  { url }
   ▼
api → extractor: POST /api/v1/extract  { url }
   │  cache hit ("extract:<url>")?  → return cached JSON
   │  miss? → yt-dlp full extraction (needs Deno as JS runtime to
   │          decipher YouTube's signature scheme) → cache → return
   ▼
api → browser: { title, duration, formats: [...] }
```

This is the slow path (real extraction, not `extract_flat`), which is why
the UI prewarms it for likely-to-be-clicked results ahead of time and
caches it in Redis so a second click on the same video is instant.

## Request flow 3 — downloading

```
browser
   │ POST /api/v1/jobs  { url, format }
   ▼
api
   │ 1. validate URL (SSRF check: resolve DNS, reject private/loopback IPs)
   │ 2. call extractor /api/v1/extract again (to get fresh CDN URLs + all formats)
   │ 3. pick the requested format id, pair it with a matching audio-only
   │    format if the chosen video track has no audio (selectFormatPair)
   │ 4. INSERT a row into Postgres `jobs` (status=QUEUED)
   │ 5. nc.Publish("jobs.ready", jobPayload)   ← NATS
   ▼
api → browser: 202 Accepted, job record (status=QUEUED)

meanwhile, worker (subscribed to "jobs.ready"):
   │ 1. receives the job
   │ 2. POST downloader:8000/download  { media_url, audio_url, output path, ... }
   │    (holds this HTTP request open for up to 2h — it's synchronous)
   ▼
downloader (Rust)
   │ splits each stream into 1MiB byte-range granules, pulled by a shared
   │ work queue of parallel connections (up to 8, IDM-style — not fixed
   │ pre-sliced ranges), retries 5xx/429/403 automatically
   │ video-only + audio-only streams are downloaded independently, then
   │ muxed together with ffmpeg (-map, -shortest, -avoid_negative_ts) with
   │ live progress parsed from ffmpeg's `-progress pipe:1` output
   │ result: a finished file under /data/downloads (shared volume)
   ▼
worker: reads the downloader's terminal status (COMPLETED/CANCELLED/error)
   │ UPDATE jobs SET status = ... WHERE id = ...   ← Postgres
```

While this runs, the browser polls:

```
browser → GET /api/v1/jobs/:id/progress
   ▼
api → GET downloader:8000/downloads/:id/progress
   (falls back to the job's own status from Postgres if the downloader
    has no record — i.e. not started yet, or already finished)
   ▼
api → browser: { status, bytes_downloaded, bytes_total, speed_bytes_per_second, segments, mux_progress_percent }
```

The UI renders this as per-segment progress bars plus a distinct
"merging" phase once all segments finish and ffmpeg muxing starts.

Cancelling (`POST /api/v1/jobs/:id/cancel`) updates Postgres and publishes
`jobs.cancelled` on NATS — the worker/downloader watch for that and abort
in-flight chunk downloads.

## Request flow 4 — fetching the finished file

```
browser → GET /api/v1/jobs/:id/file
   ▼
api: job must be status=COMPLETED, else 409
   │ streams the bytes through from downloader:8000/files/<job_id>.<ext>
   │ (api never buffers the whole file — io.Copy straight to the response)
   ▼
api → browser: Content-Disposition: attachment; filename="<video title>.<ext>"
```

## Request flow 5 — playing (next, previous, autoplay, audio)

Playing a video makes no API call for the video itself: both clients embed
YouTube's player. What the app adds is a **queue**: the list a video was
opened from (the endless feed) becomes the playlist. Next / Previous step
through it and, at the end of what is loaded, ask the feed for the next page;
when a video ends and Autoplay is on, the next one starts. Previous restarts
the video if you are more than 3 s in. If another search replaces the list
meanwhile, the queue keeps going through the list playback started from.

On the phone only, audio can take over from the video:

```
phone (expo-audio)
   │  GET /api/v1/audio?url=<youtube url>
   ▼
api (audio.go)
   │  extractor /api/v1/extract → pick the best playable audio format
   │  (host must be an allowed YouTube CDN host) → proxy the bytes
   │  through, passing `Range` along so seeking works
   ▼
phone: plays it as a normal media session (lock-screen controls, keeps
       going with the screen off)
```

That happens either automatically (the app leaves the screen while a video
plays; it hands back to the video, at the right second, on return) or because
the user switched on **Audio only**, in which case audio stays on and follows
the queue when a track ends. The decision logic is in
`mobile/src/player/handoff.ts`, the queue in `mobile/src/player/queue.ts`.

## How the phone finds the server

The web UI shows a QR code containing the API's LAN address; the phone scans
it (camera) and remembers it. The API answers CORS for any origin and the app
is allowed cleartext HTTP, since the server lives on your own network.

## Getting the app to the phone

`./build-apk.sh` runs an EAS cloud build (build number auto-incremented,
version + commit embedded), downloads the APK into `web/app/` (git-ignored)
and updates `web/app/versions.json`; the web UI's 📱 panel lists those builds
with a download link and QR code.

## Why the pieces are split this way

- **extractor is isolated** because yt-dlp/YouTube-parsing logic changes
  often (YouTube tweaks its signing scheme) and needs Python + a JS
  runtime (Deno) — keeping it separate means that churn never touches the
  Rust downloader or Go API.
- **downloader is isolated and written in Rust** because it's the
  performance/reliability-critical path: parallel chunked HTTP with
  retries, SSRF-safe redirect handling, and CPU work (ffmpeg muxing)
  benefit from a language with cheap concurrency and no GC pauses.
- **api never does slow work itself** — it validates, delegates to
  extractor/downloader, and persists to Postgres. This is why job
  creation returns immediately (202) instead of blocking until the
  download finishes.
- **worker exists so the API can stay fast and stateless per-request** —
  the actual multi-hour download call happens off the request path, in a
  process that can be scaled independently of `api`.
- **NATS is deliberately used for exactly two events** (`jobs.ready`,
  `jobs.cancelled`) rather than as a general event bus — it's the minimum
  needed to decouple "a job was created" from "a job is being worked."
- **Redis caches are separate by prefix** (`extract:` vs `search:`) so a
  cached search-result list and a cached full-extraction result for the
  same video don't collide, and so `scan_values(prefix)` can cheaply
  aggregate just one kind of entry (used by `/api/v1/cached-searches`).
