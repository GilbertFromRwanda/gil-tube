export interface SearchResult {
  id: string;
  url: string;
  title: string;
  thumbnail: string | null;
  duration: number | null;
  uploader: string | null;
}

export interface SearchResponse {
  results: SearchResult[];
  // Paging: where the next page starts, and whether YouTube has more.
  offset?: number;
  next_offset?: number;
  has_more?: boolean;
}

export interface CachedSearchesResponse {
  videos: SearchResult[];
  queries: string[];
  offset: number;
  limit: number;
  total: number;
  has_more: boolean;
}

export interface FormatEntry {
  id: string;
  container: string | null;
  video_codec: string | null;
  audio_codec: string | null;
  height: number | null;
  fps: number | null;
  resolution: string | null;
  bitrate: number | null;
  filesize: number | null;
  url: string | null;
}

export interface PreviewInfo {
  id: string;
  title: string;
  duration: number | null;
  uploader: string | null;
  formats: FormatEntry[];
}

export type JobStatus =
  | 'QUEUED'
  | 'READY'
  | 'DOWNLOADING'
  | 'MUXING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export interface Job {
  job_id: string;
  status: JobStatus;
  title?: string;
  url?: string;
  format_id?: string;
  container?: string;
  duration_seconds?: number;
  error_code?: string;
  error_message?: string;
  created_at?: string;
  updated_at?: string;
}

export interface JobProgress {
  job_id: string;
  status: JobStatus;
  bytes_downloaded: number;
  bytes_total: number | null;
  speed_bytes_per_second: number;
  segments?: number[];
  mux_progress_percent?: number;
}

export interface ApiErrorEnvelope {
  error: {
    code: string;
    message: string;
    retryable?: boolean;
    request_id?: string | null;
  };
}
