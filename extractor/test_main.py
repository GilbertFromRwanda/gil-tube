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
