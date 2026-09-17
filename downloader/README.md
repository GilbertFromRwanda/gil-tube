# Downloader

An async Rust (axum + tokio + reqwest) download worker. It streams a URL to
disk with resume support, retries transient failures with backoff, enforces
a maximum file size, and rejects path traversal in output filenames.

When the source server supports HTTP range requests and the file is large
enough to benefit, it downloads with `MAX_CHUNKS_PER_DOWNLOAD` persistent
worker connections pulling small (1 MiB) byte-range granules off a shared
queue, each writing directly to its offset in a pre-allocated file — IDM's
"dynamic file segmentation" idea: faster connections drain more granules
than slower ones, rather than every connection getting a fixed equal share
decided up front. A granule that fails mid-transfer resumes from its own
last-written byte on retry, not from the start of the granule. Below the
chunking size threshold, or when the server doesn't support ranges, it falls
back to a single resumable stream.

When a request includes `audio_url` (used when the selected video format has
no audio track — the common case on modern YouTube), it downloads both
streams and muxes them into the final file with `ffmpeg` (`-c copy`, no
re-encoding).

Every outbound URL — including redirect targets — is re-validated against
its *resolved* IP address to block SSRF, per `src/ssrf.rs`.

## HTTP API

```text
GET  /health
POST /download                        { job_id, url, output, audio_url? }
POST /downloads/:job_id/cancel
GET  /downloads/:job_id/progress
GET  /files/:filename                 streams a completed download
```

`output` must be a bare filename (no path separators, no `..`); it is joined
onto `DOWNLOAD_OUTPUT_DIR`.

## CLI mode (local testing)

```bash
cargo run -- --url https://example.com/file.bin --output ./target/demo.bin
```

## Key environment variables

| Variable | Default | Purpose |
|---|---|---|
| `DOWNLOAD_OUTPUT_DIR` | `/data/downloads` | Where completed files and the file-serving endpoint look |
| `MAX_GLOBAL_CONCURRENCY` | `8` | Max downloads running at once |
| `MAX_DOWNLOAD_BYTES` | 5 GiB | Hard cap per file |
| `MAX_CHUNKS_PER_DOWNLOAD` | `8` | Parallel range requests per stream (`1` disables chunking) |
