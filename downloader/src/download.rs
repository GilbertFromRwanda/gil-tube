use futures_util::StreamExt;
use rand::Rng;
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::fs;
use tokio::io::{AsyncSeekExt, AsyncWriteExt};
use tokio::sync::{Mutex, RwLock, Semaphore};

use crate::ssrf;

const MAX_ATTEMPTS: u32 = 5;
const STALL_TIMEOUT: Duration = Duration::from_secs(30);

pub struct AppState {
    pub client: Client,
    pub semaphore: Arc<Semaphore>,
    pub jobs: RwLock<HashMap<String, Arc<JobHandle>>>,
    pub output_dir: PathBuf,
    pub max_download_bytes: u64,
    /// Number of parallel range requests to split a single stream into when
    /// the server supports it (IDM-style segmented downloading). 1 disables
    /// chunking and always uses the plain sequential/resumable path.
    pub max_chunks_per_download: usize,
}

impl AppState {
    pub fn new(
        output_dir: PathBuf,
        max_global_concurrency: usize,
        max_download_bytes: u64,
        max_chunks_per_download: usize,
    ) -> Self {
        Self {
            client: build_http_client(),
            semaphore: Arc::new(Semaphore::new(max_global_concurrency.max(1))),
            jobs: RwLock::new(HashMap::new()),
            output_dir,
            max_download_bytes,
            max_chunks_per_download: max_chunks_per_download.max(1),
        }
    }
}

pub struct JobHandle {
    pub bytes_downloaded: AtomicU64,
    pub bytes_total: AtomicI64, // -1 = unknown
    pub cancelled: AtomicBool,
    pub status: RwLock<String>,
    pub started_at: Instant,
    /// Per-connection bytes downloaded so far in the current phase (one
    /// entry per worker when chunked, a single entry when sequential).
    /// Reset at the start of each phase (video stream, then audio stream).
    pub segments: RwLock<Vec<u64>>,
    /// 0-100 while `status` is "MUXING"; meaningless otherwise.
    pub mux_progress_percent: AtomicU64,
}

impl JobHandle {
    fn new() -> Self {
        Self {
            bytes_downloaded: AtomicU64::new(0),
            bytes_total: AtomicI64::new(-1),
            cancelled: AtomicBool::new(false),
            status: RwLock::new("DOWNLOADING".to_string()),
            started_at: Instant::now(),
            segments: RwLock::new(Vec::new()),
            mux_progress_percent: AtomicU64::new(0),
        }
    }

    async fn reset_segments(&self, count: usize) {
        *self.segments.write().await = vec![0u64; count];
    }

    async fn add_segment_bytes(&self, index: usize, bytes: u64) {
        let mut segments = self.segments.write().await;
        if let Some(slot) = segments.get_mut(index) {
            *slot += bytes;
        }
    }

    async fn set_status(&self, status: &str) {
        *self.status.write().await = status.to_string();
    }
}

fn build_http_client() -> Client {
    let policy = reqwest::redirect::Policy::custom(|attempt| {
        let url = attempt.url();
        if url.scheme() != "http" && url.scheme() != "https" {
            return attempt.error("redirect to disallowed scheme");
        }
        let host = match url.host_str() {
            Some(h) => h.to_string(),
            None => return attempt.error("redirect missing host"),
        };
        let port = url.port_or_known_default().unwrap_or(443);
        if attempt.previous().len() >= 10 {
            return attempt.error("too many redirects");
        }
        match ssrf::resolve_and_check(&host, port) {
            Ok(_) => attempt.follow(),
            Err(_) => attempt.error("redirect target is not allowed"),
        }
    });

    Client::builder()
        .redirect(policy)
        .connect_timeout(Duration::from_secs(10))
        .build()
        .expect("failed to build http client")
}

#[derive(Debug, Deserialize)]
pub struct DownloadRequest {
    pub job_id: String,
    pub url: String,
    pub output: String,
    /// Companion audio-only stream to mux with `url` via ffmpeg. Modern
    /// YouTube rarely serves a single muxed audio+video stream, so the API
    /// pairs a video-only format with an audio-only one and the downloader
    /// combines them here.
    #[serde(default)]
    pub audio_url: Option<String>,
    /// Total media duration in seconds, used only to compute a percentage
    /// for the ffmpeg mux phase (`out_time` / duration). Omit or leave null
    /// if unknown; the mux still runs, it just won't report a percentage.
    #[serde(default)]
    pub duration_seconds: Option<f64>,
}

