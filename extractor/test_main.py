from unittest.mock import patch

import main


def test_health_endpoint():
    client = main.app.test_client()
    response = client.get('/health')
    assert response.status_code == 200
    data = response.get_json()
    assert data['status'] == 'ok'
    assert data['service'] == 'extractor'


def test_extract_requires_url():
    client = main.app.test_client()
    response = client.post('/api/v1/extract', json={})
    assert response.status_code == 400
    assert response.get_json()['error']['code'] == 'INVALID_URL'


def test_extract_rejects_private_network_url():
    client = main.app.test_client()
    response = client.post('/api/v1/extract', json={'url': 'http://127.0.0.1:8080/secret'})
    assert response.status_code == 400
    assert response.get_json()['error']['code'] == 'INVALID_URL'


def test_extract_rejects_link_local_metadata_url():
    client = main.app.test_client()
    response = client.post('/api/v1/extract', json={'url': 'http://169.254.169.254/latest/meta-data/'})
    assert response.status_code == 400
    assert response.get_json()['error']['code'] == 'INVALID_URL'


FAKE_INFO = {
    "id": "abc123",
    "title": "Example",
    "duration": 312,
    "thumbnail": "https://example.com/thumb.jpg",
    "uploader": "Example Channel",
    "formats": [
        {
            "format_id": "137",
            "ext": "mp4",
            "vcodec": "avc1",
            "acodec": "none",
            "height": 1080,
            "fps": 30,
            "resolution": "1920x1080",
            "tbr": 4500.0,
            "filesize": 104857600,
            "protocol": "https",
            "url": "https://cdn.example.com/video-1080p.mp4",
        }
    ],
}


def test_extract_returns_metadata_shape():
    main.cache = main.build_cache_from_env()
    with patch.object(main, 'validate_public_http_url', side_effect=lambda u: u), \
         patch.object(main, 'run_extraction', return_value=FAKE_INFO) as mocked:
        client = main.app.test_client()
        response = client.post('/api/v1/extract', json={'url': 'https://www.youtube.com/watch?v=abc123'})
        assert response.status_code == 200
        payload = response.get_json()
        assert payload['title'] == 'Example'
        assert payload['duration'] == 312
        assert len(payload['formats']) == 1
        assert payload['formats'][0]['container'] == 'mp4'
        assert payload['formats'][0]['audio_codec'] is None
        assert mocked.call_count == 1


def test_extract_uses_cache_on_second_call():
    main.cache = main.build_cache_from_env()
    with patch.object(main, 'validate_public_http_url', side_effect=lambda u: u), \
         patch.object(main, 'run_extraction', return_value=FAKE_INFO) as mocked:
        client = main.app.test_client()
        url = 'https://www.youtube.com/watch?v=cachehit'
        first = client.post('/api/v1/extract', json={'url': url})
        second = client.post('/api/v1/extract', json={'url': url})
        assert first.status_code == 200
        assert second.status_code == 200
        assert mocked.call_count == 1


def test_extract_maps_timeout_to_extraction_timeout_code():
    import concurrent.futures

    with patch.object(main, 'validate_public_http_url', side_effect=lambda u: u), \
         patch.object(main, 'extract_with_timeout', side_effect=concurrent.futures.TimeoutError()):
        client = main.app.test_client()
        response = client.post('/api/v1/extract', json={'url': 'https://www.youtube.com/watch?v=slow'})
        assert response.status_code == 504
        assert response.get_json()['error']['code'] == 'EXTRACTION_TIMEOUT'


def test_extract_returns_unsupported_source_for_live_content():
    live_info = dict(FAKE_INFO, is_live=True)
    with patch.object(main, 'validate_public_http_url', side_effect=lambda u: u), \
         patch.object(main, 'run_extraction', return_value=live_info):
        client = main.app.test_client()
        response = client.post('/api/v1/extract', json={'url': 'https://www.youtube.com/watch?v=live'})
        assert response.status_code == 422
        assert response.get_json()['error']['code'] == 'UNSUPPORTED_SOURCE'


