import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/db";
import { Worker } from "../server/worker";
import { createApi } from "../server/api";
import { normalizeUrl, parseUrls, parseLinkFile } from "../server/urls";
import { chunks } from "../server/ollama";

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "braindump-test-"));
  store = new Store(dir);
  store.setMeta("settings", {
    model: "gemma4:12b-mlx",
    tagReviewHours: 0,
    backupHours: 0,
  });
});
afterEach(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("persistent library", () => {
  test("pasted URLs preserve balanced parentheses and exact URL punctuation", () => {
    const wikipedia =
      "https://en.wikipedia.org/wiki/Quorum_(distributed_computing)";
    const microsoft =
      "https://learn.microsoft.com/en-us/previous-versions/msp-n-p/dn568099(v=pandp.10)";
    expect(parseUrls(`${wikipedia}\n${microsoft}`)).toEqual([
      wikipedia,
      microsoft,
    ]);
    expect(
      parseUrls(`Read (${wikipedia}) or [the guide](${microsoft}).`),
    ).toEqual([wikipedia, microsoft]);
    expect(parseUrls("https://example.com/path.")).toEqual([
      "https://example.com/path.",
    ]);
  });
  test("file import handles large lists, normalization, duplicates and line errors", () => {
    const result = parseLinkFile(
      "\nhttps://example.com/?utm_source=test\r\nhttps://example.com/\nnot a URL\n" +
        Array.from({ length: 150 }, (_, i) => `https://example.com/${i}`).join(
          "\n",
        ),
    );
    expect(result.entries).toBe(153);
    expect(result.urls).toHaveLength(151);
    expect(result.duplicates).toBe(1);
    expect(result.invalid).toHaveLength(1);
    expect(result.invalid[0].line).toBe(4);
  });
  test("bulk URLs normalize tracking parameters and reject private or non-web addresses", () => {
    expect(
      parseUrls(
        "https://example.com/a?utm_source=x#section\nhttps://example.com/a",
      ),
    ).toEqual(["https://example.com/a"]);
    for (const url of [
      "file:///etc/passwd",
      "http://localhost/a",
      "http://127.0.0.1/a",
      "http://10.0.0.1/a",
      "http://2130706433/a",
      "https://example.com:444",
      "https://user:password@example.com",
    ])
      expect(() => normalizeUrl(url)).toThrow();
    expect(() => parseUrls("some text without URLs")).toThrow();
  });
  test("duplicates are preserved even in Trash and jobs are deduplicated", () => {
    const first = store.add("https://example.com/");
    store.update(first.id, { deleted: true });
    expect(store.add("https://example.com/")).toEqual({
      id: first.id,
      duplicate: true,
    });
    store.enqueue("process", first.id);
    expect(store.jobs()).toHaveLength(1);
  });
  test("full text search finds article text and edited tags safely", () => {
    const { id } = store.add("https://example.com/article");
    store.update(id, {
      title: "A useful guide",
      summary: "Local databases",
      content: "An unusual pangolin studies SQLite indexing.",
      tags: ["engineering"],
    });
    expect(
      store.list(new URLSearchParams({ q: "pangol", deleted: "false" })).total,
    ).toBe(1);
    expect(store.list(new URLSearchParams({ q: "engineering" })).total).toBe(1);
    store.update(id, { tags: ["nature"] });
    expect(store.list(new URLSearchParams({ q: "engineering" })).total).toBe(0);
    expect(
      store.list(new URLSearchParams({ q: '" OR * NEAR(foo)' })).total,
    ).toBe(0);
    expect(
      store.list(new URLSearchParams({ q: "pangolin indexing" })).total,
    ).toBe(1);
  });
  test("all four statuses combine independently and counts respect Trash", () => {
    const one = store.add("https://example.com/1");
    const two = store.add("https://example.com/2");
    store.update(one.id, { read: true, liked: true, archived: true });
    store.update(two.id, { deleted: true, liked: true });
    expect(
      store.list(
        new URLSearchParams({
          read: "true",
          liked: "true",
          archived: "true",
          deleted: "false",
        }),
      ).total,
    ).toBe(1);
    expect(
      store.list(
        new URLSearchParams({ read: "false", liked: "true", deleted: "true" }),
      ).total,
    ).toBe(1);
    expect(store.counts()).toEqual({
      all: 0,
      unread: 0,
      liked: 0,
      archived: 1,
      attention: 0,
      deleted: 1,
    });
  });
  test("attention counts match failed links, including Archive but excluding Trash and automatic retries", () => {
    expect(store.counts()).toMatchObject({ attention: 0 });
    const failed = store.add("https://example.com/failed");
    const archived = store.add("https://example.com/archived");
    const deleted = store.add("https://example.com/deleted");
    const retrying = store.add("https://example.com/retrying");
    const ready = store.add("https://example.com/ready");
    store.add("https://example.com/pending");
    store.update(failed.id, { state: "error", error: "Page unavailable" });
    store.update(archived.id, {
      state: "error",
      archived: true,
      read: true,
      liked: true,
      title: "Archived SQLite guide",
      tags: ["databases"],
    });
    store.update(deleted.id, { state: "error", deleted: true });
    store.update(retrying.id, { state: "queued", error: "Retry pending" });
    store.update(ready.id, { state: "ready" });
    const params = new URLSearchParams({
      state: "error",
      deleted: "false",
      archived: "all",
    });
    const result = store.list(params);
    expect(result.total).toBe(2);
    expect(
      result.links.map((link) => link.id).sort((a, b) => a.localeCompare(b)),
    ).toEqual([failed.id, archived.id].sort());
    expect(store.counts()).toMatchObject({ attention: result.total });
    params.set("q", "sqlite");
    params.set("tag", "databases");
    params.set("liked", "true");
    params.set("read", "true");
    expect(store.list(params).links.map((link) => link.id)).toEqual([
      archived.id,
    ]);
    store.update(failed.id, { deleted: true });
    expect(store.counts()).toMatchObject({ attention: 1 });
    store.update(failed.id, { deleted: false });
    expect(store.counts()).toMatchObject({ attention: 2 });
    store.update(archived.id, { state: "ready", error: null });
    expect(store.counts()).toMatchObject({ attention: 1 });
  });
  test("attention filtering paginates across the full library", () => {
    for (let i = 0; i < 35; i++) {
      const { id } = store.add(`https://example.com/${i}`);
      store.update(id, { state: i < 31 ? "error" : "ready" });
    }
    const params = new URLSearchParams({ state: "error", deleted: "false" });
    const first = store.list(params);
    params.set("page", "2");
    const second = store.list(params);
    expect(first.total).toBe(31);
    expect(first.pages).toBe(2);
    expect(first.links).toHaveLength(30);
    expect(second.links).toHaveLength(1);
    expect(
      new Set([...first.links, ...second.links].map((link) => link.id)).size,
    ).toBe(31);
    expect(store.counts()).toMatchObject({ attention: 31 });
  });
  test("tag merges update archived and deleted links, search, and future tagging", () => {
    const a = store.add("https://example.com/a");
    const b = store.add("https://example.com/b");
    store.update(a.id, { tags: ["javascript", "js"], archived: true });
    store.update(b.id, { tags: ["js"], deleted: true });
    store.suggest("js", "javascript", "Acronym");
    expect(store.merge("js", "javascript")).toBe(2);
    expect(store.get(a.id)!.tags).toEqual(["javascript"]);
    expect(store.get(b.id)!.tags).toEqual(["javascript"]);
    store.update(a.id, { tags: ["js"] });
    expect(store.get(a.id)!.tags).toEqual(["javascript"]);
    expect(store.suggestions()).toHaveLength(0);
    expect(() => store.merge("javascript", "js")).toThrow();
  });
  test("backup round trip preserves content, statuses, aliases and search", () => {
    const { id } = store.add("https://example.com/a");
    store.update(id, {
      state: "ready",
      content: "The aardvark article",
      summary: "An article summary",
      tags: ["js"],
      read: true,
      liked: true,
      archived: true,
      deleted: true,
    });
    store.merge("js", "javascript");
    const backup = store.export();
    store.add("https://example.com/extra");
    const result = store.restore(backup);
    expect(result.restored).toBe(1);
    expect(store.get(id)).toEqual(backup.links[0]);
    expect(store.canonical("js")).toBe("javascript");
    expect(store.list(new URLSearchParams({ q: "aardvark" })).total).toBe(1);
    expect(readdirSync(join(dir, "backups"))).toContain(result.safetyBackup);
  });
  test("invalid, duplicate and cyclic backups never modify existing data", () => {
    store.add("https://example.com/");
    const before = store.export();
    expect(() => store.restore({ ...before, version: 3 })).toThrow();
    expect(() =>
      store.restore({ ...before, links: [...before.links, ...before.links] }),
    ).toThrow();
    expect(() =>
      store.restore({
        ...before,
        aliases: [
          { source: "a", target: "b" },
          { source: "b", target: "a" },
        ],
      }),
    ).toThrow();
    expect(store.all()).toEqual(before.links);
  });
  test("transaction rolls back a restore if a later row fails", () => {
    store.add("https://example.com/");
    const before = store.export();
    const id = crypto.randomUUID();
    const suggestion = {
      id,
      source: "a",
      target: "b",
      reason: "similar",
      status: "pending",
    };
    expect(() =>
      store.restore({
        ...before,
        links: [],
        suggestions: [suggestion, { ...suggestion, source: "c" }],
      }),
    ).toThrow();
    expect(store.all()).toEqual(before.links);
  });
  test("interrupted jobs restart and restored incomplete links are queued", () => {
    const { id } = store.add("https://example.com/");
    store.claim();
    store.update(id, { state: "extracting" });
    store.db.close();
    store = new Store(dir);
    expect(store.jobs()[0].state).toBe("queued");
    store.restore(store.export());
    expect(store.get(id)!.state).toBe("queued");
    expect(store.jobs()[0].state).toBe("queued");
  });
  test("long article chunking covers the entire input without dropping text", () => {
    const input = "A paragraph about libraries.\n".repeat(4000);
    const parts = chunks(input);
    expect(parts.length).toBeGreaterThan(2);
    expect(parts.join("")).toBe(input);
    expect(parts.every((p) => p.length <= 24000)).toBe(true);
  });
});

describe("API boundaries", () => {
  test("restoring a deleted unfinished link resumes its skipped job", async () => {
    const worker = new Worker(store);
    const api = createApi(store, worker);
    const { id } = store.add("https://example.com/");
    store.update(id, { deleted: true });
    await worker.tick();
    expect(store.jobs()[0].state).toBe("done");
    const response = await api(
      request(`/links/${id}`, "PATCH", { deleted: false }),
    );
    expect(response.status).toBe(200);
    expect(store.queueStatus().activeJobs).toBe(1);
    expect(store.get(id)!.deleted).toBe(false);
  });
  function request(
    path: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    return new Request(`http://127.0.0.1:3210/api${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  test("mutations reject foreign origins, unexpected fields, and form submissions", async () => {
    const api = createApi(store, new Worker(store));
    expect(
      (
        await api(
          request(
            "/links",
            "POST",
            { text: "https://example.com/" },
            { Origin: "https://evil.example" },
          ),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await api(
          request(
            "/links",
            "POST",
            { text: "https://example.com/" },
            { "Content-Type": "text/plain" },
          ),
        )
      ).status,
    ).toBe(415);
    const { id } = store.add("https://example.com/");
    expect(
      (await api(request(`/links/${id}`, "PATCH", { id: "overwrite" }))).status,
    ).toBe(400);
  });
  test("restore is blocked while a worker is running", async () => {
    const worker = new Worker(store);
    const api = createApi(store, worker);
    worker.busy = true;
    expect(
      (await api(request("/restore", "POST", store.export()))).status,
    ).toBe(409);
  });
  test("retry preserves prior summaries and prevents overlapping jobs", async () => {
    const worker = new Worker(store);
    const api = createApi(store, worker);
    const { id } = store.add("https://example.com/");
    expect(
      (await api(request(`/links/${id}/analyze`, "POST", {}))).status,
    ).toBe(409);
    store.db.run("UPDATE jobs SET state='done'");
    store.update(id, {
      content:
        "Saved article text about database transactions and durable local storage. ".repeat(
          5,
        ),
      summary: "Previous summary",
      state: "ready",
    });
    expect(
      (await api(request(`/links/${id}/analyze`, "POST", {}))).status,
    ).toBe(200);
    expect(store.get(id)!.summary).toBe("Previous summary");
    expect(
      (await api(request(`/links/${id}/refetch`, "POST", {}))).status,
    ).toBe(409);
  });
  test("retry removes an attention item without changing its saved content or user flags", async () => {
    const api = createApi(store, new Worker(store));
    const { id } = store.add("https://example.com/failed-analysis");
    store.db.run("UPDATE jobs SET state='failed'");
    store.update(id, {
      state: "error",
      error: "Model request timed out",
      content:
        "Saved article text about database transactions and durable local storage. ".repeat(
          5,
        ),
      summary: "Previous summary",
      tags: ["databases"],
      read: true,
      liked: true,
      archived: true,
    });
    const path = "/links?state=error&deleted=false&archived=all";
    expect((await (await api(request(path))).json()).total).toBe(1);
    expect(
      (await api(request(`/links/${id}/analyze`, "POST", {}))).status,
    ).toBe(200);
    expect((await (await api(request(path))).json()).total).toBe(0);
    expect(store.counts()).toMatchObject({ attention: 0 });
    expect(store.get(id)).toMatchObject({
      state: "queued",
      error: null,
      content:
        "Saved article text about database transactions and durable local storage. ".repeat(
          5,
        ),
      summary: "Previous summary",
      tags: ["databases"],
      read: true,
      liked: true,
      archived: true,
      deleted: false,
    });
    expect(
      (await api(request(`/links/${id}/refetch`, "POST", {}))).status,
    ).toBe(409);
  });
});

test("normalized URL bounds preserve backup round trips and reject an entire invalid batch", async () => {
  const { MAX_URL_LENGTH } = await import("../server/urls");
  const { backupSchema } = await import("../server/schema");
  const prefix = "https://example.com/";
  const boundary = prefix + "a".repeat(MAX_URL_LENGTH - prefix.length);
  expect(normalizeUrl(boundary)).toBe(boundary);
  expect(() => normalizeUrl(boundary + "a")).toThrow("8192");
  const encoded = prefix + "é".repeat(1400);
  expect(encoded.length).toBeLessThan(MAX_URL_LENGTH);
  expect(() => normalizeUrl(encoded)).toThrow("8192");
  expect(parseLinkFile(encoded).invalid).toHaveLength(1);
  const api = createApi(store, new Worker(store));
  const add = (text: string) =>
    api(
      new Request("http://127.0.0.1:3210/api/links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      }),
    );
  expect((await add(`${prefix}valid\n${encoded}`)).status).toBe(400);
  expect(store.all()).toHaveLength(0);
  expect((await add(boundary)).status).toBe(201);
  const backup = backupSchema.parse(store.export());
  store.restore(backup);
  expect(store.all()[0].url).toBe(boundary);
  backup.links[0].url = encoded;
  expect(() => store.restore(backup)).toThrow("8192");
  expect(store.all()[0].url).toBe(boundary);
});
