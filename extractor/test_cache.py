from cache import InMemoryCache, cache_key


def test_cache_key_defaults_to_extract_prefix():
    assert cache_key("https://example.com/video").startswith("extract:")


def test_cache_key_supports_custom_prefix():
    assert cache_key("some query", prefix="search").startswith("search:")


def test_cache_key_prefixes_keep_extract_and_search_distinct():
    # Same underlying string, different namespaces - must not collide even
    # though both cache extractor output through the same cache backend.
    extract_key = cache_key("rwanda sda music", prefix="extract")
    search_key = cache_key("rwanda sda music", prefix="search")
    assert extract_key != search_key


def test_cache_key_is_case_insensitive():
    assert cache_key("Some Query") == cache_key("some query")


def test_in_memory_cache_round_trip():
    cache = InMemoryCache()
    key = cache_key("test", prefix="search")
    assert cache.get(key) is None
    cache.set(key, {"results": []}, ttl_seconds=60)
    assert cache.get(key) == {"results": []}


def test_in_memory_cache_scan_values_filters_by_prefix_and_expiry():
    cache = InMemoryCache()
    cache.set(cache_key("a", prefix="search"), {"v": "a"}, ttl_seconds=60)
    cache.set(cache_key("b", prefix="search"), {"v": "b"}, ttl_seconds=60)
    cache.set(cache_key("c", prefix="extract"), {"v": "c"}, ttl_seconds=60)
    # Expired entries must not be returned even though they're still present
    # in the underlying store until the next get() prunes them.
    cache.set(cache_key("d", prefix="search"), {"v": "d"}, ttl_seconds=-1)

    values = cache.scan_values("search:")
    assert {v["v"] for v in values} == {"a", "b"}
