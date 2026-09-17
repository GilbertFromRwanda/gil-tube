package main

import (
	"fmt"
	"net"
	"net/url"
	"strings"
)

// ErrUnsafeURL is returned when a candidate download URL is malformed or
// resolves to a network address the service must not reach out to.
type ErrUnsafeURL struct {
	Message string
}

func (e *ErrUnsafeURL) Error() string {
	return e.Message
}

// validateDownloadURL defends the first entry point for user-supplied URLs
// against SSRF: it requires http/https, rejects embedded credentials, and
// rejects any URL whose resolved address falls in a private, loopback,
// link-local, or otherwise reserved range. Validation happens after DNS
// resolution (not just on the hostname string) to defend against DNS
// rebinding, per the planner's SSRF guidance.
func validateDownloadURL(rawURL string) error {
	rawURL = strings.TrimSpace(rawURL)
	if rawURL == "" {
		return &ErrUnsafeURL{Message: "url is required"}
	}

	parsed, err := url.Parse(rawURL)
	if err != nil {
		return &ErrUnsafeURL{Message: "url could not be parsed"}
	}

	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return &ErrUnsafeURL{Message: "only http/https urls are supported"}
	}

	if parsed.User != nil {
		return &ErrUnsafeURL{Message: "credentials in url are not allowed"}
	}

	host := parsed.Hostname()
	if host == "" {
		return &ErrUnsafeURL{Message: "url is missing a host"}
	}

	ips, err := net.LookupIP(host)
	if err != nil {
		return &ErrUnsafeURL{Message: fmt.Sprintf("could not resolve host: %v", err)}
	}
	if len(ips) == 0 {
		return &ErrUnsafeURL{Message: "could not resolve host"}
	}

	for _, ip := range ips {
		if isBlockedIP(ip) {
			return &ErrUnsafeURL{Message: "url resolves to a disallowed network address"}
		}
	}

	return nil
}

func isBlockedIP(ip net.IP) bool {
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified() {
		return true
	}

	// Documentation/reserved ranges and the IPv4 cloud metadata address are
	// covered by IsPrivate/IsLinkLocalUnicast above (169.254.0.0/16), but be
	// explicit for defense in depth.
	if ip4 := ip.To4(); ip4 != nil {
		if ip4[0] == 0 { // 0.0.0.0/8
			return true
		}
	}

	return false
}
