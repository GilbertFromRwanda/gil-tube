# Gil Tube mobile

A React Native (Expo) client for the same API the [web UI](../web/index.html)
uses — search, preview, pick a format, download, and share the finished
file. See [connected.md](../connected.md) for how the backend services fit
together.

## Run it

```sh
npm install
npx expo start
```

Then press `a` for an Android emulator, `i` for an iOS simulator, or scan
the QR code with Expo Go on a physical device.

## Point it at your API

The app can't guess where your `api` container is reachable from — a
phone's "localhost" means the phone itself, not your dev machine. On
first launch, open the ⚙️ Settings screen and set the API address:

- **Scan the QR code** — open the web UI (`web/index.html`) *from the
  same LAN-reachable address your phone will use* (not `localhost`),
  tap the 📱 icon in its topbar, and scan the QR code it shows with
  Settings → "Scan QR from web UI". This is the easiest path since it
  reads the correct LAN IP straight from the browser's own address bar.
- **Android emulator**: `http://10.0.2.2:8081`
- **iOS simulator**: `http://localhost:8081`
- **Physical device (manual)**: `http://<your computer's LAN IP>:8081`
  (same network as the phone; find the IP with `ipconfig`/`ifconfig`)

The address is saved locally (AsyncStorage) and reused on future launches.

## Structure

- `src/api/client.ts` — thin fetch wrapper over the same `/api/v1/...`
  endpoints the web UI calls (search, preview, jobs, progress, file).
- `src/components/PlayerHost.tsx` + `src/player/PlayerContext.tsx` — the
  app-wide video player. Tap a video and a bottom sheet slides up (player,
  format picker, download). Drag its handle down, tap the dimmed area, or press
  Android back and it shrinks to a **mini player** docked at the bottom, still
  playing, while you browse or open Settings. Tap or drag up on the bar to
  expand, swipe it down or press ✕ to stop. One YouTube player stays mounted
  and is only scaled/moved by transforms (no reload), using RN's `Animated`
  only - no gesture/reanimated native deps.
- `src/feed/feedEngine.ts` — the **endless feed**. Starts as the cached (Redis)
  videos or a live search; when the cache runs out it carries on with live
  YouTube results for the default query, and a search itself pages deeper as
  you scroll (`POST /api/v1/search` with `offset`, depth capped at 300). Drops
  repeats, fetches the next page ahead of the scroll, skips a page that is all
  repeats (bounded), ignores late replies for an old search, and retries a
  failed page. React-free so it's unit-tested: `npm run test:feed`.
- `src/player/handoff.ts` — **background audio.** YouTube's embed stops when
  the app leaves the screen (power button, other app), so at that moment
  playback is handed to an audio-only stream from the server
  (`GET /api/v1/audio`, AAC, seekable) played with `expo-audio`, continuing
  from the same second with lock-screen/notification controls; returning to
  the app hands it back to the video where the audio got to. The decision
  logic is pure and unit-tested (timing races such as the embed pausing just
  before the app backgrounds, and any step failing - an uncaught error in the
  app-state listener would close a release build). Run them with
  `npm run test:handoff`. Needs a real build - the background-audio
  config (iOS audio mode, Android media foreground service) isn't in Expo Go.
- `src/downloads/DownloadsContext.tsx` — app-level store of download jobs
  with one shared poller (job + progress once a second, stopped when
  nothing is running), so progress survives closing the preview sheet.
- `src/components/DownloadPanel.tsx` — one job's card: IDM-style segment
  bars, mux phase, cancel, save/share. Shown inside the sheet under the
  Download button and in `DownloadsTray` (the list under the search box).
- `src/screens/` — `SearchScreen` (grid + infinite scroll over cached
  videos, live search, hosts the preview sheet), `SettingsScreen`,
  `ScanQrScreen` (camera QR scan, via `expo-camera`).
- `src/theme/theme.tsx` — dark/light palette mirroring `web/index.html`'s
  CSS variables, persisted with AsyncStorage.

## Where saved files go

- **Android** — the shared Downloads folder. Android only lets an app write
  there after you grant access once, so the first "Save file" shows a short
  explanation and opens the system picker inside Downloads: tap "Create new
  folder", paste `gil-tube` (the app copies the name to the clipboard for you,
  since Android doesn't let an app pre-fill that box), then "Use this
  folder". Android 11+ refuses the Downloads root itself, hence the
  subfolder. The choice is remembered, so later saves never ask. Change or
  forget it under Settings › Save location.
- **iOS** — a `gil-tube` folder is created automatically in the app's
  Documents (no prompt), visible in Files › On My iPhone › gil-tube. iOS
  can't remember a picked folder across launches, so there's no picker.
  This needs a dev/production build; Expo Go shows Expo's own folder.
- After saving, **Open** launches the file in your video/audio app (Android
  intent; on iOS it opens the share sheet's "Open in…").

## Notes

- Saving a finished download uses `expo-file-system` to pull it into the
  app's cache dir, then hands it to the OS share sheet
  (`expo-sharing`) so the user can save it to Files/Photos/Downloads —
  there's no direct "write to the public Downloads folder" API on iOS,
  and it needs extra permissions on Android, so the share sheet is the
  portable default for a first version.
