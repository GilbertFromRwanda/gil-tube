# YouTube Downloader(Gil-tube) — Production Build Planner

> **Goal:** Build a maintainable, observable, high-performance media-download platform with a clear separation between extraction, download execution, API orchestration, storage, and UI.
>
> **Principle:** Ship a working end-to-end path first. Optimize only after measuring real bottlenecks.
>
> **Important:** Only download content you are authorized to download and design the service to respect applicable platform terms, copyright, privacy, and access controls. Do not build features intended to bypass authentication, paywalls, DRM, or other access restrictions.

---

## 1. Project Overview

### Product

A self-hosted service consisting of:

- Web application
- REST API
- Real-time job progress
- CLI
- Media extraction service
- High-throughput download worker
- Persistent job history
- Object/file storage
- Metrics, logs, tracing, and alerts

### Initial target

| Area | MVP | Production |
|---|---:|---:|
| Concurrent jobs | 10–50 | 1,000+ |
| API instances | 1 | Horizontal scaling |
| Downloader workers | 1 | Horizontal scaling |
| Storage | Local disk | S3-compatible object storage |
| Queue | Redis Streams | NATS JetStream |
| Database | PostgreSQL | PostgreSQL + read replicas if needed |
| Observability | Logs | Metrics + logs + traces |
| Auth | Optional | API keys / accounts |
| Deployment | Docker Compose | Containers + orchestrator |

### Recommended timeline

- **MVP:** 2 weeks
- **Production foundation:** 4–6 weeks
- **Full product:** 8 weeks

Do not treat the timeline as a hard deadline. Use milestone acceptance criteria instead.

---

# 2. Architecture

```text
                    ┌─────────────────────┐
                    │      Web / CLI      │
                    └──────────┬──────────┘
                               │ HTTPS
                               ▼
                    ┌─────────────────────┐
                    │      Go API         │
                    │ Auth / Rate Limit   │
                    │ Jobs / Progress     │
                    └───────┬─────┬───────┘
                            │     │
                  Job event │     │ metadata request
                            ▼     ▼
                    ┌──────────┐ ┌──────────────┐
                    │  Queue   │ │ PostgreSQL   │
                    │ NATS     │ │ Job metadata │
                    └────┬─────┘ └──────────────┘
                         │
              ┌──────────┴──────────┐
              ▼                     ▼
     ┌────────────────┐    ┌────────────────┐
     │ Python         │    │ Rust           │
     │ Extractor      │    │ Downloader     │
     │ yt-dlp         │    │ Tokio/Reqwest  │
     └───────┬────────┘    └───────┬────────┘
             │                     │
             │ metadata            │ media
             ▼                     ▼
        ┌─────────┐          ┌───────────────┐
        │ Redis   │          │ Object Store  │
        │ Cache   │          │ S3/MinIO/R2   │
        └─────────┘          └───────┬───────┘
                                    │
                                    ▼
                              Signed download
```

## Service ownership

| Component | Language | Responsibility |
|---|---|---|
| API | Go | HTTP API, authentication, rate limits, job lifecycle |
| Extractor | Python | Metadata and available formats |
| Downloader | Rust | Concurrent HTTP downloading, resume, retries |
| Web | TypeScript | User interface |
| Worker orchestration | NATS | Reliable asynchronous job delivery |
| Database | PostgreSQL | Durable metadata and job state |
| Cache | Redis | Short-lived state and cache |
| Media storage | S3/MinIO/R2 | Large files |
| Media processing | FFmpeg | Container/format processing |

**Rule:** Each service should have one clear responsibility. Avoid putting business logic into the queue or UI.

---

# 3. Repository Structure

```text
gil-tube/
├── api/                    # Go API
├── extractor/              # Python extraction service
├── downloader/             # Rust downloader
├── web/                    # Web UI
├── worker/                 # Optional orchestration logic
├── shared/
│   ├── schemas/             # OpenAPI / JSON schemas
│   └── test-fixtures/
├── infra/
│   ├── docker/
│   ├── compose/
│   ├── k8s/
│   └── monitoring/
├── scripts/
├── docs/
├── tests/
│   ├── integration/
│   ├── e2e/
│   └── load/
├── .github/workflows/
├── .editorconfig
├── .gitignore
├── Makefile
└── README.md
```

