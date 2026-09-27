package main

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestClampSpeedTestBytes(t *testing.T) {
	cases := map[string]int{
		"":         speedTestDefaultBytes,
		"abc":      speedTestDefaultBytes,
		"-5":       speedTestDefaultBytes,
		"0":        speedTestDefaultBytes,
		"1000":     1000,
		"99999999": speedTestMaxBytes,
	}
	for in, want := range cases {
		if got := clampSpeedTestBytes(in); got != want {
			t.Errorf("clampSpeedTestBytes(%q) = %d, want %d", in, got, want)
		}
	}
}

func TestSpeedTestServesExactlyTheRequestedBytesUncached(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	registerSpeedTestRoutes(r)

	for _, size := range []int{1, 1000, speedTestChunkBytes, speedTestChunkBytes + 7, 300000} {
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/speedtest?bytes="+itoa(size), nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("size %d: status %d", size, rec.Code)
		}
		if rec.Body.Len() != size {
			t.Errorf("size %d: body has %d bytes", size, rec.Body.Len())
		}
		if rec.Header().Get("Cache-Control") != "no-store" {
			t.Errorf("size %d: must not be cacheable, got %q", size, rec.Header().Get("Cache-Control"))
		}
	}

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/speedtest", nil))
	if rec.Body.Len() != speedTestDefaultBytes {
		t.Errorf("default size: got %d bytes, want %d", rec.Body.Len(), speedTestDefaultBytes)
	}
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/speedtest?bytes=999999999", nil))
	if rec.Body.Len() != speedTestMaxBytes {
		t.Errorf("oversize request: got %d bytes, want the %d cap", rec.Body.Len(), speedTestMaxBytes)
	}
}

func itoa(n int) string {
	digits := ""
	if n == 0 {
		return "0"
	}
	for n > 0 {
		digits = string(rune('0'+n%10)) + digits
		n /= 10
	}
	return digits
}
