import { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { createJob, preview } from '../api/client';
import { FormatEntry, PreviewInfo } from '../api/types';
import { useTheme } from '../theme/theme';
import { formatDuration, formatLabel } from '../utils/format';
import { RootStackParamList } from '../navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'Preview'>;

export function PreviewScreen({ route, navigation }: Props) {
  const { colors } = useTheme();
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
  const metaParts = [
    formatDuration(info?.duration ?? result?.duration),
    info?.uploader || result?.uploader,
  ].filter(Boolean);

  const formats = (info?.formats || [])
    .filter((f) => f.id && (f.height || f.container))
    .sort((a, b) => (b.height || 0) - (a.height || 0));

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
      {result?.thumbnail ? (
        <View style={[styles.embed, { backgroundColor: '#000' }]}>
          <Image source={{ uri: result.thumbnail }} style={styles.embedImage} resizeMode="cover" />
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
          <View style={styles.formatList}>
            <FormatOption
              label="Best available"
              selected={selectedFormat === ''}
              colors={colors}
              onPress={() => setSelectedFormat('')}
            />
            {formats.map((format: FormatEntry) => (
              <FormatOption
                key={format.id}
                label={formatLabel(format)}
                selected={selectedFormat === format.id}
                colors={colors}
                onPress={() => setSelectedFormat(format.id)}
              />
            ))}
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

function FormatOption({
  label,
  selected,
  colors,
  onPress,
}: {
  label: string;
  selected: boolean;
  colors: ReturnType<typeof useTheme>['colors'];
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.formatOption,
        {
          borderColor: selected ? colors.primary : colors.border,
          backgroundColor: selected ? colors.panelAlt : colors.panel,
        },
      ]}
    >
      <Text style={{ color: colors.text, fontSize: 13 }}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, paddingTop: 54 },
  embed: { width: '100%', aspectRatio: 16 / 9, borderRadius: 14, marginBottom: 14, overflow: 'hidden' },
  embedImage: { width: '100%', height: '100%' },
  title: { fontSize: 17, fontWeight: '700' },
  meta: { fontSize: 12, marginTop: 4 },
  error: { marginTop: 12 },
  sectionLabel: { fontSize: 12, fontWeight: '600', marginTop: 18, marginBottom: 8 },
  formatList: { gap: 8 },
  formatOption: { borderWidth: 1, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 12 },
  downloadButton: { marginTop: 22, borderRadius: 10, paddingVertical: 13, alignItems: 'center' },
  downloadButtonText: { color: '#04121f', fontWeight: '700', fontSize: 15 },
});