FAKE_SEARCH_INFO = {
    "entries": [
        {
            "id": "vid1",
            "title": "First result",
            "duration": 120,
            "thumbnails": [{"url": "https://i.ytimg.com/vi/vid1/default.jpg"}],
            "channel": "Channel One",
        },
        {
            "id": "vid2",
            "title": "Second result",
            "duration": 245,
            "thumbnails": [{"url": "https://i.ytimg.com/vi/vid2/default.jpg"}],
            "uploader": "Channel Two",
        },
    ]
}


def test_search_requires_query():
    client = main.app.test_client()
    response = client.post('/api/v1/search', json={})
    assert response.status_code == 400
    assert response.get_json()['error']['code'] == 'INVALID_QUERY'


def test_search_returns_result_list():
    main.cache = main.build_cache_from_env()
    with patch.object(main, 'run_search', return_value=FAKE_SEARCH_INFO) as mocked:
        client = main.app.test_client()
        response = client.post('/api/v1/search', json={'query': 'lofi beats', 'limit': 5})
        assert response.status_code == 200
        payload = response.get_json()
        assert payload['query'] == 'lofi beats'
        assert len(payload['results']) == 2
        assert payload['results'][0]['url'] == 'https://www.youtube.com/watch?v=vid1'
        assert payload['results'][1]['uploader'] == 'Channel Two'
        mocked.assert_called_once_with('lofi beats', 5)


def test_search_uses_cache_on_second_call():
    main.cache = main.build_cache_from_env()
    with patch.object(main, 'run_search', return_value=FAKE_SEARCH_INFO) as mocked:
        client = main.app.test_client()
        client.post('/api/v1/search', json={'query': 'cache me'})
        client.post('/api/v1/search', json={'query': 'cache me'})
        assert mocked.call_count == 1


def test_search_maps_timeout_to_search_timeout_code():
    import concurrent.futures

    with patch.object(main, 'search_with_timeout', side_effect=concurrent.futures.TimeoutError()):
        client = main.app.test_client()
        response = client.post('/api/v1/search', json={'query': 'slow query'})
        assert response.status_code == 504
        assert response.get_json()['error']['code'] == 'SEARCH_TIMEOUT'


def test_cached_searches_returns_empty_list_when_nothing_cached():
    main.cache = main.build_cache_from_env()
    client = main.app.test_client()
    response = client.get('/api/v1/cached-searches')
    assert response.status_code == 200
    assert response.get_json()['videos'] == []


def test_cached_searches_flattens_and_dedupes_across_queries():
    main.cache = main.build_cache_from_env()
    with patch.object(main, 'run_search', return_value=FAKE_SEARCH_INFO):
        client = main.app.test_client()
        client.post('/api/v1/search', json={'query': 'lofi beats'})
        # Same underlying videos cached under a second query too - the
        # aggregated view must not list vid1/vid2 twice.
        client.post('/api/v1/search', json={'query': 'chill beats'})

        response = client.get('/api/v1/cached-searches')
        assert response.status_code == 200
        videos = response.get_json()['videos']
        ids = [v['id'] for v in videos]
        assert ids.count('vid1') == 1
        assert ids.count('vid2') == 1


def test_cached_searches_respects_limit():
    main.cache = main.build_cache_from_env()
    with patch.object(main, 'run_search', return_value=FAKE_SEARCH_INFO):
        client = main.app.test_client()
        client.post('/api/v1/search', json={'query': 'lofi beats'})

        response = client.get('/api/v1/cached-searches?limit=1')
        assert response.status_code == 200
        assert len(response.get_json()['videos']) == 1


def test_cached_searches_pagination_via_offset():
    main.cache = main.build_cache_from_env()
    with patch.object(main, 'run_search', return_value=FAKE_SEARCH_INFO):
        client = main.app.test_client()
        client.post('/api/v1/search', json={'query': 'lofi beats'})

        first_page = client.get('/api/v1/cached-searches?limit=1&offset=0').get_json()
        assert first_page['total'] == 2
        assert first_page['has_more'] is True
        assert len(first_page['videos']) == 1

        second_page = client.get('/api/v1/cached-searches?limit=1&offset=1').get_json()
        assert second_page['has_more'] is False
        assert len(second_page['videos']) == 1
        assert first_page['videos'][0]['id'] != second_page['videos'][0]['id']


