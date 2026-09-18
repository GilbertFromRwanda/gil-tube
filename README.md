# Gil Tube

Gil Tube is a monorepo for a self-hosted YouTube media download platform. The repository follows the production build planner and starts with a working foundation for the API, extraction layer, downloader, and UI.

## Repository layout

- `api/` — Go HTTP API and job orchestration
- `extractor/` — Python metadata extraction service
- `downloader/` — Rust download worker
- `web/` — minimal browser UI
- `mobile/` — React Native (Expo) client for iOS/Android
- `shared/` — JSON schema and shared contracts
- `infra/` — deployment assets later added as the system matures

## Quick start

```bash
./start.sh
```

This builds and starts every backend service with `docker compose`, waits for
them to become healthy, then serves the web UI at http://localhost:3000 and
opens it in your browser. Pass `--no-open` to skip the browser launch. Press
`Ctrl+C` to stop the web server; run `docker compose down` to stop the
backend too.

### Manual / per-service (for development)

1. Start everything with Docker Compose directly:
   ```bash
   docker compose up -d --build
   ```
2. Or run a single service against your own toolchain instead of its
   container, e.g.:
   ```bash
   make api          # cd api && go run .
   make extractor    # cd extractor && python main.py
   make downloader   # cd downloader && cargo run -- --url ... --output ...
   make web          # cd web && python -m http.server 3000
   ```

## Default ports

- API: http://localhost:8081
- Extractor: http://localhost:9000
- Web: http://localhost:3000
- Postgres: localhost:5432
- Redis: localhost:6379
- NATS: localhost:4222

## Current implementation status

This repository is intentionally a working foundation rather than a full production product.

- API exposes health, preview, and job lifecycle routes, with SSRF-safe URL
  validation, a structured error envelope, and a CORS policy for the web UI.
- Extractor uses real `yt-dlp` extraction with SSRF protection, a Redis (or
  in-memory) cache, and normalized error codes.
- Downloader is an async Rust service that streams downloads with resume,
  retries with backoff, a maximum size limit, path-traversal protection, and
  optional parallel chunked/ranged downloading (IDM-style) when the source
  server supports HTTP range requests. When the selected video format has no
  audio track (the common case on modern YouTube), it downloads a paired
  audio stream and muxes them with `ffmpeg`.
- Web UI: paste a URL, preview the video (embed, title, duration, format
  list), start a download, watch live progress, then save the finished file.
- CI and local test commands are wired through the root `Makefile`.

## Web UI flow

1. Open `web/index.html` (e.g. `make web`, served at http://localhost:3000).
2. Paste a URL and click **Load** — this calls `POST /api/v1/preview`, which
   runs extraction without creating a job, so you can see what you're about
   to download first.
3. Pick a format (or leave "Best available") and click **Download** — this
   calls `POST /api/v1/jobs`, which creates the job and hands it to the
   worker/downloader pipeline.
4. The page polls `GET /api/v1/jobs/:id` and `GET /api/v1/jobs/:id/progress`
   once a second to show live status, a progress bar, and download speed.
5. When the job reaches `COMPLETED`, a **Save file** link appears, backed by
   `GET /api/v1/jobs/:id/file`, which streams the finished file from the
   downloader's storage through the API.

## Mobile app

`mobile/` is an Expo (React Native + TypeScript) client that talks to the
same `api` service — search, preview, pick a format, download with live
progress, and save/share the finished file. See
[mobile/README.md](mobile/README.md) for setup; a phone can't reach
`localhost`, so the API address is set from the app's Settings screen.

## Key environment variables

| Service | Variable | Purpose |
|---|---|---|
| api | `EXTRACTOR_URL`, `DOWNLOADER_URL` | Upstream service addresses |
| api | `ALLOWED_ORIGIN` | CORS origin allowed to call the API (default `http://localhost:3000`) |
| extractor | `REDIS_URL` | Extraction cache backend; falls back to in-memory if unset/unreachable |
| downloader | `MAX_CHUNKS_PER_DOWNLOAD` | Parallel range requests per stream when the server supports it (default 8) |
| downloader | `MAX_DOWNLOAD_BYTES`, `MAX_GLOBAL_CONCURRENCY` | Size cap and concurrent-download limit |

## Security note

This project is designed to respect platform access controls, copyright, privacy, and contract requirements. It intentionally does not include bypass features or unauthorized download logic.
