import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, QueueError } from "../server/db";
import { Worker } from "../server/worker";
import { createApi } from "../server/api";
import type { QueueResult } from "../server/queue-types";

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "braindump-queue-test-"));
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
function add(name: string) {
  const link = store.add(`https://example.com/${name}`);
  store.update(link.id, { title: name });
  return store.jobs().find((j) => j.link_id === link.id)!;
}
function request(path: string, method = "GET", origin?: string) {
  return new Request(`http://127.0.0.1:3210/api${path}`, {
    method,
    headers: {
      ...(method !== "GET" ? { "Content-Type": "application/json" } : {}),
      ...(origin ? { Origin: origin } : {}),
    },
    body: method === "GET" ? undefined : "{}",
  });
}

describe("queue ordering and persistence", () => {
  test("promotion changes the next claim without touching the running job or link flags", () => {
    const a = add("first"),
      b = add("second"),
      c = add("third");
    store.update(c.link_id!, { liked: true, read: true, archived: true });
    const link = store.get(c.link_id!);
    expect(store.claim()!.id).toBe(a.id);
    store.promoteJob(c.id);
    const queue = store.queue();
    expect(queue.running.map((j) => j.id)).toEqual([a.id]);
    expect(queue.waiting.map((j) => j.id)).toEqual([c.id, b.id]);
    expect(store.get(c.link_id!)).toEqual(link);
    expect(store.claim()!.id).toBe(c.id);
    expect(store.jobs().find((j) => j.id === a.id)!.state).toBe("running");
  });
  test("latest promotion wins and normal FIFO order survives a restart", () => {
    const a = add("first"),
      b = add("second"),
      c = add("third");
    store.promoteJob(c.id);
    store.promoteJob(b.id);
    store.db.close();
    store = new Store(dir);
    expect(store.queue().waiting.map((j) => j.id)).toEqual([b.id, c.id, a.id]);
    expect(store.claim()!.id).toBe(b.id);
  });
  test("retry delays match dispatch order and explicit promotion makes a retry due without resetting attempts", () => {
    const a = add("retry"),
      b = add("ready");
    store.db.run(
      "UPDATE jobs SET attempts=2,error='Temporary failure',available_at=? WHERE id=?",
      [Date.now() + 60000, a.id],
    );
    expect(store.queue().waiting.map((j) => j.id)).toEqual([b.id, a.id]);
    expect(store.queue().retrying).toBe(1);
    store.promoteJob(a.id);
    const next = store.claim()!;
    expect(next.id).toBe(a.id);
    expect(next.attempts).toBe(3);
    expect(store.queue().retrying).toBe(0);
  });
  test("tag reviews are visible and can be promoted without a link", () => {
    add("article");
    store.enqueue("tags");
    const tags = store.jobs().find((j) => j.kind === "tags")!;
    store.promoteJob(tags.id);
    expect(store.queue().waiting[0].title).toBe("Tag consolidation review");
    expect(store.queue().waiting[0].url).toBeNull();
    expect(store.claim()!.kind).toBe("tags");
  });
  test("pagination and search cover the full queue and retain global positions", () => {
    for (let i = 0; i < 121; i++) add(`article-${i}`);
    const second = store.queue(2);
    expect(second.waiting).toHaveLength(50);
    expect(second.waiting[0].position).toBe(51);
    expect(second.waitingTotal).toBe(121);
    const found = store.queue(1, "article-120");
    expect(found.total).toBe(1);
    expect(found.waiting[0].position).toBe(121);
    expect(store.queue(99).page).toBe(3);
    expect(store.queue(1, "%").total).toBe(0);
    expect(store.queue(1, "' OR 1=1 --").total).toBe(0);
  });
  test("queued deleted links are excluded; running deleted links are still visible", () => {
    const a = add("running"),
      b = add("deleted");
    store.claim();
    store.update(a.link_id!, { deleted: true });
    store.update(b.link_id!, { deleted: true });
    const queue = store.queue();
    expect(queue.running[0].deleted).toBe(1);
    expect(queue.waitingTotal).toBe(0);
    expect(() => store.promoteJob(b.id)).toThrow(QueueError);
  });
  test("completed, failed, running and missing jobs cannot be promoted", () => {
    const a = add("job");
    for (const state of ["running", "done", "failed"]) {
      store.db.run("UPDATE jobs SET state=? WHERE id=?", [state, a.id]);
      expect(() => store.promoteJob(a.id)).toThrow(QueueError);
    }
    expect(() => store.promoteJob(99999)).toThrow(QueueError);
  });
  test("v1 migration preserves library data, queue IDs, errors and retry times", () => {
    const a = add("preserved");
    store.db.run(
      "UPDATE jobs SET attempts=1,error='Retry me',available_at=9999999999999 WHERE id=?",
      [a.id],
    );
    const link = store.get(a.link_id!);
    // Recreate precisely the previous jobs schema in a disposable store.
    store.db.exec(
      "DROP INDEX jobs_dispatch; ALTER TABLE jobs DROP COLUMN priority; PRAGMA user_version=1;",
    );
    store.db.close();
    store = new Store(dir);
    expect(store.get(a.link_id!)).toEqual(link);
    expect(store.jobs()[0]).toMatchObject({
      id: a.id,
      priority: 0,
      error: "Retry me",
      attempts: 1,
      available_at: 9999999999999,
    });
    expect(
      (store.db.query("PRAGMA user_version").get() as { user_version: number })
        .user_version,
    ).toBe(3);
    store.db.close();
    store = new Store(dir);
    expect(store.jobs()).toHaveLength(1);
  });
  test("a future database version is rejected without downgrading or requeueing it", () => {
    const a = add("running");
    store.claim();
    store.db.exec("PRAGMA user_version=99;");
    expect(() => new Store(dir)).toThrow("newer");
    expect(store.jobs().find((j) => j.id === a.id)!.state).toBe("running");
    expect(
      (store.db.query("PRAGMA user_version").get() as { user_version: number })
        .user_version,
    ).toBe(99);
  });
});

