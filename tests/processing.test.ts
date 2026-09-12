import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/db";
import { Worker } from "../server/worker";
import { createApi } from "../server/api";
import { existsSync } from "node:fs";
import {
  analyze,
  generate,
  OllamaUnavailable,
  type AnalysisCheckpoint,
} from "../server/ollama";

const text =
  "A detailed explanation of local databases and their transactional consistency. ".repeat(
    10,
  );
const result = {
  summary:
    "SQLite keeps application data in a local database with atomic transactions.",
  highlights: ["Transactions preserve consistency."],
  tags: ["sqlite"],
};
let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "braindump-processing-"));
  store = new Store(dir);
  store.setMeta("settings", {
    model: "test-model",
    tagReviewHours: 0,
    backupHours: 0,
  });
});
afterEach(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});
function services() {
  return {
    extract: async () => ({
      title: "Source title",
      description: "",
      content: text,
      method: "test",
    }),
    analyze: async () => result,
    generate,
    ollamaStatus: async () => ({
      online: true,
      models: [],
      error: null as string | null,
    }),
  };
}

function request(id: string, action: string, body: unknown) {
  return new Request(`http://127.0.0.1:3210/api/links/${id}/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("shutdown preserves saved text, flags, memberships and checkpoints without spending a retry", async () => {
  const { id } = store.add("https://example.com/shutdown");
  store.update(id, { content: text, state: "queued", read: true, liked: true });
  store.db.run("UPDATE jobs SET kind='analyze',attempts=1,priority=7");
  const list = store.createList("Keep this list");
  store.setMembership(list.id, id, true);
  store.setMeta(`analysis:${id}`, { saved: "checkpoint" });
  let entered!: () => void;
  let finish!: (value: typeof result) => void;
  const running = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const worker = new Worker(store, {
    ...services(),
    analyze: async () => {
      entered();
      return await new Promise<typeof result>((resolve) => {
        finish = resolve;
      });
    },
  });
  const tick = worker.tick();
  await running;
  const shutdown = worker.shutdown();
  finish(result);
  await Promise.all([tick, shutdown]);
  expect(store.get(id)).toMatchObject({
    content: text,
    read: true,
    liked: true,
    state: "queued",
    summary: "",
  });
  expect(
    store.db.query("SELECT kind,state,attempts,priority FROM jobs").get(),
  ).toEqual({ kind: "analyze", state: "queued", attempts: 1, priority: 7 });
  expect(
    store.db
      .query("SELECT link_id FROM list_links WHERE list_id=?")
      .get(list.id),
  ).toEqual({ link_id: id });
  expect(store.getMeta<unknown>(`analysis:${id}`, null)).toEqual({
    saved: "checkpoint",
  });
  await worker.tick();
  expect(store.db.query("SELECT attempts FROM jobs").get()).toEqual({
    attempts: 1,
  });
});

test("URL repair backs up old content, preserves identity and memberships, and queues extraction", async () => {
  const { id } = store.add("https://example.com/typo");
  store.db.run("UPDATE jobs SET state='failed'");
  store.update(id, {
    content: text,
    summary: result.summary,
    tags: ["old"],
    state: "error",
    read: true,
    liked: true,
    archived: true,
  });
  const list = store.createList("Reading");
  store.setMembership(list.id, id, true);
  const before = store.get(id);
  const api = createApi(store, new Worker(store, services()));
  const response = await api(
    request(id, "repair-url", {
      url: "https://example.com/correct?utm_source=test",
    }),
  );
  expect(response.status).toBe(200);
  const { backup } = await response.json();
  expect(
    (await Bun.file(join(dir, "backups", backup)).json()).links,
  ).toContainEqual(before);
  expect(store.get(id)).toMatchObject({
    id,
    url: "https://example.com/correct",
    content: "",
    summary: "",
    tags: [],
    read: true,
    liked: true,
    archived: true,
    state: "queued",
  });
  expect(store.linkLists(id)).toEqual([list.id]);
  expect(store.jobs()[0]).toMatchObject({ kind: "process", state: "queued" });
  expect(
    store.list(new URLSearchParams({ q: "correct", archived: "all" })).total,
  ).toBe(1);
});

test("URL repair rejects duplicates, unsafe destinations, Trash and active jobs without mutation", async () => {
  const { id } = store.add("https://example.com/old");
  store.add("https://example.com/existing");
  const api = createApi(store, new Worker(store, services()));
  expect(
    (await api(request(id, "repair-url", { url: "https://example.com/new" })))
      .status,
  ).toBe(409);
  store.db.run("UPDATE jobs SET state='failed'");
  const before = store.export();
  for (const url of [
    "https://example.com/existing",
    "http://127.0.0.1/",
    "https://user:pass@example.com/",
    "https://example.com:3210/",
    `https://example.com/${"é".repeat(1400)}`,
  ]) {
    const response = await api(request(id, "repair-url", { url }));
    expect(response.ok).toBe(false);
  }
  expect(store.all()).toEqual(before.links);
  expect(existsSync(join(dir, "backups"))).toBe(false);
  store.update(id, { deleted: true });
  expect(
    (await api(request(id, "repair-url", { url: "https://example.com/new" })))
      .status,
  ).toBe(409);
});

