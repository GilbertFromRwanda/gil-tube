import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { SearchResult } from '../api/types';
import { PlayQueue, QueueSource } from './queue';

// hidden: nothing playing. expanded: full sheet (player + formats + download).
// mini: shrunk to a bar docked at the bottom so the app stays usable.
export type PlayerMode = 'hidden' | 'expanded' | 'mini';

const AUTOPLAY_KEY = 'gil_tube_autoplay';
const AUDIO_MODE_KEY = 'gil_tube_audio_mode';

interface PlayerValue {
  current: SearchResult | null;
  mode: PlayerMode;
  // Open a video the user picked (from the list): starts a queue from that list.
  open: (result: SearchResult) => void;
  setMode: (mode: PlayerMode) => void;
  close: () => void;

  // Queue / autoplay
  // The list the queue draws from (the endless feed on the search screen).
  registerQueue: (source: QueueSource | null) => void;
  // Tell the player the list changed (more loaded, new search), so the
  // previous / next buttons re-evaluate.
  notifyQueueChanged: () => void;
  canPrev: boolean;
  canNext: boolean;
  // Move to the next video. Resolves false if there isn't one.
  next: () => Promise<boolean>;
  // Move to the previous video, or - if more than a few seconds in - ask for the
  // current one to be restarted (restart: true). Resolves what the caller should do.
  prev: (positionSeconds: number) => Promise<{ moved: boolean; restart: boolean }>;
  autoplay: boolean;
  setAutoplay: (on: boolean) => void;
  // Listen as audio only (keeps playing with the screen off, in the background).
  audioMode: boolean;
  setAudioMode: (on: boolean) => void;
}

const PlayerContext = createContext<PlayerValue | null>(null);

// Owns "which video is open and how big is the player", app-wide, so the
// player can live above the navigator and keep playing while you browse, plus
// the queue (next / previous / autoplay) and the audio-mode choice.
export function PlayerProvider({ children }: { children: React.ReactNode }) {
  const [current, setCurrent] = useState<SearchResult | null>(null);
  const [mode, setMode] = useState<PlayerMode>('hidden');
  const [autoplay, setAutoplayState] = useState(true);
  const [audioMode, setAudioModeState] = useState(false);
  const [queueVersion, setQueueVersion] = useState(0);

  const queue = useRef(new PlayQueue()).current;
  const currentRef = useRef(current);
  currentRef.current = current;

  // Remembered between launches.
  useEffect(() => {
    AsyncStorage.multiGet([AUTOPLAY_KEY, AUDIO_MODE_KEY])
      .then((pairs) => {
        for (const [key, value] of pairs) {
          if (key === AUTOPLAY_KEY && value !== null) setAutoplayState(value === '1');
          if (key === AUDIO_MODE_KEY && value !== null) setAudioModeState(value === '1');
        }
      })
      .catch(() => {});
  }, []);

  const setAutoplay = useCallback((on: boolean) => {
    setAutoplayState(on);
    AsyncStorage.setItem(AUTOPLAY_KEY, on ? '1' : '0').catch(() => {});
  }, []);

  const setAudioMode = useCallback((on: boolean) => {
    setAudioModeState(on);
    AsyncStorage.setItem(AUDIO_MODE_KEY, on ? '1' : '0').catch(() => {});
  }, []);

  const open = useCallback(
    (result: SearchResult) => {
      // Starting from the list: that list is now the queue.
      queue.adopt(result.id);
      setCurrent(result);
      setMode('expanded');
    },
    [queue],
  );

  const close = useCallback(() => {
    setCurrent(null);
    setMode('hidden');
  }, []);

  const registerQueue = useCallback(
    (source: QueueSource | null) => {
      queue.setSource(source);
    },
    [queue],
  );

  const notifyQueueChanged = useCallback(() => setQueueVersion((v) => v + 1), []);

  const next = useCallback(async () => {
    const playing = currentRef.current;
    if (!playing) return false;
    const item = await queue.next(playing.id);
    // The user may have closed or changed the video while more was loading.
    if (!item || currentRef.current?.id !== playing.id) return false;
    setCurrent(item); // the mode (mini / expanded) is left as it is
    setQueueVersion((v) => v + 1);
    return true;
  }, [queue]);

  const prev = useCallback(
    async (positionSeconds: number) => {
      const playing = currentRef.current;
      if (!playing) return { moved: false, restart: false };
      const decision = queue.prev(playing.id, positionSeconds);
      if (decision.item) {
        setCurrent(decision.item);
        setQueueVersion((v) => v + 1);
        return { moved: true, restart: false };
      }
      return { moved: false, restart: decision.restart };
    },
    [queue],
  );

  // Recomputed whenever the current video or the list changes.
  const canPrev = current ? queue.hasPrev(current.id) : false;
  const canNext = current ? queue.hasNext(current.id) : false;

  const value = useMemo(
    () => ({
      current,
      mode,
      open,
      setMode,
      close,
      registerQueue,
      notifyQueueChanged,
      canPrev,
      canNext,
      next,
      prev,
      autoplay,
      setAutoplay,
      audioMode,
      setAudioMode,
    }),
    // queueVersion makes canPrev / canNext refresh when the list changes.
    [current, mode, open, close, registerQueue, notifyQueueChanged, canPrev, canNext, next, prev, autoplay, setAutoplay, audioMode, setAudioMode, queueVersion],
  );

  return <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>;
}

export function usePlayer(): PlayerValue {
  const ctx = useContext(PlayerContext);
  if (!ctx) throw new Error('usePlayer must be used within a PlayerProvider');
  return ctx;
}
