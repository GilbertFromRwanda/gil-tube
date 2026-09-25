#!/usr/bin/env bash
# Copies the newest finished EAS Android APK build into web/app/, where the web
# UI serves it as a download (link + QR code in the 📱 dialog).
#
# Build first:   cd mobile && eas build --platform android --profile preview
# Then:          ./publish-apk.sh
#
# The APK is ~100 MB and is git-ignored; it lives only on the machine that
# serves the web UI.
set -euo pipefail
cd "$(dirname "$0")"

OUT_DIR="web/app"
OUT_FILE="$OUT_DIR/GilTube.apk"
mkdir -p "$OUT_DIR"

command -v eas >/dev/null 2>&1 || { echo "eas-cli is required (npm i -g eas-cli) and you must be logged in (eas login)." >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "node is required." >&2; exit 1; }

echo "==> Looking up the latest finished Android build (preview profile)..."
URL="$(cd mobile && eas build:list --platform android --status finished --limit 10 --json --non-interactive 2>/dev/null | node -e '
  let raw = "";
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => {
    const start = raw.indexOf("[");
    const builds = start >= 0 ? JSON.parse(raw.slice(start)) : [];
    const hit = builds.find((b) => b.buildProfile === "preview" && b.artifacts && b.artifacts.buildUrl);
    if (hit) process.stdout.write(hit.artifacts.buildUrl + "\n" + (hit.completedAt || "") + "\n");
  });
')"

if [[ -z "$URL" ]]; then
  echo "No finished preview build with an APK was found. Start one with:" >&2
  echo "  cd mobile && eas build --platform android --profile preview" >&2
  exit 1
fi

APK_URL="$(printf '%s' "$URL" | sed -n 1p)"
BUILT_AT="$(printf '%s' "$URL" | sed -n 2p)"
echo "==> Downloading the build finished at ${BUILT_AT:-unknown time}"

# Download to a temp name so a failed transfer never replaces a good APK.
if [[ -t 1 ]]; then PROGRESS="--progress-bar"; else PROGRESS="--silent --show-error"; fi
# shellcheck disable=SC2086
curl -fL $PROGRESS -o "$OUT_FILE.part" "$APK_URL"
mv "$OUT_FILE.part" "$OUT_FILE"

SIZE="$(du -h "$OUT_FILE" | cut -f1)"
echo "==> Done: $OUT_FILE ($SIZE)"
echo "    Open the web UI, click the 📱 button, and scan the QR code with your phone."
