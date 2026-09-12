import { useEffect, useMemo, useSyncExternalStore } from "react";
import { api } from "@/lib/api";
import { LibraryFeed } from "@/lib/library-feed";
import type { LibraryResult } from "@/types";

export function useLibraryFeed(query: string | null, revision: number) {
  const feed = useMemo(
    () =>
      new LibraryFeed((page, signal) => {
        const params = new URLSearchParams(query || "");
        params.set("page", String(page));
        return api<LibraryResult>(`/links?${params}`, "GET", undefined, signal);
      }),
    [query],
  );
  const state = useSyncExternalStore(feed.subscribe, feed.getSnapshot);
  useEffect(() => {
    if (query === null) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      await feed.refresh();
      if (active) timer = setTimeout(() => void poll(), 4000);
    }
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
      feed.cancel();
    };
  }, [feed, query, revision]);
  return { ...state, loadMore: feed.loadMore };
}
