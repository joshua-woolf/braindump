import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/db";
import { createApi } from "../server/api";
import { Worker } from "../server/worker";

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "braindump-lists-"));
  store = new Store(dir);
});
afterEach(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});
function request(path: string, method = "GET", body?: unknown) {
  return new Request(`http://127.0.0.1:3210/api${path}`, {
    method,
    headers: method === "GET" ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("saved lists", () => {
  test("names preserve casing while whitespace, Unicode equivalents and case duplicates are normalized", () => {
    const list = store.createList("  café   READING  ");
    expect(list.name).toBe("café READING");
    expect(() => store.createList("CAFE\u0301 reading")).toThrow(
      "already exists",
    );
    for (const name of ["", " \n ", "x".repeat(81), "bad\u0000name"])
      expect(() => store.createList(name)).toThrow();
    const other = store.createList("Ideas");
    expect(() => store.renameList(other.id, list.name)).toThrow(
      "already exists",
    );
    expect(store.renameList(list.id, "Café Reading").id).toBe(list.id);
    expect(store.requireList(list.id).name).toBe("Café Reading");
  });
  test("multiple memberships survive processing and all status changes, and removing a list never removes links", () => {
    const link = store.add("https://example.com/article");
    const first = store.createList("Reading");
    const second = store.createList("Research");
    store.setMembership(first.id, link.id, true);
    store.setMembership(first.id, link.id, true);
    store.setMembership(second.id, link.id, true);
    store.update(link.id, {
      summary: "New summary",
      tags: ["js"],
      read: true,
      liked: true,
      archived: true,
      deleted: true,
    });
    store.merge("js", "javascript");
    expect(new Set(store.linkLists(link.id))).toEqual(
      new Set([first.id, second.id]),
    );
    expect(store.lists().map((list) => list.count)).toEqual([0, 0]);
    store.update(link.id, { deleted: false });
    expect(store.lists().map((list) => list.count)).toEqual([1, 1]);
    const before = store.get(link.id);
    store.setMembership(first.id, link.id, false);
    store.setMembership(first.id, link.id, false);
    expect(store.linkLists(link.id)).toEqual([second.id]);
    store.deleteList(second.id);
    expect(store.linkLists(link.id)).toEqual([]);
    expect(store.get(link.id)).toEqual(before);
    expect(store.queueStatus().activeJobs).toBe(1);
  });
  test("list filtering combines with lexical search, tags and independent statuses across pages", () => {
    const list = store.createList("Databases");
    for (let i = 0; i < 34; i++) {
      const { id } = store.add(`https://example.com/${i}`);
      store.update(id, {
        content: "SQLite pangolin",
        tags: ["databases"],
        liked: true,
        read: true,
        archived: true,
        deleted: i === 32,
      });
      if (i < 33) store.setMembership(list.id, id, true);
    }
    const params = new URLSearchParams({
      list: list.id,
      q: "pangolin",
      tag: "databases",
      liked: "true",
      read: "true",
      archived: "true",
      deleted: "false",
    });
    const first = store.list(params);
    params.set("page", "2");
    const second = store.list(params);
    expect(first.total).toBe(32);
    expect(first.links).toHaveLength(30);
    expect(second.links).toHaveLength(2);
    expect(
      new Set([...first.links, ...second.links].map((link) => link.id)).size,
    ).toBe(32);
    params.set("read", "false");
    expect(store.list(params).total).toBe(0);
    expect(() =>
      store.list(new URLSearchParams({ list: crypto.randomUUID() })),
    ).toThrow("List not found");
  });
  test("a v2 database upgrades without changing links, queue priorities or settings and reopens safely", () => {
    const { id } = store.add("https://example.com/existing");
    store.promoteJob(store.jobs()[0].id);
    store.setMeta("settings", {
      model: "test-local",
      backupHours: 0,
      tagReviewHours: 0,
    });
    const link = store.get(id);
    const jobs = store.jobs();
    const settings = store.settings();
    store.db.exec(
      "DROP TABLE list_links; DROP TABLE lists; PRAGMA user_version=2;",
    );
    store.db.close();
    store = new Store(dir);
    expect(store.db.query("PRAGMA user_version").get()).toEqual({
      user_version: 3,
    });
    expect(store.get(id)).toEqual(link);
    expect(store.jobs()).toEqual(jobs);
    expect(store.settings()).toEqual(settings);
    expect(store.lists()).toEqual([]);
    const list = store.createList("Migrated");
    store.setMembership(list.id, id, true);
    store.db.close();
    store = new Store(dir);
    expect(store.linkLists(id)).toEqual([list.id]);
  });
  test("v2 backups round trip empty lists and memberships including links in Trash", () => {
    const { id } = store.add("https://example.com/saved");
    store.update(id, { deleted: true, state: "ready" });
    const list = store.createList("My Research");
    store.createList("Empty");
    store.setMembership(list.id, id, true);
    const backup = store.export();
    store.deleteList(list.id);
    store.createList("Extra");
    store.restore(backup);
    expect(store.export()).toMatchObject({
      version: 2,
      lists: backup.lists,
      memberships: backup.memberships,
      links: backup.links,
    });
    expect(store.linkLists(id)).toEqual([list.id]);
    expect(store.lists().map((entry) => entry.count)).toEqual([0, 0]);
  });
  test("v1 backups restore without lists and the safety snapshot retains replaced memberships", () => {
    const { id } = store.add("https://example.com/old");
    const list = store.createList("New feature");
    store.setMembership(list.id, id, true);
    const before = store.export();
    const result = store.restore({
      ...before,
      version: 1,
      lists: undefined,
      memberships: undefined,
    });
    expect(store.get(id)).toEqual(before.links[0]);
    expect(store.lists()).toEqual([]);
    expect(store.linkLists(id)).toEqual([]);
    const safety = JSON.parse(
      readFileSync(join(dir, "backups", result.safetyBackup), "utf8"),
    );
    expect(safety).toMatchObject({
      version: 2,
      lists: before.lists,
      memberships: before.memberships,
    });
  });
  test("invalid list backups fail before creating a safety copy or modifying data", () => {
    const { id } = store.add("https://example.com/protected");
    const list = store.createList("Protected");
    store.setMembership(list.id, id, true);
    const backup = store.export();
    for (const patch of [
      { memberships: [{ listId: list.id, linkId: crypto.randomUUID() }] },
      { memberships: [{ listId: crypto.randomUUID(), linkId: id }] },
      { memberships: [...backup.memberships, ...backup.memberships] },
      {
        lists: [
          ...backup.lists,
          { ...list, id: crypto.randomUUID(), name: "  PROTECTED  " },
        ],
      },
      { lists: [list, { ...list, name: "Other" }] },
      { lists: [{ ...list, name: "" }] },
    ])
      expect(() => store.restore({ ...backup, ...patch })).toThrow();
    expect(readdirSync(dir)).not.toContain("backups");
    expect(store.export()).toMatchObject({
      lists: backup.lists,
      memberships: backup.memberships,
      links: backup.links,
    });
  });
  test("a later restore failure rolls back list deletion, link changes and queue replacement", () => {
    const { id } = store.add("https://example.com/protected");
    const list = store.createList("Protected");
    store.setMembership(list.id, id, true);
    const backup = store.export();
    const jobs = store.jobs();
    const suggestion = {
      id: crypto.randomUUID(),
      source: "a",
      target: "b",
      reason: "test",
      status: "pending",
    };
    expect(() =>
      store.restore({
        ...backup,
        links: [],
        lists: [],
        memberships: [],
        suggestions: [suggestion, { ...suggestion, source: "c" }],
      }),
    ).toThrow();
    expect(store.get(id)).toEqual(backup.links[0]);
    expect(store.export().lists).toEqual(backup.lists);
    expect(store.linkLists(id)).toEqual([list.id]);
    expect(store.jobs()).toEqual(jobs);
  });
});

describe("lists API", () => {
  test("list creation, membership, rename and deletion validate inputs and preserve the saved link", async () => {
    const api = createApi(store, new Worker(store));
    const { id } = store.add("https://example.com/saved");
    const create = await api(
      request("/lists", "POST", { name: "Research", linkId: id }),
    );
    expect(create.status).toBe(201);
    const list = await create.json();
    expect(
      (await (await api(request(`/links/${id}/lists`))).json()).listIds,
    ).toEqual([list.id]);
    expect(
      (await api(request("/lists", "POST", { name: "research" }))).status,
    ).toBe(409);
    expect(
      (await api(request("/lists", "POST", { name: "", extra: true }))).status,
    ).toBe(400);
    expect(
      (await api(request(`/lists/${list.id}`, "PATCH", { name: "New Name" })))
        .status,
    ).toBe(200);
    expect(
      (await api(request(`/lists/${list.id}/links/${id}`, "DELETE", {})))
        .status,
    ).toBe(200);
    expect(store.linkLists(id)).toEqual([]);
    expect(
      (await api(request(`/lists/${list.id}/links/${id}`, "PUT", {}))).status,
    ).toBe(200);
    expect(
      (
        await api(
          request(`/lists/${list.id}/links/${crypto.randomUUID()}`, "PUT", {}),
        )
      ).status,
    ).toBe(404);
    expect(
      (await api(request("/lists/invalid", "PATCH", { name: "Valid" }))).status,
    ).toBe(400);
    expect(
      (await api(request(`/lists/${crypto.randomUUID()}`, "DELETE", {})))
        .status,
    ).toBe(404);
    expect(
      (
        await api(
          request("/lists", "POST", {
            name: "Rollback",
            linkId: crypto.randomUUID(),
          }),
        )
      ).status,
    ).toBe(404);
    expect(store.lists()).toHaveLength(1);
    expect(
      (await (await api(request("/lists"))).json()).lists[0],
    ).toMatchObject({ name: "New Name", count: 1 });
    expect((await api(request(`/lists/${list.id}`, "DELETE", {}))).status).toBe(
      200,
    );
    expect(store.get(id)).not.toBeNull();
    expect(store.linkLists(id)).toEqual([]);
  });
  test("pasting URLs into a list includes duplicates without changing their statuses and fails atomically for a missing list", async () => {
    const api = createApi(store, new Worker(store));
    const list = store.createList("Pasted");
    const { id } = store.add("https://example.com/old");
    store.update(id, {
      read: true,
      liked: true,
      archived: true,
      deleted: true,
    });
    const before = store.get(id);
    const response = await api(
      request("/links", "POST", {
        text: "https://example.com/old\nhttps://example.com/new",
        listId: list.id,
      }),
    );
    expect(response.status).toBe(201);
    const { results } = await response.json();
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ id, duplicate: true });
    expect(store.get(id)).toEqual(before);
    expect(store.linkLists(id)).toEqual([list.id]);
    expect(store.linkLists(results[1].id)).toEqual([list.id]);
    expect(
      (
        await (
          await api(request(`/links?list=${list.id}&deleted=false`))
        ).json()
      ).total,
    ).toBe(1);
    expect(
      (
        await api(
          request("/links", "POST", {
            text: "https://example.com/never-saved",
            listId: crypto.randomUUID(),
          }),
        )
      ).status,
    ).toBe(404);
    expect(store.all()).toHaveLength(2);
    expect(store.jobs()).toHaveLength(2);
  });
});

test("the membership editor adds, removes, creates and reports failed saves without losing other links", async () => {
  const child = Bun.spawn(
    [process.execPath, "tests/fixtures/list-interactions.ts"],
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
  expect(stdout).toContain("List interactions passed");
});
