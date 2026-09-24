import AsyncStorage from '@react-native-async-storage/async-storage';
import { Directory, File, Paths } from 'expo-file-system';
import { Alert, Platform } from 'react-native';

const SAVE_DIR_KEY = 'gil_tube_save_dir_uri';
const IOS_FOLDER_NAME = 'Gil Tube';
// Where the Android folder picker opens (the shared Downloads folder).
const ANDROID_DOWNLOADS_URI = 'content://com.android.externalstorage.documents/document/primary%3ADownload';

// Where finished downloads end up, decided once and then remembered.
//
// Android: the default is the shared Downloads folder. Android only lets an
// app write there after the user grants access once through the system
// picker, so the first save opens that picker already inside Downloads.
// (Android 11+ refuses the Downloads root itself, so a subfolder such as
// "Gil Tube" has to be created/picked - the picker's "new folder" button.)
// expo-file-system takes a persistable URI permission for the choice, so it
// keeps working after restarts and we never ask again - unless the folder is
// deleted or access is revoked.
//
// iOS: a folder picked through the system picker is only accessible for the
// current app session, so remembering it is impossible. Instead a "Gil Tube"
// folder is created automatically in the app's Documents directory (no
// prompt, ever); with file sharing enabled in Info.plist it shows up in
// Files > On My iPhone > Gil Tube.

export class SaveCancelledError extends Error {
  constructor() {
    super('Choosing a folder was cancelled.');
    this.name = 'SaveCancelledError';
  }
}

export const canChooseFolder = Platform.OS === 'android';

function errorText(err: unknown): string {
  const anyErr = err as { code?: string; message?: string; name?: string };
  return `${anyErr?.code ?? ''} ${anyErr?.name ?? ''} ${anyErr?.message ?? ''}`;
}

// content://…/tree/primary%3ADownload%2FGil%20Tube  ->  Download/Gil Tube
export function folderLabel(uri: string): string {
  const tree = uri.split('/tree/')[1];
  if (!tree) return uri;
  try {
    return decodeURIComponent(tree.split('/')[0]).replace(/^[^:]*:/, '') || 'Device storage';
  } catch {
    return tree;
  }
}

function isUsable(uri: string): boolean {
  try {
    return new Directory(uri).exists;
  } catch {
    return false;
  }
}

function iosFolder(): Directory {
  const dir = new Directory(Paths.document, IOS_FOLDER_NAME);
  dir.create({ intermediates: true, idempotent: true });
  return dir;
}

// The saved folder's readable name, or null if none is chosen yet (Android).
export async function getSaveFolderLabel(): Promise<string | null> {
  if (Platform.OS === 'ios') return `Files › On My iPhone › ${IOS_FOLDER_NAME}`;
  const stored = await AsyncStorage.getItem(SAVE_DIR_KEY);
  return stored && isUsable(stored) ? folderLabel(stored) : null;
}

export async function chooseSaveFolder(): Promise<Directory> {
  if (!canChooseFolder) return iosFolder();
  try {
    const dir = await Directory.pickDirectoryAsync(ANDROID_DOWNLOADS_URI);
    await AsyncStorage.setItem(SAVE_DIR_KEY, dir.uri);
    return dir;
  } catch (err) {
    if (/cancel/i.test(errorText(err))) throw new SaveCancelledError();
    throw err;
  }
}

export async function forgetSaveFolder(): Promise<void> {
  await AsyncStorage.removeItem(SAVE_DIR_KEY);
}

// The folder to save into: the remembered one if it still works, otherwise
// (Android, first save or folder gone) ask the user to choose.
export async function resolveSaveFolder(): Promise<Directory> {
  if (Platform.OS === 'ios') return iosFolder();
  const stored = await AsyncStorage.getItem(SAVE_DIR_KEY);
  if (stored && isUsable(stored)) return new Directory(stored);
  await explainFolderChoice();
  return chooseSaveFolder();
}

// The system picker's wording is easy to misread, so say what to do first.
function explainFolderChoice(): Promise<void> {
  return new Promise((resolve, reject) => {
    Alert.alert(
      'Save to your Downloads folder',
      'Android needs your OK once. Pick a folder inside Downloads (tap "Create new folder" and name it Gil Tube), then tap "Use this folder". Videos will be saved there from now on, without asking again.',
      [
        { text: 'Cancel', style: 'cancel', onPress: () => reject(new SaveCancelledError()) },
        { text: 'Choose folder', onPress: () => resolve() },
      ],
      { cancelable: true, onDismiss: () => reject(new SaveCancelledError()) },
    );
  });
}

// Puts a finished download (already on disk in app storage) into the folder.
// Copies on Android, where a large file can't be written straight to a
// content:// folder by the download API; moves on iOS. If a file with that
// name already exists it's saved as "name (xxxx).ext" instead of failing.
export async function placeFileInFolder(
  cachedFileUri: string,
  folder: Directory,
  baseName: string,
  ext: string,
): Promise<void> {
  const put = (file: File) => (Platform.OS === 'ios' ? file.move(folder) : file.copy(folder));

  let source = new File(cachedFileUri);
  try {
    await put(source);
  } catch (err) {
    if (!/exist/i.test(errorText(err))) throw err;
    const suffix = Date.now().toString(36).slice(-4);
    const renamed = new File(Paths.cache, `${baseName} (${suffix}).${ext}`);
    await source.move(renamed);
    source = renamed;
    await put(source);
  }

  if (Platform.OS !== 'ios') {
    try {
      source.delete();
    } catch {
      // The cache copy is disposable; the OS will reclaim it eventually.
    }
  }
}
