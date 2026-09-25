#!/usr/bin/env bash
# Builds the Android app in the Expo cloud (EAS), waits for it to finish, then
# publishes it to the web UI. The build gets the next build number
# automatically (eas.json: autoIncrement), so every build is distinguishable:
# check Settings > About in the app, or the version shown in the web UI's 📱
# dialog.
#
#   ./build-apk.sh
#
# The version shown is <version in mobile/app.json> + the build number; bump
# "version" in mobile/app.json for a new release (e.g. 1.0.0 -> 1.1.0).
set -euo pipefail
cd "$(dirname "$0")"

command -v eas >/dev/null 2>&1 || { echo "eas-cli is required (npm i -g eas-cli) and you must be logged in (eas login)." >&2; exit 1; }

if [[ -n "$(git status --porcelain -- mobile 2>/dev/null)" ]]; then
  echo "Note: mobile/ has uncommitted changes. The cloud build uses what is in your working"
  echo "      tree, but the commit shown in the build's version is the last commit."
fi

export EAS_NO_EXPO_GO_WARNING=true
echo "==> Starting the cloud build (this waits until it finishes, usually 10-20 minutes)..."
( cd mobile && eas build --platform android --profile preview --non-interactive )

echo "==> Build finished. Publishing..."
./publish-apk.sh
