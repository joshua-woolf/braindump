import { z } from "zod";
import { Store, QueueError, ListError, TrashError } from "./db";
import { Worker } from "./worker";
import { ollamaStatus, assertReadableContent } from "./ollama";
import {
  patchSchema,
  settingsSchema,
  tagName,
  listInputSchema,
  emptyTrashSchema,
  createBackupSchema,
} from "./schema";
import { MAX_URL_LENGTH, parseUrls, normalizeUrl } from "./urls";
import { FaviconCache } from "./favicon";
import { BackupFileError, listBackups, readBackup } from "./backup-files";

const json = (data: unknown, status = 200) =>
  Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
export function createApi(
  store: Store,
  worker: Worker,
  favicons = new FaviconCache(),
) {
  let restoring = false;
  return async (request: Request) => {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    try {
      const host = url.hostname;
      if (!["localhost", "127.0.0.1", "[::1]"].includes(host))
        return json({ error: "Local requests only." }, 403);
      const origin = request.headers.get("origin");
      const allowedOrigins = new Set([
        url.origin,
        "http://127.0.0.1:5173",
        "http://localhost:5173",
      ]);
      if (
        (origin && !allowedOrigins.has(origin)) ||
        request.headers.get("sec-fetch-site") === "cross-site"
      )
        return json({ error: "Cross-site requests are blocked." }, 403);
      if (
        method !== "GET" &&
        request.headers.get("content-type")?.split(";")[0] !==
          "application/json"
      )
        return json({ error: "Use application/json." }, 415);
      if (path === "/api/status" && method === "GET")
        return json({
          ...(await ollamaStatus()),
          ...store.queueStatus(),
          model: store.settings().model,
          busy: worker.busy,
          jobs: store.jobs(),
          counts: store.counts(),
          lastTagReview: store.getMeta("lastTagReview", null),
          lastBackup: store.getMeta("lastBackup", null),
        });
      if (path === "/api/links" && method === "GET")
        return json(store.list(url.searchParams));
      if (path === "/api/trash" && method === "GET")
        return json(store.trashPreview());
      if (path === "/api/trash/empty" && method === "POST") {
        const { token } = emptyTrashSchema.parse(await request.json());
        return json(store.emptyTrash(token));
      }
      if (path === "/api/queue" && method === "GET") {
        const params = z
          .object({
            page: z.coerce.number().int().min(1).max(1_000_000),
            q: z.string().trim().max(200),
          })
          .parse({
            page: url.searchParams.get("page") || 1,
            q: url.searchParams.get("q") || "",
          });
        return json({
          ...store.queue(params.page, params.q),
          current: worker.current,
          model: store.settings().model,
        });
      }
      const promote = path.match(/^\/api\/queue\/(\d+)\/promote$/);
      if (promote && method === "POST") {
        const id = z.coerce
          .number()
          .int()
          .positive()
          .max(Number.MAX_SAFE_INTEGER)
          .parse(promote[1]);
        return json(store.promoteJob(id));
      }
      if (path === "/api/links" && method === "POST") {
        const data = z
          .object({
            text: z.string().min(1).max(100000),
            listId: z.string().uuid().optional(),
          })
          .strict()
          .parse(await request.json());
        const urls = parseUrls(data.text);
        return json(
          {
            results: store.db.transaction(() => {
              if (data.listId) store.requireList(data.listId);
              return urls.map((u) => {
                const result = store.add(u);
                if (data.listId)
                  store.setMembership(data.listId, result.id, true);
                return result;
              });
            })(),
          },
          201,
        );
      }
      if (path === "/api/lists") {
        if (method === "GET") return json({ lists: store.lists() });
        if (method === "POST") {
          const { name, linkId } = listInputSchema
            .extend({ linkId: z.string().uuid().optional() })
            .parse(await request.json());
          const list = store.db.transaction(() => {
            const created = store.createList(name);
            if (linkId) store.setMembership(created.id, linkId, true);
            return created;
          })();
          return json(list, 201);
        }
        return json({ error: "Method not allowed." }, 405);
      }
      const membershipMatch = path.match(
        /^\/api\/lists\/([^/]+)\/links\/([^/]+)$/,
      );
      if (membershipMatch) {
        const listId = z.string().uuid().parse(membershipMatch[1]);
        const linkId = z.string().uuid().parse(membershipMatch[2]);
        if (method !== "PUT" && method !== "DELETE")
          return json({ error: "Method not allowed." }, 405);
        store.setMembership(listId, linkId, method === "PUT");
        return json({ ok: true });
      }
      const listMatch = path.match(/^\/api\/lists\/([^/]+)$/);
      if (listMatch) {
        const id = z.string().uuid().parse(listMatch[1]);
        if (method === "PATCH") {
          const { name } = listInputSchema.parse(await request.json());
          return json(store.renameList(id, name));
        }
        if (method === "DELETE") {
          store.deleteList(id);
          return json({ ok: true });
        }
        return json({ error: "Method not allowed." }, 405);
      }
      const linkListsMatch = path.match(/^\/api\/links\/([^/]+)\/lists$/);
      if (linkListsMatch && method === "GET") {
        const id = z.string().uuid().parse(linkListsMatch[1]);
        return json({ listIds: store.linkLists(id) });
      }
      const linkMatch = path.match(
        /^\/api\/links\/([0-9a-f-]+)(?:\/(analyze|refetch|content|favicon|repair-url))?$/,
      );
      if (linkMatch) {
        const [, id, action] = linkMatch;
        const link = store.get(id);
        if (!link) return json({ error: "Link not found." }, 404);
        if (action === "favicon")
          return method === "GET"
            ? favicons.response(link.url)
            : json({ error: "Method not allowed." }, 405);
        if (!action && method === "GET") return json(link);
        if (!action && method === "PATCH") {
          const patch = patchSchema.parse(await request.json());
          const updated = store.db.transaction(() => {
            const next = store.update(id, patch);
            if (
              link.deleted &&
              patch.deleted === false &&
              ["queued", "extracting", "summarizing"].includes(next.state)
            ) {
              const active = store.db
                .query(
                  "SELECT id FROM jobs WHERE link_id=? AND state IN ('queued','running')",
                )
                .get(id);
              if (!active) {
                store.update(id, { state: "queued", error: null });
                store.enqueue(next.content ? "analyze" : "process", id);
              }
            }
            return store.get(id);
          })();
          return json(updated);
        }
        if (action && method === "POST") {
          const replacement =
            action === "repair-url"
              ? normalizeUrl(
                  z
                    .object({ url: z.string().url().max(MAX_URL_LENGTH) })
                    .strict()
                    .parse(await request.json()).url,
                )
              : null;
          const pasted =
            action === "content"
              ? z
                  .object({
                    content: z.string().trim().min(180).max(1_000_000),
                  })
                  .strict()
                  .parse(await request.json()).content
              : null;
          // Read again after body parsing: another request may have queued or trashed this link.
          const current = store.get(id)!;
          if (current.deleted)
            return json(
              { error: "Restore this link from Trash before processing it." },
              409,
            );
          const active = store.db
            .query(
              "SELECT id FROM jobs WHERE link_id=? AND state IN ('queued','running')",
            )
            .get(id);
          if (active)
            return json(
              { error: "This link already has a queued or running job." },
              409,
            );
          if (pasted !== null) assertReadableContent(pasted);
          if (action === "analyze") assertReadableContent(current.content);
          if (replacement) {
            if (replacement === current.url)
              return json({ error: "Enter a different URL." }, 400);
            if (
              store.db
                .query("SELECT id FROM links WHERE url=?")
                .get(replacement)
            )
              return json(
                {
                  error:
                    "That URL is already saved. Open the existing link instead.",
                },
                409,
              );
          }
          const backup = replacement ? store.backup("before-url-repair") : null;
          store.db.transaction(() => {
            if (replacement) {
              store.update(id, {
                url: replacement,
                title: new URL(replacement).hostname,
                description: "",
                content: "",
                summary: "",
                highlights: [],
                tags: [],
                method: null,
                model: null,
                summarizedAt: null,
              });
              store.db.run("DELETE FROM meta WHERE key=?", [`analysis:${id}`]);
            }
            if (pasted !== null)
              store.update(id, { content: pasted, method: "pasted-text" });
            store.update(id, { state: "queued", error: null });
            store.enqueue(
              action === "refetch" || replacement ? "process" : "analyze",
              id,
            );
          })();
          return json({ queued: true, ...(backup ? { backup } : {}) });
        }
      }
      if (path === "/api/tags" && method === "GET")
        return json({ tags: store.tags(), suggestions: store.suggestions() });
      if (path === "/api/tags/review" && method === "POST") {
        store.enqueue("tags");
        store.setMeta("lastTagReviewScheduled", Date.now());
        return json({ queued: true });
      }
      if (path === "/api/tags/merge" && method === "POST") {
        const { source, target } = z
          .object({ source: tagName, target: tagName })
          .parse(await request.json());
        const backup = store.backup("before-merge");
        return json({ changed: store.merge(source, target), backup });
      }
      const suggestion = path.match(/^\/api\/suggestions\/([0-9a-f-]+)$/);
      if (suggestion && method === "PATCH") {
        store.db.run("UPDATE suggestions SET status='dismissed' WHERE id=?", [
          suggestion[1],
        ]);
        return json({ ok: true });
      }
      if (path === "/api/settings" && method === "GET")
        return json(store.settings());
      if (path === "/api/settings" && method === "PUT") {
        const settings = settingsSchema.parse(await request.json());
        store.setMeta("settings", settings);
        return json(settings);
      }
      if (path === "/api/settings/backup-directory" && method === "GET")
        return json({ directory: store.backupDirectory() });
      if (path === "/api/settings/backup-directory" && method === "PUT")
        return json(store.moveBackups(await request.json()));
      if (path === "/api/backups" && method === "GET")
        return json({ backups: listBackups(store.backupDirectory()) });
      if (path === "/api/backups" && method === "POST") {
        createBackupSchema.parse(await request.json());
        return json({ backup: store.backup("manual") }, 201);
      }
      if (path === "/api/backups/before-import" && method === "POST") {
        createBackupSchema.parse(await request.json());
        return json({ backup: store.backup("before-import") }, 201);
      }
      const savedBackup = path.match(/^\/api\/backups\/([^/]+)$/);
      if (savedBackup && method === "GET") {
        const name = decodeURIComponent(savedBackup[1]);
        const encodedName = encodeURIComponent(name).replace(
          /[!'()*]/g,
          (character) =>
            `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
        );
        return new Response(readBackup(store.backupDirectory(), name), {
          headers: {
            "Content-Type": "application/json",
            "Content-Disposition": `attachment; filename="backup.json"; filename*=UTF-8''${encodedName}`,
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }
      if (path === "/api/backup" && method === "GET")
        return new Response(JSON.stringify(store.export(), null, 2), {
          headers: {
            "Content-Type": "application/json",
            "Content-Disposition": `attachment; filename="braindump-${new Date().toISOString().slice(0, 10)}.json"`,
            "Cache-Control": "no-store",
          },
        });
      if (path === "/api/restore" && method === "POST") {
        if (worker.busy || restoring)
          return json(
            {
              error:
                "A background job or restore is running. Wait for it to finish before restoring.",
            },
            409,
          );
        restoring = true;
        const wasPaused = worker.paused;
        worker.paused = true;
        try {
          return json(store.restore(await request.json()));
        } finally {
          worker.paused = wasPaused;
          restoring = false;
        }
      }
      return json({ error: "Not found." }, 404);
    } catch (error) {
      if (error instanceof BackupFileError)
        return json({ error: error.message }, error.status);
      if (error instanceof TrashError)
        return json({ error: error.message }, 409);
      if (error instanceof QueueError || error instanceof ListError)
        return json({ error: error.message }, error.status);
      if (error instanceof z.ZodError)
        return json(
          {
            error: error.issues
              .map((i) => `${i.path.join(".")}: ${i.message}`)
              .slice(0, 5)
              .join("; "),
          },
          400,
        );
      console.error("[api]", error);
      return json(
        { error: error instanceof Error ? error.message : "Unexpected error." },
        400,
      );
    }
  };
}
