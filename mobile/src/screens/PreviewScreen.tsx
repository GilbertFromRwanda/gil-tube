import { Picker } from '@react-native-picker/picker';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import YoutubePlayer from 'react-native-youtube-iframe';
import { createJob, preview } from '../api/client';
import { PreviewInfo } from '../api/types';
import { useTheme } from '../theme/theme';
import { formatDuration, formatLabel } from '../utils/format';
import { RootStackParamList } from '../navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'Preview'>;

export function PreviewScreen({ route, navigation }: Props) {
  const { colors } = useTheme();
  const { width: windowWidth } = useWindowDimensions();
  const { result, url: paramUrl } = route.params;
  const url = result?.url || paramUrl || '';

  const [info, setInfo] = useState<PreviewInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedFormat, setSelectedFormat] = useState<string>('');
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    preview(url)
      .then((data) => {
        if (cancelled) return;
        setInfo(data);
        setSelectedFormat('');
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Could not load formats for this video.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  const title = info?.title || result?.title || 'Untitled';
  const videoId = info?.id || result?.id || '';
  const metaParts = [
    formatDuration(info?.duration ?? result?.duration),
    info?.uploader || result?.uploader,
  ].filter(Boolean);

  const formats = (info?.formats || [])
    .filter((f) => f.id && (f.height || f.container))
    .sort((a, b) => (b.height || 0) - (a.height || 0));

  const embedWidth = windowWidth - 32;
  const embedHeight = embedWidth * (9 / 16);

  const startDownload = async () => {
    setStarting(true);
    setError('');
    try {
      const job = await createJob(url, selectedFormat || undefined);
      navigation.navigate('Download', {
        jobId: job.job_id,
        title,
        container: job.container,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the download.');
    } finally {
      setStarting(false);
    }
  };

  return (
    <ScrollView style={{ backgroundColor: colors.bg }} contentContainerStyle={styles.container}>
      {videoId ? (
        <View style={[styles.embed, { backgroundColor: '#000', height: embedHeight }]}>
          <YoutubePlayer height={embedHeight} width={embedWidth} videoId={videoId} play={false} />
        </View>
      ) : null}

      <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
      {metaParts.length > 0 ? (
        <Text style={[styles.meta, { color: colors.muted }]}>{metaParts.join(' · ')}</Text>
      ) : null}

      {error ? <Text style={[styles.error, { color: colors.danger }]}>{error}</Text> : null}

      {loading ? (
        <ActivityIndicator style={{ marginTop: 20 }} color={colors.primary} />
      ) : (
        <>
          <Text style={[styles.sectionLabel, { color: colors.muted }]}>Format</Text>
          <View style={[styles.pickerWrap, { backgroundColor: colors.panel, borderColor: colors.border }]}>
            <Picker
              selectedValue={selectedFormat}
              onValueChange={(value) => setSelectedFormat(value)}
              style={[styles.picker, { color: colors.text }]}
              dropdownIconColor={colors.text}
              itemStyle={{ color: colors.text }}
            >
              <Picker.Item label="Best available" value="" />
              {formats.map((format) => (
                <Picker.Item key={format.id} label={formatLabel(format)} value={format.id} />
              ))}
            </Picker>
          </View>

          <Pressable
            disabled={starting}
            onPress={startDownload}
            style={[styles.downloadButton, { backgroundColor: colors.primary, opacity: starting ? 0.7 : 1 }]}
          >
            <Text style={styles.downloadButtonText}>{starting ? 'Starting…' : 'Download'}</Text>
          </Pressable>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, paddingTop: 54 },
  embed: { width: '100%', aspectRatio: 16 / 9, borderRadius: 14, marginBottom: 14, overflow: 'hidden' },
  embedWebview: { flex: 1, backgroundColor: '#000' },
  title: { fontSize: 17, fontWeight: '700' },
  meta: { fontSize: 12, marginTop: 4 },
  error: { marginTop: 12 },
  sectionLabel: { fontSize: 12, fontWeight: '600', marginTop: 18, marginBottom: 8 },
  pickerWrap: {
    borderWidth: 1,
    borderRadius: 10,
    overflow: 'hidden',
    // iOS renders Picker as an inline wheel that needs real height;
    // Android renders it as a compact native dropdown row.
    height: Platform.OS === 'ios' ? 170 : 48,
    justifyContent: 'center',
  },
  picker: { width: '100%' },
  downloadButton: { marginTop: 22, borderRadius: 10, paddingVertical: 13, alignItems: 'center' },
  downloadButtonText: { color: '#04121f', fontWeight: '700', fontSize: 15 },
});
