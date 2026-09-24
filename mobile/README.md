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
- `src/components/DownloadPanel.tsx` — rendered inside the sheet, below the
  Download button: polls job + progress every second, IDM-style segment
  bars, mux phase, cancel, save/share the finished file.
- `src/screens/` — `SearchScreen` (grid + infinite scroll over cached
  videos, live search, hosts the preview sheet), `SettingsScreen`,
  `ScanQrScreen` (camera QR scan, via `expo-camera`).
- `src/theme/theme.tsx` — dark/light palette mirroring `web/index.html`'s
  CSS variables, persisted with AsyncStorage.

## Notes

- Saving a finished download uses `expo-file-system` to pull it into the
  app's cache dir, then hands it to the OS share sheet
  (`expo-sharing`) so the user can save it to Files/Photos/Downloads —
  there's no direct "write to the public Downloads folder" API on iOS,
  and it needs extra permissions on Android, so the share sheet is the
  portable default for a first version.
