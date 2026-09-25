mod download;
mod ssrf;

use axum::extract::{Path as AxumPath, State};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use download::{AppState, DownloadError, DownloadRequest};
use std::path::PathBuf;
use std::process;
use std::sync::atomic::Ordering;
use std::sync::Arc;

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key)
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

fn default_max_bytes() -> u64 {
    5 * 1024 * 1024 * 1024 // 5 GiB
}

fn arg_value(args: &[String], flag: &str) -> Option<String> {
    args.iter().position(|arg| arg == flag).and_then(|i| args.get(i + 1)).cloned()
}

async fn health() -> impl IntoResponse {
    Json(serde_json::json!({"status": "ok", "service": "downloader"}))
}

async fn download_handler(State(state): State<Arc<AppState>>, Json(req): Json<DownloadRequest>) -> impl IntoResponse {
    match download::handle_download_request(state, req).await {
        Ok(resp) => (axum::http::StatusCode::OK, Json(serde_json::to_value(resp).unwrap())).into_response(),
        Err(err) => error_response(&err),
    }
}

/// Read size when streaming a finished file to a client.
const FILE_STREAM_BUFFER_BYTES: usize = 1024 * 1024;

async fn file_handler(State(state): State<Arc<AppState>>, AxumPath(filename): AxumPath<String>) -> impl IntoResponse {
    let path = match download::resolve_output_path(&state, &filename) {
        Ok(p) => p,
        Err(err) => return error_response(&err),
    };

    let file = match tokio::fs::File::open(&path).await {
        Ok(f) => f,
        Err(_) => {
            return (
                axum::http::StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": {"code": "NOT_FOUND", "message": "file not found"}})),
            )
                .into_response();
        }
    };

    let content_length = file.metadata().await.ok().map(|m| m.len());
    // ReaderStream's default is a 4 KiB buffer, which turns a 400 MB file into
    // ~100,000 tiny reads (each one handed to a blocking thread by tokio::fs)
    // and capped throughput near 11-18 MB/s even on the same machine.
    let stream = tokio_util::io::ReaderStream::with_capacity(file, FILE_STREAM_BUFFER_BYTES);
    let body = axum::body::Body::from_stream(stream);

    let mut builder = axum::http::Response::builder()
        .status(axum::http::StatusCode::OK)
        .header(axum::http::header::CONTENT_TYPE, "application/octet-stream")
        .header(
            axum::http::header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{filename}\""),
        );
    if let Some(len) = content_length {
        builder = builder.header(axum::http::header::CONTENT_LENGTH, len);
    }
    builder.body(body).unwrap().into_response()
}

async fn cancel_handler(State(state): State<Arc<AppState>>, AxumPath(job_id): AxumPath<String>) -> impl IntoResponse {
    let jobs = state.jobs.read().await;
    match jobs.get(&job_id) {
        Some(handle) => {
            handle.cancelled.store(true, Ordering::Relaxed);
            (
                axum::http::StatusCode::OK,
                Json(serde_json::json!({"status": "CANCELLING", "job_id": job_id})),
            )
                .into_response()
        }
        None => (
            axum::http::StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": {"code": "NOT_FOUND", "message": "job not active"}})),
        )
            .into_response(),
    }
}

async fn progress_handler(State(state): State<Arc<AppState>>, AxumPath(job_id): AxumPath<String>) -> impl IntoResponse {
    let jobs = state.jobs.read().await;
    match jobs.get(&job_id) {
        Some(handle) => {
            let downloaded = handle.bytes_downloaded.load(Ordering::Relaxed);
            let total = handle.bytes_total.load(Ordering::Relaxed);
            let elapsed = handle.started_at.elapsed().as_secs_f64();
            let speed = if elapsed > 0.0 { downloaded as f64 / elapsed } else { 0.0 };
            let status = handle.status.read().await.clone();
            let segments = handle.segments.read().await.clone();
            let mux_progress_percent = handle.mux_progress_percent.load(Ordering::Relaxed);
            (
                axum::http::StatusCode::OK,
                Json(serde_json::json!({
                    "job_id": job_id,
                    "status": status,
                    "bytes_downloaded": downloaded,
                    "bytes_total": if total >= 0 { serde_json::json!(total) } else { serde_json::Value::Null },
                    "speed_bytes_per_second": speed,
                    "segments": segments,
                    "mux_progress_percent": mux_progress_percent,
                })),
            )
                .into_response()
        }
        None => (
            axum::http::StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": {"code": "NOT_FOUND", "message": "job not active"}})),
        )
            .into_response(),
    }
}

