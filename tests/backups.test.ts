import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/db";
import { Worker } from "../server/worker";
import { createApi } from "../server/api";
import { listBackups, readBackup } from "../server/backup-files";
import { backupSchema, MAX_BACKUP_BYTES } from "../server/schema";

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "braindump-backups-"));
  store = new Store(dir);
  store.setMeta("settings", {
    model: "test",
    tagReviewHours: 0,
    backupHours: 0,
  });
});
afterEach(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});
function saved(name: string, content = "{}") {
  mkdirSync(join(dir, "backups"), { recursive: true });
  const path = join(dir, "backups", name);
  writeFileSync(path, content);
  return path;
}
function request(path: string, method = "GET", body?: unknown) {
  return new Request(`http://127.0.0.1:3210/api${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("backup inventory includes automatic safety and custom JSON files newest first without changing the library", async () => {
  const api = createApi(store, new Worker(store));
  expect(await (await api(request("/backups"))).json()).toEqual({
    backups: [],
  });
  const first = saved("auto-old.json", '{"old":true}');
  const second = saved("before-empty-trash-new.json");
  const third = saved("My Custom Backup.JSON", "not JSON yet");
  utimesSync(first, 1, 1);
  utimesSync(second, 3, 3);
  utimesSync(third, 2, 2);
  saved("ignore.txt");
  saved(".hidden.json");
  mkdirSync(join(dir, "backups", "folder.json"));
  symlinkSync(first, join(dir, "backups", "linked.json"));
  const before = store.all();
  const response = await api(request("/backups"));
  expect(response.status).toBe(200);
  expect((await response.json()).backups).toEqual([
    {
      name: "before-empty-trash-new.json",
      size: 2,
      modifiedAt: new Date(3000).toISOString(),
    },
    {
      name: "My Custom Backup.JSON",
      size: 12,
      modifiedAt: new Date(2000).toISOString(),
    },
    {
      name: "auto-old.json",
      size: 12,
      modifiedAt: new Date(1000).toISOString(),
    },
  ]);
  expect(store.all()).toEqual(before);
});

test("downloads preserve the selected bytes and use an encoded attachment filename", async () => {
  const name = "Jo's backup é.json";
  const content = JSON.stringify(store.export(), null, 2);
  saved(name, content);
  const api = createApi(store, new Worker(store));
  const response = await api(request(`/backups/${encodeURIComponent(name)}`));
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(content);
  expect(response.headers.get("Content-Disposition")).toContain(
    "Jo%27s%20backup%20%C3%A9.json",
  );
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
});

test("stored v1 and v2 backups reuse validated restoration and create safety snapshots", async () => {
  const { id } = store.add("https://example.com/saved");
  store.update(id, { state: "ready", deleted: true });
  const list = store.createList("Research");
  store.setMembership(list.id, id, true);
  const v2 = store.export();
  const { lists: _lists, memberships: _memberships, ...old } = v2;
  saved("v2.json", JSON.stringify(v2));
  saved("v1.json", JSON.stringify({ ...old, version: 1 }));
  const api = createApi(store, new Worker(store));
  for (const version of [2, 1]) {
    const download = await api(request(`/backups/v${version}.json`));
    const parsed = backupSchema.parse(await download.json());
    const restored = await api(request("/restore", "POST", parsed));
    expect(restored.status).toBe(200);
    expect((await restored.json()).restored).toBe(1);
    expect(store.get(id)?.deleted).toBe(true);
    expect(store.lists()).toHaveLength(version === 2 ? 1 : 0);
  }
  expect(
    readdirSync(join(dir, "backups")).filter((name) =>
      name.startsWith("before-restore-"),
    ),
  ).toHaveLength(2);
});

test("missing files traversal symlinks and non-files never expose other data", async () => {
  const outside = join(dir, "private.json");
  writeFileSync(outside, "private fixture");
  saved("regular.json");
  symlinkSync(outside, join(dir, "backups", "escape.json"));
  mkdirSync(join(dir, "backups", "folder.json"));
  const api = createApi(store, new Worker(store));
  for (const name of [
    "../private.json",
    "..\\private.json",
    "escape.json",
    "folder.json",
    "file\n.json",
  ]) {
    const response = await api(request(`/backups/${encodeURIComponent(name)}`));
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("private fixture");
  }
  expect((await api(request("/backups/missing.json"))).status).toBe(404);
  rmSync(join(dir, "backups"), { recursive: true });
  symlinkSync(dir, join(dir, "backups"));
  expect(() => listBackups(dir)).toThrow("regular directory");
  expect(() => readBackup(dir, "private.json")).toThrow("regular directory");
});

test("oversized files are listed but rejected before reading into memory", async () => {
  const path = saved("oversized.json");
  truncateSync(path, MAX_BACKUP_BYTES + 1);
  expect(listBackups(dir)[0].size).toBe(MAX_BACKUP_BYTES + 1);
  const api = createApi(store, new Worker(store));
  expect((await api(request("/backups/oversized.json"))).status).toBe(413);
});

test("invalid backups and active jobs cannot replace a library through the saved-file workflow", async () => {
  const { id } = store.add("https://example.com/kept");
  store.update(id, { state: "ready" });
  const worker = new Worker(store);
  const api = createApi(store, worker);
  saved("invalid.json", JSON.stringify({ version: 2 }));
  const invalid = await (await api(request("/backups/invalid.json"))).json();
  expect((await api(request("/restore", "POST", invalid))).status).toBe(400);
  worker.busy = true;
  expect((await api(request("/restore", "POST", store.export()))).status).toBe(
    409,
  );
  expect(store.get(id)).not.toBeNull();
  expect(readdirSync(join(dir, "backups"))).toEqual(["invalid.json"]);
});

test("saved backup endpoints preserve local origin and method boundaries", async () => {
  saved("test.json");
  const api = createApi(store, new Worker(store));
  for (const path of ["/backups", "/backups/test.json"]) {
    expect(
      (
        await api(
          new Request(`http://127.0.0.1:3210/api${path}`, {
            headers: { Origin: "https://foreign.example" },
          }),
        )
      ).status,
    ).toBe(403);
    expect((await api(request(path, "DELETE", {}))).status).toBe(404);
  }
  expect(listBackups(dir)).toHaveLength(1);
});
