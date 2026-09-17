package main

import (
	"net"
	"testing"
)

func mustParseIP(t *testing.T, raw string) net.IP {
	t.Helper()
	ip := net.ParseIP(raw)
	if ip == nil {
		t.Fatalf("could not parse ip %q", raw)
	}
	return ip
}

func TestValidateDownloadURLRejectsNonHTTPScheme(t *testing.T) {
	if err := validateDownloadURL("ftp://example.com/file"); err == nil {
		t.Fatal("expected error for non-http scheme")
	}
}

func TestValidateDownloadURLRejectsEmpty(t *testing.T) {
	if err := validateDownloadURL(""); err == nil {
		t.Fatal("expected error for empty url")
	}
}

func TestValidateDownloadURLRejectsCredentials(t *testing.T) {
	if err := validateDownloadURL("https://user:pass@example.com/video"); err == nil {
		t.Fatal("expected error for url with embedded credentials")
	}
}

func TestValidateDownloadURLRejectsLoopback(t *testing.T) {
	if err := validateDownloadURL("http://127.0.0.1:8080/secret"); err == nil {
		t.Fatal("expected error for loopback address")
	}
}

func TestValidateDownloadURLRejectsLinkLocalMetadata(t *testing.T) {
	if err := validateDownloadURL("http://169.254.169.254/latest/meta-data/"); err == nil {
		t.Fatal("expected error for link-local metadata address")
	}
}

func TestValidateDownloadURLRejectsPrivateRange(t *testing.T) {
	if err := validateDownloadURL("http://10.0.0.5/internal"); err == nil {
		t.Fatal("expected error for private ipv4 address")
	}
}

func TestIsBlockedIPClassification(t *testing.T) {
	blocked := []string{"127.0.0.1", "10.1.2.3", "192.168.1.1", "169.254.1.1", "::1", "fc00::1", "fe80::1"}
	for _, ip := range blocked {
		if !isBlockedIP(mustParseIP(t, ip)) {
			t.Errorf("expected %s to be blocked", ip)
		}
	}

	allowed := []string{"93.184.216.34", "8.8.8.8"}
	for _, ip := range allowed {
		if isBlockedIP(mustParseIP(t, ip)) {
			t.Errorf("expected %s to be allowed", ip)
		}
	}
}
