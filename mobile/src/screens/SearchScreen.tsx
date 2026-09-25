import { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Platform,
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
import { CACHED_PAGE_SIZE, FeedEngine, FeedSnapshot } from '../feed/feedEngine';
import { usePlayer } from '../player/PlayerContext';
import { ResultCard } from '../components/ResultCard';
import { SkeletonGrid } from '../components/SkeletonGrid';
import { useTheme } from '../theme/theme';
import { RootStackParamList } from '../navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'Search'>;

// Defined once, outside the component, so the list always gets the same function.
const keyExtractor = (item: SearchResult, index: number) => `${item.id || item.url}-${index}`;

const DEFAULT_QUERY = 'Rwanda SDA music';

const EMPTY_FEED: FeedSnapshot = { items: [], hasMore: false, loadingMore: false, ended: false };

export function SearchScreen({ navigation }: Props) {
  const { colors, theme, toggleTheme } = useTheme();
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [heading, setHeading] = useState('');
  const { open: openVideo, mode: playerMode, registerQueue, notifyQueueChanged } = usePlayer();
  const [refreshing, setRefreshing] = useState(false);

  // The endless feed (cached videos, then live YouTube results, paged deeper
  // as you scroll) lives in an engine so its rules are testable; the screen
  // just shows its latest snapshot.
  const engineRef = useRef<FeedEngine | null>(null);
  const [feed, setFeed] = useState<FeedSnapshot>(EMPTY_FEED);
  if (!engineRef.current) {
    const created: FeedEngine = new FeedEngine(
      {
        searchPage: (q, offset, limit, refresh) => search(q, limit, !!refresh, offset),
        cachedPage: (offset, limit) => cachedSearches(offset, limit),
      },
      () => setFeed(created.snapshot()),
    );
    engineRef.current = created;
  }
  const engine = engineRef.current;

  // Next / previous / autoplay walk through this list, and load more of it
  // when they reach its end.
  useEffect(() => {
    registerQueue({
      items: () => engine.snapshot().items,
      hasMore: () => engine.snapshot().hasMore,
      loadMore: () => engine.loadMore(),
    });
    return () => registerQueue(null);
  }, [engine, registerQueue]);

  // The list grew or changed: the player's next / previous buttons re-check.
  useEffect(() => {
    notifyQueueChanged();
  }, [feed.items, notifyQueueChanged]);

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
        const data = await cachedSearches(0, CACHED_PAGE_SIZE);
        if (data.videos.length > 0) {
          setHeading('Cached videos');
          // When the cached videos run out the feed carries on with live
          // results for the default query.
          engine.startCached(data.videos, data.has_more, DEFAULT_QUERY);
          return;
        }
      } catch (err) {
        // Fall through to a live search on a cold cache or unreachable server.
      }

      try {
        setQuery(DEFAULT_QUERY);
        await engine.startSearch(DEFAULT_QUERY);
        setHeading(`Results for "${DEFAULT_QUERY}"`);
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
  }, [engine]);

  useEffect(() => {
    loadInitial();
  }, [loadInitial]);

  // Extract formats for the first few results in the background, so tapping
  // one opens with its formats already loaded.
  const firstUrls = feed.items
    .slice(0, 3)
    .map((r) => r.url)
    .filter(Boolean)
    .join('|');
  useEffect(() => {
    if (loading || !firstUrls) return;
    prewarmPreviews(firstUrls.split('|'));
  }, [loading, firstUrls]);

  const runSearch = useCallback(
    async (text: string) => {
      const q = text.trim();
      if (!q) return;
      setLoading(true);
      setError('');
      try {
        await engine.startSearch(q);
        setHeading(`Results for "${q}"`);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Search failed.');
      } finally {
        setLoading(false);
      }
    },
    [engine],
  );

  // Pull-to-refresh keeps the list mounted (so the native pull spinner
  // shows) instead of swapping to the skeleton, and re-fetches whatever the
  // list is showing: a live search bypasses the server's cached copy; the
  // cached feed reloads from the top to pick up newly cached videos. If it
  // fails the current list stays as it was.
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    setError('');
    try {
      if (engine.mode === 'search') {
        await engine.startSearch(engine.query, true);
      } else {
        const data = await cachedSearches(0, CACHED_PAGE_SIZE);
        if (data.videos.length > 0) {
          engine.startCached(data.videos, data.has_more, engine.query || DEFAULT_QUERY);
        } else {
          await loadInitial();
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not refresh.');
    } finally {
      setRefreshing(false);
    }
  }, [engine, loadInitial]);

  // Stable identities for everything the list receives: new functions or
  // style arrays every render make the list (and every card) re-render.
  const renderItem = useCallback(
    ({ item }: { item: SearchResult }) => <ResultCard result={item} colors={colors} onPress={openVideo} />,
    [colors, openVideo],
  );
  const listContentStyle = useMemo(
    () => [
      styles.list,
      feed.items.length === 0 && styles.listEmpty,
      // Keep the last results clear of the docked mini player.
      playerMode === 'mini' && styles.listMini,
    ],
    [feed.items.length, playerMode],
  );
  const refreshControl = useMemo(
    () => (
      <RefreshControl
        refreshing={refreshing}
        onRefresh={onRefresh}
        tintColor={colors.primary}
        colors={[colors.primary]}
        progressBackgroundColor={colors.panel}
      />
    ),
    [refreshing, onRefresh, colors],
  );

  const loadMore = useCallback(() => {
    engine.loadMore();
  }, [engine]);

  // Placeholder tiles while the next page loads; a quiet note when the results
  // truly end.
  const listFooter = useMemo(() => {
    if (feed.loadingMore) return <SkeletonGrid colors={colors} rows={1} />;
    if (feed.ended) {
      return <Text style={[styles.endNote, { color: colors.muted }]}>You have reached the end of the results.</Text>;
    }
    return null;
  }, [feed.loadingMore, feed.ended, colors]);

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
          data={feed.items}
          keyExtractor={keyExtractor}
          numColumns={2}
          contentContainerStyle={listContentStyle}
          refreshControl={refreshControl}
          renderItem={renderItem}
          // Render a screenful or so up front and only a small window around
          // the viewport afterwards, instead of every card loaded so far.
          initialNumToRender={8}
          maxToRenderPerBatch={6}
          windowSize={7}
          updateCellsBatchingPeriod={50}
          removeClippedSubviews={Platform.OS === 'android'}
          // Start the next page a couple of screens early so it is usually
          // ready before you get to the bottom.
          onEndReachedThreshold={1.5}
          onEndReached={loadMore}
          ListFooterComponent={listFooter}
          ListEmptyComponent={
            !loading ? (
              <Text style={[styles.empty, { color: colors.muted }]}>No results yet.</Text>
            ) : null
          }
        />
      )}

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
  listMini: { paddingBottom: 120 },
  empty: { textAlign: 'center', marginTop: 32 },
  endNote: { textAlign: 'center', fontSize: 12, paddingVertical: 20 },
});
