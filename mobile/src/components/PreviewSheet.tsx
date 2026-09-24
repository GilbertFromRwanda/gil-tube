import { Picker } from '@react-native-picker/picker';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import YoutubePlayer from 'react-native-youtube-iframe';
import { createJob, preview } from '../api/client';
import { PreviewInfo, SearchResult } from '../api/types';
import { isActive, useDownloads } from '../downloads/DownloadsContext';
import { useTheme } from '../theme/theme';
import { formatDuration, formatLabel } from '../utils/format';
import { DownloadPanel } from './DownloadPanel';

const SLIDE_MS = 280;
const DISMISS_DISTANCE = 120;
const DISMISS_VELOCITY = 0.9;

// Bottom sheet that slides up over the results list to play the tapped
// video and pick a format, instead of pushing a whole new screen. Built on
// RN's Modal + Animated (no gesture/reanimated native deps): drag the handle
// down, tap the dimmed backdrop, or press Android back to dismiss.
export function PreviewSheet({
  result,
  onClose,
}: {
  result: SearchResult | null;
  onClose: () => void;
}) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();

  const translateY = useRef(new Animated.Value(windowHeight)).current;
  const closing = useRef(false);

  const [info, setInfo] = useState<PreviewInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedFormat, setSelectedFormat] = useState('');
  const [starting, setStarting] = useState(false);
  const [playing, setPlaying] = useState(true);
  const { items, track } = useDownloads();
  const [jobId, setJobId] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);

  const url = result?.url || '';

  useEffect(() => {
    if (!result) return;
    closing.current = false;
    setInfo(null);
    setLoading(true);
    setError('');
    setSelectedFormat('');
    setStarting(false);
    setPlaying(true);
    setJobId(null);

    translateY.setValue(windowHeight);
    Animated.timing(translateY, {
      toValue: 0,
      duration: SLIDE_MS,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();

    let cancelled = false;
    preview(result.url)
      .then((data) => {
        if (!cancelled) setInfo(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load formats for this video.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Only re-run when a different video is opened.
  }, [url]);

  const slideOutThen = useCallback(
    (after: () => void) => {
      if (closing.current) return;
      closing.current = true;
      setPlaying(false);
      Animated.timing(translateY, {
        toValue: windowHeight,
        duration: SLIDE_MS - 40,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }).start(() => after());
    },
    [translateY, windowHeight],
  );

  const requestClose = useCallback(() => slideOutThen(onClose), [slideOutThen, onClose]);

  // Only the handle area listens for the drag, so it never fights the
  // scrolling content or the video player below it.
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onPanResponderMove: (_, gesture) => {
          if (gesture.dy > 0) translateY.setValue(gesture.dy);
        },
        onPanResponderRelease: (_, gesture) => {
          if (gesture.dy > DISMISS_DISTANCE || gesture.vy > DISMISS_VELOCITY) {
            requestClose();
          } else {
            Animated.spring(translateY, { toValue: 0, useNativeDriver: true, bounciness: 4 }).start();
          }
        },
        onPanResponderTerminate: () => {
          Animated.spring(translateY, { toValue: 0, useNativeDriver: true }).start();
        },
      }),
    [requestClose, translateY],
  );

  const title = info?.title || result?.title || 'Untitled';
  const videoId = info?.id || result?.id || '';
  const metaParts = [
    formatDuration(info?.duration ?? result?.duration),
    info?.uploader || result?.uploader,
  ].filter(Boolean);

  const formats = (info?.formats || [])
    .filter((f) => f.id && (f.height || f.container))
    .sort((a, b) => (b.height || 0) - (a.height || 0));

  const jobItem = jobId ? items.find((item) => item.jobId === jobId) : undefined;
  const jobActive = jobItem ? isActive(jobItem) : false;

  const sheetWidth = windowWidth;
  const playerWidth = sheetWidth - 32;
  const playerHeight = playerWidth * (9 / 16);

  const startDownload = async () => {
    setStarting(true);
    setError('');
    try {
      const created = await createJob(url, selectedFormat || undefined);
      track(created, title);
      setJobId(created.job_id);
      // Progress renders below the button; bring it into view once laid out.
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 150);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the download.');
    } finally {
      setStarting(false);
    }
  };

  const backdropOpacity = translateY.interpolate({
    inputRange: [0, windowHeight],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  });

  return (
    <Modal
      visible={result !== null}
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={requestClose}
    >
      <View style={styles.root}>
        <Animated.View style={[StyleSheet.absoluteFill, styles.backdrop, { opacity: backdropOpacity }]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={requestClose} accessibilityLabel="Close preview" />
        </Animated.View>

        <Animated.View
          style={[
            styles.sheet,
            {
              backgroundColor: colors.bg,
              borderColor: colors.border,
              maxHeight: windowHeight * 0.9,
              transform: [{ translateY }],
            },
          ]}
        >
          <View {...panResponder.panHandlers} style={styles.handleArea}>
            <View style={[styles.handle, { backgroundColor: colors.border }]} />
          </View>

          <ScrollView
            ref={scrollRef}
            contentContainerStyle={[styles.content, { paddingBottom: 20 + insets.bottom }]}
            showsVerticalScrollIndicator={false}
            bounces={false}
          >
            {videoId ? (
              <View style={[styles.player, { height: playerHeight }]}>
                <YoutubePlayer
                  height={playerHeight}
                  width={playerWidth}
                  videoId={videoId}
                  play={playing}
                  onChangeState={(state: string) => {
                    if (state === 'paused' || state === 'ended') setPlaying(false);
                    if (state === 'playing') setPlaying(true);
                  }}
                />
              </View>
            ) : null}

            <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
            {metaParts.length > 0 ? (
              <Text style={[styles.meta, { color: colors.muted }]}>{metaParts.join(' · ')}</Text>
            ) : null}

            {error ? <Text style={[styles.error, { color: colors.danger }]}>{error}</Text> : null}

            {loading ? (
              <ActivityIndicator style={{ marginTop: 20 }} color={colors.primary} />
            ) : info ? (
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
                    <Picker.Item label="Best available" value="" color={colors.text} />
                    {formats.map((format) => (
                      <Picker.Item key={format.id} label={formatLabel(format)} value={format.id} color={colors.text} />
                    ))}
                  </Picker>
                </View>

                <Pressable
                  disabled={starting || jobActive}
                  onPress={startDownload}
                  style={[
                    styles.downloadButton,
                    { backgroundColor: colors.primary, opacity: starting || jobActive ? 0.7 : 1 },
                  ]}
                >
                  <Text style={styles.downloadButtonText}>
                    {starting ? 'Starting…' : jobActive ? 'Downloading…' : jobItem ? 'Download again' : 'Download'}
                  </Text>
                </Pressable>

                {jobItem ? <DownloadPanel key={jobItem.jobId} item={jobItem} /> : null}
              </>
            ) : null}
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { backgroundColor: 'rgba(0,0,0,0.55)' },
  sheet: {
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderWidth: 1,
    borderBottomWidth: 0,
    overflow: 'hidden',
  },
  handleArea: { alignItems: 'center', paddingTop: 10, paddingBottom: 12 },
  handle: { width: 44, height: 5, borderRadius: 3 },
  content: { paddingHorizontal: 16 },
  player: { width: '100%', borderRadius: 14, overflow: 'hidden', backgroundColor: '#000', marginBottom: 14 },
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
