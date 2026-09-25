package main

import (
	"bytes"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	_ "github.com/lib/pq"
	"github.com/nats-io/nats.go"
)

type Job struct {
	ID        string `json:"job_id"`
	Status    string `json:"status"`
	Title     string `json:"title,omitempty"`
	URL       string `json:"url,omitempty"`
	FormatID  string `json:"format_id,omitempty"`
	Container string `json:"container,omitempty"`
	// Duration is the media length in seconds, used by the downloader to
	// compute a percentage for the ffmpeg mux phase.
	Duration int `json:"duration,omitempty"`
	// MediaURL and AudioMediaURL are direct, resolved CDN URLs the downloader
	// fetches. They are internal implementation details (and may be
	// short-lived signed URLs), so they are deliberately excluded from the
	// public API response. AudioMediaURL is set only when the selected video
	// format has no audio track and must be muxed with a separate audio
	// stream (the common case for modern YouTube uploads, which rarely serve
	// a single combined audio+video file).
	MediaURL      string    `json:"-"`
	AudioMediaURL string    `json:"-"`
	ErrorCode     string    `json:"error_code,omitempty"`
	ErrorMessage  string    `json:"error_message,omitempty"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
}

type ExtractResponse struct {
	ID       string        `json:"id"`
	Title    string        `json:"title"`
	Duration int           `json:"duration"`
	Formats  []FormatEntry `json:"formats"`
}

type FormatEntry struct {
	ID         string  `json:"id"`
	Container  string  `json:"container"`
	VideoCodec string  `json:"video_codec,omitempty"`
	AudioCodec string  `json:"audio_codec,omitempty"`
	Height     int     `json:"height,omitempty"`
	FPS        float64 `json:"fps,omitempty"`
	FileSize   int64   `json:"filesize,omitempty"`
	URL        string  `json:"url,omitempty"`
}

func isMuxed(f FormatEntry) bool     { return f.VideoCodec != "" && f.AudioCodec != "" }
func isVideoOnly(f FormatEntry) bool { return f.VideoCodec != "" && f.AudioCodec == "" }
func isAudioOnly(f FormatEntry) bool { return f.AudioCodec != "" && f.VideoCodec == "" }

// bestAudioFor picks a companion audio-only format for a video-only stream,
// preferring a container compatible with the video's container so the
// downloader can mux them with ffmpeg using a codec copy (no transcoding).
func bestAudioFor(formats []FormatEntry, videoContainer string) (FormatEntry, bool) {
	preferredContainers := map[string]bool{}
	switch videoContainer {
	case "mp4":
		preferredContainers = map[string]bool{"m4a": true, "mp4": true}
	case "webm":
		preferredContainers = map[string]bool{"webm": true}
	}

	var bestPreferred, bestAny FormatEntry
	havePreferred, haveAny := false, false
	for _, f := range formats {
		if f.URL == "" || !isAudioOnly(f) {
			continue
		}
		if !haveAny || f.FileSize > bestAny.FileSize {
			bestAny = f
			haveAny = true
		}
		if preferredContainers[f.Container] && (!havePreferred || f.FileSize > bestPreferred.FileSize) {
			bestPreferred = f
			havePreferred = true
		}
	}
	if havePreferred {
		return bestPreferred, true
	}
	return bestAny, haveAny
}

// selectFormatPair resolves the caller's requested format id (if any) to a
// concrete download plan. Modern YouTube rarely serves a single muxed
// audio+video stream, so when the chosen format is video-only, a companion
// audio-only format is selected too and the downloader muxes them with
// ffmpeg. audio.ID is empty when no muxing is required.
func selectFormatPair(formats []FormatEntry, requested string) (video FormatEntry, audio FormatEntry, err error) {
	var chosen FormatEntry
	found := false

	if strings.TrimSpace(requested) != "" {
		for _, f := range formats {
			if f.ID == requested {
				chosen = f
				found = true
				break
			}
		}
		if !found {
			return FormatEntry{}, FormatEntry{}, fmt.Errorf("requested format %q is not available", requested)
		}
		if chosen.URL == "" {
			return FormatEntry{}, FormatEntry{}, fmt.Errorf("requested format %q has no downloadable source", requested)
		}
	} else {
		best := FormatEntry{}
		haveVideo := false
		for _, f := range formats {
			if f.URL == "" || !(isVideoOnly(f) || isMuxed(f)) {
				continue
			}
			if f.Height > best.Height {
				best = f
				haveVideo = true
			}
		}
		if haveVideo {
			chosen, found = best, true
		} else {
			for _, f := range formats {
				if f.URL != "" && isAudioOnly(f) {
					chosen, found = f, true
					break
				}
			}
		}
		if !found {
			return FormatEntry{}, FormatEntry{}, fmt.Errorf("no downloadable formats available")
		}
	}

	if isMuxed(chosen) || isAudioOnly(chosen) {
		return chosen, FormatEntry{}, nil
	}

	audioFormat, ok := bestAudioFor(formats, chosen.Container)
	if !ok {
		return FormatEntry{}, FormatEntry{}, fmt.Errorf("no audio track available to pair with video format %q", chosen.ID)
	}
	return chosen, audioFormat, nil
}

// NewJobParams groups the fields needed to create a job. It's a struct
// rather than positional parameters because the field count has grown
// (format pairing, media duration for mux progress) and keeps growing.
type NewJobParams struct {
	URL           string
	Title         string
	MediaURL      string
	AudioMediaURL string
	FormatID      string
	Container     string
	Duration      int
}

type JobStore interface {
	Create(params NewJobParams) (*Job, error)
	Get(id string) (*Job, bool, error)
	Cancel(id string) (*Job, bool, error)
}

type InMemoryJobStore struct {
	mu   sync.RWMutex
	jobs map[string]*Job
}

func newInMemoryJobStore() *InMemoryJobStore {
	return &InMemoryJobStore{jobs: make(map[string]*Job)}
}

func (s *InMemoryJobStore) Create(params NewJobParams) (*Job, error) {
	job := &Job{
		ID:            makeJobID(),
		Status:        "READY",
		Title:         params.Title,
		URL:           params.URL,
		MediaURL:      params.MediaURL,
		AudioMediaURL: params.AudioMediaURL,
		FormatID:      params.FormatID,
		Container:     params.Container,
		Duration:      params.Duration,
		CreatedAt:     time.Now().UTC(),
		UpdatedAt:     time.Now().UTC(),
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	s.jobs[job.ID] = job
	return job, nil
}

func (s *InMemoryJobStore) Get(id string) (*Job, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	job, ok := s.jobs[id]
	if !ok {
		return nil, false, nil
	}
	jobCopy := *job
	return &jobCopy, true, nil
}

func (s *InMemoryJobStore) Cancel(id string) (*Job, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	job, ok := s.jobs[id]
	if !ok {
		return nil, false, nil
	}
	job.Status = "CANCELLED"
	job.UpdatedAt = time.Now().UTC()
	jobCopy := *job
	return &jobCopy, true, nil
}

type PostgresJobStore struct {
	db *sql.DB
}

func newPostgresJobStore(connString string) (*PostgresJobStore, error) {
	db, err := sql.Open("postgres", connString)
	if err != nil {
		return nil, err
	}

	if err := db.Ping(); err != nil {
		_ = db.Close()
		return nil, err
	}

	_, err = db.Exec(`
		CREATE TABLE IF NOT EXISTS jobs (
			id TEXT PRIMARY KEY,
			status TEXT NOT NULL,
			title TEXT,
			url TEXT NOT NULL,
			media_url TEXT,
			audio_media_url TEXT,
			format_id TEXT,
			container TEXT,
			duration_seconds INTEGER,
			error_code TEXT,
			error_message TEXT,
			created_at TIMESTAMPTZ NOT NULL,
			updated_at TIMESTAMPTZ NOT NULL
		)`)
	if err != nil {
		_ = db.Close()
		return nil, err
	}

	// Defensive for pre-existing dev databases created before these columns
	// existed; a no-op once the table above is created fresh.
	for _, stmt := range []string{
		`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS media_url TEXT`,
		`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS audio_media_url TEXT`,
		`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS format_id TEXT`,
		`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS container TEXT`,
		`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS duration_seconds INTEGER`,
		`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS error_code TEXT`,
		`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS error_message TEXT`,
	} {
		if _, err := db.Exec(stmt); err != nil {
			_ = db.Close()
			return nil, err
		}
	}

	return &PostgresJobStore{db: db}, nil
}

func (s *PostgresJobStore) Create(params NewJobParams) (*Job, error) {
	job := &Job{
		ID:            makeJobID(),
		Status:        "READY",
		Title:         params.Title,
		URL:           params.URL,
		MediaURL:      params.MediaURL,
		AudioMediaURL: params.AudioMediaURL,
		FormatID:      params.FormatID,
		Container:     params.Container,
		Duration:      params.Duration,
		CreatedAt:     time.Now().UTC(),
		UpdatedAt:     time.Now().UTC(),
	}
	_, err := s.db.Exec(
		`INSERT INTO jobs (id, status, title, url, media_url, audio_media_url, format_id, container, duration_seconds, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
		job.ID, job.Status, job.Title, job.URL, job.MediaURL, job.AudioMediaURL, job.FormatID, job.Container, job.Duration, job.CreatedAt, job.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	return job, nil
}

func (s *PostgresJobStore) Get(id string) (*Job, bool, error) {
	row := s.db.QueryRow(
		`SELECT id, status, title, url, media_url, audio_media_url, format_id, container, duration_seconds, error_code, error_message, created_at, updated_at
		 FROM jobs WHERE id = $1`, id,
	)
	job := &Job{}
	var mediaURL, audioMediaURL, formatID, container, errorCode, errorMessage sql.NullString
	var duration sql.NullInt64
	if err := row.Scan(&job.ID, &job.Status, &job.Title, &job.URL, &mediaURL, &audioMediaURL, &formatID, &container, &duration, &errorCode, &errorMessage, &job.CreatedAt, &job.UpdatedAt); err != nil {
		if err == sql.ErrNoRows {
			return nil, false, nil
		}
		return nil, false, err
	}
	job.MediaURL = mediaURL.String
	job.AudioMediaURL = audioMediaURL.String
	job.FormatID = formatID.String
	job.Container = container.String
	job.Duration = int(duration.Int64)
	job.ErrorCode = errorCode.String
	job.ErrorMessage = errorMessage.String
	return job, true, nil
}

func (s *PostgresJobStore) Cancel(id string) (*Job, bool, error) {
	job, found, err := s.Get(id)
	if err != nil || !found {
		return job, found, err
	}
	job.Status = "CANCELLED"
	job.UpdatedAt = time.Now().UTC()
	_, err = s.db.Exec(`UPDATE jobs SET status = $1, updated_at = $2 WHERE id = $3`, job.Status, job.UpdatedAt, job.ID)
	if err != nil {
		return nil, false, err
	}
	return job, true, nil
}

type EventPublisher interface {
	PublishJobReady(job *Job) error
	PublishJobCancelled(job *Job) error
}

type NoopEventPublisher struct{}

func (NoopEventPublisher) PublishJobReady(job *Job) error     { return nil }
func (NoopEventPublisher) PublishJobCancelled(job *Job) error { return nil }

type NatsEventPublisher struct {
	nc *nats.Conn
}

func newNatsEventPublisher(url string) EventPublisher {
	if strings.TrimSpace(url) == "" {
		return NoopEventPublisher{}
	}
	conn, err := nats.Connect(url)
	if err != nil {
		return NoopEventPublisher{}
	}
	return &NatsEventPublisher{nc: conn}
}

// jobReadyPayload carries only what the download worker needs, independent
// of the public Job JSON shape (which intentionally omits MediaURL).
type jobReadyPayload struct {
	JobID           string `json:"job_id"`
	Title           string `json:"title,omitempty"`
	URL             string `json:"url,omitempty"`
	MediaURL        string `json:"media_url"`
	AudioURL        string `json:"audio_url,omitempty"`
	FormatID        string `json:"format_id,omitempty"`
	Container       string `json:"container,omitempty"`
	DurationSeconds int    `json:"duration_seconds,omitempty"`
}

func (p *NatsEventPublisher) PublishJobReady(job *Job) error {
	payload, err := json.Marshal(map[string]any{
		"event": "jobs.ready",
		"job": jobReadyPayload{
			JobID:           job.ID,
			Title:           job.Title,
			URL:             job.URL,
			MediaURL:        job.MediaURL,
			AudioURL:        job.AudioMediaURL,
			FormatID:        job.FormatID,
			Container:       job.Container,
			DurationSeconds: job.Duration,
		},
	})
	if err != nil {
		return err
	}
	return p.nc.Publish("jobs.ready", payload)
}

func (p *NatsEventPublisher) PublishJobCancelled(job *Job) error {
	payload, err := json.Marshal(map[string]any{"event": "jobs.cancelled", "job": map[string]string{"job_id": job.ID}})
	if err != nil {
		return err
	}
	return p.nc.Publish("jobs.cancelled", payload)
}

func envOrDefault(key string, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func newJobStoreFromEnv() JobStore {
	connString := envOrDefault("DATABASE_URL", "postgres://gil_tube:gil_tube@localhost:5432/gil_tube?sslmode=disable")
	if store, err := newPostgresJobStore(connString); err == nil {
		return store
	}
	return newInMemoryJobStore()
}

func newEventPublisherFromEnv() EventPublisher {
	return newNatsEventPublisher(envOrDefault("NATS_URL", "nats://localhost:4222"))
}

var extractorURL = "http://localhost:9000"

func defaultExtractorURL() string {
	if value := strings.TrimSpace(os.Getenv("EXTRACTOR_URL")); value != "" {
		return value
	}
	return extractorURL
}

func defaultDownloaderURL() string {
	return envOrDefault("DOWNLOADER_URL", "http://localhost:8000")
}

func apiError(code, message string) gin.H {
	return gin.H{"error": gin.H{"code": code, "message": message}}
}

// callExtractor calls the extractor service and returns either the parsed
// response (status 200) or the raw status/body so the caller can proxy a
// structured error envelope through unchanged.
func callExtractor(extractorBaseURL string, httpClient *http.Client, url string) (*ExtractResponse, int, []byte, error) {
	reqBody, err := json.Marshal(map[string]string{"url": url})
	if err != nil {
		return nil, 0, nil, err
	}

	req, err := http.NewRequest(http.MethodPost, extractorBaseURL+"/api/v1/extract", bytes.NewReader(reqBody))
	if err != nil {
		return nil, 0, nil, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, 0, nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, 0, nil, err
	}

	if resp.StatusCode != http.StatusOK {
		return nil, resp.StatusCode, body, nil
	}

	var extractResp ExtractResponse
	if err := json.Unmarshal(body, &extractResp); err != nil {
		return nil, 0, nil, err
	}
	return &extractResp, http.StatusOK, body, nil
}

// callExtractorSearch proxies a search query to the extractor and returns
// its raw status/body, since the API doesn't need to inspect the result
// shape itself (it's passed straight through to the browser).
func callExtractorSearch(extractorBaseURL string, httpClient *http.Client, query string, limit int, refresh bool) (int, []byte, error) {
	reqBody, err := json.Marshal(map[string]any{"query": query, "limit": limit, "refresh": refresh})
	if err != nil {
		return 0, nil, err
	}

	req, err := http.NewRequest(http.MethodPost, extractorBaseURL+"/api/v1/search", bytes.NewReader(reqBody))
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := httpClient.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return 0, nil, err
	}
	return resp.StatusCode, body, nil
}

func callExtractorCachedSearches(extractorBaseURL string, httpClient *http.Client, limit, offset int) (int, []byte, error) {
	req, err := http.NewRequest(http.MethodGet, fmt.Sprintf("%s/api/v1/cached-searches?limit=%d&offset=%d", extractorBaseURL, limit, offset), nil)
	if err != nil {
		return 0, nil, err
	}

	resp, err := httpClient.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return 0, nil, err
	}
	return resp.StatusCode, body, nil
}