#[derive(Debug, Serialize)]
pub struct DownloadResponse {
    pub job_id: String,
    pub status: String,
    pub bytes_downloaded: u64,
    pub output_path: String,
}

#[derive(Debug)]
pub enum DownloadError {
    InvalidRequest(String),
    UnsafeUrl(String),
    Timeout,
    TooLarge,
    Cancelled,
    /// (message, retryable)
    Failed(String, bool),
    ProcessingFailed(String),
}

impl DownloadError {
    pub fn code(&self) -> &'static str {
        match self {
            DownloadError::InvalidRequest(_) => "INVALID_URL",
            DownloadError::UnsafeUrl(_) => "INVALID_URL",
            DownloadError::Timeout => "DOWNLOAD_TIMEOUT",
            DownloadError::TooLarge => "DOWNLOAD_FAILED",
            DownloadError::Cancelled => "JOB_CANCELLED",
            DownloadError::Failed(_, _) => "DOWNLOAD_FAILED",
            DownloadError::ProcessingFailed(_) => "PROCESSING_FAILED",
        }
    }

    pub fn message(&self) -> String {
        match self {
            DownloadError::InvalidRequest(m) => m.clone(),
            DownloadError::UnsafeUrl(m) => m.clone(),
            DownloadError::Timeout => "the download did not make progress before the timeout".to_string(),
            DownloadError::TooLarge => "the download exceeded the maximum allowed size".to_string(),
            DownloadError::Cancelled => "the job was cancelled".to_string(),
            DownloadError::Failed(m, _) => m.clone(),
            DownloadError::ProcessingFailed(m) => m.clone(),
        }
    }

    pub fn retryable(&self) -> bool {
        matches!(self, DownloadError::Timeout | DownloadError::Failed(_, true))
    }

    pub fn status_code(&self) -> StatusCode {
        match self {
            DownloadError::InvalidRequest(_) | DownloadError::UnsafeUrl(_) | DownloadError::TooLarge => {
                StatusCode::BAD_REQUEST
            }
            DownloadError::Timeout => StatusCode::GATEWAY_TIMEOUT,
            DownloadError::Cancelled => StatusCode::OK,
            DownloadError::Failed(_, _) => StatusCode::BAD_GATEWAY,
            DownloadError::ProcessingFailed(_) => StatusCode::BAD_GATEWAY,
        }
    }
}

/// Resolves a bare filename (no path separators, no "..") against the
/// downloader's configured output directory. Used both to build the target
/// path for a new download and to look up a completed file for retrieval,
/// so a caller can never escape the output directory via the filename.
pub fn resolve_output_path(state: &AppState, filename: &str) -> Result<PathBuf, DownloadError> {
    safe_output_path(&state.output_dir, filename)
}

fn safe_output_path(base: &Path, filename: &str) -> Result<PathBuf, DownloadError> {
    if filename.is_empty() {
        return Err(DownloadError::InvalidRequest("output filename is required".into()));
    }
    if filename.contains('/') || filename.contains('\\') || filename.contains("..") {
        return Err(DownloadError::InvalidRequest(
            "output must be a bare filename without path separators".into(),
        ));
    }
    Ok(base.join(filename))
}

fn part_path_for(target: &Path) -> PathBuf {
    let mut part = target.as_os_str().to_owned();
    part.push(".part");
    PathBuf::from(part)
}

fn sibling_path(target: &Path, suffix: &str) -> PathBuf {
    let mut p = target.as_os_str().to_owned();
    p.push(".");
    p.push(suffix);
    PathBuf::from(p)
}

const MUX_TIMEOUT: Duration = Duration::from_secs(600);

/// Parses ffmpeg's `-progress` timestamp format (`HH:MM:SS.ffffff`) into
/// total seconds.
fn parse_ffmpeg_time(s: &str) -> Option<f64> {
    let mut parts = s.trim().splitn(3, ':');
    let hours: f64 = parts.next()?.parse().ok()?;
    let minutes: f64 = parts.next()?.parse().ok()?;
    let seconds: f64 = parts.next()?.parse().ok()?;
    Some(hours * 3600.0 + minutes * 60.0 + seconds)
}

