package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func extractorStub(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/extract" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id":       "ext_123",
			"title":    "Example",
			"duration": 312,
			"formats": []map[string]any{
				{
					"id":          "137",
					"container":   "mp4",
					"height":      1080,
					"video_codec": "avc1",
					"url":         "https://cdn.example.com/video-1080p.mp4",
				},
				{
					"id":          "140",
					"container":   "m4a",
					"height":      0,
					"audio_codec": "mp4a.40.2",
					"url":         "https://cdn.example.com/audio.m4a",
				},
			},
		})
	}))
}

func TestCreateJobRequiresURL(t *testing.T) {
	router := setupRouter("http://example.com", http.DefaultClient)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/jobs", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d: %s", http.StatusBadRequest, rec.Code, rec.Body.String())
	}

	var payload map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("invalid json: %v", err)
	}
	errObj, ok := payload["error"].(map[string]any)
	if !ok || errObj["code"] != "INVALID_URL" {
		t.Fatalf("expected INVALID_URL error code, got: %s", rec.Body.String())
	}
}

func TestCreateJobRejectsPrivateNetworkURL(t *testing.T) {
	router := setupRouter("http://example.com", http.DefaultClient)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/jobs", strings.NewReader(`{"url":"http://127.0.0.1:8080/secret"}`))
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d: %s", http.StatusBadRequest, rec.Code, rec.Body.String())
	}

	var payload map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("invalid json: %v", err)
	}
	errObj, ok := payload["error"].(map[string]any)
	if !ok || errObj["code"] != "INVALID_URL" {
		t.Fatalf("expected INVALID_URL error code, got: %s", rec.Body.String())
	}
}

func TestCreateJobCallsExtractorAndReturnsReadyJob(t *testing.T) {
	extractor := extractorStub(t)
	defer extractor.Close()

	router := setupRouter(extractor.URL, extractor.Client())

	req := httptest.NewRequest(http.MethodPost, "/api/v1/jobs", strings.NewReader(`{"url":"https://example.com/video"}`))
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected status %d, got %d: %s", http.StatusAccepted, rec.Code, rec.Body.String())
	}

	var payload map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("invalid json: %v", err)
	}

	if payload["status"] != "READY" {
		t.Fatalf("expected ready status, got %v", payload["status"])
	}

	if _, ok := payload["job_id"]; !ok {
		t.Fatalf("expected job_id field in body: %s", rec.Body.String())
	}

	// The selected format should be the highest-resolution video track, and
	// the internal media URL must never be exposed in the public response.
	if payload["format_id"] != "137" {
		t.Fatalf("expected highest-resolution format to be selected, got %v", payload["format_id"])
	}
	if _, leaked := payload["media_url"]; leaked {
		t.Fatalf("media_url must not be present in the public job response")
	}
}

func TestCreateJobHonorsRequestedFormat(t *testing.T) {
	extractor := extractorStub(t)
	defer extractor.Close()

	router := setupRouter(extractor.URL, extractor.Client())

	req := httptest.NewRequest(http.MethodPost, "/api/v1/jobs", strings.NewReader(`{"url":"https://example.com/video","format":"140"}`))
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected status %d, got %d: %s", http.StatusAccepted, rec.Code, rec.Body.String())
	}

	var payload map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("invalid json: %v", err)
	}
	if payload["format_id"] != "140" {
		t.Fatalf("expected requested format to be honored, got %v", payload["format_id"])
	}
}

func TestPreviewReturnsMetadataWithoutCreatingJob(t *testing.T) {
	extractor := extractorStub(t)
	defer extractor.Close()

	router := setupRouter(extractor.URL, extractor.Client())

	req := httptest.NewRequest(http.MethodPost, "/api/v1/preview", strings.NewReader(`{"url":"https://example.com/video"}`))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
	}

	var payload map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("invalid json: %v", err)
	}
	if payload["title"] != "Example" {
		t.Fatalf("expected preview title, got %v", payload["title"])
	}
	if _, hasJobID := payload["job_id"]; hasJobID {
		t.Fatalf("preview must not create a job")
	}
}

func TestSearchRequiresQuery(t *testing.T) {
	router := setupRouter("http://example.com", http.DefaultClient)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/search", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d: %s", http.StatusBadRequest, rec.Code, rec.Body.String())
	}
}

