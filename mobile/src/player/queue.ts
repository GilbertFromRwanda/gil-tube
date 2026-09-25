import type { SearchResult } from '../api/types';

// What "next" and "previous" mean. The queue is the list of videos on screen
// (the endless feed), captured when a video is started from it. Because the
// feed keeps growing as you scroll and can be replaced by a new search, the
// queue keeps its own copy: it picks up pages the feed has loaded since (as
// long as the playing video is still in the feed), but if you search for
// something else while listening, it carries on through the list you started
// from instead of jumping into the new results.

export interface QueueSource {
  items(): SearchResult[];
  hasMore(): boolean;
  loadMore(): Promise<void>;
}

// Pressing "previous" more than this far into a video restarts it (like every
// music player) instead of going back a track.
export const RESTART_THRESHOLD_SECONDS = 3;

export function indexOfVideo(items: SearchResult[], id: string): number {
  return items.findIndex((item) => item.id === id);
}

export class PlayQueue {
  private frozen: SearchResult[] = [];
  private source: QueueSource | null = null;

  setSource(source: QueueSource | null): void {
    this.source = source;
  }

  // The source's items if the playing video is still among them, which means
  // the feed it came from is still on screen and may have grown.
  private liveItems(currentId: string): SearchResult[] | null {
    const items = this.source?.items();
    return items && indexOfVideo(items, currentId) >= 0 ? items : null;
  }

  // A video was started from the feed: remember that list.
  adopt(currentId: string): void {
    const items = this.liveItems(currentId);
    if (items) this.frozen = items.slice();
  }

  private sync(currentId: string): void {
    const items = this.liveItems(currentId);
    if (items && items.length >= this.frozen.length) this.frozen = items.slice();
  }

  items(): SearchResult[] {
    return this.frozen;
  }

  hasPrev(currentId: string): boolean {
    this.sync(currentId);
    return indexOfVideo(this.frozen, currentId) > 0;
  }

  hasNext(currentId: string): boolean {
    this.sync(currentId);
    const index = indexOfVideo(this.frozen, currentId);
    if (index < 0) return false;
    if (index + 1 < this.frozen.length) return true;
    return this.liveItems(currentId) !== null && !!this.source?.hasMore();
  }

  // The video after `currentId`, loading more of the feed if the loaded part
  // has run out. Null when there really is nothing further.
  async next(currentId: string): Promise<SearchResult | null> {
    this.sync(currentId);
    let index = indexOfVideo(this.frozen, currentId);
    if (index < 0) return null;
    if (index + 1 < this.frozen.length) return this.frozen[index + 1];

    // At the end of what is loaded: ask the feed for more, a couple of times if
    // a page came back with nothing new.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const source = this.source;
      if (!source || !source.hasMore() || this.liveItems(currentId) === null) return null;
      const before = source.items().length;
      await source.loadMore();
      this.sync(currentId);
      index = indexOfVideo(this.frozen, currentId);
      if (index >= 0 && index + 1 < this.frozen.length) return this.frozen[index + 1];
      if (source.items().length === before && !source.hasMore()) return null;
    }
    return null;
  }

  // Either the previous video, or a request to restart the current one.
  prev(currentId: string, positionSeconds: number): { item: SearchResult | null; restart: boolean } {
    this.sync(currentId);
    const index = indexOfVideo(this.frozen, currentId);
    if (positionSeconds > RESTART_THRESHOLD_SECONDS || index <= 0) {
      return { item: null, restart: true };
    }
    return { item: this.frozen[index - 1], restart: false };
  }
}
