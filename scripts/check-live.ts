import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../server/db";
import { Worker } from "../server/worker";
import { config } from "../server/config";

// Explicit opt-in integration check: real extraction and inference, temporary data only.
const dir = mkdtempSync(join(tmpdir(), "braindump-live-"));
const store = new Store(dir);
store.setMeta("settings", {
  model: config.model,
  tagReviewHours: 0,
  backupHours: 0,
});
const worker = new Worker(store);
try {
  const { id } = store.add("https://bun.sh/docs/runtime/sqlite");
  const started = Date.now();
  await worker.tick();
  const link = store.get(id)!;
  if (
    link.state !== "ready" ||
    !link.summary ||
    !link.tags.length ||
    !link.content
  )
    throw new Error(link.error || `Unexpected state ${link.state}`);
  console.log(
    JSON.stringify(
      {
        state: link.state,
        method: link.method,
        model: link.model,
        seconds: Math.round((Date.now() - started) / 1000),
        title: link.title,
        summary: link.summary,
        tags: link.tags,
        contentCharacters: link.content.length,
      },
      null,
      2,
    ),
  );
  const backup = store.export();
  const restored = store.restore(backup);
  if (
    restored.restored !== 1 ||
    store.list(new URLSearchParams({ q: "SQLite" })).total !== 1
  )
    throw new Error("Restore/search failed.");
  console.log(
    "Live extraction → Ollama → SQLite → backup/restore → full-text search passed.",
  );
  store.update(id, { tags: ["javascript", "js", "databases", "database"] });
  await worker.reviewTags();
  if (!store.getMeta("lastTagReview", 0))
    throw new Error("Tag review did not complete.");
  console.log("Live tag review passed:", JSON.stringify(store.suggestions()));
} finally {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
}
