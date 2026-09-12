import type { CardLink, LibraryResult } from "@/types";

type FeedState = {
  links: CardLink[];
  total: number;
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  refreshing: boolean;
  error: string;
  moreError: string;
};

// A single query's loaded library. Polling and scrolling share one request lane.
export class LibraryFeed {
  private state: FeedState = {
    links: [],
    total: 0,
    hasMore: false,
    loading: true,
    loadingMore: false,
    refreshing: false,
    error: "",
    moreError: "",
  };
  private listeners = new Set<() => void>();
  private pages = 0;
  private generation = 0;
  private task: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private refreshPending = false;

  constructor(
    private fetchPage: (
      page: number,
      signal: AbortSignal,
    ) => Promise<LibraryResult>,
  ) {}

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(patch: Partial<FeedState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  refresh = (): Promise<void> => {
    if (this.task) {
      this.refreshPending = true;
      return this.task;
    }
    return this.start(false);
  };

  loadMore = (): Promise<void> => {
    if (this.task) return this.task;
    if (!this.state.hasMore) return Promise.resolve();
    return this.start(true);
  };

  // Invalidates late responses, including transports that ignore abort signals.
  cancel = () => {
    this.generation++;
    this.controller?.abort();
    this.task = null;
    this.refreshPending = false;
  };

  private start(append: boolean) {
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    this.publish({
      loading: this.pages === 0,
      loadingMore: append,
      refreshing: !append,
    });
    this.task = this.run(append, controller.signal, generation).finally(() => {
      if (generation !== this.generation) return;
      this.task = null;
      this.publish({ loading: false, loadingMore: false, refreshing: false });
    });
    return this.task;
  }

  private async run(append: boolean, signal: AbortSignal, generation: number) {
    do {
      this.refreshPending = false;
      try {
        // Refresh the entire loaded prefix before replacing it. Refreshing only
        // page one would leave duplicates/gaps when status edits move boundaries.
        const start = append ? this.pages + 1 : 1;
        let end = append ? start : Math.max(1, this.pages);
        let result: LibraryResult;
        const links = new Map(
          (append ? this.state.links : []).map((link) => [link.id, link]),
        );
        let loaded = start;
        do {
          result = await this.fetchPage(loaded, signal);
          if (generation !== this.generation) return;
          for (const link of result.links) links.set(link.id, link);
          end = Math.min(end, Math.max(1, result.pages));
          if (loaded >= end || !result.links.length) break;
          loaded++;
        } while (loaded <= end);
        this.pages = Math.min(loaded, Math.max(1, result.pages));
        this.publish({
          links: [...links.values()],
          total: result.total,
          hasMore: loaded < result.pages && result.links.length > 0,
          error: "",
          // A failed append needs an explicit retry; polling must not restart it.
          moreError:
            append || loaded >= result.pages ? "" : this.state.moreError,
        });
      } catch (error) {
        if (generation !== this.generation) return;
        const message =
          error instanceof Error ? error.message : "Could not load links.";
        this.publish(append ? { moreError: message } : { error: message });
      }
      append = false;
    } while (this.refreshPending && generation === this.generation);
  }
}