describe("queue API", () => {
  test("returns current model work and promotes waiting jobs with boundary checks", async () => {
    const a = add("running"),
      b = add("waiting");
    store.claim();
    store.update(a.link_id!, { state: "summarizing" });
    const worker = new Worker(store);
    worker.current = {
      id: a.id,
      stage: "summarizing",
      model: "gemma4:12b-mlx",
      startedAt: new Date().toISOString(),
    };
    const api = createApi(store, worker);
    const response = await api(request("/queue"));
    const queue = (await response.json()) as QueueResult;
    expect(queue.current?.stage).toBe("summarizing");
    expect(queue.running[0].linkState).toBe("summarizing");
    expect(queue.waiting[0].id).toBe(b.id);
    expect(JSON.stringify(queue)).not.toContain('"content"');
    expect((await api(request(`/queue/${b.id}/promote`, "POST"))).status).toBe(
      200,
    );
    expect((await api(request(`/queue/${a.id}/promote`, "POST"))).status).toBe(
      409,
    );
    expect((await api(request("/queue/999999/promote", "POST"))).status).toBe(
      404,
    );
    expect(
      (
        await api(
          request(`/queue/${b.id}/promote`, "POST", "https://foreign.example"),
        )
      ).status,
    ).toBe(403);
    expect((await api(request("/queue?page=-1"))).status).toBe(400);
  });
  test("the worker actually dispatches a promoted job first", async () => {
    const a = add("first"),
      b = add("next");
    store.enqueue("tags");
    const tags = store.jobs().find((j) => j.kind === "tags")!;
    store.promoteJob(tags.id);
    const worker = new Worker(store);
    // No tags means this real worker job completes without network/model access.
    await worker.tick();
    expect(store.jobs().find((j) => j.id === tags.id)!.state).toBe("done");
    expect(store.jobs().find((j) => j.id === a.id)!.state).toBe("queued");
    expect(store.jobs().find((j) => j.id === b.id)!.state).toBe("queued");
    expect(worker.current).toBeNull();
  });
});
