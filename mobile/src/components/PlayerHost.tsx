import { Picker } from '@react-native-picker/picker';
import { setAudioModeAsync, useAudioPlayer } from 'expo-audio';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  AppState,
  BackHandler,
  Easing,
  Image,
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
import YoutubePlayer, { YoutubeIframeRef } from 'react-native-youtube-iframe';
import { createJob, getAudioStreamUrl, getCachedPreview, preview } from '../api/client';
import { PreviewInfo } from '../api/types';
import { isActive, useDownloads } from '../downloads/DownloadsContext';
import { createHandoff, Handoff } from '../player/handoff';
import { usePlayer } from '../player/PlayerContext';
import { useTheme } from '../theme/theme';
import { formatDuration, formatLabel } from '../utils/format';
import { DownloadPanel } from './DownloadPanel';
import { SkeletonBlock } from './SkeletonBlock';

// Expo Go doesn't ship the audio library's Android media service (it needs the
// config plugin, i.e. a real build), so lock-screen controls can't be attached
// there - trying only logs errors. Audio still plays; it just has no controls.
const IS_EXPO_GO = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

const SLIDE_MS = 280;
const HANDLE_H = 28;
const MINI_H = 80;
const MINI_VIDEO_W = 128;
const MINI_VIDEO_H = 72;

