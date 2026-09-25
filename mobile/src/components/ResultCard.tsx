import React, { useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { SearchResult } from '../api/types';
import { Palette } from '../theme/theme';
import { formatDuration } from '../utils/format';

// The result's own thumbnail is 1280x720; a grid tile is ~180px wide, so
// decoding it (times dozens of tiles) is wasted memory and time. YouTube
// serves a 320x180 rendition at a predictable address for real video ids.
function gridThumbnail(result: SearchResult): string | null {
  return result.id && result.id.length === 11
    ? `https://i.ytimg.com/vi/${result.id}/mqdefault.jpg`
    : result.thumbnail;
}

// Memoised: the list re-renders whenever anything on the screen changes
// (typing, suggestions, loading flags, the player), and without this every
// card rebuilt each time. `onPress` must be a stable function that takes the
// result, so an unchanged card is skipped entirely.
export const ResultCard = React.memo(function ResultCard({
  result,
  colors,
  onPress,
}: {
  result: SearchResult;
  colors: Palette;
  onPress: (result: SearchResult) => void;
}) {
  const [smallFailed, setSmallFailed] = useState(false);
  const thumb = smallFailed ? result.thumbnail : gridThumbnail(result);
  const durationLabel = formatDuration(result.duration);
  return (
    <Pressable
      onPress={() => onPress(result)}
      style={({ pressed }) => [
        styles.card,
        { backgroundColor: colors.panel, borderColor: colors.border, opacity: pressed ? 0.85 : 1 },
      ]}
    >
      <View style={styles.thumbWrap}>
        {thumb ? (
          <Image source={{ uri: thumb }} style={styles.thumb} onError={() => setSmallFailed(true)} />
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
});

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
