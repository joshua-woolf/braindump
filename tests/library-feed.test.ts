import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/db";
import { LibraryFeed } from "../src/lib/library-feed";
import type { LibraryResult } from "../src/types";

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "braindump-feed-"));
  store = new Store(dir);
});
afterEach(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

function seed(count = 65) {
  for (let i = 0; i < count; i++) {
    const link = store.add(`https://example.com/article-${i}`);
    store.update(link.id, {
      title: `Article ${i}`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    });
  }
}
function page(number: number) {
  return store.list(
    new URLSearchParams({ page: String(number), deleted: "false" }),
  );
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("infinite library", () => {
  test("scrolling loads every link once and stops at the final partial batch", async () => {
    seed();
    const calls: number[] = [];
    const feed = new LibraryFeed(async (number) => {
      calls.push(number);
      return page(number);
    });
    await feed.refresh();
    expect(feed.getSnapshot().links).toHaveLength(30);
    await feed.loadMore();
    expect(feed.getSnapshot().links).toHaveLength(60);
    await feed.loadMore();
    await feed.loadMore();
    expect(calls).toEqual([1, 2, 3]);
    expect(feed.getSnapshot().links).toHaveLength(65);
    expect(new Set(feed.getSnapshot().links.map((link) => link.id)).size).toBe(
      65,
    );
    expect(feed.getSnapshot().hasMore).toBe(false);
  });

  test("repeated scroll events share one request and a refresh waits behind it", async () => {
    seed();
    const pending = deferred<LibraryResult>();
    const calls: number[] = [];
    const feed = new LibraryFeed(async (number) => {
      calls.push(number);
      return calls.length === 2 ? pending.promise : page(number);
    });
    await feed.refresh();
    const loading = feed.loadMore();
    expect(feed.loadMore()).toBe(loading);
    expect(feed.refresh()).toBe(loading);
    expect(calls).toEqual([1, 2]);
    pending.resolve(page(2));
    await loading;
    expect(calls).toEqual([1, 2, 1, 2]);
    expect(feed.getSnapshot().links).toHaveLength(60);
    expect(feed.getSnapshot().loadingMore).toBe(false);
  });

  test("failed appends preserve loaded links and retry the same batch explicitly", async () => {
    seed();
    let failure = true;
    const calls: number[] = [];
    const feed = new LibraryFeed(async (number) => {
      calls.push(number);
      if (number === 2 && failure) throw new Error("Connection lost");
      return page(number);
    });
    await feed.refresh();
    const before = feed.getSnapshot().links;
    await feed.loadMore();
    expect(feed.getSnapshot().links).toEqual(before);
    expect(feed.getSnapshot().moreError).toBe("Connection lost");
    await feed.refresh();
    expect(calls).toEqual([1, 2, 1]);
    expect(feed.getSnapshot().moreError).toBe("Connection lost");
    failure = false;
    await feed.loadMore();
    expect(calls).toEqual([1, 2, 1, 2]);
    expect(feed.getSnapshot().links).toHaveLength(60);
    expect(feed.getSnapshot().moreError).toBe("");
  });

  test("refresh repairs moved batch boundaries and preserves the loaded depth", async () => {
    seed();
    const feed = new LibraryFeed(async (number) => page(number));
    await feed.refresh();
    const newLink = store.add("https://example.com/new");
    store.update(newLink.id, { createdAt: "2027-01-01T00:00:00.000Z" });
    await feed.loadMore();
    expect(new Set(feed.getSnapshot().links.map((link) => link.id)).size).toBe(
      59,
    );
    const removed = feed.getSnapshot().links[5].id;
    store.update(removed, { deleted: true });
    await feed.refresh();
    const expected = [...page(1).links, ...page(2).links];
    expect(feed.getSnapshot().links).toEqual(expected);
    expect(feed.getSnapshot().links[0].id).toBe(newLink.id);
    expect(feed.getSnapshot().links.some((link) => link.id === removed)).toBe(
      false,
    );
    expect(feed.getSnapshot().links).toHaveLength(60);
  });

  test("a failed background refresh never replaces only part of the loaded list", async () => {
    seed();
    let failure = false;
    const feed = new LibraryFeed(async (number) => {
      if (number === 2 && failure) throw new Error("Refresh interrupted");
      return page(number);
    });
    await feed.refresh();
    await feed.loadMore();
    const before = feed.getSnapshot().links;
    store.update(before[0].id, { title: "Updated article" });
    failure = true;
    await feed.refresh();
    expect(feed.getSnapshot().links).toEqual(before);
    expect(feed.getSnapshot().error).toBe("Refresh interrupted");
    failure = false;
    await feed.refresh();
    expect(feed.getSnapshot().links[0].title).toBe("Updated article");
    expect(feed.getSnapshot().links).toHaveLength(60);
    expect(feed.getSnapshot().error).toBe("");
  });

  test("shrinking or empty results remove stale links and terminate scrolling", async () => {
    seed();
    const feed = new LibraryFeed(async (number) => page(number));
    await feed.refresh();
    await feed.loadMore();
    await feed.loadMore();
    for (const link of feed.getSnapshot().links.slice(0, 62))
      store.update(link.id, { deleted: true });
    await feed.refresh();
    expect(feed.getSnapshot().links).toHaveLength(3);
    expect(feed.getSnapshot().total).toBe(3);
    expect(feed.getSnapshot().hasMore).toBe(false);
    for (const link of feed.getSnapshot().links)
      store.update(link.id, { deleted: true });
    await feed.refresh();
    expect(feed.getSnapshot().links).toEqual([]);
    expect(feed.getSnapshot().total).toBe(0);
    expect(feed.getSnapshot().loading).toBe(false);
  });

  test("cancelled responses cannot overwrite a newer refresh even if abort is ignored", async () => {
    seed(2);
    const old = page(1);
    const pending = deferred<LibraryResult>();
    const signals: AbortSignal[] = [];
    const feed = new LibraryFeed(async (_number, signal) => {
      signals.push(signal);
      return signals.length === 1 ? pending.promise : page(1);
    });
    const previous = feed.refresh();
    feed.cancel();
    expect(signals[0].aborted).toBe(true);
    store.update(old.links[0].id, { title: "Newer title" });
    await feed.refresh();
    pending.resolve(old);
    await previous;
    expect(feed.getSnapshot().links[0].title).toBe("Newer title");
    expect(feed.getSnapshot().loading).toBe(false);
    expect(feed.getSnapshot().error).toBe("");
  });
});