func TestSearchProxiesExtractorResults(t *testing.T) {
	extractor := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/search" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["query"] != "lofi beats" {
			t.Fatalf("expected query to be forwarded, got %v", body["query"])
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"query": "lofi beats",
			"results": []map[string]any{
				{"id": "vid1", "title": "First result", "url": "https://www.youtube.com/watch?v=vid1"},
			},
		})
	}))
	defer extractor.Close()

	router := setupRouter(extractor.URL, extractor.Client())

	req := httptest.NewRequest(http.MethodPost, "/api/v1/search", strings.NewReader(`{"query":"lofi beats"}`))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
	}

	var payload map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("invalid json: %v", err)
	}
	results, ok := payload["results"].([]any)
	if !ok || len(results) != 1 {
		t.Fatalf("expected one result to be proxied through, got: %s", rec.Body.String())
	}
}

func TestSelectFormatPairPicksBestVideoAndPairsAudio(t *testing.T) {
	formats := []FormatEntry{
		{ID: "137", Container: "mp4", VideoCodec: "avc1", Height: 1080, URL: "https://cdn.example.com/v1080.mp4"},
		{ID: "133", Container: "mp4", VideoCodec: "avc1", Height: 480, URL: "https://cdn.example.com/v480.mp4"},
		{ID: "140", Container: "m4a", AudioCodec: "mp4a.40.2", URL: "https://cdn.example.com/audio.m4a"},
	}

	video, audio, err := selectFormatPair(formats, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if video.ID != "137" {
		t.Fatalf("expected highest-resolution video format, got %s", video.ID)
	}
	if audio.ID != "140" {
		t.Fatalf("expected companion audio format to be paired, got %q", audio.ID)
	}
}

func TestSelectFormatPairSkipsPairingForMuxedFormat(t *testing.T) {
	formats := []FormatEntry{
		{ID: "18", Container: "mp4", VideoCodec: "avc1", AudioCodec: "mp4a.40.2", Height: 360, URL: "https://cdn.example.com/muxed.mp4"},
	}

	video, audio, err := selectFormatPair(formats, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if video.ID != "18" {
		t.Fatalf("expected muxed format to be selected, got %s", video.ID)
	}
	if audio.ID != "" {
		t.Fatalf("muxed format should not need a paired audio format, got %q", audio.ID)
	}
}

func TestSelectFormatPairErrorsWhenNoAudioAvailableToPair(t *testing.T) {
	formats := []FormatEntry{
		{ID: "137", Container: "mp4", VideoCodec: "avc1", Height: 1080, URL: "https://cdn.example.com/v1080.mp4"},
	}

	if _, _, err := selectFormatPair(formats, ""); err == nil {
		t.Fatal("expected error when no audio track is available to pair with a video-only format")
	}
}

func TestJobLookupAndCancellation(t *testing.T) {
	extractor := extractorStub(t)
	defer extractor.Close()

	router := setupRouter(extractor.URL, extractor.Client())

	req := httptest.NewRequest(http.MethodPost, "/api/v1/jobs", strings.NewReader(`{"url":"https://example.com/video"}`))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	var payload map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("invalid job payload: %v", err)
	}
	jobID := payload["job_id"].(string)

	lookupReq := httptest.NewRequest(http.MethodGet, "/api/v1/jobs/"+jobID, nil)
	lookupRec := httptest.NewRecorder()
	router.ServeHTTP(lookupRec, lookupReq)
	if lookupRec.Code != http.StatusOK {
		t.Fatalf("expected lookup status %d, got %d: %s", http.StatusOK, lookupRec.Code, lookupRec.Body.String())
	}

	cancelReq := httptest.NewRequest(http.MethodPost, "/api/v1/jobs/"+jobID+"/cancel", nil)
	cancelRec := httptest.NewRecorder()
	router.ServeHTTP(cancelRec, cancelReq)
	if cancelRec.Code != http.StatusOK {
		t.Fatalf("expected cancel status %d, got %d: %s", http.StatusOK, cancelRec.Code, cancelRec.Body.String())
	}

	var cancelPayload map[string]any
	if err := json.Unmarshal(cancelRec.Body.Bytes(), &cancelPayload); err != nil {
		t.Fatalf("invalid cancel payload: %v", err)
	}
	if cancelPayload["status"] != "CANCELLED" {
		t.Fatalf("expected cancelled status, got %v", cancelPayload["status"])
	}
}
