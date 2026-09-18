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

# python -m http.server binds all interfaces, so the LAN IP works too - but
# only browsing via that IP (not "localhost") lets the web UI's "Connect
# the mobile app" QR code fill in a phone-reachable address automatically.
detect_lan_ip() {
  case "$(uname -s)" in
    Linux*)
      hostname -I 2>/dev/null | awk '{print $1}'
      ;;
    Darwin*)
      ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null
      ;;
    MINGW*|MSYS*|CYGWIN*)
      # The interface holding the default route is the one actually used to
      # reach the network - picking "any non-loopback IPv4" instead often
      # grabs a Docker/WSL/Hyper-V virtual adapter's IP, which a phone can't
      # reach.
      powershell.exe -NoProfile -Command \
        "\$route = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object -Property RouteMetric | Select-Object -First 1; if (\$route) { (Get-NetIPAddress -InterfaceIndex \$route.InterfaceIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue).IPAddress }" \
        2>/dev/null | tr -d '\r'
      ;;
  esac
}
LAN_IP="$(detect_lan_ip || true)"

echo ""
echo "==> Backend is up. Serving the web UI at $WEB_URL"
if [[ -n "${LAN_IP:-}" ]]; then
  echo "    Also reachable at http://$LAN_IP:3000 - that's the address the browser"
  echo "    will open (instead of localhost) so the 📱 \"Connect the mobile app\""
  echo "    QR code fills in an address your phone can actually reach."
else
  echo "    Could not detect a LAN IP - the 📱 \"Connect the mobile app\" QR code"
  echo "    will show localhost, which only works on this machine. Find your"
  echo "    LAN IP manually and open the page from http://<that IP>:3000 instead."
fi
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

OPEN_URL="$WEB_URL"
if [[ -n "${LAN_IP:-}" ]]; then
  OPEN_URL="http://$LAN_IP:3000"
fi

if [[ "$OPEN_BROWSER" -eq 1 ]]; then
  ( sleep 1.5 && open_browser "$OPEN_URL" ) &
fi

cd web
exec "$PYTHON_BIN" -m http.server 3000
