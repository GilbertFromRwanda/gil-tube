import { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { ApiNotConfiguredError, cachedSearches, search } from '../api/client';
import { SearchResult } from '../api/types';
import { ResultCard } from '../components/ResultCard';
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

  // Cached-videos view is a paged feed (infinite scroll); a live search
  // returns one fixed batch from yt-dlp per query, so there's nothing to
  // page through there. Mirrors web/index.html's cachedVideosHasMore logic.
  const [cachedOffset, setCachedOffset] = useState(0);
  const [cachedHasMore, setCachedHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const loadInitial = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await cachedSearches(0, PAGE_SIZE);
      if (data.videos.length > 0) {
        setHeading('Cached videos');
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
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadInitial();
  }, [loadInitial]);

  const runSearch = useCallback(async (text: string) => {
    if (!text.trim()) return;
    setLoading(true);
    setError('');
    setCachedHasMore(false);
    try {
      const data = await search(text.trim(), 12);
      setHeading(`Results for "${text.trim()}"`);
      setResults(data.results);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed.');
    } finally {
      setLoading(false);
    }
  }, []);

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
          onChangeText={setQuery}
          onSubmitEditing={() => runSearch(query)}
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
          onPress={() => runSearch(query)}
          style={[styles.searchButton, { backgroundColor: colors.primary, opacity: loading ? 0.7 : 1 }]}
        >
          <Text style={styles.searchButtonText}>{loading ? 'Searching…' : 'Search'}</Text>
        </Pressable>
      </View>

      {error ? (
        <Text style={[styles.error, { color: colors.danger }]}>{error}</Text>
      ) : null}

      {heading ? <Text style={[styles.heading, { color: colors.muted }]}>{heading}</Text> : null}

      {loading && results.length === 0 ? (
        <ActivityIndicator style={{ marginTop: 24 }} color={colors.primary} />
      ) : (
        <FlatList
          data={results}
          keyExtractor={(item, index) => `${item.id || item.url}-${index}`}
          numColumns={2}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <ResultCard
              result={item}
              colors={colors}
              onPress={() => navigation.navigate('Preview', { result: item })}
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
  error: { marginHorizontal: 12, marginTop: 10 },
  heading: { marginHorizontal: 12, marginTop: 12, marginBottom: 2, fontSize: 12, fontWeight: '600' },
  list: { paddingHorizontal: 6, paddingBottom: 24 },
  empty: { textAlign: 'center', marginTop: 32 },
});
