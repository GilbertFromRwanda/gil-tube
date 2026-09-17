#!/usr/bin/env bash
# One-command start: builds/starts the backend (docker compose), waits for
# it to become healthy, then serves the web UI and opens it in your browser.
#
# Usage:
#   ./start.sh            # start everything, open the browser
#   ./start.sh --no-open  # start everything, skip opening the browser
set -euo pipefail
cd "$(dirname "$0")"

OPEN_BROWSER=1
if [[ "${1:-}" == "--no-open" ]]; then
  OPEN_BROWSER=0
fi

if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  echo "Docker (with the 'compose' plugin, or docker-compose) is required. Install Docker Desktop and try again." >&2
  exit 1
fi

echo "==> Building and starting backend services (postgres, redis, nats, extractor, api, downloader, worker)..."
$DC up -d --build

wait_for() {
  local name="$1" url="$2"
  printf "   waiting for %s" "$name"
  for _ in $(seq 1 60); do
    if curl -sf "$url" >/dev/null 2>&1; then
      echo " ready"
      return 0
    fi
    printf "."
    sleep 2
  done
  echo " timed out (continuing anyway; check 'docker compose logs')"
}

wait_for "extractor"  "http://localhost:9000/health"
wait_for "api"        "http://localhost:8081/health"
wait_for "downloader" "http://localhost:8000/health"

PYTHON_BIN=python3
command -v python3 >/dev/null 2>&1 || PYTHON_BIN=python

WEB_URL="http://localhost:3000"
echo ""
echo "==> Backend is up. Serving the web UI at $WEB_URL"
echo "    Press Ctrl+C to stop the web UI. Backend services keep running in the background;"
echo "    run '$DC down' to stop those too."
echo ""

open_browser() {
  local url="$1"
  case "$(uname -s)" in
    Linux*)   command -v xdg-open >/dev/null 2>&1 && xdg-open "$url" >/dev/null 2>&1 ;;
    Darwin*)  open "$url" >/dev/null 2>&1 ;;
    MINGW*|MSYS*|CYGWIN*) explorer.exe "$url" >/dev/null 2>&1 ;;
  esac
}

if [[ "$OPEN_BROWSER" -eq 1 ]]; then
  ( sleep 1.5 && open_browser "$WEB_URL" ) &
fi

cd web
exec "$PYTHON_BIN" -m http.server 3000
