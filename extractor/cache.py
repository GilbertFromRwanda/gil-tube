"""Pluggable extraction cache. Redis-backed in production, in-memory as a
fallback for local development or when Redis is unavailable. Per the
planner, Redis is an accelerator, never the source of truth, so falling
back to an in-memory cache on connection failure is safe.
"""
import hashlib
import json
import os
import time


class ExtractionCache:
    def get(self, key):
        raise NotImplementedError

    def set(self, key, value, ttl_seconds):
        raise NotImplementedError

    def scan_values(self, prefix):
        """Returns every still-live cached value whose key starts with
        `prefix`. Used to let the UI show what's already cached (e.g. past
        search results) without needing separate bookkeeping of what was
        cached - the cache_key prefix convention (see cache_key()) is enough
        to scope a scan to one kind of entry."""
        raise NotImplementedError


class InMemoryCache(ExtractionCache):
    def __init__(self):
        self._store = {}

    def get(self, key):
        entry = self._store.get(key)
        if not entry:
            return None
        expires_at, value = entry
        if time.time() > expires_at:
            self._store.pop(key, None)
            return None
        return value

    def set(self, key, value, ttl_seconds):
        self._store[key] = (time.time() + ttl_seconds, value)

    def scan_values(self, prefix):
        now = time.time()
        return [value for key, (expires_at, value) in self._store.items() if key.startswith(prefix) and expires_at >= now]


class RedisCache(ExtractionCache):
    def __init__(self, redis_client):
        self._redis = redis_client

    def get(self, key):
        raw = self._redis.get(key)
        if raw is None:
            return None
        try:
            return json.loads(raw)
        except (TypeError, ValueError):
            return None

    def set(self, key, value, ttl_seconds):
        self._redis.setex(key, ttl_seconds, json.dumps(value))

    def scan_values(self, prefix):
        values = []
        for key in self._redis.scan_iter(match=f"{prefix}*"):
            raw = self._redis.get(key)
            if raw is None:
                continue
            try:
                values.append(json.loads(raw))
            except (TypeError, ValueError):
                continue
        return values


def cache_key(value: str, prefix: str = "extract") -> str:
    normalized = value.strip().lower()
    return f"{prefix}:" + hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def build_cache_from_env() -> ExtractionCache:
    redis_url = os.environ.get("REDIS_URL", "").strip()
    if not redis_url:
        return InMemoryCache()
    try:
        import redis  # type: ignore

        client = redis.Redis.from_url(redis_url, socket_timeout=2)
        client.ping()
        return RedisCache(client)
    except Exception:
        return InMemoryCache()
