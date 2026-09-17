from unittest.mock import patch

import pytest

from url_safety import UnsafeURLError, validate_public_http_url


def test_rejects_non_http_scheme():
    with pytest.raises(UnsafeURLError) as exc:
        validate_public_http_url("ftp://example.com/file")
    assert exc.value.code == "INVALID_URL"


def test_rejects_missing_url():
    with pytest.raises(UnsafeURLError):
        validate_public_http_url("")


def test_rejects_credentials_in_url():
    with pytest.raises(UnsafeURLError):
        validate_public_http_url("https://user:pass@example.com/video")


def test_rejects_loopback_ip_literal():
    with pytest.raises(UnsafeURLError):
        validate_public_http_url("http://127.0.0.1/admin")


def test_rejects_dns_rebinding_to_private_ip():
    """A hostname that looks public but resolves to an internal address
    must still be blocked (validation happens after DNS resolution)."""
    fake_addrinfo = [(2, 1, 6, "", ("10.0.0.5", 0))]
    with patch("url_safety.socket.getaddrinfo", return_value=fake_addrinfo):
        with pytest.raises(UnsafeURLError):
            validate_public_http_url("http://looks-public.example.com/video")


def test_allows_hostname_resolving_to_public_ip():
    fake_addrinfo = [(2, 1, 6, "", ("93.184.216.34", 0))]
    with patch("url_safety.socket.getaddrinfo", return_value=fake_addrinfo):
        assert validate_public_http_url("https://example.com/video") == "https://example.com/video"
