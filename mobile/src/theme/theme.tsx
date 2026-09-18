import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useColorScheme } from 'react-native';

// Mirrors the palette in web/index.html's :root and :root[data-theme="light"]
// blocks, so the mobile app reads as the same product.
export const palettes = {
  dark: {
    bg: '#0b1120',
    panel: '#141b2e',
    panelAlt: '#1b2440',
    text: '#e7ebf5',
    muted: '#8a93a8',
    primary: '#38bdf8',
    primaryStrong: '#0ea5e9',
    success: '#34d399',
    danger: '#f87171',
    warning: '#fbbf24',
    border: '#2a3454',
  },
  light: {
    bg: '#f3f5fa',
    panel: '#ffffff',
    panelAlt: '#eef1f7',
    text: '#101728',
    muted: '#5b6478',
    primary: '#0ea5e9',
    primaryStrong: '#0284c7',
    success: '#16a34a',
    danger: '#dc2626',
    warning: '#b45309',
    border: '#dde3ee',
  },
};

export type ThemeName = 'dark' | 'light';
export type Palette = typeof palettes.dark;

interface ThemeContextValue {
  theme: ThemeName;
  colors: Palette;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const THEME_STORAGE_KEY = 'gil_tube_theme';

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const systemScheme = useColorScheme();
  const [theme, setTheme] = useState<ThemeName>(systemScheme === 'light' ? 'light' : 'dark');

  useEffect(() => {
    AsyncStorage.getItem(THEME_STORAGE_KEY).then((stored) => {
      if (stored === 'light' || stored === 'dark') setTheme(stored);
    });
  }, []);

  const toggleTheme = () => {
    setTheme((current) => {
      const next = current === 'dark' ? 'light' : 'dark';
      AsyncStorage.setItem(THEME_STORAGE_KEY, next).catch(() => {
        // Theme just won't persist across restarts in this environment.
      });
      return next;
    });
  };

  const value = useMemo(
    () => ({ theme, colors: palettes[theme], toggleTheme }),
    [theme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
}
