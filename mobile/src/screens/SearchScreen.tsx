import { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { ApiNotConfiguredError, cachedSearches, prewarmPreviews, search, searchSuggestions } from '../api/client';
import { SearchResult } from '../api/types';
import { DownloadsTray } from '../components/DownloadsTray';
import { PreviewSheet } from '../components/PreviewSheet';
import { ResultCard } from '../components/ResultCard';
import { SkeletonGrid } from '../components/SkeletonGrid';
import { useTheme } from '../theme/theme';
import { RootStackParamList } from '../navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'Search'>;

const DEFAULT_QUERY = 'Rwanda SDA music';
const PAGE_SIZE = 24;

export function SearchScreen({ navigation }: Props) {
  const { colors, theme, toggleTheme } = useTheme();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [heading, setHeading] = useState('');
  const [selected, setSelected] = useState<SearchResult | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // What the list currently shows: a live search's query, or null for the
  // cached-videos feed. Pull-to-refresh reloads whichever this is.
  const [activeQuery, setActiveQuery] = useState<string | null>(null);

  // Cached-videos view is a paged feed (infinite scroll); a live search
  // returns one fixed batch from yt-dlp per query, so there's nothing to
  // page through there. Mirrors web/index.html's cachedVideosHasMore logic.
  const [cachedOffset, setCachedOffset] = useState(0);
  const [cachedHasMore, setCachedHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  // Prefix matches against queries stored in Redis, fetched as you type.
  // The sequence ref drops responses that a newer keystroke already
  // superseded, so a slow reply for "re" can't overwrite the one for "rek".
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const suggestionSeq = useRef(0);
  const suggestionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onQueryChange = (text: string) => {
    setQuery(text);
    if (suggestionTimer.current) clearTimeout(suggestionTimer.current);
    const prefix = text.trim();
    if (!prefix) {
      suggestionSeq.current += 1;
      setSuggestions([]);
      return;
    }
    suggestionTimer.current = setTimeout(async () => {
      const seq = ++suggestionSeq.current;
      try {
        const data = await searchSuggestions(prefix);
        if (seq === suggestionSeq.current) setSuggestions(data.suggestions || []);
      } catch (err) {
        if (seq === suggestionSeq.current) setSuggestions([]);
      }
    }, 150);
  };

  const pickSuggestion = (text: string) => {
    suggestionSeq.current += 1;
    setSuggestions([]);
    setQuery(text);
    runSearch(text);
  };

  const loadInitial = useCallback(async () => {
    setLoading(true);
    setError('');
    // One outer finally so every exit path (including the early return for
    // cached videos) clears the loading flag - otherwise the skeleton, which
    // is keyed on `loading`, would stay up forever.
    try {
      try {
        const data = await cachedSearches(0, PAGE_SIZE);
        if (data.videos.length > 0) {
          setHeading('Cached videos');
          setActiveQuery(null);
          setResults(data.videos);
          setCachedOffset(data.videos.length);
          setCachedHasMore(data.has_more);
          return;
        }
      } catch (err) {
        // Fall through to a live search on a cold cache or unreachable server.
      }

      try {
        setQuery(DEFAULT_QUERY);
        setActiveQuery(DEFAULT_QUERY);
        const data = await search(DEFAULT_QUERY, 12);
        setHeading(`Results for "${DEFAULT_QUERY}"`);
        setResults(data.results);
        setCachedHasMore(false);
      } catch (err) {
        if (err instanceof ApiNotConfiguredError) {
          setError(err.message);
        } else {
          setError(err instanceof Error ? err.message : 'Could not load videos.');
        }
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadInitial();
  }, [loadInitial]);

  // Extract formats for the first few results in the background, so tapping
  // one opens with its formats already loaded.
  const firstUrls = results
    .slice(0, 3)
    .map((r) => r.url)
    .filter(Boolean)
    .join('|');
  useEffect(() => {
    if (loading || !firstUrls) return;
    prewarmPreviews(firstUrls.split('|'));
  }, [loading, firstUrls]);

  const runSearch = useCallback(async (text: string) => {
    if (!text.trim()) return;
    setLoading(true);
    setError('');
    setCachedHasMore(false);
    try {
      const data = await search(text.trim(), 12);
      setActiveQuery(text.trim());
      setHeading(`Results for "${text.trim()}"`);
      setResults(data.results);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed.');
    } finally {
      setLoading(false);
    }
  }, []);

  // Pull-to-refresh keeps the list mounted (so the native pull spinner
  // shows) instead of swapping to the skeleton, and re-fetches whatever the
  // list is showing: a live search bypasses the server's cached copy; the
  // cached feed reloads from the top to pick up newly cached videos.
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    setError('');
    try {
      if (activeQuery) {
        const data = await search(activeQuery, 12, true);
        setResults(data.results);
        setCachedHasMore(false);
      } else {
        const data = await cachedSearches(0, PAGE_SIZE);
        if (data.videos.length > 0) {
          setResults(data.videos);
          setCachedOffset(data.videos.length);
          setCachedHasMore(data.has_more);
        } else {
          await loadInitial();
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not refresh.');
    } finally {
      setRefreshing(false);
    }
  }, [activeQuery, loadInitial]);

  const loadMoreCached = useCallback(async () => {
    if (!cachedHasMore || loadingMore) return;
    setLoadingMore(true);
    try {
      const data = await cachedSearches(cachedOffset, PAGE_SIZE);
      setResults((prev) => [...prev, ...data.videos]);
      setCachedOffset(cachedOffset + data.videos.length);
      setCachedHasMore(data.has_more);
    } catch (err) {
      // Leave the list as-is; the user can pull again or search directly.
    } finally {
      setLoadingMore(false);
    }
  }, [cachedHasMore, cachedOffset, loadingMore]);

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      <View style={[styles.topbar, { backgroundColor: colors.panel, borderColor: colors.border }]}>
        <Text style={[styles.brand, { color: colors.text }]}>📼 Gil Tube</Text>
        <View style={styles.topbarActions}>
          <Pressable
            onPress={toggleTheme}
            style={[styles.iconButton, { backgroundColor: colors.panelAlt, borderColor: colors.border }]}
          >
            <Text style={{ fontSize: 16 }}>{theme === 'light' ? '☀️' : '🌙'}</Text>
          </Pressable>
          <Pressable
            onPress={() => navigation.navigate('Settings')}
            style={[styles.iconButton, { backgroundColor: colors.panelAlt, borderColor: colors.border }]}
          >
            <Text style={{ fontSize: 16 }}>⚙️</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.searchRow}>
        <TextInput
          value={query}
          onChangeText={onQueryChange}
          onSubmitEditing={() => pickSuggestion(query)}
          placeholder="Search YouTube…"
          placeholderTextColor={colors.muted}
          style={[
            styles.input,
            { backgroundColor: colors.panelAlt, borderColor: colors.border, color: colors.text },
          ]}
          returnKeyType="search"
        />
        <Pressable
          disabled={loading}
          onPress={() => pickSuggestion(query)}
          style={[styles.searchButton, { backgroundColor: colors.primary, opacity: loading ? 0.7 : 1 }]}
        >
          <Text style={styles.searchButtonText}>{loading ? 'Searching…' : 'Search'}</Text>
        </Pressable>
      </View>

      {suggestions.length > 0 ? (
        <View style={[styles.suggestions, { backgroundColor: colors.panel, borderColor: colors.border }]}>
          {suggestions.map((text, index) => (
            <Pressable
              key={text}
              onPress={() => pickSuggestion(text)}
              style={[
                styles.suggestionItem,
                index > 0 && { borderTopWidth: 1, borderTopColor: colors.border },
              ]}
            >
              <Text style={{ color: colors.text, fontSize: 14 }} numberOfLines={1}>
                {text}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      <DownloadsTray />

      {error ? (
        <Text style={[styles.error, { color: colors.danger }]}>{error}</Text>
      ) : null}

      {heading ? <Text style={[styles.heading, { color: colors.muted }]}>{heading}</Text> : null}

      {loading ? (
        <SkeletonGrid colors={colors} />
      ) : (
        <FlatList
          data={results}
          keyExtractor={(item, index) => `${item.id || item.url}-${index}`}
          numColumns={2}
          contentContainerStyle={[styles.list, results.length === 0 && styles.listEmpty]}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.primary}
              colors={[colors.primary]}
              progressBackgroundColor={colors.panel}
            />
          }
          renderItem={({ item }) => (
            <ResultCard
              result={item}
              colors={colors}
              onPress={() => setSelected(item)}
            />
          )}
          onEndReachedThreshold={0.4}
          onEndReached={loadMoreCached}
          ListFooterComponent={
            loadingMore ? <ActivityIndicator style={{ marginVertical: 16 }} color={colors.primary} /> : null
          }
          ListEmptyComponent={
            !loading ? (
              <Text style={[styles.empty, { color: colors.muted }]}>No results yet.</Text>
            ) : null
          }
        />
      )}

      <PreviewSheet result={selected} onClose={() => setSelected(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  topbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingTop: 54,
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  brand: { fontSize: 17, fontWeight: '700' },
  topbarActions: { flexDirection: 'row', gap: 8 },
  iconButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchRow: { flexDirection: 'row', paddingHorizontal: 12, paddingTop: 10, gap: 8 },
  input: { flex: 1, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, height: 40 },
  searchButton: { borderRadius: 10, paddingHorizontal: 16, justifyContent: 'center' },
  searchButtonText: { color: '#04121f', fontWeight: '700' },
  suggestions: { marginHorizontal: 12, marginTop: 6, borderWidth: 1, borderRadius: 10, overflow: 'hidden' },
  suggestionItem: { paddingVertical: 11, paddingHorizontal: 12 },
  error: { marginHorizontal: 12, marginTop: 10 },
  heading: { marginHorizontal: 12, marginTop: 12, marginBottom: 2, fontSize: 12, fontWeight: '600' },
  list: { paddingHorizontal: 6, paddingBottom: 24 },
  // Lets an empty/errored list still be pulled to retry.
  listEmpty: { flexGrow: 1 },
  empty: { textAlign: 'center', marginTop: 32 },
});