/// Muxes a video-only and audio-only stream into a single output file with
/// ffmpeg, using a codec copy (no re-encoding). The output container is
/// inferred by ffmpeg from `output_path`'s extension. Reports live progress
/// on `handle.mux_progress_percent` by parsing ffmpeg's machine-readable
/// `-progress` stream against the known media `duration_seconds`; if the
/// duration is unknown, the mux still runs, it just won't report a percent.
async fn mux_with_ffmpeg(
    video_path: &Path,
    audio_path: &Path,
    output_path: &Path,
    duration_seconds: Option<f64>,
    handle: &Arc<JobHandle>,
) -> Result<(), DownloadError> {
    use tokio::io::{AsyncBufReadExt, BufReader};

    handle.set_status("MUXING").await;
    handle.mux_progress_percent.store(0, Ordering::Relaxed);

    let mut cmd = tokio::process::Command::new("ffmpeg");
    cmd.arg("-y")
        .arg("-i")
        .arg(video_path)
        .arg("-i")
        .arg(audio_path)
        .arg("-c")
        .arg("copy");

    // movflags is an mp4/mov-muxer-only option; passing it for other output
    // containers (e.g. webm) causes ffmpeg to reject the whole command.
    if matches!(
        output_path.extension().and_then(|e| e.to_str()),
        Some("mp4") | Some("m4a") | Some("mov")
    ) {
        cmd.arg("-movflags").arg("+faststart");
    }
    cmd.arg("-progress").arg("pipe:1").arg("-nostats");
    cmd.arg(output_path);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| DownloadError::ProcessingFailed(format!("could not run ffmpeg: {e}")))?;

    let stdout = child.stdout.take().expect("ffmpeg stdout was piped");
    let stderr = child.stderr.take().expect("ffmpeg stderr was piped");

    let progress_handle = handle.clone();
    let progress_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(rest) = line.strip_prefix("out_time=") {
                if let (Some(elapsed), Some(total)) = (parse_ffmpeg_time(rest), duration_seconds) {
                    if total > 0.0 {
                        let percent = (elapsed / total * 100.0).clamp(0.0, 100.0) as u64;
                        progress_handle.mux_progress_percent.store(percent, Ordering::Relaxed);
                    }
                }
            }
        }
    });

    let stderr_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        let mut collected = String::new();
        while let Ok(Some(line)) = lines.next_line().await {
            collected.push_str(&line);
            collected.push('\n');
        }
        collected
    });

    let wait_result = tokio::time::timeout(MUX_TIMEOUT, child.wait()).await;
    let _ = progress_task.await;
    let stderr_output = stderr_task.await.unwrap_or_default();

    let status = match wait_result {
        Ok(Ok(status)) => status,
        Ok(Err(e)) => return Err(DownloadError::ProcessingFailed(format!("could not run ffmpeg: {e}"))),
        Err(_) => {
            let _ = child.kill().await;
            return Err(DownloadError::ProcessingFailed("ffmpeg mux timed out".to_string()));
        }
    };

    if !status.success() {
        let last_line = stderr_output.lines().last().unwrap_or_default();
        return Err(DownloadError::ProcessingFailed(format!("ffmpeg exited with {status}: {last_line}")));
    }

    handle.mux_progress_percent.store(100, Ordering::Relaxed);
    Ok(())
}

fn is_retryable(err: &DownloadError) -> bool {
    err.retryable()
}

fn backoff_duration(attempt: u32) -> Duration {
    let base_ms = 500u64 * 2u64.saturating_pow(attempt.saturating_sub(1).min(6) as u32);
    let jitter_ms = rand::thread_rng().gen_range(0..250);
    Duration::from_millis(base_ms.min(15_000) + jitter_ms)
}