test("binary saved or pasted content cannot enter the analysis queue", async () => {
  const { id } = store.add("https://example.com/book.pdf");
  store.db.run("UPDATE jobs SET state='failed'");
  store.update(id, { content: "%PDF-1.5\n" + text, state: "error" });
  const api = createApi(store, new Worker(store, services()));
  expect((await api(request(id, "analyze", {}))).status).toBe(400);
  expect(
    (await api(request(id, "content", { content: "%PDF-1.5\n" + text })))
      .status,
  ).toBe(400);
  expect(store.queueStatus().activeJobs).toBe(0);
});

test("an unavailable model preserves retry attempts and resumes after backoff", async () => {
  const { id } = store.add("https://example.com/");
  const service = services();
  let online = false;
  let extractions = 0;
  service.ollamaStatus = async () => ({ online, models: [], error: null });
  service.extract = async () => {
    extractions++;
    return { title: "Example", description: "", content: text, method: "test" };
  };
  const worker = new Worker(store, service);
  await worker.tick();
  expect(extractions).toBe(0);
  expect(store.jobs()[0]).toMatchObject({ state: "queued", attempts: 0 });
  expect(store.get(id)).toMatchObject({ state: "queued" });
  expect(store.get(id)!.error).toContain("Waiting for local Ollama");
  online = true;
  store.setMeta("ollamaRetryAt", 0);
  store.db.run("UPDATE jobs SET available_at=0");
  await worker.tick();
  expect(store.get(id)!.state).toBe("ready");
  expect(store.jobs()[0]).toMatchObject({ state: "done", attempts: 1 });
});

test("a model failure resumes saved extraction after restart and preserves edits and lists", async () => {
  const { id } = store.add("https://example.com/");
  const list = store.createList("Reading");
  store.setMembership(list.id, id, true);
  const service = services();
  let extractions = 0;
  service.extract = async () => {
    extractions++;
    store.update(id, { read: true, liked: true });
    return {
      title: "original Title",
      description: "",
      content: text,
      method: "test",
    };
  };
  service.analyze = async () => {
    throw new OllamaUnavailable("Waiting for Ollama");
  };
  await new Worker(store, service).tick();
  expect(store.jobs()[0]).toMatchObject({
    kind: "analyze",
    attempts: 0,
    state: "queued",
  });
  store.db.close();
  store = new Store(dir);
  store.setMeta("ollamaRetryAt", 0);
  store.db.run("UPDATE jobs SET available_at=0");
  service.analyze = async () => {
    store.update(id, { archived: true });
    return result;
  };
  await new Worker(store, service).tick();
  expect(extractions).toBe(1);
  expect(store.get(id)).toMatchObject({
    state: "ready",
    read: true,
    liked: true,
    archived: true,
    title: "original Title",
  });
  expect(store.linkLists(id)).toEqual([list.id]);
});

test("ordinary model failures still stop after three attempts", async () => {
  const { id } = store.add("https://example.com/");
  const service = services();
  service.analyze = async () => {
    throw new Error("Invalid model JSON");
  };
  const worker = new Worker(store, service);
  for (let i = 0; i < 3; i++) {
    store.db.run("UPDATE jobs SET available_at=0");
    await worker.tick();
  }
  expect(store.jobs()[0]).toMatchObject({ state: "failed", attempts: 3 });
  expect(store.get(id)!.state).toBe("error");
});

test("binary and insufficient saved text are rejected before any inference", async () => {
  let calls = 0;
  for (const content of ["%PDF-1.5\n" + text, text + "\0", "short"])
    expect(
      await analyze("test", "Source", content, [], {
        generate: async () => {
          calls++;
          return result;
        },
      }).catch((error: unknown) => error),
    ).toBeInstanceOf(Error);
  expect(calls).toBe(0);
});

test("chunk and reduction checkpoints survive failure and invalidate when source or model changes", async () => {
  let saved: AnalysisCheckpoint | null = null;
  const checkpoint = {
    read: () => saved,
    write: (value: AnalysisCheckpoint) => {
      saved = structuredClone(value);
    },
  };
  const content = text.repeat(90);
  let calls = 0;
  const run = async () => {
    calls++;
    if (calls === 2) throw new Error("Interrupted");
    return result;
  };
  expect(
    await analyze("model-one", "Source", content, [], {
      checkpoint,
      generate: run,
    }).catch((error: unknown) => error),
  ).toMatchObject({ message: "Interrupted" });
  expect(Object.keys(saved!.results)).toHaveLength(1);
  const afterFailure = calls;
  await analyze("model-one", "Source", content, [], {
    checkpoint,
    generate: run,
  });
  const totalSteps = Object.keys(saved!.results).length;
  expect(calls - afterFailure).toBe(totalSteps - 1);
  const afterSuccess = calls;
  await analyze("model-one", "Source", content, [], {
    checkpoint,
    generate: run,
  });
  expect(calls).toBe(afterSuccess);
  await analyze("model-two", "Source", content, [], {
    checkpoint,
    generate: run,
  });
  expect(calls - afterSuccess).toBe(totalSteps);
  const afterModelChange = calls;
  await analyze("model-two", "Source", content + " changed", [], {
    checkpoint,
    generate: run,
  });
  expect(calls - afterModelChange).toBe(totalSteps);
});
