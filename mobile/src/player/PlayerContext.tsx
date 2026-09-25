import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { SearchResult } from '../api/types';

// hidden: nothing playing. expanded: full sheet (player + formats + download).
// mini: shrunk to a bar docked at the bottom so the app stays usable.
export type PlayerMode = 'hidden' | 'expanded' | 'mini';

interface PlayerValue {
  current: SearchResult | null;
  mode: PlayerMode;
  open: (result: SearchResult) => void;
  setMode: (mode: PlayerMode) => void;
  close: () => void;
}

const PlayerContext = createContext<PlayerValue | null>(null);

// Owns "which video is open and how big is the player", app-wide, so the
// player can live above the navigator and keep playing while you browse.
export function PlayerProvider({ children }: { children: React.ReactNode }) {
  const [current, setCurrent] = useState<SearchResult | null>(null);
  const [mode, setMode] = useState<PlayerMode>('hidden');

  const open = useCallback((result: SearchResult) => {
    setCurrent(result);
    setMode('expanded');
  }, []);

  const close = useCallback(() => {
    setCurrent(null);
    setMode('hidden');
  }, []);

  const value = useMemo(() => ({ current, mode, open, setMode, close }), [current, mode, open, close]);

  return <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>;
}

export function usePlayer(): PlayerValue {
  const ctx = useContext(PlayerContext);
  if (!ctx) throw new Error('usePlayer must be used within a PlayerProvider');
  return ctx;
}