/// Validates the HTTP request payload (bare filename + SSRF-safe URLs) and
/// runs the download.
pub async fn handle_download_request(
    state: Arc<AppState>,
    req: DownloadRequest,
) -> Result<DownloadResponse, DownloadError> {
    let target_path = safe_output_path(&state.output_dir, &req.output)?;
    let url = ssrf::validate_url(&req.url).map_err(|e| DownloadError::UnsafeUrl(e.to_string()))?;
    let audio_url = match req.audio_url.as_deref() {
        Some(a) if !a.trim().is_empty() => {
            Some(ssrf::validate_url(a).map_err(|e| DownloadError::UnsafeUrl(e.to_string()))?)
        }
        _ => None,
    };
    execute_download(state, req.job_id, url, audio_url, target_path, req.duration_seconds).await
}

/// Runs a download to an already-resolved absolute path. Used both by the
/// HTTP handler (after joining a bare filename onto the configured output
/// directory) and by the CLI entry point (which trusts a locally supplied
/// path directly). When `audio_url` is set, both streams are downloaded and
/// muxed with ffmpeg into `target_path`.
pub async fn execute_download(
    state: Arc<AppState>,
    job_id: String,
    url: url::Url,
    audio_url: Option<url::Url>,
    target_path: PathBuf,
    duration_seconds: Option<f64>,
) -> Result<DownloadResponse, DownloadError> {
    let parent = target_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    fs::create_dir_all(&parent)
        .await
        .map_err(|e| DownloadError::Failed(format!("could not create output directory: {e}"), false))?;

    let handle = Arc::new(JobHandle::new());
    {
        let mut jobs = state.jobs.write().await;
        jobs.insert(job_id.clone(), handle.clone());
    }

    let permit = state.semaphore.clone().acquire_owned().await;
    let _permit = match permit {
        Ok(p) => p,
        Err(_) => {
            state.jobs.write().await.remove(&job_id);
            return Err(DownloadError::Failed("downloader is shutting down".into(), false));
        }
    };

    let result = run_pipeline(&state, &url, audio_url.as_ref(), &target_path, &handle, &job_id, duration_seconds).await;

    state.jobs.write().await.remove(&job_id);

    let bytes_downloaded = handle.bytes_downloaded.load(Ordering::Relaxed);

    match result {
        Ok(()) => Ok(DownloadResponse {
            job_id,
            status: "COMPLETED".to_string(),
            bytes_downloaded,
            output_path: target_path.to_string_lossy().to_string(),
        }),
        Err(DownloadError::Cancelled) => Ok(DownloadResponse {
            job_id,
            status: "CANCELLED".to_string(),
            bytes_downloaded,
            output_path: target_path.to_string_lossy().to_string(),
        }),
        Err(err) => Err(err),
    }
}

async fn run_pipeline(
    state: &AppState,
    url: &url::Url,
    audio_url: Option<&url::Url>,
    target_path: &Path,
    handle: &Arc<JobHandle>,
    job_id: &str,
    duration_seconds: Option<f64>,
) -> Result<(), DownloadError> {
    match audio_url {
        None => {
            let part_path = part_path_for(target_path);
            download_with_retries(state, url, &part_path, handle, job_id).await?;
            fs::rename(&part_path, target_path)
                .await
                .map_err(|e| DownloadError::Failed(format!("could not finalize output file: {e}"), false))
        }
        Some(audio_url) => {
            let video_part = sibling_path(target_path, "video.part");
            let audio_part = sibling_path(target_path, "audio.part");

            let download_result = async {
                download_with_retries(state, url, &video_part, handle, job_id).await?;
                download_with_retries(state, audio_url, &audio_part, handle, job_id).await
            }
            .await;

            let result = match download_result {
                Ok(()) => mux_with_ffmpeg(&video_part, &audio_part, target_path, duration_seconds, handle).await,
                Err(err) => Err(err),
            };

            let _ = fs::remove_file(&video_part).await;
            let _ = fs::remove_file(&audio_part).await;

            result
        }
    }
}

async fn download_with_retries(
    state: &AppState,
    url: &url::Url,
    part_path: &Path,
    handle: &Arc<JobHandle>,
    job_id: &str,
) -> Result<(), DownloadError> {
    let mut attempt = 0u32;
    loop {
        attempt += 1;
        if handle.cancelled.load(Ordering::Relaxed) {
            return Err(DownloadError::Cancelled);
        }

        match attempt_download(state, url, part_path, handle).await {
            Ok(()) => return Ok(()),
            Err(DownloadError::Cancelled) => return Err(DownloadError::Cancelled),
            Err(err) if attempt >= MAX_ATTEMPTS || !is_retryable(&err) => return Err(err),
            Err(err) => {
                let backoff = backoff_duration(attempt);
                tracing::warn!(
                    job_id,
                    attempt,
                    error = %err.message(),
                    backoff_ms = backoff.as_millis() as u64,
                    "download attempt failed, retrying"
                );
                tokio::time::sleep(backoff).await;
            }
        }
    }
}