---

# 4. Phase 0 — Foundation

**Duration:** Days 1–3

## Goals

- Create a reproducible development environment.
- Define service boundaries.
- Define contracts before implementation.
- Make CI work immediately.

## Checklist

- [ ] Create Git repository.
- [ ] Create monorepo structure.
- [ ] Add `.gitignore` and `.editorconfig`.
- [ ] Add `Makefile` or `justfile`.
- [ ] Add Docker Compose.
- [ ] Install:
  - [ ] Go
  - [ ] Rust
  - [ ] Python
  - [ ] Node/Bun
  - [ ] FFmpeg
- [ ] Add PostgreSQL.
- [ ] Add Redis.
- [ ] Add NATS JetStream.
- [ ] Add health-check endpoints.
- [ ] Add GitHub Actions.
- [ ] Add formatting/linting.
- [ ] Add unit-test commands.
- [ ] Define API schemas.
- [ ] Define job states.
- [ ] Write architecture documentation.

## Standard job states

```text
QUEUED
  ↓
EXTRACTING
  ↓
READY
  ↓
DOWNLOADING
  ↓
PROCESSING
  ↓
COMPLETED

Failure from any stage:
  ↓
FAILED

User cancellation:
  ↓
CANCELLED
```

## Deliverable

```bash
docker compose up -d
```

starts all development dependencies and every service exposes a health endpoint.

### Acceptance criteria

- [ ] Fresh checkout can start without manual database setup.
- [ ] CI passes.
- [ ] Every service has `/health`.
- [ ] API can create a test job.

---

# 5. Phase 1 — Extraction MVP

**Duration:** Week 1

## Goals

Return reliable metadata and an explicit list of available formats.

## Checklist

- [ ] Build Python extractor around `yt-dlp`.
- [ ] Define request/response schema.
- [ ] Add `POST /extract`.
- [ ] Validate and normalize URLs.
- [ ] Return:
  - [ ] title
  - [ ] duration
  - [ ] thumbnail
  - [ ] uploader/channel when available
  - [ ] formats
  - [ ] codec
  - [ ] container
  - [ ] resolution
  - [ ] bitrate
  - [ ] filesize when available
- [ ] Normalize extractor errors.
- [ ] Handle unsupported/private/unavailable/live cases explicitly.
- [ ] Add Redis cache.
- [ ] Cache key should include normalized URL and relevant extraction options.
- [ ] Add timeout and cancellation.
- [ ] Add structured logs.
- [ ] Add unit tests.
- [ ] Add integration tests with controlled fixtures.
- [ ] Pin and regularly update extractor dependencies.

## API example

```http
POST /api/v1/extract
Content-Type: application/json

{
  "url": "https://www.youtube.com/watch?v=..."
}
```

Response:

```json
{
  "id": "ext_123",
  "title": "Example",
  "duration": 312,
  "formats": [
    {
      "id": "137",
      "container": "mp4",
      "video_codec": "avc1",
      "audio_codec": null,
      "height": 1080,
      "fps": 30
    }
  ]
}
```

## Acceptance criteria

- [ ] 95%+ success on a maintained, authorized test corpus.
- [ ] Timeout does not leave orphaned processes.
- [ ] Invalid URLs return useful errors.
- [ ] Cached extraction is substantially faster than uncached extraction.

---

# 6. Phase 2 — Rust Downloader

**Duration:** Week 2

## Goals

Build a robust downloader before trying to maximize raw speed.

## Checklist

- [ ] Create Rust workspace.
- [ ] Use Tokio.
- [ ] Use Reqwest.
- [ ] Implement HTTP streaming.
- [ ] Detect server Range support.
- [ ] Implement optional ranged/chunked downloading.
- [ ] Limit concurrency per job.
- [ ] Limit global concurrency.
- [ ] Track bytes downloaded.
- [ ] Track throughput.
- [ ] Resume interrupted downloads.
- [ ] Write atomic temporary files.
- [ ] Retry transient network errors.
- [ ] Exponential backoff + jitter.
- [ ] Enforce maximum file size.
- [ ] Enforce request timeouts.
- [ ] Validate final file size/checksum where available.
- [ ] Gracefully cancel jobs.
- [ ] Prevent path traversal in output paths.
- [ ] Integrate FFmpeg only when processing is required.