def test_cached_searches_includes_distinct_query_suggestions():
    main.cache = main.build_cache_from_env()
    with patch.object(main, 'run_search', return_value=FAKE_SEARCH_INFO):
        client = main.app.test_client()
        client.post('/api/v1/search', json={'query': 'lofi beats'})
        client.post('/api/v1/search', json={'query': 'chill beats'})
        # Same query again, different case - must not appear twice.
        client.post('/api/v1/search', json={'query': 'Lofi Beats'})

        response = client.get('/api/v1/cached-searches')
        queries = response.get_json()['queries']
        assert len(queries) == 2
        assert {q.lower() for q in queries} == {'lofi beats', 'chill beats'}


def test_search_suggestions_match_only_by_prefix_case_insensitively():
    main.cache = main.build_cache_from_env()
    with patch.object(main, 'run_search', return_value=FAKE_SEARCH_INFO):
        client = main.app.test_client()
        client.post('/api/v1/search', json={'query': 'rekeba music'})
        client.post('/api/v1/search', json={'query': 'Rekeba worship'})
        client.post('/api/v1/search', json={'query': 'lofi beats'})
        # Contains "rek" but doesn't start with it - must not match.
        client.post('/api/v1/search', json={'query': 'best of rek'})

        response = client.get('/api/v1/search-suggestions?q=REK')
        assert response.status_code == 200
        assert response.get_json()['suggestions'] == ['rekeba music', 'Rekeba worship']


def test_search_suggestions_dedupe_same_query_cached_under_different_limits():
    main.cache = main.build_cache_from_env()
    with patch.object(main, 'run_search', return_value=FAKE_SEARCH_INFO):
        client = main.app.test_client()
        client.post('/api/v1/search', json={'query': 'lofi beats', 'limit': 12})
        client.post('/api/v1/search', json={'query': 'lofi beats', 'limit': 5})

        suggestions = client.get('/api/v1/search-suggestions?q=lo').get_json()['suggestions']
        assert suggestions == ['lofi beats']


def test_search_suggestions_empty_prefix_returns_recent_queries_and_respects_limit():
    main.cache = main.build_cache_from_env()
    with patch.object(main, 'run_search', return_value=FAKE_SEARCH_INFO):
        client = main.app.test_client()
        client.post('/api/v1/search', json={'query': 'aaa'})
        client.post('/api/v1/search', json={'query': 'bbb'})

        assert len(client.get('/api/v1/search-suggestions').get_json()['suggestions']) == 2
        assert len(client.get('/api/v1/search-suggestions?limit=1').get_json()['suggestions']) == 1


def test_search_excludes_channels_and_playlists():
    main.cache = main.build_cache_from_env()
    info = {
        'entries': [
            {'id': 'UClGmPgUP-6fRH-yP99c9cYQ', 'ie_key': 'YoutubeTab', 'title': 'A channel'},
            {'id': 'PLabcdefghijklmnopqrstuvwxyz0123456', 'ie_key': 'YoutubeTab', 'title': 'A playlist'},
            {'id': 'R51PMRjyS9w', 'ie_key': 'Youtube', 'title': 'A real video'},
        ]
    }
    with patch.object(main, 'run_search', return_value=info):
        client = main.app.test_client()
        results = client.post('/api/v1/search', json={'query': 'king james'}).get_json()['results']
        assert [r['id'] for r in results] == ['R51PMRjyS9w']
        assert results[0]['url'] == 'https://www.youtube.com/watch?v=R51PMRjyS9w'


def test_cached_searches_drops_channel_entries_cached_earlier():
    main.cache = main.build_cache_from_env()
    main.cache.set(
        main.cache_key('12:legacy', prefix='search'),
        {'query': 'legacy', 'results': [
            {'id': 'UClGmPgUP-6fRH-yP99c9cYQ', 'title': 'channel', 'url': 'https://www.youtube.com/watch?v=UClGmPgUP-6fRH-yP99c9cYQ'},
            {'id': 'R51PMRjyS9w', 'title': 'video', 'url': 'https://www.youtube.com/watch?v=R51PMRjyS9w'},
        ]},
        600,
    )
    videos = main.app.test_client().get('/api/v1/cached-searches').get_json()['videos']
    assert [v['id'] for v in videos] == ['R51PMRjyS9w']