/// Minimum file size worth splitting into parallel range requests; below
/// this, connection-setup overhead outweighs any speedup.
const MIN_CHUNKED_SIZE: u64 = 8 * 1024 * 1024;

struct RangeProbe {
    total_size: u64,
    supports_ranges: bool,
}

/// Issues a 1-byte range request to determine total size and whether the
/// server honors `Range` at all, without committing to a transfer mode yet.
async fn probe_range_support(client: &Client, url: &url::Url) -> Result<RangeProbe, DownloadError> {
    let response = client
        .get(url.clone())
        .header(reqwest::header::RANGE, "bytes=0-0")
        .send()
        .await
        .map_err(|e| DownloadError::Failed(format!("probe request failed: {e}"), true))?;

    let status = response.status();
    if status == StatusCode::PARTIAL_CONTENT {
        let total = response
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.rsplit('/').next())
            .and_then(|v| v.parse::<u64>().ok());
        match total {
            Some(total) => Ok(RangeProbe { total_size: total, supports_ranges: true }),
            None => Ok(RangeProbe { total_size: 0, supports_ranges: false }),
        }
    } else if status.is_success() {
        Ok(RangeProbe { total_size: response.content_length().unwrap_or(0), supports_ranges: false })
    } else {
        let retryable = status.is_server_error() || status == StatusCode::TOO_MANY_REQUESTS;
        Err(DownloadError::Failed(format!("server returned status {status} during probe"), retryable))
    }
}

/// Dispatches to a parallel, chunked transfer (IDM-style) when the server
/// supports byte ranges and the file is large enough to benefit, otherwise
/// falls back to the plain sequential/resumable transfer.
async fn attempt_download(
    state: &AppState,
    url: &url::Url,
    part_path: &Path,
    handle: &Arc<JobHandle>,
) -> Result<(), DownloadError> {
    if state.max_chunks_per_download > 1 {
        if let Ok(probe) = probe_range_support(&state.client, url).await {
            if probe.supports_ranges && probe.total_size >= MIN_CHUNKED_SIZE {
                if probe.total_size > state.max_download_bytes {
                    return Err(DownloadError::TooLarge);
                }
                return attempt_download_chunked(
                    state,
                    url,
                    part_path,
                    handle,
                    probe.total_size,
                    state.max_chunks_per_download,
                )
                .await;
            }
        }
    }
    attempt_download_sequential(state, url, part_path, handle).await
}

/// Work-unit size for the shared download queue. Granules are deliberately
/// small relative to a whole chunk so that faster workers naturally pull
/// more of them than slower ones — a lightweight form of IDM's dynamic
/// segmentation, without the added complexity of stealing and re-splitting
/// a range that's already in flight on another connection.
const GRANULE_SIZE: u64 = 2 * 1024 * 1024;

