import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { isActive, useDownloads } from '../downloads/DownloadsContext';
import { useTheme } from '../theme/theme';
import { DownloadPanel } from './DownloadPanel';

// Every download started this session, newest first, so progress and the
// Save button stay reachable after the preview sheet is closed. Finished
// ones can be dismissed.
export function DownloadsTray() {
  const { colors } = useTheme();
  const { items, dismiss } = useDownloads();
  if (items.length === 0) return null;

  const running = items.filter(isActive).length;

  return (
    <View style={styles.wrap}>
      <Text style={[styles.heading, { color: colors.muted }]}>
        Downloads{running > 0 ? ` · ${running} running` : ''}
      </Text>
      <ScrollView style={styles.list} showsVerticalScrollIndicator={false} nestedScrollEnabled>
        {items.map((item) => (
          <DownloadPanel
            key={item.jobId}
            item={item}
            showTitle
            onDismiss={isActive(item) ? undefined : () => dismiss(item.jobId)}
          />
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginHorizontal: 12, marginTop: 10 },
  heading: { fontSize: 12, fontWeight: '600' },
  list: { maxHeight: 230 },
});