## Important performance rule

Do **not** assume 32 connections is faster than 8.

Benchmark:

```text
1 connection
2 connections
4 connections
8 connections
16 connections
32 connections
```

Measure:

- Download time
- Throughput
- CPU
- RAM
- Server-side throttling
- Failure/retry rate

## Acceptance criteria

Example benchmark target:

```text
100 MB test object
1 Gbps local/network environment

Record:
- single connection time
- 4 connection time
- 8 connection time
- 16 connection time
```

The result should be based on measurements, not a fixed promise such as "10x faster."

---

# 7. Phase 3 — Job API

**Duration:** Week 3

## Goals

Create a durable asynchronous job system.

## Endpoints

```text
POST   /api/v1/jobs
GET    /api/v1/jobs/:id
POST   /api/v1/jobs/:id/cancel
GET    /api/v1/jobs/:id/events
GET    /api/v1/downloads/:id
GET    /api/v1/health
GET    /api/v1/ready
```

## Job submission

```json
{
  "url": "https://www.youtube.com/watch?v=...",
  "format": "1080p",
  "container": "mp4"
}
```

Response:

```json
{
  "job_id": "job_01...",
  "status": "QUEUED"
}
```

## Checklist

- [ ] Go API.
- [ ] OpenAPI specification.
- [ ] PostgreSQL migrations.
- [ ] Job table.
- [ ] Idempotency key support.
- [ ] Queue publishing.
- [ ] Worker acknowledgement.
- [ ] Retry policy.
- [ ] Dead-letter strategy.
- [ ] Job cancellation.
- [ ] SSE or WebSocket progress.
- [ ] Authentication.
- [ ] Rate limiting.
- [ ] Request size limits.
- [ ] Structured logging.
- [ ] Correlation/request IDs.

## Acceptance criteria

- [ ] Duplicate submission with the same idempotency key does not create duplicate jobs.
- [ ] Restarting the API does not lose durable jobs.
- [ ] A failed worker can be retried safely.
- [ ] Job progress survives API restarts.

---

# 8. Phase 4 — Processing and Media Pipeline

**Duration:** Week 4

## Goals

Separate download from media processing.

```text
Extract
   ↓
Select format
   ↓
Download
   ↓
Validate
   ↓
Merge/remux/transcode if required
   ↓
Store
   ↓
Publish completed event
```

## Checklist

- [ ] Define processing profiles.
- [ ] FFmpeg wrapper.
- [ ] Process timeout.
- [ ] CPU/memory limits.
- [ ] Temporary workspace per job.
- [ ] Validate output.
- [ ] Capture FFmpeg stderr.
- [ ] Cleanup temporary files.
- [ ] Store final artifact.
- [ ] Generate metadata for final artifact.

## Security

- [ ] Never execute user-provided shell commands.
- [ ] Pass FFmpeg arguments as structured arguments.
- [ ] Sanitize filenames.
- [ ] Use isolated temporary directories.
- [ ] Limit process resources.
- [ ] Run workers with minimal filesystem permissions.

---

# 9. Phase 5 — Reliability and Compatibility

**Duration:** Week 4–5

Instead of designing around bypassing platform protections, build a compatibility layer that handles normal extractor evolution safely.

## Checklist

- [ ] Dependency version management.
- [ ] Automated dependency update process.
- [ ] Extraction health checks.
- [ ] Controlled compatibility tests.
- [ ] Clear unsupported-content errors.
- [ ] Circuit breaker for repeated failures.
- [ ] Per-host timeout policy.
- [ ] Retry only transient failures.
- [ ] Do not retry permanent authorization/access errors indefinitely.
- [ ] Feature flags for experimental extractors.

## Acceptance criteria

- [ ] Extractor failure is visible in metrics.
- [ ] Broken dependencies fail health checks.
- [ ] Failed jobs do not create infinite retry loops.
- [ ] Unsupported content receives a deterministic error.

---

# 10. Phase 6 — Web UI

**Duration:** Week 5

