import concurrent.futures
import json as jsonlib
import logging
import time

from flask import Flask, jsonify, request
from yt_dlp import YoutubeDL
from yt_dlp.utils import DownloadError

from cache import build_cache_from_env, cache_key
from url_safety import UnsafeURLError, validate_public_http_url

app = Flask(__name__)
cache = build_cache_from_env()

EXTRACT_TIMEOUT_SECONDS = 30
CACHE_TTL_SECONDS = 600

logger = logging.getLogger("extractor")
logging.basicConfig(level=logging.INFO)


def log_event(event, **fields):
    logger.info(jsonlib.dumps({"service": "extractor", "event": event, **fields}))


def error_response(code, message, status, retryable=False, request_id=None):
    return (
        jsonify(
            {
                "error": {
                    "code": code,
                    "message": message,
                    "retryable": retryable,
                    "request_id": request_id,
                }
            }
        ),
        status,
    )


def classify_download_error(err: DownloadError):
    text = str(err).lower()
    if "private video" in text or "sign in" in text:
        return "CONTENT_UNAVAILABLE", "The requested content is private or requires authentication.", False
    if "video unavailable" in text or "has been removed" in text:
        return "CONTENT_UNAVAILABLE", "The requested content is unavailable.", False
    if "unsupported url" in text or "no extractor" in text:
        return "UNSUPPORTED_SOURCE", "The URL is not from a supported source.", False
    if "is not a valid url" in text:
        return "INVALID_URL", "The URL could not be parsed.", False
    return "EXTRACTION_FAILED", "The source could not be processed.", True


def is_downloadable_format(fmt):
    """Excludes formats the downloader cannot fetch with a plain HTTP GET:
    non-media formats (storyboards/thumbnail sheets with neither a video nor
    an audio codec), and adaptive-manifest protocols (HLS/DASH) that require
    segment-aware fetching the downloader does not implement."""
    if not fmt.get("format_id") or not fmt.get("url"):
        return False
    if fmt.get("protocol") not in ("https", "http"):
        return False
    has_video = fmt.get("vcodec") not in (None, "none")
    has_audio = fmt.get("acodec") not in (None, "none")
    return has_video or has_audio


def build_format_entry(fmt):
    return {
        "id": str(fmt.get("format_id", "")),
        "container": fmt.get("ext"),
        "video_codec": fmt.get("vcodec") if fmt.get("vcodec") not in (None, "none") else None,
        "audio_codec": fmt.get("acodec") if fmt.get("acodec") not in (None, "none") else None,
        "height": fmt.get("height"),
        "fps": fmt.get("fps"),
        "resolution": fmt.get("resolution"),
        "bitrate": fmt.get("tbr"),
        "filesize": fmt.get("filesize") or fmt.get("filesize_approx"),
        # Direct, downloadable source URL for this format. The downloader
        # fetches this URL directly; it cannot fetch the original page URL.
        "url": fmt.get("url"),
    }


def run_extraction(url: str):
    ydl_opts = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "skip_download": True,
        "socket_timeout": 15,
        "extractor_retries": 1,
    }
    with YoutubeDL(ydl_opts) as ydl:
        return ydl.extract_info(url, download=False)


def extract_with_timeout(url: str, timeout_seconds: int):
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(run_extraction, url)
        return future.result(timeout=timeout_seconds)


@app.get("/health")
def health():
    return jsonify({"status": "ok", "service": "extractor"})


@app.post("/api/v1/extract")
def extract():
    payload = request.get_json(silent=True) or {}
    raw_url = payload.get("url")

    try:
        url = validate_public_http_url(raw_url)
    except UnsafeURLError as err:
        log_event("extract_rejected", code=err.code, reason=err.message)
        return error_response(err.code, err.message, 400)

    key = cache_key(url)
    cached = cache.get(key)
    if cached is not None:
        log_event("extract_cache_hit", url=url)
        return jsonify(cached)

    started = time.monotonic()
    try:
        info = extract_with_timeout(url, EXTRACT_TIMEOUT_SECONDS)
    except concurrent.futures.TimeoutError:
        log_event("extract_timeout", url=url)
        return error_response(
            "EXTRACTION_TIMEOUT",
            "The source could not be processed before the timeout.",
            504,
            retryable=True,
        )
    except DownloadError as err:
        code, message, retryable = classify_download_error(err)
        log_event("extract_failed", url=url, code=code)
        return error_response(code, message, 502 if retryable else 422, retryable=retryable)
    except Exception as err:  # unexpected extractor failure
        log_event("extract_error", url=url, error=str(err))
        return error_response("EXTRACTION_FAILED", "The source could not be processed.", 502, retryable=True)

    duration_ms = int((time.monotonic() - started) * 1000)

    if info is None:
        return error_response("EXTRACTION_FAILED", "The source could not be processed.", 502, retryable=True)

    if info.get("is_live"):
        return error_response("UNSUPPORTED_SOURCE", "Live streams are not supported.", 422)

    formats = [build_format_entry(f) for f in info.get("formats", []) if is_downloadable_format(f)]
    if not formats:
        return error_response("FORMAT_UNAVAILABLE", "No downloadable formats were found.", 422)

    result = {
        "id": info.get("id"),
        "title": info.get("title"),
        "duration": info.get("duration"),
        "thumbnail": info.get("thumbnail"),
        "uploader": info.get("uploader") or info.get("channel"),
        "formats": formats,
    }

    cache.set(key, result, CACHE_TTL_SECONDS)
    log_event("extract_completed", url=url, duration_ms=duration_ms, format_count=len(formats))
    return jsonify(result)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=9000)