/// Splits `total_size` into small granules placed on a shared queue and
/// fetched by `worker_count` persistent workers pulling from it, each
/// writing directly to its offset in a pre-allocated file. Faster
/// connections drain more granules than slower ones, so work is
/// load-balanced dynamically rather than pre-partitioned equally up front.
/// A failed attempt is retried in full by the caller
/// (`download_with_retries`); there is no cross-*attempt* resume, but a
/// single granule does resume from its own last-written byte across its own
/// internal retries.
async fn attempt_download_chunked(
    state: &AppState,
    url: &url::Url,
    part_path: &Path,
    handle: &Arc<JobHandle>,
    total_size: u64,
    worker_count: usize,
) -> Result<(), DownloadError> {
    handle.bytes_total.store(total_size as i64, Ordering::Relaxed);
    handle.bytes_downloaded.store(0, Ordering::Relaxed);
    handle.reset_segments(worker_count).await;

    {
        let file = tokio::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(part_path)
            .await
            .map_err(|e| DownloadError::Failed(format!("could not create output file: {e}"), false))?;
        file.set_len(total_size)
            .await
            .map_err(|e| DownloadError::Failed(format!("could not allocate output file: {e}"), false))?;
    }

    let mut granules = VecDeque::new();
    let mut start = 0u64;
    while start < total_size {
        let end = (start + GRANULE_SIZE - 1).min(total_size - 1);
        granules.push_back((start, end));
        start = end + 1;
    }
    let queue = Arc::new(Mutex::new(granules));
    let failed = Arc::new(AtomicBool::new(false));

    let mut tasks = Vec::with_capacity(worker_count);
    for worker_index in 0..worker_count {
        let client = state.client.clone();
        let url = url.clone();
        let path = part_path.to_path_buf();
        let handle = handle.clone();
        let queue = queue.clone();
        let failed = failed.clone();
        tasks.push(tokio::spawn(async move {
            download_worker(client, url, path, handle, queue, failed, worker_index).await
        }));
    }

    let mut first_err = None;
    for task in tasks {
        match task.await {
            Ok(Ok(())) => {}
            Ok(Err(err)) => {
                first_err.get_or_insert(err);
            }
            Err(join_err) => {
                first_err.get_or_insert(DownloadError::Failed(format!("chunk worker panicked: {join_err}"), false));
            }
        }
    }

    match first_err {
        Some(err) => Err(err),
        None => Ok(()),
    }
}

/// Pulls granules off the shared queue until it's empty, cancelled, or a
/// sibling worker has already failed the attempt.
async fn download_worker(
    client: Client,
    url: url::Url,
    path: PathBuf,
    handle: Arc<JobHandle>,
    queue: Arc<Mutex<VecDeque<(u64, u64)>>>,
    failed: Arc<AtomicBool>,
    worker_index: usize,
) -> Result<(), DownloadError> {
    loop {
        if failed.load(Ordering::Relaxed) || handle.cancelled.load(Ordering::Relaxed) {
            return Ok(());
        }

        let next = { queue.lock().await.pop_front() };
        let Some((start, end)) = next else { return Ok(()) };

        if let Err(err) = download_granule(&client, &url, &path, start, end, &handle, worker_index).await {
            failed.store(true, Ordering::Relaxed);
            return Err(err);
        }
    }
}

/// Downloads one granule, retrying with backoff. Unlike a whole-attempt
/// retry, this resumes from `cursor` (the last successfully written byte)
/// rather than re-fetching the granule from `start` every time.
async fn download_granule(
    client: &Client,
    url: &url::Url,
    path: &Path,
    start: u64,
    end: u64,
    handle: &Arc<JobHandle>,
    worker_index: usize,
) -> Result<(), DownloadError> {
    const GRANULE_MAX_ATTEMPTS: u32 = 5;
    let mut attempt = 0u32;
    let mut cursor = start;
    loop {
        attempt += 1;
        if handle.cancelled.load(Ordering::Relaxed) {
            return Err(DownloadError::Cancelled);
        }

        match download_granule_once(client, url, path, &mut cursor, end, handle, worker_index).await {
            Ok(()) => return Ok(()),
            Err(DownloadError::Cancelled) => return Err(DownloadError::Cancelled),
            Err(err) if attempt >= GRANULE_MAX_ATTEMPTS || !is_retryable(&err) => return Err(err),
            Err(_) => tokio::time::sleep(backoff_duration(attempt)).await,
        }
    }
}

