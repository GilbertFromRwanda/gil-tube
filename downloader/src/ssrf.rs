//! SSRF defenses for the downloader.
//!
//! The downloader makes outbound requests to whatever URL it is given, so
//! every request (including redirect hops) must be validated against the
//! *resolved* IP address, not just the hostname string, to defend against
//! DNS-rebinding attacks against internal services.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};

#[derive(Debug)]
pub struct UnsafeUrl(pub String);

impl std::fmt::Display for UnsafeUrl {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "unsafe url: {}", self.0)
    }
}

impl std::error::Error for UnsafeUrl {}

fn is_blocked_ipv4(ip: &Ipv4Addr) -> bool {
    ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_documentation()
        || ip.is_unspecified()
        || ip.is_multicast()
}

fn is_blocked_ipv6(ip: &Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4_mapped() {
        return is_blocked_ipv4(&v4);
    }
    ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        || is_unique_local(ip)
        || is_unicast_link_local(ip)
}

// Rust's std IPv6 helper methods for these ranges are still unstable on
// some toolchains, so classify by prefix directly instead of depending on
// an unstable API surface.
fn is_unique_local(ip: &Ipv6Addr) -> bool {
    (ip.segments()[0] & 0xfe00) == 0xfc00
}

fn is_unicast_link_local(ip: &Ipv6Addr) -> bool {
    (ip.segments()[0] & 0xffc0) == 0xfe80
}

pub fn is_blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_blocked_ipv4(&v4),
        IpAddr::V6(v6) => is_blocked_ipv6(&v6),
    }
}

/// Resolves `host:port` and returns an error if it cannot be resolved or if
/// any resolved address falls in a blocked range. Synchronous: callers on
/// the async runtime should keep this off hot paths that need low latency,
/// but it is required inside `reqwest`'s synchronous redirect-policy hook.
pub fn resolve_and_check(host: &str, port: u16) -> Result<Vec<SocketAddr>, UnsafeUrl> {
    let addrs: Vec<SocketAddr> = (host, port)
        .to_socket_addrs()
        .map_err(|_| UnsafeUrl(format!("could not resolve host: {host}")))?
        .collect();

    if addrs.is_empty() {
        return Err(UnsafeUrl(format!("could not resolve host: {host}")));
    }

    for addr in &addrs {
        if is_blocked_ip(addr.ip()) {
            return Err(UnsafeUrl(format!(
                "host {host} resolves to a disallowed network address"
            )));
        }
    }

    Ok(addrs)
}

/// Validates scheme, absence of embedded credentials, and resolved-address
/// safety for a candidate download URL.
pub fn validate_url(raw_url: &str) -> Result<url::Url, UnsafeUrl> {
    let parsed = url::Url::parse(raw_url).map_err(|_| UnsafeUrl("invalid url".to_string()))?;

    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(UnsafeUrl("only http/https urls are supported".to_string()));
    }

    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(UnsafeUrl("credentials in url are not allowed".to_string()));
    }

    let host = parsed
        .host_str()
        .ok_or_else(|| UnsafeUrl("url is missing a host".to_string()))?;
    let port = parsed
        .port_or_known_default()
        .ok_or_else(|| UnsafeUrl("url is missing a port".to_string()))?;

    resolve_and_check(host, port)?;

    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_private_ipv4() {
        assert!(is_blocked_ip("10.0.0.5".parse().unwrap()));
        assert!(is_blocked_ip("192.168.1.1".parse().unwrap()));
        assert!(is_blocked_ip("127.0.0.1".parse().unwrap()));
        assert!(is_blocked_ip("169.254.169.254".parse().unwrap()));
    }

    #[test]
    fn allows_public_ipv4() {
        assert!(!is_blocked_ip("93.184.216.34".parse().unwrap()));
    }

    #[test]
    fn blocks_ipv6_loopback_and_unique_local() {
        assert!(is_blocked_ip("::1".parse().unwrap()));
        assert!(is_blocked_ip("fd00::1".parse().unwrap()));
        assert!(is_blocked_ip("fe80::1".parse().unwrap()));
    }

    #[test]
    fn rejects_non_http_scheme() {
        assert!(validate_url("ftp://example.com/file").is_err());
    }

    #[test]
    fn rejects_credentials() {
        assert!(validate_url("https://user:pass@example.com/video").is_err());
    }

    #[test]
    fn rejects_loopback_literal() {
        assert!(validate_url("http://127.0.0.1:8080/secret").is_err());
    }
}
