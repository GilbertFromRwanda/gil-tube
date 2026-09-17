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


def cache_key(url: str) -> str:
    normalized = url.strip().lower()
    return "extract:" + hashlib.sha256(normalized.encode("utf-8")).hexdigest()


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