func callExtractorSearchSuggestions(extractorBaseURL string, httpClient *http.Client, prefix string, limit int) (int, []byte, error) {
	endpoint := fmt.Sprintf("%s/api/v1/search-suggestions?limit=%d&q=%s", extractorBaseURL, limit, url.QueryEscape(prefix))
	req, err := http.NewRequest(http.MethodGet, endpoint, nil)
	if err != nil {
		return 0, nil, err
	}

	resp, err := httpClient.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return 0, nil, err
	}
	return resp.StatusCode, body, nil
}

// sanitizeFilename strips a video title down to characters safe to embed in
// an HTTP header value. Titles come from untrusted third-party content, so
// this also blocks header-injection via embedded CR/LF/quote characters.
func sanitizeFilename(name string) string {
	var b strings.Builder
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == ' ' || r == '-' || r == '_' || r == '.' || r == '(' || r == ')':
			b.WriteRune(r)
		}
	}
	result := strings.TrimSpace(b.String())
	if len(result) > 100 {
		result = result[:100]
	}
	if result == "" {
		result = "download"
	}
	return result
}

// corsMiddleware reflects whatever Origin the browser sent, rather than
// checking it against one fixed configured value: the web UI can be
// opened from localhost, a LAN IP, or (on a phone) a different device
// entirely, and none of those are known ahead of time. This is safe here
// because the API has no cookie/session-based auth for a permissive CORS
// policy to leak, and the one genuinely sensitive operation (fetching an
// arbitrary URL) is independently guarded by SSRF validation on the
// download target itself, regardless of the caller's origin.
func corsMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		if origin := c.GetHeader("Origin"); origin != "" {
			c.Header("Access-Control-Allow-Origin", origin)
			c.Header("Vary", "Origin")
		}
		c.Header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		c.Header("Access-Control-Allow-Headers", "Content-Type")
		if c.Request.Method == http.MethodOptions {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	}
}

