.PHONY: api extractor downloader web test compose-up compose-down

api:
	cd api && go run .

extractor:
	cd extractor && python main.py

downloader:
	cd downloader && cargo run -- --url https://example.com --output ./target/demo.bin

web:
	cd web && python -m http.server 3000

test:
	cd api && go test ./...
	cd extractor && python -m py_compile main.py
	cd downloader && cargo check

compose-up:
	docker compose up -d

compose-down:
	docker compose down -v
