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

export function search(query: string, limit = 12): Promise<SearchResponse> {
  return request('/api/v1/search', {
    method: 'POST',
    body: JSON.stringify({ query, limit }),
  });
}

export function searchSuggestions(prefix: string): Promise<{ suggestions: string[] }> {
  return request(`/api/v1/search-suggestions?q=${encodeURIComponent(prefix)}`);
}

export function cachedSearches(offset: number, limit: number): Promise<CachedSearchesResponse> {
  return request(`/api/v1/cached-searches?offset=${offset}&limit=${limit}`);
}

export function preview(url: string): Promise<PreviewInfo> {
  return request('/api/v1/preview', {
    method: 'POST',
    body: JSON.stringify({ url }),
  });
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
