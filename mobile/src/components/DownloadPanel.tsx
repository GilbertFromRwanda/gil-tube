// SDK 57's default expo-file-system export is the new File/Directory API;
// `downloadAsync`/`cacheDirectory` still live under the /legacy subpath.
import * as FileSystem from 'expo-file-system/legacy';
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { getJobFileUrl } from '../api/client';
import { JobStatus } from '../api/types';
import { DownloadItem, displayStatusOf, isActive, useDownloads } from '../downloads/DownloadsContext';
import { useTheme } from '../theme/theme';
import { openSavedFile } from '../storage/openFile';
import { DEFAULT_FOLDER_NAME, folderLabel, placeFileInFolder, resolveSaveFolder, SaveCancelledError } from '../storage/saveLocation';
import { formatBytes } from '../utils/format';
import { createTransferTracker, TransferSample } from '../utils/transferProgress';
import { ProgressBar } from './ProgressBar';
import { SegmentBars } from './SegmentBars';

function statusColor(status: JobStatus, colors: ReturnType<typeof useTheme>['colors']) {
  if (status === 'COMPLETED') return colors.success;
  if (status === 'FAILED' || status === 'CANCELLED') return colors.danger;
  if (status === 'MUXING') return colors.warning;
  return colors.primary;
}

// One download's progress card: status, progress bar, speed, IDM-style
// segment bars, the merge phase, cancel while running, and save/share once
// complete. Purely presentational - the shared poller in DownloadsProvider
// keeps the item fresh, so this works the same inside the preview sheet and
// in the downloads list on the main screen.
export function DownloadPanel({
  item,
  showTitle = false,
  onDismiss,
}: {
  item: DownloadItem;
  showTitle?: boolean;
  onDismiss?: () => void;
}) {
  const { colors } = useTheme();
  const { cancel } = useDownloads();

  const [cancelling, setCancelling] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState('');
  const [savedTo, setSavedTo] = useState('');
  const [savedUri, setSavedUri] = useState('');
  // What the save is doing right now, so it can show a bar and speed like the
  // download does instead of a bare "Saving…" that looks frozen.
  const [saveProgress, setSaveProgress] = useState<{ phase: 'download' | 'copy'; sample: TransferSample | null } | null>(null);

  const { jobId, title, container, job, progress } = item;
  const displayStatus = displayStatusOf(item);
  const running = isActive(item);
  const isMuxing = displayStatus === 'MUXING';

  const onCancel = async () => {
    setCancelling(true);
    await cancel(jobId);
    setCancelling(false);
  };

  // Saves into the remembered folder without asking. Only the very first
  // save on Android (or after the folder was deleted / access revoked) shows
  // the system folder picker - and it does so *before* the download starts,
  // so the wait isn't wasted if the user cancels.
  const onSave = async () => {
    setSaveState('saving');
    setSaveError('');
    try {
      const folder = await resolveSaveFolder();

      const fileUrl = await getJobFileUrl(jobId);
      const ext = container || 'bin';
      const baseName = (title || jobId).replace(/[\/:*?"<>|]/g, '_');
      const cachedUri = `${FileSystem.cacheDirectory}${baseName}.${ext}`;
      const tracker = createTransferTracker();
      setSaveProgress({ phase: 'download', sample: null });
      const resumable = FileSystem.createDownloadResumable(fileUrl, cachedUri, {}, (p) => {
        const sample = tracker(p.totalBytesWritten, p.totalBytesExpectedToWrite);
        if (sample) setSaveProgress({ phase: 'download', sample });
      });
      const result = await resumable.downloadAsync();
      if (!result) throw new Error('The transfer was interrupted.');
      // The download call doesn't fail on an HTTP error; without this the
      // server's error message would be written out as if it were the video.
      if (result.status >= 400) throw new Error(`The server refused the file (HTTP ${result.status}).`);

      // Second phase: moving it into the chosen folder. That copy has no byte
      // callbacks, so it is shown as an indeterminate step.
      setSaveProgress({ phase: 'copy', sample: null });
      setSavedUri(await placeFileInFolder(result.uri, folder, baseName, ext));
      setSavedTo(folder.uri.includes('/tree/') ? folderLabel(folder.uri) : `${DEFAULT_FOLDER_NAME} folder in Files`);
      setSaveState('saved');
    } catch (err) {
      if (err instanceof SaveCancelledError) {
        setSaveState('idle');
        return;
      }
      setSaveState('error');
      setSaveError(err instanceof Error ? err.message : 'Could not save the file.');
    } finally {
      setSaveProgress(null);
    }
  };

  const onOpen = async () => {
    setSaveError('');
    try {
      await openSavedFile(savedUri, container || 'bin');
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'No app found to open this file.');
    }
  };

  const downloaded = progress?.bytes_downloaded || 0;
  const total = progress?.bytes_total ?? null;
  const percent = isMuxing
    ? progress?.mux_progress_percent || 0
    : displayStatus === 'COMPLETED'
      ? 100
      : total
        ? (downloaded / total) * 100
        : 0;

  return (
    <View style={[styles.card, { backgroundColor: colors.panel, borderColor: colors.border }]}>
      {showTitle ? (
        <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
          {title}
        </Text>
      ) : null}

      <View style={styles.statusRow}>
        <View style={[styles.statusPill, { backgroundColor: statusColor(displayStatus, colors) }]}>
          <Text style={styles.statusText}>{displayStatus}</Text>
        </View>
        {running ? (
          <Pressable disabled={cancelling} onPress={onCancel} style={{ opacity: cancelling ? 0.6 : 1 }}>
            <Text style={{ color: colors.danger, fontWeight: '600', fontSize: 13 }}>Cancel</Text>
          </Pressable>
        ) : onDismiss ? (
          <Pressable onPress={onDismiss} hitSlop={10} accessibilityLabel="Dismiss download">
            <Text style={{ color: colors.muted, fontSize: 16 }}>✕</Text>
          </Pressable>
        ) : null}
      </View>

      <View style={styles.progressBlock}>
        <ProgressBar percent={percent} colors={colors} indeterminate={!isMuxing && !total && running} />
        <View style={styles.progressMetaRow}>
          <Text style={[styles.progressMeta, { color: colors.muted }]}>
            {isMuxing
              ? 'Merging audio and video…'
              : total
                ? `${formatBytes(downloaded)} / ${formatBytes(total)}`
                : formatBytes(downloaded)}
          </Text>
          <Text style={[styles.progressMeta, { color: colors.muted }]}>
            {isMuxing
              ? `${Math.round(percent)}%`
              : progress?.speed_bytes_per_second && running
                ? `${formatBytes(progress.speed_bytes_per_second)}/s`
                : ''}
          </Text>
        </View>
        {!isMuxing && running && progress?.segments ? (
          <SegmentBars segments={progress.segments} bytesTotal={total} colors={colors} />
        ) : null}
      </View>

      {displayStatus === 'COMPLETED' ? (
        <>
          <Pressable
            disabled={saveState === 'saving'}
            onPress={onSave}
            style={[styles.saveButton, { backgroundColor: colors.success, opacity: saveState === 'saving' ? 0.7 : 1 }]}
          >
            <Text style={styles.saveButtonText}>
              {saveState === 'saving'
                ? saveProgress?.phase === 'copy'
                  ? 'Copying…'
                  : saveProgress?.sample
                    ? `Saving… ${Math.floor(saveProgress.sample.percent)}%`
                    : 'Saving…'
                : saveState === 'saved'
                  ? 'Save again'
                  : 'Save file'}
            </Text>
          </Pressable>
          {saveState === 'saving' && saveProgress ? (
            <View style={styles.saveProgress}>
              <ProgressBar
                percent={saveProgress.sample?.percent ?? 0}
                colors={colors}
                indeterminate={saveProgress.phase === 'copy' || !saveProgress.sample}
              />
              <View style={styles.progressMetaRow}>
                <Text style={[styles.progressMeta, { color: colors.muted }]}>
                  {saveProgress.phase === 'copy'
                    ? 'Copying into your folder…'
                    : saveProgress.sample
                      ? `${formatBytes(saveProgress.sample.written)} / ${formatBytes(saveProgress.sample.total)}`
                      : 'Starting…'}
                </Text>
                <Text style={[styles.progressMeta, { color: colors.muted }]}>
                  {saveProgress.phase === 'download' && saveProgress.sample && saveProgress.sample.speed > 0
                    ? `${formatBytes(saveProgress.sample.speed)}/s`
                    : ''}
                </Text>
              </View>
            </View>
          ) : null}
          {saveState === 'saved' ? (
            <View style={styles.savedRow}>
              <Text style={[styles.savedText, { color: colors.success }]} numberOfLines={2}>
                Saved to {savedTo}
              </Text>
              {savedUri ? (
                <Pressable onPress={onOpen} hitSlop={8}>
                  <Text style={{ color: colors.primary, fontWeight: '600', fontSize: 13 }}>Open</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
        </>
      ) : null}

      {displayStatus === 'FAILED' || displayStatus === 'CANCELLED' ? (
        <Text style={[styles.errorText, { color: colors.danger }]}>{job.error_message || displayStatus}</Text>
      ) : null}

      {saveError ? <Text style={[styles.errorText, { color: colors.danger }]}>{saveError}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { marginTop: 12, padding: 14, borderRadius: 12, borderWidth: 1 },
  title: { fontSize: 14, fontWeight: '600', marginBottom: 8 },
  statusRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  statusPill: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  statusText: { color: '#04121f', fontWeight: '700', fontSize: 11 },
  progressBlock: { marginTop: 12 },
  progressMetaRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
  progressMeta: { fontSize: 12 },
  saveProgress: { marginTop: 10 },
  saveButton: { marginTop: 14, borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  saveButtonText: { color: '#04121f', fontWeight: '700', fontSize: 15 },
  errorText: { marginTop: 12, fontSize: 13 },
  savedRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 10, gap: 12 },
  savedText: { flex: 1, fontSize: 13 },
});
