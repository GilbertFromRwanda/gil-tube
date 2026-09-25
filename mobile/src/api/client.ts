import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  ApiErrorEnvelope,
  CachedSearchesResponse,
  Job,
  JobProgress,
  PreviewInfo,
  SearchResponse,
} from './types';

const API_BASE_STORAGE_KEY = 'gil_tube_api_base_url';

// No sensible default exists: "localhost" on a phone means the phone
// itself, not the developer's machine, so the user must point this at
// their API's LAN/deployed address from the Settings screen before
// anything else in the app can work.
let cachedBaseUrl: string | null = null;

export async function getApiBaseUrl(): Promise<string | null> {
  if (cachedBaseUrl !== null) return cachedBaseUrl;
  const stored = await AsyncStorage.getItem(API_BASE_STORAGE_KEY);
  cachedBaseUrl = stored ? stored.replace(/\/+$/, '') : null;
  return cachedBaseUrl;
}

export async function setApiBaseUrl(url: string): Promise<void> {
  const normalized = url.trim().replace(/\/+$/, '');
  cachedBaseUrl = normalized || null;
  // Cached formats belong to the old server; don't serve them for the new one.
  previewCache.clear();
  previewInflight.clear();
  if (normalized) {
    await AsyncStorage.setItem(API_BASE_STORAGE_KEY, normalized);
  } else {
    await AsyncStorage.removeItem(API_BASE_STORAGE_KEY);
  }
}

export class ApiNotConfiguredError extends Error {
  constructor() {
    super('Set the API server address in Settings first.');
    this.name = 'ApiNotConfiguredError';
  }
}

export class ApiRequestError extends Error {
  code: string;
  status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'ApiRequestError';
    this.code = code;
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const base = await getApiBaseUrl();
  if (!base) throw new ApiNotConfiguredError();

  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const envelope = data as ApiErrorEnvelope | null;
    throw new ApiRequestError(
      envelope?.error?.message || 'Request failed.',
      envelope?.error?.code || 'UNKNOWN_ERROR',
      response.status,
    );
  }

  return data as T;
}

// `refresh` skips the server's cached copy of this search and fetches fresh
// results (used by pull-to-refresh).
export function search(query: string, limit = 12, refresh = false): Promise<SearchResponse> {
  return request('/api/v1/search', {
    method: 'POST',
    body: JSON.stringify({ query, limit, refresh }),
  });
}

export function searchSuggestions(prefix: string): Promise<{ suggestions: string[] }> {
  return request(`/api/v1/search-suggestions?q=${encodeURIComponent(prefix)}`);
}

export function cachedSearches(offset: number, limit: number): Promise<CachedSearchesResponse> {
  return request(`/api/v1/cached-searches?offset=${offset}&limit=${limit}`);
}

// Format lookups are the slow part of opening a video (a full yt-dlp
// extraction on a cache miss), so results are kept in memory. The TTL sits
// under the server's own extraction cache (10 min) because the direct media
// URLs inside are signed and expire. In-flight requests are shared, so a
// background prewarm and the user tapping the same video make one call.
const PREVIEW_CACHE_TTL_MS = 5 * 60 * 1000;
const previewCache = new Map<string, { at: number; info: PreviewInfo }>();
const previewInflight = new Map<string, Promise<PreviewInfo>>();

export function getCachedPreview(url: string): PreviewInfo | null {
  const entry = previewCache.get(url);
  if (!entry) return null;
  if (Date.now() - entry.at > PREVIEW_CACHE_TTL_MS) {
    previewCache.delete(url);
    return null;
  }
  return entry.info;
}

export function preview(url: string): Promise<PreviewInfo> {
  const cached = getCachedPreview(url);
  if (cached) return Promise.resolve(cached);

  const inflight = previewInflight.get(url);
  if (inflight) return inflight;

  const promise = request<PreviewInfo>('/api/v1/preview', {
    method: 'POST',
    body: JSON.stringify({ url }),
  })
    .then((info) => {
      previewCache.set(url, { at: Date.now(), info });
      return info;
    })
    .finally(() => {
      previewInflight.delete(url);
    });
  previewInflight.set(url, promise);
  return promise;
}

// Fire-and-forget: extracts formats for likely-to-be-tapped videos ahead of
// time, staggered so it doesn't hammer the extractor. Failures are ignored -
// tapping the video just does the lookup then.
export function prewarmPreviews(urls: string[], staggerMs = 500): void {
  urls.forEach((url, index) => {
    setTimeout(() => {
      preview(url).catch(() => {});
    }, index * staggerMs);
  });
}

// Address of the server's audio-only stream for a video (Range-capable, so a
// player can seek). Used to keep playing when the app leaves the screen.
export async function getAudioStreamUrl(videoUrl: string): Promise<string> {
  const base = await getApiBaseUrl();
  if (!base) throw new ApiNotConfiguredError();
  return `${base}/api/v1/audio?url=${encodeURIComponent(videoUrl)}`;
}

export function createJob(url: string, format?: string): Promise<Job> {
  return request('/api/v1/jobs', {
    method: 'POST',
    body: JSON.stringify({ url, format: format || undefined }),
  });
}

export function getJob(jobId: string): Promise<Job> {
  return request(`/api/v1/jobs/${jobId}`);
}

export function getJobProgress(jobId: string): Promise<JobProgress> {
  return request(`/api/v1/jobs/${jobId}/progress`);
}

export function cancelJob(jobId: string): Promise<Job> {
  return request(`/api/v1/jobs/${jobId}/cancel`, { method: 'POST' });
}

export async function getJobFileUrl(jobId: string): Promise<string> {
  const base = await getApiBaseUrl();
  if (!base) throw new ApiNotConfiguredError();
  return `${base}/api/v1/jobs/${jobId}/file`;
}