// The app-wide video player. One YouTube player stays mounted and is moved and
// scaled by a single animated value between two layouts:
//   expanded - a bottom sheet with the player, formats and download.
//   mini     - a bar docked at the bottom (small video, title, play/pause,
//              close), so the list, Settings etc. stay usable while it plays.
// Drag the handle down (or tap the dimmed area / press Android back) to
// minimise; tap or drag up on the bar to expand; swipe the bar down or press
// its X to stop. Built on RN's Animated only - no gesture/reanimated deps.
export function PlayerHost() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { width: W, height: H } = useWindowDimensions();
  const { current, mode, setMode, close, next, prev, canPrev, canNext, autoplay, setAutoplay, audioMode, setAudioMode } =
    usePlayer();
  const { items, track } = useDownloads();

  // Geometry, all in px. The sheet is a fixed-height panel anchored to the
  // bottom of the screen; `y` is its vertical offset (0 = expanded, miniY =
  // only the top MINI_H strip showing, sheetH = fully hidden).
  const sheetH = Math.round(H * 0.88);
  const miniY = sheetH - MINI_H - insets.bottom;
  const playerW = W - 32;
  const playerH = playerW * (9 / 16);
  const scale = MINI_VIDEO_W / playerW;
  // Scaling happens about the element's centre, so moving its top-left to the
  // mini position needs the shrink offset subtracted.
  const miniTx = 12 - 16 - ((1 - scale) * playerW) / 2;
  const miniTy = 4 - HANDLE_H - ((1 - scale) * playerH) / 2;

  const y = useRef(new Animated.Value(H)).current;

  const [info, setInfo] = useState<PreviewInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedFormat, setSelectedFormat] = useState('');
  const [starting, setStarting] = useState(false);
  const [playing, setPlaying] = useState(true);
  const [playerReady, setPlayerReady] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const closing = useRef(false);

  // --- Background audio -----------------------------------------------------
  // The YouTube embed stops when the app leaves the screen, so at that moment
  // playback is handed to an audio-only stream from our server (and handed back
  // when the app returns). See player/handoff.ts for the rules; this wires it
  // to the real player, audio engine and app state.
  const ytRef = useRef<YoutubeIframeRef | null>(null);
  const audio = useAudioPlayer(null);
  const audioRef = useRef(audio);
  audioRef.current = audio;
  const currentRef = useRef(current);
  currentRef.current = current;
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const lastVideoTime = useRef<{ seconds: number; at: number } | null>(null);
  const lastPlayingAt = useRef<number | null>(null);
  const handoffRef = useRef<Handoff | null>(null);
  // Long-lived callbacks (the handoff, audio events) must see the latest values.
  const nextRef = useRef(next);
  nextRef.current = next;
  const autoplayRef = useRef(autoplay);
  autoplayRef.current = autoplay;
  const setAudioModeRef = useRef(setAudioMode);
  setAudioModeRef.current = setAudioMode;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  // Lock-screen controls are switched on once per audio session, then only their
  // text is updated as tracks change.
  const lockScreenActive = useRef(false);
  // The video whose end already triggered autoplay, so one 'ended' can't skip twice.
  const endedFor = useRef<string | null>(null);
  const [audioPlaying, setAudioPlaying] = useState(false);

  useEffect(() => {
    setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      // Needed for the lock-screen / notification controls to attach to us.
      interruptionMode: 'doNotMix',
    }).catch(() => {});
  }, []);

  if (!handoffRef.current) {
    handoffRef.current = createHandoff({
      now: Date.now,
      lastVideoTime: () => lastVideoTime.current,
      lastPlayingAt: () => lastPlayingAt.current,
      pauseVideo: () => setPlaying(false),
      startAudio: async (fromSeconds) => {
        const video = currentRef.current;
        if (!video) throw new Error('no video open');
        const player = audioRef.current;
        player.replace({ uri: await getAudioStreamUrl(video.url) });
        await player.seekTo(fromSeconds);
        if (!IS_EXPO_GO) {
          const metadata = {
            title: video.title,
            artist: video.uploader ?? undefined,
            artworkUrl: video.thumbnail ?? undefined,
          };
          if (lockScreenActive.current) {
            // Already showing controls: just change the track's text.
            player.updateLockScreenMetadata(metadata);
          } else {
            player.setActiveForLockScreen(true, metadata);
            lockScreenActive.current = true;
          }
        }
        player.play();
      },
      stopAudio: () => {
        // Each native call is isolated: this runs when the app returns to the
        // screen, and one failing must not stop the rest (or crash the app).
        const player = audioRef.current;
        let seconds = NaN;
        let wasPlaying = true;
        try {
          seconds = player.currentTime;
          wasPlaying = player.playing;
        } catch (err) {
          console.warn('Could not read the audio position:', err);
        }
        try {
          player.pause();
        } catch (err) {
          console.warn('Could not pause the audio:', err);
        }
        try {
          // Deactivate (not just clear): this also resets the player's own
          // "active for lock screen" flag, which clearLockScreenControls()
          // leaves set. The old source stays loaded until the next handoff
          // replaces it - replace(null) is not valid, the native side takes a
          // non-null source and the call threw.
          if (!IS_EXPO_GO && lockScreenActive.current) player.setActiveForLockScreen(false);
        } catch (err) {
          console.warn('Could not release the lock-screen controls:', err);
        }
        lockScreenActive.current = false;
        return { seconds, wasPlaying };
      },
      resumeVideo: (seconds, wasPlaying) => {
        if (Number.isFinite(seconds)) {
          ytRef.current?.seekTo(seconds, true);
          lastVideoTime.current = { seconds, at: Date.now() };
        }
        if (wasPlaying) lastPlayingAt.current = Date.now();
        setPlaying(wasPlaying);
      },
      // The audio track ended: autoplay moves to the next video (which the
      // handoff then follows with audio). With autoplay off, or nothing next,
      // it simply stops.
      advanceAudio: async () => (autoplayRef.current ? nextRef.current() : false),
      // Audio mode was switched on but couldn't start: flip the switch back.
      onExplicitFailed: () => {
        setAudioModeRef.current(false);
        setError('Could not start audio. Check the server address and connection.');
      },
      onError: (err) => console.warn('Background audio could not start:', err),
    });
  }

  // Audio progress: keeps the play/pause icon honest in audio mode and reports
  // the end of a track, which is what drives autoplay when the app is in the
  // background (the video player can't tell us anything then).
  useEffect(() => {
    const player = audioRef.current;
    const subscription = player.addListener('playbackStatusUpdate', (status) => {
      try {
        setAudioPlaying(status.playing);
        if (status.didJustFinish) handoffRef.current?.handleAudioEnded();
      } catch (err) {
        console.warn('Audio status handler failed:', err);
      }
    });
    return () => subscription.remove();
  }, [audio]);

  // Audio mode: the user chose to listen instead of watch.
  const hasCurrent = !!current;
  useEffect(() => {
    const handoff = handoffRef.current;
    if (!handoff || !hasCurrent) return;
    try {
      if (audioMode) handoff.enterAudioMode();
      else handoff.exitAudioMode();
    } catch (err) {
      console.warn('Switching audio mode failed:', err);
    }
  }, [audioMode, hasCurrent]);

  useEffect(() => {
    if (!current) return;
    const sub = AppState.addEventListener('change', (state) => {
      // The handoff contains its own failures; this is the last line of
      // defence, because an error thrown from here is uncaught and closes a
      // release build of the app.
      try {
        handoffRef.current?.handleAppState(state);
      } catch (err) {
        console.warn('Background audio handoff failed:', err);
      }
    });
    return () => sub.remove();
  }, [current]);

  // While the video plays on screen, keep noting where it is, so there is a
  // recent position to continue from the instant the app is backgrounded (the
  // embed can't be asked once it has been suspended).
  useEffect(() => {
    if (!current) return;
    const timer = setInterval(() => {
      if (!playingRef.current || AppState.currentState !== 'active') return;
      ytRef.current
        ?.getCurrentTime()
        .then((seconds) => {
          lastVideoTime.current = { seconds, at: Date.now() };
          lastPlayingAt.current = Date.now();
        })
        .catch(() => {});
    }, 1000);
    return () => clearInterval(timer);
  }, [current]);

  // Closing the player must also silence any audio-only playback.
  useEffect(() => {
    if (current) return;
    // Reset the handoff too, otherwise it would still think audio is running
    // and ignore the next video that is opened.
    try {
      handoffRef.current?.exitAudioMode();
    } catch {
      // Best effort.
    }
    const player = audioRef.current;
    try {
      player.pause();
      if (!IS_EXPO_GO && lockScreenActive.current) player.setActiveForLockScreen(false);
    } catch {
      // Nothing was playing.
    }
    lockScreenActive.current = false;
  }, [current]);

  const url = current?.url || '';

  const animateTo = useCallback(
    (target: 'expanded' | 'mini') => {
      Animated.timing(y, {
        toValue: target === 'mini' ? miniY : 0,
        duration: SLIDE_MS,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    },
    [y, miniY],
  );

  // A new video was opened: reset per-video state, slide the sheet up, and
  // load its formats (from the in-memory cache when a prewarm already did).
  useEffect(() => {
    if (!current) return;
    closing.current = false;
    const cachedInfo = getCachedPreview(current.url);
    setInfo(cachedInfo);
    setLoading(!cachedInfo);
    setPlayerReady(false);
    setError('');
    setSelectedFormat('');
    setStarting(false);
    setJobId(null);

    // Nothing carries over from the previous video: its position would be
    // wrong for this one.
    lastVideoTime.current = null;
    lastPlayingAt.current = null;
    endedFor.current = null;

    // In audio mode (or a background handoff) the video stays paused and the
    // audio follows to this video instead.
    const handoff = handoffRef.current;
    const audioOwned = !!handoff && (handoff.isAudioActive() || handoff.isExplicit());
    setPlaying(!audioOwned);
    if (audioOwned) {
      try {
        handoff?.handleVideoChanged();
      } catch (err) {
        console.warn('Following the new video with audio failed:', err);
      }
    }

    // Slides up from wherever the sheet is: below the screen on first open
    // (it is always parked there while hidden), from the mini bar when a video
    // is opened from the list while one is minimised - and stays where it is
    // when the video changed by itself (autoplay, next, previous).
    animateTo(modeRef.current === 'mini' ? 'mini' : 'expanded');

    let cancelled = false;
    if (cachedInfo) return;
    preview(current.url)
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

  // Failsafe: if a video never reports a state (an embed error, say), don't
  // leave the thumbnail cover and spinner over the player forever.
  useEffect(() => {
    if (!current || playerReady) return;
    const timer = setTimeout(() => setPlayerReady(true), 8000);
    return () => clearTimeout(timer);
  }, [current, playerReady, url]);

  const goExpanded = useCallback(() => {
    setMode('expanded');
    animateTo('expanded');
  }, [setMode, animateTo]);

  const goMini = useCallback(() => {
    setMode('mini');
    animateTo('mini');
  }, [setMode, animateTo]);

  const stopAndClose = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    setPlaying(false);
    Animated.timing(y, {
      toValue: sheetH,
      duration: SLIDE_MS - 60,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start(() => close());
  }, [y, sheetH, close]);

  // Android back: shrink the full sheet to the mini bar instead of leaving
  // the app; with the bar showing, back behaves normally.
  useEffect(() => {
    if (!current) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (mode === 'expanded') {
        goMini();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [current, mode, goMini]);

  // The pan handlers are created once but must always call the latest
  // actions, so they go through a ref that is refreshed every render.
  const actions = useRef({ mode, goExpanded, goMini, stopAndClose, animateTo, miniY, sheetH });
  actions.current = { mode, goExpanded, goMini, stopAndClose, animateTo, miniY, sheetH };
  const dragStart = useRef(0);

  const panRef = useRef<ReturnType<typeof PanResponder.create> | null>(null);
  if (!panRef.current) {
    panRef.current = PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        y.stopAnimation();
        dragStart.current = actions.current.mode === 'mini' ? actions.current.miniY : 0;
      },
      onPanResponderMove: (_, g) => {
        const a = actions.current;
        y.setValue(Math.min(Math.max(dragStart.current + g.dy, 0), a.sheetH));
      },
      onPanResponderRelease: (_, g) => {
        const a = actions.current;
        if (a.mode === 'mini') {
          const moved = Math.abs(g.dx) > 8 || Math.abs(g.dy) > 8;
          if (!moved || g.dy < -40 || g.vy < -0.6) a.goExpanded();
          else if (g.dy > 60 || g.vy > 0.8) a.stopAndClose();
          else a.animateTo('mini');
        } else if (g.dy > 100 || g.vy > 0.8) {
          a.goMini();
        } else {
          a.animateTo('expanded');
        }
      },
      onPanResponderTerminate: () => actions.current.animateTo(actions.current.mode === 'mini' ? 'mini' : 'expanded'),
    });
  }
  const panResponder = panRef.current;

  if (!current) return null;

  const title = info?.title || current.title || 'Untitled';
  const videoId = info?.id || current.id || '';
  const metaParts = [
    formatDuration(info?.duration ?? current.duration),
    info?.uploader || current.uploader,
  ].filter(Boolean);

  const formats = (info?.formats || [])
    .filter((f) => f.id && (f.height || f.container))
    .sort((a, b) => (b.height || 0) - (a.height || 0));

  const jobItem = jobId ? items.find((item) => item.jobId === jobId) : undefined;
  const jobActive = jobItem ? isActive(jobItem) : false;

  const startDownload = async () => {
    setStarting(true);
    setError('');
    try {
      const created = await createJob(url, selectedFormat || undefined);
      track(created, title);
      setJobId(created.job_id);
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 150);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the download.');
    } finally {
      setStarting(false);
    }
  };

  // ---- Transport: previous / play-pause / next --------------------------------
  const isPlayingNow = audioMode ? audioPlaying : playing;

  const togglePlayPause = () => {
    if (audioMode) {
      try {
        if (audio.playing) audio.pause();
        else audio.play();
      } catch (err) {
        console.warn('Could not toggle the audio:', err);
      }
      return;
    }
    setPlaying((p) => !p);
  };

  // Where the current video is right now, in seconds.
  const currentPosition = async (): Promise<number> => {
    try {
      if (audioMode) return audio.currentTime || 0;
      const seconds = await ytRef.current?.getCurrentTime();
      if (typeof seconds === 'number' && Number.isFinite(seconds)) return seconds;
    } catch {
      // Fall back to the last position noted while it was playing.
    }
    return lastVideoTime.current?.seconds ?? 0;
  };

  const restartCurrent = () => {
    try {
      if (audioMode) {
        audio.seekTo(0);
        audio.play();
      } else {
        ytRef.current?.seekTo(0, true);
        setPlaying(true);
      }
    } catch (err) {
      console.warn('Could not restart:', err);
    }
  };

  const goNext = () => {
    next().catch((err) => console.warn('Next failed:', err));
  };

  const goPrev = async () => {
    try {
      const result = await prev(await currentPosition());
      if (result.restart) restartCurrent();
    } catch (err) {
      console.warn('Previous failed:', err);
    }
  };

  const clamp = { extrapolate: 'clamp' as const };
  const backdropOpacity = y.interpolate({ inputRange: [0, miniY], outputRange: [1, 0], ...clamp });
  const expandedOpacity = y.interpolate({ inputRange: [0, miniY * 0.5], outputRange: [1, 0], ...clamp });
  const miniOpacity = y.interpolate({ inputRange: [miniY * 0.5, miniY], outputRange: [0, 1], ...clamp });
  const playerTx = y.interpolate({ inputRange: [0, miniY], outputRange: [0, miniTx], ...clamp });
  const playerTy = y.interpolate({ inputRange: [0, miniY], outputRange: [0, miniTy], ...clamp });
  const playerScale = y.interpolate({ inputRange: [0, miniY], outputRange: [1, scale], ...clamp });

  const isMini = mode === 'mini';
  const miniTextLeft = 12 + MINI_VIDEO_W + 12;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <Animated.View
        style={[StyleSheet.absoluteFill, styles.backdrop, { opacity: backdropOpacity }]}
        pointerEvents={isMini ? 'none' : 'auto'}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={goMini} accessibilityLabel="Minimise player" />
      </Animated.View>

      <Animated.View
        pointerEvents="box-none"
        style={[
          styles.sheet,
          {
            height: sheetH,
            backgroundColor: colors.bg,
            borderColor: colors.border,
            transform: [{ translateY: y }],
          },
        ]}
      >
        {/* Expanded layout: grab handle, close, then the scrolling details. */}
        <Animated.View
          style={[StyleSheet.absoluteFill, { opacity: expandedOpacity }]}
          pointerEvents={isMini ? 'none' : 'box-none'}
        >
          <View {...panResponder.panHandlers} style={styles.handleArea}>
            <View style={[styles.handle, { backgroundColor: colors.border }]} />
          </View>
          <Pressable
            onPress={stopAndClose}
            hitSlop={10}
            style={[styles.closeX, { backgroundColor: colors.panelAlt, borderColor: colors.border }]}
            accessibilityLabel="Stop and close"
          >
            <Text style={{ color: colors.muted, fontSize: 13 }}>✕</Text>
          </Pressable>

          <ScrollView
            ref={scrollRef}
            style={{ position: 'absolute', left: 0, right: 0, bottom: 0, top: HANDLE_H + playerH + 14 }}
            contentContainerStyle={[styles.content, { paddingBottom: 20 + insets.bottom }]}
            showsVerticalScrollIndicator={false}
            bounces={false}
          >
            <View style={styles.transport}>
              <Pressable
                onPress={goPrev}
                style={[styles.transportButton, { backgroundColor: colors.panelAlt, borderColor: colors.border, opacity: canPrev ? 1 : 0.6 }]}
                accessibilityLabel="Previous video"
              >
                <Text style={[styles.transportGlyph, { color: colors.text }]}>⏮</Text>
              </Pressable>
              <Pressable
                onPress={togglePlayPause}
                style={[styles.transportButton, styles.transportMain, { backgroundColor: colors.primary, borderColor: colors.primary }]}
                accessibilityLabel={isPlayingNow ? 'Pause' : 'Play'}
              >
                <Text style={[styles.transportGlyph, { color: '#04121f' }]}>{isPlayingNow ? '❚❚' : '▶'}</Text>
              </Pressable>
              <Pressable
                onPress={goNext}
                disabled={!canNext}
                style={[styles.transportButton, { backgroundColor: colors.panelAlt, borderColor: colors.border, opacity: canNext ? 1 : 0.35 }]}
                accessibilityLabel="Next video"
              >
                <Text style={[styles.transportGlyph, { color: colors.text }]}>⏭</Text>
              </Pressable>
            </View>
            <View style={styles.chips}>
              <Pressable
                onPress={() => setAudioMode(!audioMode)}
                style={[styles.chip, { borderColor: audioMode ? colors.primary : colors.border, backgroundColor: audioMode ? colors.panelAlt : colors.panel }]}
                accessibilityRole="switch"
                accessibilityState={{ checked: audioMode }}
              >
                <Text style={{ color: audioMode ? colors.primary : colors.muted, fontSize: 12, fontWeight: '600' }}>
                  🎧 Audio only {audioMode ? '· on' : ''}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => setAutoplay(!autoplay)}
                style={[styles.chip, { borderColor: autoplay ? colors.primary : colors.border, backgroundColor: autoplay ? colors.panelAlt : colors.panel }]}
                accessibilityRole="switch"
                accessibilityState={{ checked: autoplay }}
              >
                <Text style={{ color: autoplay ? colors.primary : colors.muted, fontSize: 12, fontWeight: '600' }}>
                  ⏭ Autoplay {autoplay ? '· on' : '· off'}
                </Text>
              </Pressable>
            </View>

            <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
            {metaParts.length > 0 ? (
              <Text style={[styles.meta, { color: colors.muted }]}>{metaParts.join(' · ')}</Text>
            ) : null}

            {error ? <Text style={[styles.error, { color: colors.danger }]}>{error}</Text> : null}

            {loading ? (
              <View>
                <SkeletonBlock colors={colors} style={styles.skelLabel} />
                <SkeletonBlock colors={colors} style={styles.skelPicker} />
                <SkeletonBlock colors={colors} style={styles.skelButton} />
              </View>
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

        {/* The one persistent player. It is laid out at full size and only
            scaled/moved by transforms, so it never reloads or interrupts
            playback when the panel shrinks to the mini bar. */}
        {videoId ? (
          <Animated.View
            pointerEvents={isMini ? 'none' : 'auto'}
            style={[
              styles.player,
              {
                top: HANDLE_H,
                left: 16,
                width: playerW,
                height: playerH,
                transform: [{ translateX: playerTx }, { translateY: playerTy }, { scale: playerScale }],
              },
            ]}
          >
            <YoutubePlayer
              ref={ytRef}
              height={playerH}
              width={playerW}
              videoId={videoId}
              play={playing}
              onReady={() => setPlayerReady(true)}
              onChangeState={(state: string) => {
                if (state === 'paused' || state === 'ended') setPlaying(false);
                if (state === 'ended' && autoplayRef.current && !audioMode && endedFor.current !== current.id) {
                  // The video finished: carry on with the next one in the list.
                  endedFor.current = current.id;
                  nextRef.current().catch((err) => console.warn('Autoplay failed:', err));
                }
                if (state === 'playing') {
                  setPlaying(true);
                  lastPlayingAt.current = Date.now();
                }
                // onReady fires only once, when the player first starts. A
                // video loaded into the already-running player (opened while
                // minimised) only reports these state changes, so they are
                // what clear the thumbnail cover for it.
                if (state === 'buffering' || state === 'playing' || state === 'video cued') setPlayerReady(true);
              }}
            />
            {audioMode ? (
              <View style={styles.audioOverlay} pointerEvents="none">
                {current.thumbnail ? (
                  <Image source={{ uri: current.thumbnail }} style={StyleSheet.absoluteFill} resizeMode="cover" />
                ) : null}
                <View style={styles.audioOverlayShade}>
                  <Text style={styles.audioOverlayText}>🎧 Audio only</Text>
                </View>
              </View>
            ) : null}
            {/* Cover until ready: the thumbnail from the results grid plus a
                spinner, so the box is never empty while the embed loads. */}
            {!playerReady ? (
              <View style={StyleSheet.absoluteFill} pointerEvents="none">
                {current.thumbnail ? (
                  <Image source={{ uri: current.thumbnail }} style={StyleSheet.absoluteFill} resizeMode="cover" />
                ) : (
                  <SkeletonBlock colors={colors} style={StyleSheet.absoluteFill} />
                )}
                <View style={styles.playerLoading}>
                  <ActivityIndicator size="large" color="#fff" />
                </View>
              </View>
            ) : null}
          </Animated.View>
        ) : null}

        {/* Mini bar controls, drawn over the shrunk video's row. Drag up to
            expand, swipe down to stop, tap anywhere on it to expand. */}
        <Animated.View
          {...panResponder.panHandlers}
          pointerEvents={isMini ? 'auto' : 'none'}
          style={[styles.miniBar, { height: MINI_H, opacity: miniOpacity }]}
        >
          <View style={[styles.miniText, { left: miniTextLeft, right: 140 }]}>
            <Text style={[styles.miniTitle, { color: colors.text }]} numberOfLines={2}>
              {title}
            </Text>
            {metaParts.length > 0 ? (
              <Text style={[styles.miniMeta, { color: colors.muted }]} numberOfLines={1}>
                {metaParts.join(' · ')}
              </Text>
            ) : null}
          </View>
          <Pressable
            onPress={goNext}
            disabled={!canNext}
            hitSlop={8}
            style={[styles.miniButton, { right: 96, opacity: canNext ? 1 : 0.35 }]}
            accessibilityLabel="Next video"
          >
            <Text style={{ color: colors.text, fontSize: 18 }}>⏭</Text>
          </Pressable>
          <Pressable
            onPress={togglePlayPause}
            hitSlop={8}
            style={[styles.miniButton, { right: 52 }]}
            accessibilityLabel={isPlayingNow ? 'Pause' : 'Play'}
          >
            <Text style={{ color: colors.text, fontSize: 20 }}>{isPlayingNow ? '❚❚' : '▶'}</Text>
          </Pressable>
          <Pressable onPress={stopAndClose} hitSlop={8} style={[styles.miniButton, { right: 8 }]} accessibilityLabel="Stop and close">
            <Text style={{ color: colors.muted, fontSize: 18 }}>✕</Text>
          </Pressable>
        </Animated.View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { backgroundColor: 'rgba(0,0,0,0.55)' },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderWidth: 1,
    borderBottomWidth: 0,
    overflow: 'hidden',
    elevation: 16,
  },
  handleArea: { height: HANDLE_H, alignItems: 'center', paddingTop: 10 },
  handle: { width: 44, height: 5, borderRadius: 3 },
  closeX: {
    position: 'absolute',
    top: 4,
    right: 12,
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: { paddingHorizontal: 16 },
  player: { position: 'absolute', borderRadius: 14, overflow: 'hidden', backgroundColor: '#000' },
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
  playerLoading: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  transport: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 14, marginBottom: 12 },
  transportButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  transportMain: { width: 60, height: 60, borderRadius: 30 },
  transportGlyph: { fontSize: 20 },
  chips: { flexDirection: 'row', gap: 8, justifyContent: 'center', marginBottom: 14 },
  chip: { borderWidth: 1, borderRadius: 999, paddingVertical: 7, paddingHorizontal: 12 },
  audioOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#000' },
  audioOverlayShade: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  audioOverlayText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  miniBar: { position: 'absolute', top: 0, left: 0, right: 0 },
  miniText: { position: 'absolute', top: 0, bottom: 0, justifyContent: 'center' },
  miniTitle: { fontSize: 14, fontWeight: '600', lineHeight: 18 },
  miniMeta: { fontSize: 11, marginTop: 3 },
  miniButton: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  skelLabel: { width: 60, height: 12, marginTop: 18, marginBottom: 8, borderRadius: 6 },
  skelPicker: { height: Platform.OS === 'ios' ? 170 : 48 },
  skelButton: { height: 46, marginTop: 22 },
  downloadButton: { marginTop: 22, borderRadius: 10, paddingVertical: 13, alignItems: 'center' },
  downloadButtonText: { color: '#04121f', fontWeight: '700', fontSize: 15 },
});
