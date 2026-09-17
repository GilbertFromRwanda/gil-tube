package main

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	_ "github.com/lib/pq"
	"github.com/nats-io/nats.go"
)

type Job struct {
	ID        string    `json:"job_id"`
	Status    string    `json:"status"`
	Title     string    `json:"title,omitempty"`
	URL       string    `json:"url,omitempty"`
	MediaURL  string    `json:"media_url"`
	AudioURL  string    `json:"audio_url,omitempty"`
	FormatID  string    `json:"format_id,omitempty"`
	Container string    `json:"container,omitempty"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// downloaderClient uses a long timeout rather than none: the worker holds
// this request open for the full duration of a synchronous download, which
// can legitimately take a long time for large files, but an external
// dependency must never be allowed to hang forever.
var downloaderClient = &http.Client{Timeout: 2 * time.Hour}

type downloadError struct {
	code    string
	message string
}

func (e *downloadError) Error() string { return e.message }

func envOrDefault(key string, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func connectDatabase() (*sql.DB, error) {
	connString := envOrDefault("DATABASE_URL", "postgres://gil_tube:gil_tube@postgres:5432/gil_tube?sslmode=disable")
	db, err := sql.Open("postgres", connString)
	if err != nil {
		return nil, err
	}
	if err := db.Ping(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return db, nil
}

func updateJobStatus(db *sql.DB, jobID string, status string, errorCode string, errorMessage string) error {
	_, err := db.Exec(
		`UPDATE jobs SET status = $1, error_code = NULLIF($2, ''), error_message = NULLIF($3, ''), updated_at = $4 WHERE id = $5`,
		status, errorCode, errorMessage, time.Now().UTC(), jobID,
	)
	return err
}

// invokeDownloader asks the downloader service to fetch the job's resolved
// media URL and returns the terminal status it reports ("COMPLETED" or
// "CANCELLED"). Errors carry a stable error code when the downloader
// returned a structured error envelope.
func invokeDownloader(baseURL string, job Job) (string, error) {
	ext := job.Container
	if ext == "" {
		ext = "bin"
	}
	outputName := fmt.Sprintf("%s.%s", job.ID, ext)

	fields := map[string]string{
		"job_id": job.ID,
		"url":    job.MediaURL,
		"output": outputName,
	}
	if job.AudioURL != "" {
		fields["audio_url"] = job.AudioURL
	}
	payload, err := json.Marshal(fields)
	if err != nil {
		return "", err
	}

	req, err := http.NewRequest(http.MethodPost, baseURL+"/download", bytes.NewReader(payload))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := downloaderClient.Do(req)
	if err != nil {
		return "", &downloadError{code: "DOWNLOAD_FAILED", message: err.Error()}
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", &downloadError{code: "DOWNLOAD_FAILED", message: err.Error()}
	}

	if resp.StatusCode != http.StatusOK {
		var errPayload struct {
			Error struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(body, &errPayload) == nil && errPayload.Error.Code != "" {
			return "", &downloadError{code: errPayload.Error.Code, message: errPayload.Error.Message}
		}
		return "", &downloadError{code: "DOWNLOAD_FAILED", message: fmt.Sprintf("downloader returned status %d", resp.StatusCode)}
	}

	var result struct {
		Status string `json:"status"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return "", &downloadError{code: "DOWNLOAD_FAILED", message: "invalid downloader response"}
	}
	return result.Status, nil
}

func main() {
	db, err := connectDatabase()
	if err != nil {
		log.Fatalf("database connection failed: %v", err)
	}
	defer db.Close()

	natsURL := envOrDefault("NATS_URL", "nats://nats:4222")
	downloaderURL := envOrDefault("DOWNLOADER_URL", "http://downloader:8000")
	nc, err := nats.Connect(natsURL)
	if err != nil {
		log.Fatalf("nats connection failed: %v", err)
	}
	defer nc.Close()

	sub, err := nc.SubscribeSync("jobs.ready")
	if err != nil {
		log.Fatalf("subscribe failed: %v", err)
	}

	if err := nc.Flush(); err != nil {
		log.Fatalf("flush failed: %v", err)
	}

	log.Printf("worker listening on %s and downloader at %s", natsURL, downloaderURL)
	for {
		msg, err := sub.NextMsg(5 * time.Second)
		if err != nil {
			if strings.Contains(err.Error(), "timeout") {
				continue
			}
			log.Printf("receive error: %v", err)
			continue
		}

		var payload struct {
			Job Job `json:"job"`
		}
		if err := json.Unmarshal(msg.Data, &payload); err != nil {
			log.Printf("invalid message payload: %v", err)
			continue
		}

		job := payload.Job
		if job.ID == "" {
			continue
		}
		if job.MediaURL == "" {
			log.Printf("job %s has no resolved media url, marking failed", job.ID)
			_ = updateJobStatus(db, job.ID, "FAILED", "FORMAT_UNAVAILABLE", "no downloadable media url was resolved")
			continue
		}

		if err := updateJobStatus(db, job.ID, "DOWNLOADING", "", ""); err != nil {
			log.Printf("mark downloading failed for %s: %v", job.ID, err)
			continue
		}

		status, err := invokeDownloader(downloaderURL, job)
		if err != nil {
			code := "DOWNLOAD_FAILED"
			if de, ok := err.(*downloadError); ok && de.code != "" {
				code = de.code
			}
			log.Printf("downloader failed for %s: %v", job.ID, err)
			_ = updateJobStatus(db, job.ID, "FAILED", code, err.Error())
			continue
		}

		finalStatus := "COMPLETED"
		if status == "CANCELLED" {
			finalStatus = "CANCELLED"
		}
		if err := updateJobStatus(db, job.ID, finalStatus, "", ""); err != nil {
			log.Printf("mark %s failed for %s: %v", finalStatus, job.ID, err)
			continue
		}
		log.Printf("job %s finished with status %s", job.ID, finalStatus)
	}
}