fn error_response(err: &DownloadError) -> axum::response::Response {
    let status = err.status_code();
    let body = serde_json::json!({
        "error": {
            "code": err.code(),
            "message": err.message(),
            "retryable": err.retryable(),
        }
    });
    (status, Json(body)).into_response()
}

fn build_router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/download", post(download_handler))
        .route("/downloads/:job_id/cancel", post(cancel_handler))
        .route("/downloads/:job_id/progress", get(progress_handler))
        .route("/files/:filename", get(file_handler))
        .with_state(state)
}

async fn run_server() {
    let output_dir = PathBuf::from(env_or("DOWNLOAD_OUTPUT_DIR", "/data/downloads"));
    let max_concurrency: usize = env_or("MAX_GLOBAL_CONCURRENCY", "8").parse().unwrap_or(8);
    let max_bytes: u64 = env_or("MAX_DOWNLOAD_BYTES", &default_max_bytes().to_string())
        .parse()
        .unwrap_or_else(|_| default_max_bytes());
    let max_chunks: usize = env_or("MAX_CHUNKS_PER_DOWNLOAD", "8").parse().unwrap_or(8);
    let bind_addr = env_or("BIND_ADDR", "0.0.0.0:8000");

    if let Err(err) = std::fs::create_dir_all(&output_dir) {
        eprintln!("failed to create output dir {output_dir:?}: {err}");
        process::exit(1);
    }

    let state = Arc::new(AppState::new(output_dir, max_concurrency, max_bytes, max_chunks));
    let app = build_router(state);

    tracing::info!(%bind_addr, "downloader listening");
    let listener = match tokio::net::TcpListener::bind(&bind_addr).await {
        Ok(l) => l,
        Err(err) => {
            eprintln!("listen failed: {err}");
            process::exit(1);
        }
    };

    if let Err(err) = axum::serve(listener, app).await {
        eprintln!("server error: {err}");
        process::exit(1);
    }
}

async fn run_healthcheck() {
    let url = env_or("HEALTHCHECK_URL", "http://127.0.0.1:8000/health");
    match reqwest::get(&url).await {
        Ok(resp) if resp.status().is_success() => process::exit(0),
        _ => process::exit(1),
    }
}

async fn run_cli(url_arg: String, output_arg: String) {
    let output_dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let max_chunks: usize = env_or("MAX_CHUNKS_PER_DOWNLOAD", "8").parse().unwrap_or(8);
    let state = Arc::new(AppState::new(output_dir, 1, default_max_bytes(), max_chunks));

    let url = match ssrf::validate_url(&url_arg) {
        Ok(u) => u,
        Err(err) => {
            eprintln!("{err}");
            process::exit(1);
        }
    };

    match download::execute_download(state, "cli".to_string(), url, None, PathBuf::from(&output_arg), None).await {
        Ok(resp) => println!("{}", serde_json::to_string_pretty(&resp).unwrap()),
        Err(err) => {
            eprintln!("{}: {}", err.code(), err.message());
            process::exit(1);
        }
    }
}

#[tokio::main]
async fn main() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .json()
        .try_init();

    let args: Vec<String> = std::env::args().collect();

    if args.iter().any(|arg| arg == "--healthcheck") {
        run_healthcheck().await;
        return;
    }

    if let (Some(url), Some(output)) = (arg_value(&args, "--url"), arg_value(&args, "--output")) {
        run_cli(url, output).await;
        return;
    }

    run_server().await;
}
