import * as IntentLauncher from 'expo-intent-launcher';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';

const MIME_BY_EXT: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
};

export function mimeForExt(ext: string): string {
  return MIME_BY_EXT[ext.toLowerCase()] ?? '*/*';
}

const FLAG_GRANT_READ_URI_PERMISSION = 1;

// Opens a saved file in whatever app the user has for it. Android hands the
// file's content:// URI to the system chooser (the folder permission we
// already hold covers reading it). iOS has no "open" call for a file, so it
// shows the share sheet, whose "Open in..." entries do the same job.
export async function openSavedFile(uri: string, ext: string): Promise<void> {
  const mimeType = mimeForExt(ext);
  if (Platform.OS === 'android') {
    await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
      data: uri,
      type: mimeType,
      flags: FLAG_GRANT_READ_URI_PERMISSION,
    });
    return;
  }
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(uri, { mimeType });
  }
}
