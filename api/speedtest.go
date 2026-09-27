package main

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
)

const (
	speedTestDefaultBytes = 768 * 1024
	speedTestMaxBytes     = 4 * 1024 * 1024
	speedTestChunkBytes   = 32 * 1024
)

// clampSpeedTestBytes reads the requested size ("bytes" query value), falling
// back to the default for anything missing or unusable and never exceeding the
// cap, so the endpoint can't be used to pull an unbounded stream.
func clampSpeedTestBytes(raw string) int {
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return speedTestDefaultBytes
	}
	if n > speedTestMaxBytes {
		return speedTestMaxBytes
	}
	return n
}

// registerSpeedTestRoutes adds GET /api/v1/speedtest?bytes=N: a body of N
// filler bytes (default 768 KiB, at most 4 MiB), uncacheable. Clients time it to
// learn how fast they can pull data from this server, which is what decides how
// big a file they can comfortably fetch - used to pick a download quality.
func registerSpeedTestRoutes(r *gin.Engine) {
	r.GET("/api/v1/speedtest", func(c *gin.Context) {
		total := clampSpeedTestBytes(c.Query("bytes"))
		c.Header("Cache-Control", "no-store")
		c.Header("Content-Type", "application/octet-stream")
		c.Header("Content-Length", strconv.Itoa(total))
		c.Status(http.StatusOK)

		chunk := make([]byte, speedTestChunkBytes)
		for sent := 0; sent < total; {
			size := speedTestChunkBytes
			if total-sent < size {
				size = total - sent
			}
			if _, err := c.Writer.Write(chunk[:size]); err != nil {
				return // client went away
			}
			sent += size
		}
	})
}
