import React from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { SearchResult } from '../api/types';
import { Palette } from '../theme/theme';
import { formatDuration } from '../utils/format';

export function ResultCard({
  result,
  colors,
  onPress,
}: {
  result: SearchResult;
  colors: Palette;
  onPress: () => void;
}) {
  const durationLabel = formatDuration(result.duration);
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        { backgroundColor: colors.panel, borderColor: colors.border, opacity: pressed ? 0.85 : 1 },
      ]}
    >
      <View style={styles.thumbWrap}>
        {result.thumbnail ? (
          <Image source={{ uri: result.thumbnail }} style={styles.thumb} />
        ) : (
          <View style={[styles.thumb, { backgroundColor: colors.panelAlt }]} />
        )}
        {durationLabel ? (
          <View style={styles.durationBadge}>
            <Text style={styles.durationText}>{durationLabel}</Text>
          </View>
        ) : null}
      </View>
      <View style={styles.info}>
        <Text style={[styles.title, { color: colors.text }]} numberOfLines={2}>
          {result.title || 'Untitled'}
        </Text>
        {result.uploader ? (
          <Text style={[styles.meta, { color: colors.muted }]} numberOfLines={1}>
            {result.uploader}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    margin: 6,
    borderRadius: 12,
    borderWidth: 1,
    overflow: 'hidden',
  },
  thumbWrap: { position: 'relative', backgroundColor: '#000' },
  thumb: { width: '100%', aspectRatio: 16 / 9 },
  durationBadge: {
    position: 'absolute',
    right: 6,
    bottom: 6,
    backgroundColor: 'rgba(0,0,0,0.8)',
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  durationText: { color: '#fff', fontSize: 11, fontWeight: '600' },
  info: { padding: 8 },
  title: { fontSize: 13, fontWeight: '600', lineHeight: 17 },
  meta: { fontSize: 11, marginTop: 3 },
});
