import { expect, test } from "bun:test";
import { readViewState, saveViewState } from "../src/lib/view-state";

function tabStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

test("refresh restores navigation, explicit filters and queue position without changing user text", () => {
  const storage = tabStorage();
  const saved = {
    view: "attention",
    query: "MiXeD café (notes) & ideas",
    tag: "machine-learning",
    listId: "672290b1-f560-4c22-b6f0-3a4b2d92ed63",
    read: "false",
    liked: "true",
    archived: "all",
    deleted: "",
    state: "error",
    sort: "title",
    advanced: true,
    queue: { query: "https://example.com/Doc_(API)", page: 3 },
  } as const;
  saveViewState(saved, storage);
  expect(readViewState(storage)).toEqual(saved);
  expect(readViewState(tabStorage()).view).toBe("all");
});

test("invalid saved fields fall back individually and old partial preferences remain usable", () => {
  const storage = tabStorage();
  storage.setItem(
    "braindump.view.v1",
    JSON.stringify({
      view: "settings",
      sort: "unsupported",
      read: true,
      listId: "missing-id",
      query: "kept",
      tag: "x".repeat(61),
      advanced: "false",
      queue: { query: "x".repeat(201), page: -1 },
      selected: "do-not-reopen",
      restore: true,
    }),
  );
  expect(readViewState(storage)).toEqual({
    ...readViewState(tabStorage()),
    view: "settings",
    query: "kept",
  });
  for (const invalid of ["{", "null", "[]", '"settings"']) {
    storage.setItem("braindump.view.v1", invalid);
    expect(readViewState(storage)).toEqual(readViewState(tabStorage()));
  }
});

test("unavailable storage cannot prevent startup or navigation", () => {
  const blocked = {
    getItem: () => {
      throw new Error("Storage blocked");
    },
    setItem: () => {
      throw new Error("Storage full");
    },
  };
  expect(readViewState(blocked).view).toBe("all");
  expect(() => saveViewState({ view: "settings" }, blocked)).not.toThrow();
});

test("refresh sends the restored filters immediately and keeps the queue page after debounce", async () => {
  const child = Bun.spawn(
    [process.execPath, "tests/fixtures/view-interactions.ts"],
    {
      cwd: new URL("..", import.meta.url).pathname,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  expect(stdout).toContain("View interactions passed");
});
