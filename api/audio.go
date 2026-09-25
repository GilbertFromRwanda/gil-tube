package main

import (
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/gin-gonic/gin"
)

// isAllowedMediaHost reports whether the API may fetch audio from this host.
// The stream URL comes from the extractor, not straight from the client, but
// it still ends up as a server-side request, so it is limited to YouTube's
// media hosts rather than trusting whatever an extractor returns. It is a
// variable so tests can point it at a local server.
var isAllowedMediaHost = func(host string) bool {
	host = strings.ToLower(host)
	return host == "googlevideo.com" || strings.HasSuffix(host, ".googlevideo.com")
}

// audioMimeType maps an audio-only container to the Content-Type players
// expect. m4a is AAC in an MP4 container.
func audioMimeType(container string) string {
	switch strings.ToLower(container) {
	case "m4a", "mp4":
		return "audio/mp4"
	case "webm":
		return "audio/webm"
	default:
		return "application/octet-stream"
	}
}

// bestPlayableAudio picks the audio-only stream to play. AAC in m4a is
// preferred because both Android and iOS decode it natively (webm/opus does
// not play on iOS); within that, a plain stream beats a "-drc" (dynamic range
// compressed) variant, then the larger file, which tracks bitrate.
func bestPlayableAudio(formats []FormatEntry) (FormatEntry, bool) {
	var best FormatEntry
	bestScore := -1
	found := false

	for _, f := range formats {
		if f.URL == "" || !isAudioOnly(f) {
			continue
		}
		score := 0
		if f.Container == "m4a" {
			score += 2
		}
		if !strings.Contains(f.ID, "drc") {
			score++
		}
		if !found || score > bestScore || (score == bestScore && f.FileSize > best.FileSize) {
			best, bestScore, found = f, score, true
		}
	}
	return best, found
}

// registerAudioRoutes adds GET /api/v1/audio?url=<video url>, which streams a
// video's audio track to the caller. The mobile app uses it to keep playing
// when the screen is off or the app is in the background, where the YouTube
// embed pauses. Range requests are passed through, so players can seek and
// buffer, and the response is streamed rather than held in memory.
func registerAudioRoutes(r *gin.Engine, extractorBaseURL string, httpClient *http.Client) {
	mediaClient := &http.Client{
		// Follow redirects, but never to a host we wouldn't have fetched
		// directly - otherwise an allowed host could bounce us anywhere.
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return fmt.Errorf("too many redirects")
			}
			if req.URL.Scheme != "https" || !isAllowedMediaHost(req.URL.Hostname()) {
				return fmt.Errorf("redirect to a disallowed host")
			}
			return nil
		},
	}

	r.GET("/api/v1/audio", func(c *gin.Context) {
		videoURL := strings.TrimSpace(c.Query("url"))
		if err := validateDownloadURL(videoURL); err != nil {
			c.JSON(http.StatusBadRequest, apiError("INVALID_URL", err.Error()))
			return
		}

		extractResp, status, body, err := callExtractor(extractorBaseURL, httpClient, videoURL)
		if err != nil {
			c.JSON(http.StatusBadGateway, apiError("EXTRACTION_FAILED", "extractor unavailable"))
			return
		}
		if status != http.StatusOK {
			c.Data(status, "application/json", body)
			return
		}

		audio, ok := bestPlayableAudio(extractResp.Formats)
		if !ok {
			c.JSON(http.StatusUnprocessableEntity, apiError("FORMAT_UNAVAILABLE", "no audio stream available for this video"))
			return
		}

		upstreamURL, err := url.Parse(audio.URL)
		if err != nil || !isAllowedMediaHost(upstreamURL.Hostname()) {
			c.JSON(http.StatusUnprocessableEntity, apiError("FORMAT_UNAVAILABLE", "audio source is not supported"))
			return
		}

		req, err := http.NewRequestWithContext(c.Request.Context(), http.MethodGet, audio.URL, nil)
		if err != nil {
			c.JSON(http.StatusInternalServerError, apiError("AUDIO_UNAVAILABLE", "could not build audio request"))
			return
		}
		if rng := c.GetHeader("Range"); rng != "" {
			req.Header.Set("Range", rng)
		}

		resp, err := mediaClient.Do(req)
		if err != nil {
			c.JSON(http.StatusBadGateway, apiError("AUDIO_UNAVAILABLE", "audio source unavailable"))
			return
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusPartialContent {
			c.JSON(http.StatusBadGateway, apiError("AUDIO_UNAVAILABLE", fmt.Sprintf("audio source returned status %d", resp.StatusCode)))
			return
		}

		for _, header := range []string{"Content-Length", "Content-Range", "Last-Modified"} {
			if v := resp.Header.Get(header); v != "" {
				c.Header(header, v)
			}
		}
		c.Header("Accept-Ranges", "bytes")
		c.Header("Content-Type", audioMimeType(audio.Container))
		c.Status(resp.StatusCode)
		_, _ = io.Copy(c.Writer, resp.Body)
	})
}
