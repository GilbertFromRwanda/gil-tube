// SDK 57's default expo-file-system export is the new File/Directory API;
// `downloadAsync`/`cacheDirectory` still live under the /legacy subpath.
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { cancelJob, getJob, getJobFileUrl, getJobProgress } from '../api/client';
import { Job, JobProgress, JobStatus } from '../api/types';
import { useTheme } from '../theme/theme';
import { formatBytes } from '../utils/format';
import { ProgressBar } from './ProgressBar';
import { SegmentBars } from './SegmentBars';

function statusColor(status: JobStatus, colors: ReturnType<typeof useTheme>['colors']) {
  if (status === 'COMPLETED') return colors.success;
  if (status === 'FAILED' || status === 'CANCELLED') return colors.danger;
  if (status === 'MUXING') return colors.warning;
  return colors.primary;
}

// Live progress for one download job: polls status + progress once a second
// (like the web UI), shows IDM-style segment bars and the merge phase, and
// offers cancel while running / save-share once it completes. Reports
// whether the job is still running so the host can disable its Download
// button meanwhile.
export function DownloadPanel({
  jobId,
  title,
  container,
  onActiveChange,
}: {
  jobId: string;
  title: string;
  container?: string;
  onActiveChange?: (active: boolean) => void;
}) {
  const { colors } = useTheme();

  const [job, setJob] = useState<Job | null>(null);
  const [progress, setProgress] = useState<JobProgress | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const poll = useCallback(async () => {
    try {
      const [jobData, progressData] = await Promise.all([getJob(jobId), getJobProgress(jobId)]);
      setJob(jobData);
      setProgress(progressData);

      if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(jobData.status) && pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    } catch (err) {
      // Transient network hiccup while polling; keep trying on the next tick.
    }
  }, [jobId]);

  useEffect(() => {
    poll();
    pollRef.current = setInterval(poll, 1000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [poll]);

  const displayStatus: JobStatus =
    job?.status === 'DOWNLOADING' && progress?.status ? progress.status : job?.status || 'QUEUED';
  const isTerminal = ['COMPLETED', 'FAILED', 'CANCELLED'].includes(displayStatus);
  const isMuxing = displayStatus === 'MUXING';

  useEffect(() => {
    onActiveChange?.(!isTerminal);
  }, [isTerminal, onActiveChange]);

  const onCancel = async () => {
    setCancelling(true);
    try {
      await cancelJob(jobId);
    } catch (err) {
      // Ignore: the next poll tick will reflect whatever state actually won.
    } finally {
      setCancelling(false);
    }
  };

  const onSave = async () => {
    setSaveState('saving');
    setSaveError('');
    try {
      const fileUrl = await getJobFileUrl(jobId);
      const ext = container || 'bin';
      const safeName = (title || jobId).replace(/[\\/:*?"<>|]/g, '_');
      const localUri = `${FileSystem.cacheDirectory}${safeName}.${ext}`;
      const { uri } = await FileSystem.downloadAsync(fileUrl, localUri);

      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri);
      }
      setSaveState('saved');
    } catch (err) {
      setSaveState('error');
      setSaveError(err instanceof Error ? err.message : 'Could not save the file.');
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
      <View style={styles.statusRow}>
        <View style={[styles.statusPill, { backgroundColor: statusColor(displayStatus, colors) }]}>
          <Text style={styles.statusText}>{displayStatus}</Text>
        </View>
        {!isTerminal ? (
          <Pressable disabled={cancelling} onPress={onCancel} style={{ opacity: cancelling ? 0.6 : 1 }}>
            <Text style={{ color: colors.danger, fontWeight: '600', fontSize: 13 }}>Cancel</Text>
          </Pressable>
        ) : null}
      </View>

      <View style={styles.progressBlock}>
        <ProgressBar percent={percent} colors={colors} indeterminate={!isMuxing && !total && !isTerminal} />
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
              : progress?.speed_bytes_per_second && !isTerminal
                ? `${formatBytes(progress.speed_bytes_per_second)}/s`
                : ''}
          </Text>
        </View>
        {!isMuxing && !isTerminal && progress?.segments ? (
          <SegmentBars segments={progress.segments} bytesTotal={total} colors={colors} />
        ) : null}
      </View>

      {displayStatus === 'COMPLETED' ? (
        <Pressable
          disabled={saveState === 'saving'}
          onPress={onSave}
          style={[styles.saveButton, { backgroundColor: colors.success, opacity: saveState === 'saving' ? 0.7 : 1 }]}
        >
          <Text style={styles.saveButtonText}>
            {saveState === 'saving' ? 'Preparing file…' : saveState === 'saved' ? 'Saved — share again' : 'Save file'}
          </Text>
        </Pressable>
      ) : null}

      {displayStatus === 'FAILED' || displayStatus === 'CANCELLED' ? (
        <Text style={[styles.errorText, { color: colors.danger }]}>{job?.error_message || displayStatus}</Text>
      ) : null}

      {saveError ? <Text style={[styles.errorText, { color: colors.danger }]}>{saveError}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { marginTop: 16, padding: 14, borderRadius: 12, borderWidth: 1 },
  statusRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  statusPill: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  statusText: { color: '#04121f', fontWeight: '700', fontSize: 11 },
  progressBlock: { marginTop: 12 },
  progressMetaRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
  progressMeta: { fontSize: 12 },
  saveButton: { marginTop: 14, borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  saveButtonText: { color: '#04121f', fontWeight: '700', fontSize: 15 },
  errorText: { marginTop: 12, fontSize: 13 },
});
