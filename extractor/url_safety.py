"""URL validation and SSRF defenses for the extractor service.

Since this service accepts arbitrary user-supplied URLs and fetches them
server-side, every URL must be validated for scheme and resolved-address
safety before any network request is made. Validation happens against the
*resolved* IP addresses (not just the hostname) to defend against DNS
rebinding, per the planner's SSRF guidance.
"""
import ipaddress
import socket
from urllib.parse import urlparse

ALLOWED_SCHEMES = {"http", "https"}


class UnsafeURLError(ValueError):
    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(message)


def _is_blocked_ip(ip_str: str) -> bool:
    try:
        ip = ipaddress.ip_address(ip_str)
    except ValueError:
        return True
    return (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    )


def validate_public_http_url(raw_url: str) -> str:
    raw_url = (raw_url or "").strip()
    if not raw_url:
        raise UnsafeURLError("INVALID_URL", "url is required")

    parsed = urlparse(raw_url)
    if parsed.scheme not in ALLOWED_SCHEMES:
        raise UnsafeURLError("INVALID_URL", "only http/https URLs are supported")
    if not parsed.hostname:
        raise UnsafeURLError("INVALID_URL", "url is missing a host")
    if parsed.username or parsed.password:
        raise UnsafeURLError("INVALID_URL", "credentials in url are not allowed")

    try:
        addrinfo = socket.getaddrinfo(parsed.hostname, None)
    except socket.gaierror as err:
        raise UnsafeURLError("INVALID_URL", f"could not resolve host: {err}") from err

    resolved_ips = {info[4][0] for info in addrinfo}
    if not resolved_ips:
        raise UnsafeURLError("INVALID_URL", "could not resolve host")

    for ip in resolved_ips:
        if _is_blocked_ip(ip):
            raise UnsafeURLError(
                "INVALID_URL", "url resolves to a disallowed network address"
            )

    return raw_url
