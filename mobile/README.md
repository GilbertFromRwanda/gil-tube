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
- `src/components/PreviewSheet.tsx` — the bottom sheet that slides up when
  you tap a video: plays it, lists formats in a picker, starts the job.
  Plain `Modal` + `Animated` (drag the handle down, tap the backdrop, or
  Android back to dismiss), so it needs no gesture/reanimated native deps.
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
  explanation and opens the system picker inside Downloads (create a
  "Gil Tube" folder there and tap "Use this folder"; Android 11+ refuses the
  Downloads root itself). The choice is remembered, so later saves never ask.
  Change or forget it under Settings › Save location.
- **iOS** — a "Gil Tube" folder is created automatically in the app's
  Documents (no prompt), visible in Files › On My iPhone › Gil Tube. iOS
  can't remember a picked folder across launches, so there's no picker.
  This needs a dev/production build; Expo Go shows Expo's own folder.

## Notes

- Saving a finished download uses `expo-file-system` to pull it into the
  app's cache dir, then hands it to the OS share sheet
  (`expo-sharing`) so the user can save it to Files/Photos/Downloads —
  there's no direct "write to the public Downloads folder" API on iOS,
  and it needs extra permissions on Android, so the share sheet is the
  portable default for a first version.
