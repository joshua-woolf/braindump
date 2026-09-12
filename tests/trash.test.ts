import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/db";
import { Worker } from "../server/worker";
import { createApi } from "../server/api";

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "braindump-trash-"));
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
function trashed(path: string) {
  const { id } = store.add(`https://example.com/${path}`);
  store.update(id, {
    deleted: true,
    content: "vanishingpangolin",
    tags: ["removedtag"],
  });
  store.setMeta(`analysis:${id}`, { progress: true });
  return id;
}
function request(token: unknown, origin = "http://127.0.0.1:3210") {
  return new Request("http://127.0.0.1:3210/api/trash/empty", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ token }),
  });
}

test("emptying Trash removes all pages and derived records while preserving the library and a restorable backup", async () => {
  const kept = store.add("https://example.com/kept");
  store.update(kept.id, {
    state: "ready",
    archived: true,
    read: true,
    liked: true,
    tags: ["kepttag"],
  });
  const list = store.createList("Keep This List");
  store.setMembership(list.id, kept.id, true);
  const ids = Array.from({ length: 35 }, (_, i) => trashed(`removed-${i}`));
  for (const id of ids) store.setMembership(list.id, id, true);
  store.db.run("INSERT INTO aliases VALUES ('legacy','kepttag')");
  store.suggest("kepttags", "kepttag", "Plural");
  const before = store.export();
  const api = createApi(store, new Worker(store));
  const preview = await (
    await api(new Request("http://127.0.0.1:3210/api/trash"))
  ).json();
  expect(preview.count).toBe(35);
  const response = await api(request(preview.token));
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.deleted).toBe(35);
  expect(store.all()).toEqual(before.links.filter((l) => !l.deleted));
  expect(store.lists()).toEqual([{ ...list, count: 1 }]);
  expect(store.linkLists(kept.id)).toEqual([list.id]);
  expect(
    store.list(new URLSearchParams({ q: "vanishingpangolin", deleted: "all" }))
      .total,
  ).toBe(0);
  expect(store.tags()).toEqual([{ name: "kepttag", count: 1 }]);
  expect(store.jobs().every((job) => job.link_id === kept.id)).toBe(true);
  for (const id of ids)
    expect(store.getMeta(`analysis:${id}`, null)).toBeNull();
  const after = store.export();
  expect(after.settings).toEqual(before.settings);
  expect(after.aliases).toEqual(before.aliases);
  expect(after.suggestions).toEqual(before.suggestions);
  const backup = await Bun.file(join(dir, "backups", result.backup)).json();
  expect(backup.links).toEqual(before.links);
  expect(backup.memberships).toEqual(before.memberships);
  store.restore(backup);
  expect(store.counts()).toMatchObject({ deleted: 35 });
  expect(store.linkLists(ids[0])).toEqual([list.id]);
});

test("a confirmation becomes stale when different links enter Trash even with the same count", async () => {
  const first = trashed("first");
  const preview = store.trashPreview();
  store.update(first, { deleted: false });
  const second = trashed("second");
  const api = createApi(store, new Worker(store));
  const response = await api(request(preview.token));
  expect(response.status).toBe(409);
  expect(store.get(first)?.deleted).toBe(false);
  expect(store.get(second)?.deleted).toBe(true);
  expect(existsSync(join(dir, "backups"))).toBe(false);
});

test("running Trash jobs block deletion but unrelated running jobs do not", () => {
  const id = trashed("running");
  store.db.run("UPDATE jobs SET state='running' WHERE link_id=?", [id]);
  const preview = store.trashPreview();
  expect(preview.running).toBe(1);
  expect(() => store.emptyTrash(preview.token)).toThrow("still processing");
  expect(store.get(id)).not.toBeNull();
  const active = store.add("https://example.com/active");
  store.db.run("UPDATE jobs SET state='done' WHERE link_id=?", [id]);
  store.db.run("UPDATE jobs SET state='running' WHERE link_id=?", [active.id]);
  expect(store.emptyTrash(preview.token).deleted).toBe(1);
  expect(store.get(active.id)).not.toBeNull();
  expect(store.jobs()[0].state).toBe("running");
});

test("a failed safety backup leaves Trash and search unchanged", () => {
  const id = trashed("backup-failure");
  writeFileSync(
    join(dir, "backups"),
    "A file blocks creation of the backup directory.",
  );
  expect(() => store.emptyTrash(store.trashPreview().token)).toThrow();
  expect(store.get(id)?.deleted).toBe(true);
  expect(
    store.list(new URLSearchParams({ q: "vanishingpangolin" })).total,
  ).toBe(1);
  expect(store.getMeta<unknown>(`analysis:${id}`, null)).toEqual({
    progress: true,
  });
});

test("a database deletion failure rolls back search checkpoints memberships and jobs", () => {
  const id = trashed("rollback");
  const list = store.createList("Preserved");
  store.setMembership(list.id, id, true);
  store.db.exec(
    "CREATE TRIGGER refuse_trash BEFORE DELETE ON links BEGIN SELECT RAISE(ABORT,'test deletion failure'); END;",
  );
  expect(() => store.emptyTrash(store.trashPreview().token)).toThrow(
    "test deletion failure",
  );
  expect(store.get(id)?.deleted).toBe(true);
  expect(store.linkLists(id)).toEqual([list.id]);
  expect(store.jobs().map((job) => job.link_id)).toEqual([id]);
  expect(store.getMeta<unknown>(`analysis:${id}`, null)).toEqual({
    progress: true,
  });
  expect(
    store.list(new URLSearchParams({ q: "vanishingpangolin" })).total,
  ).toBe(1);
  expect(readdirSync(join(dir, "backups"))).toHaveLength(1);
});

test("empty Trash is a no-op and a removed URL can be saved again", () => {
  expect(store.emptyTrash(store.trashPreview().token)).toEqual({
    deleted: 0,
    backup: null,
  });
  expect(existsSync(join(dir, "backups"))).toBe(false);
  const id = trashed("again");
  store.emptyTrash(store.trashPreview().token);
  const added = store.add("https://example.com/again");
  expect(added.duplicate).toBe(false);
  expect(added.id).not.toBe(id);
});

test("the empty Trash API requires a valid confirmation and the existing local JSON boundary", async () => {
  const id = trashed("boundaries");
  const api = createApi(store, new Worker(store));
  expect((await api(request("invalid"))).status).toBe(400);
  expect(
    (await api(request(store.trashPreview().token, "https://foreign.example")))
      .status,
  ).toBe(403);
  expect(
    (
      await api(
        new Request("http://127.0.0.1:3210/api/trash/empty", {
          method: "POST",
          body: "{}",
        }),
      )
    ).status,
  ).toBe(415);
  expect(
    (await api(new Request("http://127.0.0.1:3210/api/trash/empty"))).status,
  ).toBe(404);
  expect(store.get(id)?.deleted).toBe(true);
});
