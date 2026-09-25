package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestBestPlayableAudioPrefersPlainM4A(t *testing.T) {
	formats := []FormatEntry{
		{ID: "137", Container: "mp4", VideoCodec: "avc1", URL: "https://x/v"},
		{ID: "251", Container: "webm", AudioCodec: "opus", FileSize: 400, URL: "https://x/opus"},
		{ID: "140-drc", Container: "m4a", AudioCodec: "mp4a", FileSize: 310, URL: "https://x/drc"},
		{ID: "140", Container: "m4a", AudioCodec: "mp4a", FileSize: 300, URL: "https://x/plain"},
		{ID: "139", Container: "m4a", AudioCodec: "mp4a", FileSize: 100, URL: "https://x/low"},
	}
	got, ok := bestPlayableAudio(formats)
	if !ok || got.ID != "140" {
		t.Fatalf("want plain 140 (m4a, non-drc, largest), got %+v ok=%v", got, ok)
	}
}

func TestBestPlayableAudioFallsBackToWebmAndIgnoresUnusable(t *testing.T) {
	got, ok := bestPlayableAudio([]FormatEntry{
		{ID: "137", Container: "mp4", VideoCodec: "avc1", URL: "https://x/v"},
		{ID: "140", Container: "m4a", AudioCodec: "mp4a"}, // no URL
		{ID: "251", Container: "webm", AudioCodec: "opus", URL: "https://x/opus"},
	})
	if !ok || got.ID != "251" {
		t.Fatalf("want webm fallback 251, got %+v ok=%v", got, ok)
	}
	if _, ok := bestPlayableAudio([]FormatEntry{{ID: "137", VideoCodec: "avc1", URL: "https://x/v"}}); ok {
		t.Fatal("video-only formats must not count as audio")
	}
}

func TestDefaultMediaHostAllowlist(t *testing.T) {
	for host, want := range map[string]bool{
		"rr3---sn-abc.googlevideo.com": true,
		"googlevideo.com":              true,
		"GOOGLEVIDEO.COM":              true,
		"googlevideo.com.evil.com":     false,
		"evilgooglevideo.com":          false,
		"127.0.0.1":                    false,
		"169.254.169.254":              false,
		"example.com":                  false,
	} {
		if got := isAllowedMediaHost(host); got != want {
			t.Errorf("isAllowedMediaHost(%q) = %v, want %v", host, got, want)
		}
	}
}

// mediaAndExtractor starts a fake media server (with Range support) and an
// extractor stub whose only audio format points at it.
func mediaAndExtractor(t *testing.T, audio []byte, withAudio bool) (extractorURL string) {
	t.Helper()
	media := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.ServeContent(w, r, "audio.m4a", time.Unix(0, 0), strings.NewReader(string(audio)))
	}))
	t.Cleanup(media.Close)

	formats := []map[string]any{
		{"id": "137", "container": "mp4", "video_codec": "avc1", "height": 1080, "url": "https://cdn.example.com/v.mp4"},
	}
	if withAudio {
		formats = append(formats, map[string]any{
			"id": "140", "container": "m4a", "audio_codec": "mp4a.40.2", "url": media.URL + "/audio.m4a",
		})
	}
	extractor := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "x", "title": "T", "duration": 10, "formats": formats})
	}))
	t.Cleanup(extractor.Close)
	return extractor.URL
}

func allowLocalMediaHost(t *testing.T) {
	t.Helper()
	orig := isAllowedMediaHost
	isAllowedMediaHost = func(host string) bool { return host == "127.0.0.1" }
	t.Cleanup(func() { isAllowedMediaHost = orig })
}

const audioTestVideoURL = "https://www.youtube.com/watch?v=abc123"

func TestAudioEndpointStreamsWholeFile(t *testing.T) {
	allowLocalMediaHost(t)
	body := []byte("0123456789ABCDEFGHIJ")
	router := setupRouter(mediaAndExtractor(t, body, true), http.DefaultClient)

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/audio?url="+audioTestVideoURL, nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	if rec.Body.String() != string(body) {
		t.Fatalf("body = %q", rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "audio/mp4" {
		t.Fatalf("content-type = %q", ct)
	}
	if rec.Header().Get("Accept-Ranges") != "bytes" {
		t.Fatal("Accept-Ranges must be advertised so players can seek")
	}
}

func TestAudioEndpointPassesRangeRequestsThrough(t *testing.T) {
	allowLocalMediaHost(t)
	body := []byte("0123456789ABCDEFGHIJ")
	router := setupRouter(mediaAndExtractor(t, body, true), http.DefaultClient)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/audio?url="+audioTestVideoURL, nil)
	req.Header.Set("Range", "bytes=5-9")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusPartialContent {
		t.Fatalf("status = %d, want 206", rec.Code)
	}
	if rec.Body.String() != "56789" {
		t.Fatalf("body = %q, want 56789", rec.Body.String())
	}
	if cr := rec.Header().Get("Content-Range"); cr != "bytes 5-9/20" {
		t.Fatalf("Content-Range = %q", cr)
	}
}

func TestAudioEndpointRejectsUnsupportedSources(t *testing.T) {
	// Default allowlist: a 127.0.0.1 media URL must be refused, not fetched.
	router := setupRouter(mediaAndExtractor(t, []byte("data"), true), http.DefaultClient)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/audio?url="+audioTestVideoURL, nil))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("disallowed host: status = %d, want 422", rec.Code)
	}
}

func TestAudioEndpointReportsMissingAudioAndBadURL(t *testing.T) {
	allowLocalMediaHost(t)
	router := setupRouter(mediaAndExtractor(t, []byte("data"), false), http.DefaultClient)

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/audio?url="+audioTestVideoURL, nil))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("no audio format: status = %d, want 422", rec.Code)
	}

	for _, bad := range []string{"", "ftp://example.com/x", "http://127.0.0.1/secret"} {
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/audio?url="+bad, nil))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("url %q: status = %d, want 400", bad, rec.Code)
		}
	}
}
