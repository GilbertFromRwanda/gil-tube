# How Gil Tube's components fit together

Gil Tube is six small services, each in its own container, plus a static
web page you open in a browser. Nothing talks to YouTube directly except
the extractor; nothing writes files to disk except the downloader. Here's
the wiring.

## The pieces

| Component      | Language           | Talks on          | Job |
|-----------------|--------------------|--------------------|-----|
| `web/`          | HTML/CSS/JS (static) | served on `:3000` by `start.sh` | Browser UI: search, preview, kick off downloads, show progress |
| `api/`          | Go (gin)           | `:8081` → container `:8080` | Front door. Validates requests, proxies to the extractor, writes jobs to Postgres, publishes to NATS, proxies file downloads/progress from the downloader |
| `extractor/`    | Python (Flask + yt-dlp, gunicorn) | `:9000` | Resolves a YouTube URL (or search query) into real, direct CDN media URLs via yt-dlp. Caches results in Redis |
| `downloader/`   | Rust (axum)        | `:8000` | Actually fetches the media bytes from the CDN URL(s), in parallel byte-range chunks, muxes video+audio with ffmpeg, serves the finished file |
| `worker/`       | Go                 | no inbound port | Listens for `jobs.ready` on NATS, calls the downloader synchronously, writes the terminal status back to Postgres |
| `postgres`      | Postgres 16        | `:5432` | Source of truth for job records (`jobs` table) |
| `redis`         | Redis 7            | `:6379` | Cache for extraction/search results (`extract:*`, `search:*` keys) |
| `nats`          | NATS 2.10 (JetStream flag on) | `:4222` (`:8222` monitoring) | Message bus between `api` and `worker` — just two subjects: `jobs.ready`, `jobs.cancelled` |

All of this is defined in [docker-compose.yml](docker-compose.yml) and
brought up together by [start.sh](start.sh), which also serves `web/` and
waits on each service's `/health` before opening the browser.

## Request flow 1 — searching / browsing

```
browser (web/index.html)
   │  POST /api/v1/search  { query }
   ▼
api (Go)
   │  forwards to extractor, unchanged
   ▼
extractor (Python)
   │  cache hit?  → return cached JSON (Redis, prefix "search:")
   │  cache miss? → yt-dlp `ytsearchN:<query>` (extract_flat, fast) → cache it (TTL 6h) → return
   ▼
api → browser: list of {id, title, thumbnail, duration, ...}
```

`GET /api/v1/cached-searches` is a variant of this: the extractor scans all
`search:*` Redis keys, flattens/dedupes the videos across every past query,
and returns a page of them (`offset`/`limit`) — this is what the browser
loads on first paint and on infinite scroll, before the user has typed
anything.

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
