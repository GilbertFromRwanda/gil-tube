import type { CachedSearchesResponse, SearchResponse, SearchResult } from '../api/types';

// The endless results feed, independent of React so its rules can be tested.
//
// It starts as the cached (Redis) videos or as a live search. When the cached
// videos run out it carries on with live results for the query the screen was
// showing, and a live search pages deeper the same way. Repeats are dropped,
// the next page is fetched ahead of the scroll, and every new search bumps a
// generation so a slow reply for an old search can never land in a new list.
// (web/index.html has the same rules, tested by scripts/test-web-feed.mjs.)

export const SEARCH_FIRST_PAGE = 12; // matches pages already cached at this size
export const SEARCH_PAGE_SIZE = 24;
export const CACHED_PAGE_SIZE = 24;
// Pages in a row that turn out to be all repeats before giving up until the next scroll.
export const MAX_EMPTY_PAGES = 4;

export interface FeedDeps {
  searchPage: (query: string, offset: number, limit: number, refresh?: boolean) => Promise<SearchResponse>;
  cachedPage: (offset: number, limit: number) => Promise<CachedSearchesResponse>;
}

export interface FeedSnapshot {
  items: SearchResult[];
  hasMore: boolean;
  loadingMore: boolean;
  // The server said there is nothing further to load.
  ended: boolean;
}

// Returns the results not seen yet and remembers them.
export function takeNewResults(results: SearchResult[], seen: Set<string>): SearchResult[] {
  const fresh: SearchResult[] = [];
  for (const result of results) {
    const id = result && result.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    fresh.push(result);
  }
  return fresh;
}

export class FeedEngine {
  private generation = 0;
  private items: SearchResult[] = [];
  private seen = new Set<string>();
  private loadingMore = false;
  private cachedOffset = 0;
  private cachedHasMore = false;
  private searchOffset = 0;
  private searchHasMore = false;
  private pageRequests = new Map<string, Promise<SearchResponse>>();

  // 'none' until something has been loaded.
  mode: 'none' | 'cached' | 'search' = 'none';
  query = '';

  private readonly deps: FeedDeps;
  private readonly onChange: () => void;

  constructor(deps: FeedDeps, onChange: () => void) {
    this.deps = deps;
    this.onChange = onChange;
  }

  hasMore(): boolean {
    return this.cachedHasMore || this.searchHasMore;
  }

  snapshot(): FeedSnapshot {
    return {
      items: this.items,
      hasMore: this.hasMore(),
      loadingMore: this.loadingMore,
      ended: this.items.length > 0 && !this.hasMore(),
    };
  }

  private notify() {
    this.onChange();
  }

  private page(query: string, offset: number): Promise<SearchResponse> {
    const key = `${this.generation}:${offset}`;
    const existing = this.pageRequests.get(key);
    if (existing) return existing;
    const request = this.deps.searchPage(query, offset, SEARCH_PAGE_SIZE).catch((err) => {
      this.pageRequests.delete(key); // a failed page can be tried again
      throw err;
    });
    this.pageRequests.set(key, request);
    return request;
  }

  // Seeds the feed with the cached videos; live results follow them.
  startCached(videos: SearchResult[], hasMore: boolean, continueQuery: string): void {
    this.generation += 1;
    this.pageRequests.clear();
    this.loadingMore = false;
    this.seen = new Set();
    this.items = takeNewResults(videos, this.seen);
    this.mode = 'cached';
    this.query = continueQuery;
    this.cachedOffset = videos.length;
    this.cachedHasMore = hasMore && videos.length > 0;
    this.searchOffset = 0;
    this.searchHasMore = true; // after the cache runs out
    this.notify();
  }

  // A new live search (or a refresh of one). Throws if the first page fails, in
  // which case the previous list is left as it was.
  async startSearch(query: string, refresh = false): Promise<void> {
    const generation = ++this.generation;
    this.pageRequests.clear();
    this.loadingMore = false;

    const data = await this.deps.searchPage(query, 0, SEARCH_FIRST_PAGE, refresh);
    if (generation !== this.generation) return;

    this.seen = new Set();
    this.items = takeNewResults(data.results ?? [], this.seen);
    this.mode = 'search';
    this.query = query;
    this.cachedOffset = 0;
    this.cachedHasMore = false;
    this.searchOffset = typeof data.next_offset === 'number' ? data.next_offset : SEARCH_FIRST_PAGE;
    this.searchHasMore = !!data.has_more;
    this.notify();
  }

  async loadMore(): Promise<void> {
    if (this.loadingMore || !this.hasMore()) return;

    const generation = this.generation;
    this.loadingMore = true;
    this.notify();
    try {
      if (this.cachedHasMore) {
        const data = await this.deps.cachedPage(this.cachedOffset, CACHED_PAGE_SIZE);
        if (generation !== this.generation) return;
        const videos = data.videos ?? [];
        this.append(takeNewResults(videos, this.seen));
        this.cachedOffset += videos.length;
        // An empty page ends the cached feed even if the server claims more.
        this.cachedHasMore = !!data.has_more && videos.length > 0;
        return;
      }

      let emptyPages = 0;
      while (this.searchHasMore && emptyPages < MAX_EMPTY_PAGES) {
        const data = await this.page(this.query, this.searchOffset);
        if (generation !== this.generation) return; // a newer search took over
        this.searchOffset = typeof data.next_offset === 'number' ? data.next_offset : this.searchOffset + SEARCH_PAGE_SIZE;
        this.searchHasMore = !!data.has_more;

        const fresh = takeNewResults(data.results ?? [], this.seen);
        this.append(fresh);
        if (fresh.length) break;
        emptyPages += 1; // every video on that page was already shown
      }
      // Have the next page ready before the scroll gets there.
      if (this.searchHasMore && generation === this.generation) {
        this.page(this.query, this.searchOffset).catch(() => {});
      }
    } catch {
      // Transient failure: the next scroll near the bottom tries again.
    } finally {
      if (generation === this.generation) {
        this.loadingMore = false;
        this.notify();
      }
    }
  }

  private append(fresh: SearchResult[]) {
    if (fresh.length === 0) return;
    this.items = this.items.concat(fresh);
  }
}
