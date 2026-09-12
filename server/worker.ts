import { z } from "zod";
import type { Store, Job } from "./db";
import { extract } from "./extract";
import { analyze, generate, ollamaStatus, OllamaUnavailable } from "./ollama";
import type { CurrentJob } from "./queue-types";

export class Worker {
  busy = false;
  paused = false;
  private stopping = false;
  current: CurrentJob | null = null;
  timer?: ReturnType<typeof setInterval>;
  constructor(
    public store: Store,
    private services = { extract, analyze, generate, ollamaStatus },
  ) {}
  start() {
    this.timer = setInterval(() => void this.tick(), 1500);
    void this.tick();
  }
  stop() {
    clearInterval(this.timer);
    this.paused = true;
  }
  async shutdown() {
    this.stopping = true;
    this.stop();
    while (this.busy) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  private ensureRunning() {
    if (this.stopping) throw new Error("Braindump is shutting down.");
  }
  schedule() {
    const settings = this.store.settings();
    if (
      settings.backupHours > 0 &&
      Date.now() - this.store.getMeta("lastBackup", 0) >
        settings.backupHours * 3_600_000
    ) {
      this.store.backup();
      this.store.setMeta("lastBackup", Date.now());
    }
    if (
      settings.tagReviewHours > 0 &&
      Date.now() - this.store.getMeta("lastTagReviewScheduled", 0) >
        settings.tagReviewHours * 3_600_000
    ) {
      this.store.enqueue("tags");
      this.store.setMeta("lastTagReviewScheduled", Date.now());
    }
  }
  async tick() {
    if (this.busy || this.paused) return;
    this.busy = true;
    let job: Job | null = null;
    try {
      this.schedule();
      if (Date.now() < this.store.getMeta("ollamaRetryAt", 0)) return;
      job = this.store.claim();
      if (!job) return;
      this.current = {
        id: job.id,
        stage:
          job.kind === "tags"
            ? "reviewing-tags"
            : job.kind === "process"
              ? "extracting"
              : "summarizing",
        model: null,
        startedAt: new Date().toISOString(),
      };
      if (job.kind === "tags") await this.reviewTags();
      else if (job.link_id) {
        let link = this.store.get(job.link_id);
        if (!link || link.deleted) {
          this.store.db.run("UPDATE jobs SET state='done' WHERE id=?", [
            job.id,
          ]);
          return;
        }
        await this.requireOllama();
        if (job.kind === "process") {
          this.store.update(link.id, { state: "extracting", error: null });
          const article = await this.services.extract(link.url);
          this.ensureRunning();
          // Always re-read before writing; read/like/archive edits can happen during extraction.
          const jobId = job.id;
          const linkId = link.id;
          link = this.store.db.transaction(() => {
            const updated = this.store.update(linkId, {
              ...article,
              state: "summarizing",
            });
            // Retry/restart must not fetch a page already extracted successfully.
            this.store.db.run("UPDATE jobs SET kind='analyze' WHERE id=?", [
              jobId,
            ]);
            return updated;
          })();
        } else
          this.store.update(link.id, { state: "summarizing", error: null });
        if (!link.content)
          throw new Error(
            "No extracted text yet. Use Re-fetch page or paste article text.",
          );
        const model = this.store.settings().model;
        this.current.stage = "summarizing";
        this.current.model = model;
        const checkpointKey = `analysis:${link.id}`;
        const result = await this.services.analyze(
          model,
          link.title,
          link.content,
          this.store.tags().map((t) => t.name),
          {
            checkpoint: {
              read: () => this.store.getMeta(checkpointKey, null),
              write: (value) => this.store.setMeta(checkpointKey, value),
            },
          },
        );
        this.ensureRunning();
        this.store.update(link.id, {
          ...result,
          state: "ready",
          error: null,
          model,
          summarizedAt: new Date().toISOString(),
        });
        this.store.db.run("DELETE FROM meta WHERE key=?", [checkpointKey]);
      }
      this.store.db.run("UPDATE jobs SET state='done',error=NULL WHERE id=?", [
        job.id,
      ]);
      this.store.db.run(
        "DELETE FROM jobs WHERE state='done' AND id < (SELECT COALESCE(MAX(id),0)-500 FROM jobs)",
      );
    } catch (error) {
      if (this.stopping) {
        if (job) {
          const interrupted = job;
          this.store.db.transaction(() => {
            this.store.db.run(
              "UPDATE jobs SET state='queued',attempts=?,available_at=0 WHERE id=?",
              [Math.max(0, interrupted.attempts - 1), interrupted.id],
            );
            if (interrupted.link_id && this.store.get(interrupted.link_id))
              this.store.update(interrupted.link_id, { state: "queued" });
          })();
        }
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error("[worker]", message);
      if (job) {
        const unavailable = error instanceof OllamaUnavailable;
        const retry = unavailable || job.attempts < 3;
        if (unavailable)
          this.store.setMeta("ollamaRetryAt", Date.now() + 30_000);
        this.store.db.run(
          "UPDATE jobs SET state=?,error=?,available_at=?,attempts=? WHERE id=?",
          [
            retry ? "queued" : "failed",
            message,
            Date.now() + (unavailable ? 30_000 : job.attempts * 30_000),
            job.attempts - (unavailable ? 1 : 0),
            job.id,
          ],
        );
        if (job.link_id && this.store.get(job.link_id))
          this.store.update(job.link_id, {
            state: retry ? "queued" : "error",
            error: message,
          });
      }
    } finally {
      this.current = null;
      this.busy = false;
    }
  }
  private async requireOllama() {
    const status = await this.services.ollamaStatus();
    this.ensureRunning();
    if (!status.online)
      throw new OllamaUnavailable(
        "Waiting for local Ollama to become available. Start Ollama; this job will resume automatically.",
      );
  }
  async reviewTags() {
    const tags = this.store.tags();
    if (tags.length < 2) {
      this.store.setMeta("lastTagReview", Date.now());
      return;
    }
    await this.requireOllama();
    const groups = new Map<string, string>();
    for (const tag of tags) {
      const key = tag.name.replace(/[^\p{L}\p{N}]/gu, "").replace(/s$/, "");
      const prior = groups.get(key);
      if (prior && prior !== tag.name)
        this.store.suggest(
          tag.name,
          prior,
          "Similar spelling or singular/plural variation.",
        );
      else groups.set(key, tag.name);
    }
    const schema = z.object({
      suggestions: z
        .array(
          z.object({
            source: z.string(),
            target: z.string(),
            reason: z.string().max(500),
          }),
        )
        .max(30),
    });
    const names = new Set(tags.map((t) => t.name));
    // Each batch includes the 60 most-used canonical candidates, plus every remaining tag.
    const popular = tags.slice(0, 60);
    for (let i = 0; i < tags.length; i += 100) {
      const batch = [
        ...new Map(
          [...popular, ...tags.slice(i, i + 100)].map((t) => [t.name, t]),
        ).values(),
      ];
      const model = this.store.settings().model;
      if (this.current) this.current.model = model;
      const result = await this.services.generate(
        model,
        schema,
        "Find only synonymous tags, spelling variants, acronyms with the exact same meaning, or singular/plural duplicates. Do not merge broader/narrower or merely related topics. Source and target must both be supplied existing tag names. Prefer the more commonly used name as target. Suggest merges for user review, with a short reason. Return an empty list if none.",
        { tags: batch },
      );
      this.ensureRunning();
      for (const s of result.suggestions)
        if (names.has(s.source) && names.has(s.target) && s.source !== s.target)
          this.store.suggest(s.source, s.target, s.reason);
    }
    this.store.setMeta("lastTagReview", Date.now());
  }
}