## Goals

Make the complete workflow usable.

## Screens

```text
Home
 ├── URL input
 ├── Format selection
 └── Download

Job
 ├── Extraction
 ├── Download progress
 ├── Processing progress
 ├── Speed
 ├── ETA
 └── Result

History
 ├── Completed
 ├── Failed
 └── Cancelled

Settings
 ├── Language
 ├── Theme
 └── Download preferences
```

## Checklist

- [ ] TypeScript.
- [ ] Responsive UI.
- [ ] URL validation.
- [ ] Format selection.
- [ ] Progress updates.
- [ ] Error display.
- [ ] Cancel button.
- [ ] Download result.
- [ ] History.
- [ ] Dark mode.
- [ ] Accessibility.
- [ ] i18n.
- [ ] PWA only after the core UX is stable.

## Acceptance criteria

- [ ] Complete download flow works on desktop and mobile.
- [ ] No page refresh is required during a job.
- [ ] Errors are understandable.
- [ ] Core UI passes accessibility checks.

---

# 11. Phase 7 — Storage and Caching

**Duration:** Week 6

## Storage architecture

```text
PostgreSQL
    │
    ├── jobs
    ├── artifacts
    ├── users
    └── audit events

Redis
    │
    ├── short-lived cache
    ├── progress snapshots
    └── rate-limit state

Object Storage
    │
    └── media files
```

## Checklist

- [ ] MinIO/S3-compatible storage.
- [ ] Object key strategy.
- [ ] Content metadata.
- [ ] Signed download URLs.
- [ ] Expiration policy.
- [ ] Cleanup worker.
- [ ] Storage quotas.
- [ ] Deduplication policy.
- [ ] Cache invalidation.
- [ ] Maximum object size.
- [ ] Disk/storage monitoring.

## Suggested object key

```text
media/{content_hash}/{artifact_id}.{ext}
```

Never use a raw user-provided filename as the storage path.

---

# 12. Phase 8 — Observability

**Duration:** Week 6–7

Observability should be added before large-scale load testing.

## Metrics

### API

```text
http_requests_total
http_request_duration_seconds
http_requests_in_flight
```

### Jobs

```text
jobs_created_total
jobs_completed_total
jobs_failed_total
jobs_cancelled_total
job_duration_seconds
queue_depth
```

### Downloader

```text
download_bytes_total
download_duration_seconds
download_speed_bytes_per_second
download_retries_total
active_downloads
```

### Extractor

```text
extract_requests_total
extract_failures_total
extract_duration_seconds
extract_cache_hits_total
```

### Storage

```text
storage_bytes_used
artifact_count
cleanup_deleted_total
```

## Logs

Use structured JSON:

```json
{
  "level": "info",
  "service": "downloader",
  "job_id": "job_123",
  "event": "download_completed",
  "duration_ms": 8421,
  "bytes": 104857600
}
```

## Tracing

Use OpenTelemetry when cross-service debugging becomes necessary:

```text
API
 ↓
Queue
 ↓
Extractor
 ↓
Downloader
 ↓
FFmpeg
 ↓
Storage
```

---

# 13. Phase 9 — Security

Security is a product requirement, not a final-week task.

## API security

- [ ] HTTPS.
- [ ] Authentication.
- [ ] Per-user/API-key rate limits.
- [ ] IP-based abuse controls.
- [ ] Request body limits.
- [ ] URL validation.
- [ ] SSRF protection.
- [ ] Timeouts.
- [ ] CORS policy.
- [ ] Security headers.
- [ ] Secrets stored outside source code.

## Worker security

- [ ] Non-root containers.
- [ ] Read-only filesystem where practical.
- [ ] CPU limits.
- [ ] Memory limits.
- [ ] Process limits.
- [ ] Temporary-directory isolation.
- [ ] Network egress controls where practical.
- [ ] No arbitrary command execution.
- [ ] No user-controlled output paths.

## SSRF protection

Because users submit URLs, explicitly defend against requests to:

```text
localhost
127.0.0.1
::1
private IPv4 ranges
link-local addresses
cloud metadata endpoints
internal DNS names
```

Validate after DNS resolution as well as before it, and account for redirects.

---

