import { NativeStackScreenProps } from '@react-navigation/native-stack';
// SDK 57's default expo-file-system export is the new File/Directory API;
// `downloadAsync`/`cacheDirectory` still live under the /legacy subpath.
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { cancelJob, getJob, getJobFileUrl, getJobProgress } from '../api/client';
import { Job, JobProgress, JobStatus } from '../api/types';
import { ProgressBar } from '../components/ProgressBar';
import { SegmentBars } from '../components/SegmentBars';
import { useTheme } from '../theme/theme';
import { formatBytes } from '../utils/format';
import { RootStackParamList } from '../navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'Download'>;

function statusColor(status: JobStatus, colors: ReturnType<typeof useTheme>['colors']) {
  if (status === 'COMPLETED') return colors.success;
  if (status === 'FAILED' || status === 'CANCELLED') return colors.danger;
  if (status === 'MUXING') return colors.warning;
  return colors.primary;
}

export function DownloadScreen({ route }: Props) {
  const { colors } = useTheme();
  const { jobId, title, container } = route.params;

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

  const displayStatus: JobStatus =
    job?.status === 'DOWNLOADING' && progress?.status ? progress.status : job?.status || 'QUEUED';
  const isTerminal = ['COMPLETED', 'FAILED', 'CANCELLED'].includes(displayStatus);
  const isMuxing = displayStatus === 'MUXING';

  const downloaded = progress?.bytes_downloaded || 0;
  const total = progress?.bytes_total ?? null;
  const percent = isMuxing
    ? progress?.mux_progress_percent || 0
    : total
      ? (downloaded / total) * 100
      : 0;

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      <Text style={[styles.title, { color: colors.text }]} numberOfLines={2}>
        {title || jobId}
      </Text>

      <View style={styles.statusRow}>
        <View style={[styles.statusPill, { backgroundColor: statusColor(displayStatus, colors) }]}>
          <Text style={styles.statusText}>{displayStatus}</Text>
        </View>
      </View>

      <View style={styles.progressBlock}>
        <ProgressBar
          percent={percent}
          colors={colors}
          indeterminate={!isMuxing && !total && !isTerminal}
        />
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
              : progress?.speed_bytes_per_second
                ? `${formatBytes(progress.speed_bytes_per_second)}/s`
                : ''}
          </Text>
        </View>
        {!isMuxing && progress?.segments ? (
          <SegmentBars segments={progress.segments} bytesTotal={total} colors={colors} />
        ) : null}
      </View>

      {!isTerminal ? (
        <Pressable
          disabled={cancelling}
          onPress={onCancel}
          style={[styles.cancelButton, { borderColor: colors.danger, opacity: cancelling ? 0.6 : 1 }]}
        >
          <Text style={{ color: colors.danger, fontWeight: '600' }}>Cancel</Text>
        </Pressable>
      ) : null}

      {displayStatus === 'COMPLETED' ? (
        <Pressable
          disabled={saveState === 'saving'}
          onPress={onSave}
          style={[styles.saveButton, { backgroundColor: colors.primary, opacity: saveState === 'saving' ? 0.7 : 1 }]}
        >
          <Text style={styles.saveButtonText}>
            {saveState === 'saving' ? 'Preparing file…' : saveState === 'saved' ? 'Saved — share again' : 'Save file'}
          </Text>
        </Pressable>
      ) : null}

      {displayStatus === 'FAILED' || displayStatus === 'CANCELLED' ? (
        <Text style={[styles.errorText, { color: colors.danger }]}>
          {job?.error_message || displayStatus}
        </Text>
      ) : null}

      {saveError ? <Text style={[styles.errorText, { color: colors.danger }]}>{saveError}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, paddingTop: 54 },
  title: { fontSize: 16, fontWeight: '700' },
  statusRow: { marginTop: 12 },
  statusPill: { alignSelf: 'flex-start', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  statusText: { color: '#04121f', fontWeight: '700', fontSize: 11 },
  progressBlock: { marginTop: 18 },
  progressMetaRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
  progressMeta: { fontSize: 12 },
  cancelButton: {
    marginTop: 24,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  saveButton: { marginTop: 24, borderRadius: 10, paddingVertical: 13, alignItems: 'center' },
  saveButtonText: { color: '#04121f', fontWeight: '700', fontSize: 15 },
  errorText: { marginTop: 14 },
});