func setupRouter(extractorBaseURL string, httpClient *http.Client) *gin.Engine {
	return setupRouterWithDeps(extractorBaseURL, defaultDownloaderURL(), httpClient, newJobStoreFromEnv(), newEventPublisherFromEnv())
}

func setupRouterWithDeps(extractorBaseURL, downloaderBaseURL string, httpClient *http.Client, jobs JobStore, publisher EventPublisher) *gin.Engine {
	gin.SetMode(gin.ReleaseMode)
	r := gin.Default()
	r.Use(corsMiddleware())

	// Unbounded client for streaming large files through the file-download
	// proxy below; the extraction httpClient's timeout would otherwise cut
	// off long-running downloads part way through the response body.
	streamClient := &http.Client{}

	r.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"status":  "ok",
			"service": "api",
			"time":    time.Now().UTC().Format(time.RFC3339),
		})
	})

	r.GET("/api/v1/ready", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ready"})
	})

	r.POST("/api/v1/preview", func(c *gin.Context) {
		var payload struct {
			URL string `json:"url"`
		}

		if err := c.ShouldBindJSON(&payload); err != nil || strings.TrimSpace(payload.URL) == "" {
			c.JSON(http.StatusBadRequest, apiError("INVALID_URL", "url is required"))
			return
		}

		if err := validateDownloadURL(payload.URL); err != nil {
			c.JSON(http.StatusBadRequest, apiError("INVALID_URL", err.Error()))
			return
		}

		extractResp, status, body, err := callExtractor(extractorBaseURL, httpClient, payload.URL)
		if err != nil {
			c.JSON(http.StatusBadGateway, apiError("EXTRACTION_FAILED", "extractor unavailable"))
			return
		}
		if status != http.StatusOK {
			c.Data(status, "application/json", body)
			return
		}
		c.JSON(http.StatusOK, extractResp)
	})

	registerAudioRoutes(r, extractorBaseURL, httpClient)

	r.POST("/api/v1/search", func(c *gin.Context) {
		var payload struct {
			Query   string `json:"query"`
			Limit   int    `json:"limit"`
			Refresh bool   `json:"refresh"`
		}

		if err := c.ShouldBindJSON(&payload); err != nil || strings.TrimSpace(payload.Query) == "" {
			c.JSON(http.StatusBadRequest, apiError("INVALID_QUERY", "query is required"))
			return
		}
		if payload.Limit <= 0 {
			payload.Limit = 12
		}

		status, body, err := callExtractorSearch(extractorBaseURL, httpClient, payload.Query, payload.Limit, payload.Refresh)
		if err != nil {
			c.JSON(http.StatusBadGateway, apiError("SEARCH_FAILED", "extractor unavailable"))
			return
		}
		c.Data(status, "application/json", body)
	})

	r.GET("/api/v1/search-suggestions", func(c *gin.Context) {
		prefix := strings.TrimSpace(c.Query("q"))
		if len(prefix) > 200 {
			prefix = prefix[:200]
		}
		limit := 8
		if raw := c.Query("limit"); raw != "" {
			if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 && parsed <= 8 {
				limit = parsed
			}
		}

		status, body, err := callExtractorSearchSuggestions(extractorBaseURL, httpClient, prefix, limit)
		if err != nil {
			c.JSON(http.StatusBadGateway, apiError("SEARCH_FAILED", "extractor unavailable"))
			return
		}
		c.Data(status, "application/json", body)
	})

	r.GET("/api/v1/cached-searches", func(c *gin.Context) {
		limit := 24
		if raw := c.Query("limit"); raw != "" {
			if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
				limit = parsed
			}
		}
		offset := 0
		if raw := c.Query("offset"); raw != "" {
			if parsed, err := strconv.Atoi(raw); err == nil && parsed >= 0 {
				offset = parsed
			}
		}

		status, body, err := callExtractorCachedSearches(extractorBaseURL, httpClient, limit, offset)
		if err != nil {
			c.JSON(http.StatusBadGateway, apiError("SEARCH_FAILED", "extractor unavailable"))
			return
		}
		c.Data(status, "application/json", body)
	})

	r.POST("/api/v1/jobs", func(c *gin.Context) {
		var payload struct {
			URL    string `json:"url"`
			Format string `json:"format"`
		}

		if err := c.ShouldBindJSON(&payload); err != nil || strings.TrimSpace(payload.URL) == "" {
			c.JSON(http.StatusBadRequest, apiError("INVALID_URL", "url is required"))
			return
		}

		if err := validateDownloadURL(payload.URL); err != nil {
			c.JSON(http.StatusBadRequest, apiError("INVALID_URL", err.Error()))
			return
		}

		extractResp, status, body, err := callExtractor(extractorBaseURL, httpClient, payload.URL)
		if err != nil {
			c.JSON(http.StatusBadGateway, apiError("EXTRACTION_FAILED", "extractor unavailable"))
			return
		}

		if status != http.StatusOK {
			// Proxy the extractor's structured error envelope through as-is
			// rather than re-wrapping already-JSON content as a string.
			c.Data(status, "application/json", body)
			return
		}

		video, audio, err := selectFormatPair(extractResp.Formats, payload.Format)
		if err != nil {
			c.JSON(http.StatusUnprocessableEntity, apiError("FORMAT_UNAVAILABLE", err.Error()))
			return
		}

		job, err := jobs.Create(NewJobParams{
			URL:           payload.URL,
			Title:         extractResp.Title,
			MediaURL:      video.URL,
			AudioMediaURL: audio.URL,
			FormatID:      video.ID,
			Container:     video.Container,
			Duration:      extractResp.Duration,
		})
		if err != nil {
			c.JSON(http.StatusInternalServerError, apiError("EXTRACTION_FAILED", "failed to create job"))
			return
		}
		_ = publisher.PublishJobReady(job)
		c.JSON(http.StatusAccepted, job)
	})

	r.GET("/api/v1/jobs/:id", func(c *gin.Context) {
		id := c.Param("id")
		job, ok, err := jobs.Get(id)
		if err != nil {
			c.JSON(http.StatusInternalServerError, apiError("JOB_LOOKUP_FAILED", "could not fetch job"))
			return
		}
		if !ok {
			c.JSON(http.StatusNotFound, apiError("JOB_NOT_FOUND", "job not found"))
			return
		}
		c.JSON(http.StatusOK, job)
	})

	r.POST("/api/v1/jobs/:id/cancel", func(c *gin.Context) {
		id := c.Param("id")
		job, ok, err := jobs.Cancel(id)
		if err != nil {
			c.JSON(http.StatusInternalServerError, apiError("JOB_CANCEL_FAILED", "could not cancel job"))
			return
		}
		if !ok {
			c.JSON(http.StatusNotFound, apiError("JOB_NOT_FOUND", "job not found"))
			return
		}
		_ = publisher.PublishJobCancelled(job)
		c.JSON(http.StatusOK, job)
	})

	r.GET("/api/v1/jobs/:id/progress", func(c *gin.Context) {
		id := c.Param("id")
		job, ok, err := jobs.Get(id)
		if err != nil {
			c.JSON(http.StatusInternalServerError, apiError("JOB_LOOKUP_FAILED", "could not fetch job"))
			return
		}
		if !ok {
			c.JSON(http.StatusNotFound, apiError("JOB_NOT_FOUND", "job not found"))
			return
		}

		fallback := gin.H{
			"job_id":                 id,
			"status":                 job.Status,
			"bytes_downloaded":       0,
			"bytes_total":            nil,
			"speed_bytes_per_second": 0,
		}

		req, err := http.NewRequest(http.MethodGet, downloaderBaseURL+"/downloads/"+id+"/progress", nil)
		if err != nil {
			c.JSON(http.StatusOK, fallback)
			return
		}
		resp, err := httpClient.Do(req)
		if err != nil {
			// The downloader has no record of this job: it either hasn't
			// started the transfer yet or has already finished. Report the
			// job's own terminal status instead of a hard error.
			c.JSON(http.StatusOK, fallback)
			return
		}
		defer resp.Body.Close()

		if resp.StatusCode == http.StatusNotFound {
			c.JSON(http.StatusOK, fallback)
			return
		}

		body, err := io.ReadAll(resp.Body)
		if err != nil {
			c.JSON(http.StatusOK, fallback)
			return
		}
		c.Data(resp.StatusCode, "application/json", body)
	})

	r.GET("/api/v1/jobs/:id/file", func(c *gin.Context) {
		id := c.Param("id")
		job, ok, err := jobs.Get(id)
		if err != nil {
			c.JSON(http.StatusInternalServerError, apiError("JOB_LOOKUP_FAILED", "could not fetch job"))
			return
		}
		if !ok {
			c.JSON(http.StatusNotFound, apiError("JOB_NOT_FOUND", "job not found"))
			return
		}
		if job.Status != "COMPLETED" {
			c.JSON(http.StatusConflict, apiError("JOB_NOT_READY", "job has not completed"))
			return
		}

		ext := job.Container
		if ext == "" {
			ext = "bin"
		}
		filename := fmt.Sprintf("%s.%s", job.ID, ext)

		req, err := http.NewRequest(http.MethodGet, downloaderBaseURL+"/files/"+filename, nil)
		if err != nil {
			c.JSON(http.StatusInternalServerError, apiError("FILE_UNAVAILABLE", "could not build file request"))
			return
		}
		resp, err := streamClient.Do(req)
		if err != nil {
			c.JSON(http.StatusBadGateway, apiError("FILE_UNAVAILABLE", "downloader unavailable"))
			return
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			body, _ := io.ReadAll(resp.Body)
			c.Data(resp.StatusCode, "application/json", body)
			return
		}

		displayName := filename
		if job.Title != "" {
			displayName = sanitizeFilename(job.Title) + "." + ext
		}
		c.Header("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, displayName))
		if cl := resp.Header.Get("Content-Length"); cl != "" {
			c.Header("Content-Length", cl)
		}
		c.Header("Content-Type", "application/octet-stream")
		c.Status(http.StatusOK)
		_, _ = io.Copy(c.Writer, resp.Body)
	})

	return r
}

func makeJobID() string {
	bytes := make([]byte, 6)
	if _, err := rand.Read(bytes); err != nil {
		return fmt.Sprintf("job_%d", time.Now().UnixNano())
	}
	return "job_" + hex.EncodeToString(bytes)
}

func main() {
	extractorURL = defaultExtractorURL()

	httpClient := &http.Client{Timeout: 30 * time.Second}
	r := setupRouter(extractorURL, httpClient)
	if err := r.Run("0.0.0.0:8080"); err != nil {
		panic(err)
	}
}