# 14. Phase 10 — Testing

## Testing pyramid

```text
                 ┌─────────────┐
                 │     E2E     │
                 └──────┬──────┘
                ┌───────┴───────┐
                │  Integration  │
                └───────┬───────┘
           ┌────────────┴────────────┐
           │        Unit tests       │
           └─────────────────────────┘
```

## Targets

| Layer | Tool | Initial target |
|---|---|---:|
| Python | pytest | 85%+ |
| Rust | cargo test + proptest | 85%+ |
| Go | `go test` | 80%+ |
| Web | Vitest | 80%+ |
| E2E | Playwright | Critical paths |
| Load | k6 | Defined scenarios |
| Security | OWASP tooling/manual | Critical paths |

Coverage is a signal, not the definition of quality.

## Required test scenarios

- [ ] Invalid URL.
- [ ] Unsupported content.
- [ ] Extraction timeout.
- [ ] Download timeout.
- [ ] Network interruption.
- [ ] Resume after interruption.
- [ ] Worker restart.
- [ ] API restart.
- [ ] Duplicate job.
- [ ] Cancellation.
- [ ] Storage failure.
- [ ] FFmpeg failure.
- [ ] Disk/storage full.
- [ ] Concurrent jobs.
- [ ] Large file.
- [ ] Malicious filename.
- [ ] SSRF attempt.

---

# 15. Phase 11 — Load Testing

**Duration:** Week 7

Do not start with "10,000 concurrent downloads."

Separate API load from bandwidth-heavy media workloads.

## Scenario A — API load

```text
1,000 concurrent clients
mostly job creation/status requests
```

Measure:

- RPS
- P50
- P95
- P99
- CPU
- RAM
- PostgreSQL connections
- Redis latency

## Scenario B — Worker load

```text
10
25
50
100
250
```

active download jobs.

Measure:

- Aggregate bandwidth
- Per-job throughput
- CPU
- RAM
- Queue depth
- Retry rate
- Completion rate

## Scenario C — Failure test

Inject:

- Network failures
- Worker restarts
- Storage failures
- Queue restarts
- Database connection failures

### Acceptance criteria

Define limits before testing:

```text
P95 API latency < X ms
error rate < X%
queue recovery < X seconds
no lost durable jobs
no corrupted completed artifacts
```

Replace `X` with values based on your deployment capacity.

---

# 16. Phase 12 — Deployment

## Development

```text
Docker Compose
```

## Staging

```text
Container registry
       ↓
Single-node deployment
       ↓
PostgreSQL
Redis
NATS
Object storage
Monitoring
```

## Production

Scale independently:

```text
              Load Balancer
                    │
          ┌─────────┴─────────┐
          ▼                   ▼
       API #1              API #2
          │                   │
          └─────────┬─────────┘
                    ▼
                 NATS
          ┌─────────┼─────────┐
          ▼         ▼         ▼
      Worker #1 Worker #2 Worker #N
                    │
                    ▼
               Object Store
```

Only introduce Kubernetes when operational complexity is justified.

---

# 17. Database Design

## `jobs`

```text
id
user_id
source_url
normalized_url
status
requested_format
requested_container
progress
bytes_total
bytes_downloaded
error_code
error_message
created_at
started_at
completed_at
```

## `artifacts`

```text
id
job_id
object_key
filename
mime_type
size_bytes
checksum
created_at
expires_at
```

## `job_events`

```text
id
job_id
event_type
payload
created_at
```

### Important indexes

```text
jobs(status, created_at)
jobs(user_id, created_at)
artifacts(job_id)
job_events(job_id, created_at)
```

Add indexes only according to actual query patterns.

---

# 18. Queue Design

## Message

```json
{
  "job_id": "job_123",
  "type": "download",
  "attempt": 1,
  "created_at": "2026-09-17T09:00:00Z"
}
```

## Reliability rules

- [ ] At-least-once delivery is assumed.
- [ ] Workers must be idempotent.
- [ ] Acknowledgement happens only after durable progress.
- [ ] Retry transient failures.
- [ ] Dead-letter permanent failures.
- [ ] Include attempt number.
- [ ] Add visibility/lease timeout where applicable.
- [ ] Never depend on in-memory queue state for durable jobs.