async fn download_granule_once(
    client: &Client,
    url: &url::Url,
    path: &Path,
    cursor: &mut u64,
    end: u64,
    handle: &Arc<JobHandle>,
    worker_index: usize,
) -> Result<(), DownloadError> {
    if *cursor > end {
        return Ok(()); // fully written by an earlier attempt already
    }

    let response = client
        .get(url.clone())
        .header(reqwest::header::RANGE, format!("bytes={}-{end}", *cursor))
        .send()
        .await
        .map_err(|e| DownloadError::Failed(format!("chunk request failed: {e}"), true))?;

    let status = response.status();
    if status != StatusCode::PARTIAL_CONTENT && !status.is_success() {
        let retryable = status.is_server_error() || status == StatusCode::TOO_MANY_REQUESTS;
        return Err(DownloadError::Failed(format!("server returned status {status} for chunk"), retryable));
    }

    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .open(path)
        .await
        .map_err(|e| DownloadError::Failed(format!("could not open output file: {e}"), false))?;
    file.seek(std::io::SeekFrom::Start(*cursor))
        .await
        .map_err(|e| DownloadError::Failed(format!("could not seek output file: {e}"), false))?;

    let mut stream = response.bytes_stream();
    loop {
        if handle.cancelled.load(Ordering::Relaxed) {
            return Err(DownloadError::Cancelled);
        }

        let next_chunk = tokio::time::timeout(STALL_TIMEOUT, stream.next()).await;
        let bytes = match next_chunk {
            Ok(Some(Ok(bytes))) => bytes,
            Ok(Some(Err(e))) => return Err(DownloadError::Failed(format!("stream error: {e}"), true)),
            Ok(None) => break,
            Err(_) => return Err(DownloadError::Timeout),
        };

        file.write_all(&bytes)
            .await
            .map_err(|e| DownloadError::Failed(format!("write failed: {e}"), false))?;
        *cursor += bytes.len() as u64;
        handle.bytes_downloaded.fetch_add(bytes.len() as u64, Ordering::Relaxed);
        handle.add_segment_bytes(worker_index, bytes.len() as u64).await;
    }

    let _ = file.flush().await;
    Ok(())
}

async fn attempt_download_sequential(
    state: &AppState,
    url: &url::Url,
    part_path: &Path,
    handle: &Arc<JobHandle>,
) -> Result<(), DownloadError> {
    let existing_len = fs::metadata(part_path).await.map(|m| m.len()).unwrap_or(0);

    let mut request = state.client.get(url.clone());
    if existing_len > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={existing_len}-"));
    }

    let response = request
        .send()
        .await
        .map_err(|e| DownloadError::Failed(format!("request failed: {e}"), true))?;

    let status = response.status();
    let resume_offset = if status == StatusCode::PARTIAL_CONTENT {
        existing_len
    } else if status.is_success() {
        0
    } else {
        let retryable = status.is_server_error() || status == StatusCode::TOO_MANY_REQUESTS;
        return Err(DownloadError::Failed(format!("server returned status {status}"), retryable));
    };

    if let Some(content_length) = response.content_length() {
        let total = resume_offset + content_length;
        handle.bytes_total.store(total as i64, Ordering::Relaxed);
        if total > state.max_download_bytes {
            return Err(DownloadError::TooLarge);
        }
    }

    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .open(part_path)
        .await
        .map_err(|e| DownloadError::Failed(format!("could not open output file: {e}"), false))?;

    if resume_offset == 0 {
        let _ = file.set_len(0).await;
    }
    file.seek(std::io::SeekFrom::Start(resume_offset))
        .await
        .map_err(|e| DownloadError::Failed(format!("could not seek output file: {e}"), false))?;

    handle.bytes_downloaded.store(resume_offset, Ordering::Relaxed);
    handle.reset_segments(1).await;
    handle.add_segment_bytes(0, resume_offset).await;

    let mut stream = response.bytes_stream();
    loop {
        if handle.cancelled.load(Ordering::Relaxed) {
            return Err(DownloadError::Cancelled);
        }

        let next_chunk = tokio::time::timeout(STALL_TIMEOUT, stream.next()).await;
        let chunk = match next_chunk {
            Ok(Some(Ok(bytes))) => bytes,
            Ok(Some(Err(e))) => return Err(DownloadError::Failed(format!("stream error: {e}"), true)),
            Ok(None) => break,
            Err(_) => return Err(DownloadError::Timeout),
        };

        let written = handle.bytes_downloaded.load(Ordering::Relaxed) + chunk.len() as u64;
        if written > state.max_download_bytes {
            return Err(DownloadError::TooLarge);
        }

        file.write_all(&chunk)
            .await
            .map_err(|e| DownloadError::Failed(format!("write failed: {e}"), false))?;
        handle.bytes_downloaded.store(written, Ordering::Relaxed);
        handle.add_segment_bytes(0, chunk.len() as u64).await;
    }

    let _ = file.flush().await;
    Ok(())
}
