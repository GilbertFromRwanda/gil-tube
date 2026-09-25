#!/usr/bin/env bash
# Publishes the newest finished EAS Android build into web/app/, where the web
# UI offers it as a download (link + QR code). Every build is saved with its
# version in the file name (GilTube-v1.0.0-b7-5211c72.apk) and listed in
# web/app/versions.json.
#
#   ./publish-apk.sh              # newest finished build
#   ./publish-apk.sh --count 3    # the 3 newest
#   ./publish-apk.sh --keep 5     # keep 5 builds on disk (default 3)
#
# To build and publish in one go, use ./build-apk.sh. The APKs are ~100 MB and
# are git-ignored; they live only on the machine that serves the web UI.
set -euo pipefail
cd "$(dirname "$0")"
command -v node >/dev/null 2>&1 || { echo "node is required." >&2; exit 1; }
exec node scripts/publish-apk.mjs "$@"