---

# 19. Redis Usage

Use Redis for short-lived state, not as the source of truth for completed jobs.

Good uses:

```text
format-cache:{hash}
rate-limit:{key}
progress:{job_id}
```

Avoid putting the only copy of important job metadata in Redis.

---

# 20. API Versioning

Start with:

```text
/api/v1/
```

Example:

```text
POST /api/v1/jobs
GET  /api/v1/jobs/:id
POST /api/v1/jobs/:id/cancel
GET  /api/v1/jobs/:id/events
```

Never make breaking changes to `/api/v1` silently.

---

# 21. Error Model

Use stable machine-readable error codes.

```json
{
  "error": {
    "code": "EXTRACTION_TIMEOUT",
    "message": "The source could not be processed before the timeout.",
    "retryable": true,
    "request_id": "req_123"
  }
}
```

Example codes:

```text
INVALID_URL
UNSUPPORTED_SOURCE
CONTENT_UNAVAILABLE
EXTRACTION_TIMEOUT
EXTRACTION_FAILED
FORMAT_UNAVAILABLE
DOWNLOAD_TIMEOUT
DOWNLOAD_FAILED
PROCESSING_FAILED
STORAGE_FAILED
JOB_CANCELLED
RATE_LIMITED
```

---

# 22. MVP Scope

## Build first

### Week 1

- [ ] Go API skeleton
- [ ] Python extractor
- [ ] PostgreSQL
- [ ] Redis
- [ ] One working extraction flow

### Week 2

- [ ] Rust downloader
- [ ] One working download flow
- [ ] Basic FFmpeg integration
- [ ] Basic web UI
- [ ] End-to-end job

### MVP definition

```text
URL
 ↓
API
 ↓
Extractor
 ↓
Format selection
 ↓
Downloader
 ↓
FFmpeg if required
 ↓
Local file
 ↓
Download response
```

**Do not add Kubernetes, billing, browser extensions, multi-region infrastructure, or advanced analytics before this flow is reliable.**

---

# 23. Production Scope

After MVP:

- [ ] NATS JetStream
- [ ] Object storage
- [ ] Authentication
- [ ] Rate limiting
- [ ] Job history
- [ ] Resume
- [ ] Cancellation
- [ ] Observability
- [ ] Automated cleanup
- [ ] Security hardening
- [ ] Load testing
- [ ] Staging deployment
- [ ] Disaster recovery
- [ ] Backup/restore testing

---

# 24. Optional Features

Only after the core platform is stable:

- [ ] Playlist workflows
- [ ] Subtitle handling
- [ ] Multiple source providers
- [ ] Browser extension
- [ ] Mobile PWA improvements
- [ ] User accounts
- [ ] Usage quotas
- [ ] Billing
- [ ] Public API
- [ ] Multi-region deployment

---

# 25. Legal and Product Controls

- [ ] Publish Terms of Service.
- [ ] Publish privacy policy.
- [ ] Explain acceptable use.
- [ ] Provide copyright/contact process appropriate to your jurisdiction.
- [ ] Respect platform terms.
- [ ] Do not advertise unauthorized copyrighted-content redistribution.
- [ ] Define file retention.
- [ ] Define account/data deletion.
- [ ] Avoid storing source credentials.
- [ ] Keep an abuse-reporting process.

Legal requirements vary by jurisdiction; obtain professional advice before operating a public service.

---

# 26. Observability Dashboard

Create these Grafana panels:

### API

```text
Requests/sec
P50 latency
P95 latency
P99 latency
5xx rate
Active requests
```

### Queue

```text
Queue depth
Oldest job age
Jobs/sec
Retry count
Dead-letter count
```

### Workers

```text
Active workers
Active jobs
Download throughput
CPU
RAM
Failure rate
```

### Storage

```text
Used storage
Free storage
Files created
Files deleted
Cleanup failures
```

### Database

```text
Connections
Transactions/sec
Slow queries
Cache hit ratio
Locks
Disk usage
```

---

# 27. Definition of Done

A phase is complete only when:

- [ ] Code is merged.
- [ ] Tests pass.
- [ ] CI passes.
- [ ] Logs are available.
- [ ] Metrics exist for important operations.
- [ ] Failure paths are tested.
- [ ] Documentation is updated.
- [ ] Security implications are reviewed.
- [ ] Acceptance criteria are met.
- [ ] Staging deployment succeeds where applicable.
- [ ] Demo or evidence is recorded.

---

# 28. Weekly Milestones

| Week | Milestone | Exit condition |
|---|---|---|
| 0 | Foundation | All services start locally |
| 1 | Extraction | Metadata/format API works |
| 2 | Downloader | Reliable file download + resume |
| 3 | Job API | Durable asynchronous jobs |
| 4 | Processing | Download → process → artifact |
| 5 | Web UI | Complete user workflow |
| 6 | Storage | Object storage + cleanup |
| 7 | Observability | Metrics/logs/load tests |
| 8 | Production | Security + staging + runbook |

---

# 29. Toolchain

## Languages

```text
Go
Rust
Python
TypeScript
```

Use the current stable versions supported by your dependencies rather than locking this planner to old minor versions.

## Core libraries

```text
Go:
  HTTP framework
  PostgreSQL driver
  NATS client
  OpenTelemetry

Rust:
  Tokio
  Reqwest
  Serde
  Tracing

Python:
  yt-dlp
  FastAPI or gRPC framework
  pytest

Web:
  TypeScript
  SvelteKit or another chosen frontend framework
```

## Infrastructure

```text
Docker
PostgreSQL
Redis
NATS JetStream
S3-compatible storage
FFmpeg
Prometheus
Grafana
OpenTelemetry
```

---

# 30. Project Commands

Define one command interface for the whole repository:

```bash
make dev
make test
make lint
make format
make build
make integration
make e2e
make load
make docker-build
make clean
```

The same commands should work locally and in CI whenever practical.

---

# 31. First 10 Tasks

Do these in order:

1. [ ] Create repository.
2. [ ] Create monorepo directories.
3. [ ] Create Docker Compose.
4. [ ] Start PostgreSQL, Redis, and NATS.
5. [ ] Create Go API `/health`.
6. [ ] Create Python extractor `/health`.
7. [ ] Implement `POST /api/v1/extract`.
8. [ ] Create Rust downloader CLI.
9. [ ] Download one authorized test file end-to-end.
10. [ ] Connect the API → extractor → downloader flow.

---

# 32. What NOT to Optimize Yet

Do not spend early development time on:

- Kubernetes
- Multi-region deployment
- CDN optimization
- GPU transcoding
- Complex billing
- Browser extension
- 10,000 concurrent downloads
- Exotic caching
- Custom database sharding
- Premature microservices

First prove:

```text
correctness
   ↓
reliability
   ↓
observability
   ↓
performance
   ↓
scale
```

---

# 33. Final Engineering Principles

### 1. End-to-end first

```text
One URL → One successful artifact
```

### 2. Measure before optimizing

Never assume concurrency, caching, or a particular language is faster.

### 3. Durable state belongs in PostgreSQL/object storage

Redis and in-memory state should be treated as accelerators.

### 4. Workers must be restart-safe

A worker crash must not corrupt the job system.

### 5. Every external dependency can fail

Design explicit timeout, retry, cancellation, and failure behavior.

### 6. Security starts at the URL input

A URL downloader is also a potential SSRF and resource-exhaustion surface.

### 7. Scale independently

API, extraction, download, processing, and storage have different bottlenecks.

### 8. Keep the polyglot architecture justified

Use each language where it provides a concrete advantage:

```text
Go       → API / orchestration
Python   → extraction ecosystem
Rust     → high-throughput downloader
TypeScript → user interface
FFmpeg   → media processing
```

### 9. Production means recovery

A production system is not finished when the happy path works. It is finished when failures are observable, bounded, and recoverable.

---

# 34. Immediate Next Step

Start with:

```text
Phase 0
   ↓
Go API
   ↓
Python extractor
   ↓
Rust downloader
   ↓
One end-to-end authorized download
```

Then add queueing, persistent jobs, storage, UI, and scale **one layer at a time**.

> **Rule: Working end-to-end beats perfect architecture. Reliable beats fast. Measured beats assumed.**
