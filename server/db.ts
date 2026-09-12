import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  backupSchema,
  listName,
  type Link,
  type SavedList,
  type ListMembership,
  type Settings,
  type Suggestion,
} from "./schema";
import { normalizeUrl } from "./urls";
import { config } from "./config";
import { backupDirectory, listBackups } from "./backup-files";
import { moveBackupDirectory } from "./backup-directory";
import type { JobKind, QueueJob } from "./queue-types";

export class QueueError extends Error {
  constructor(
    message: string,
    public status: 404 | 409,
  ) {
    super(message);
  }
}
export class ListError extends Error {
  constructor(
    message: string,
    public status: 404 | 409,
  ) {
    super(message);
  }
}

export class TrashError extends Error {}

export type Job = {
  id: number;
  kind: JobKind;
  link_id: string | null;
  attempts: number;
  state: string;
  error: string | null;
  available_at: number;
  created_at: string;
  priority: number;
};
export class Store {
  db: Database;
  constructor(public dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new Database(join(dir, "braindump.sqlite"), { create: true });
    const version = (
      this.db.query("PRAGMA user_version").get() as { user_version: number }
    ).user_version;
    if (version > 3) {
      this.db.close();
      throw new Error(
        `Database version ${version} is newer than this app supports. Use the newer app; do not reset the library.`,
      );
    }
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS links (id TEXT PRIMARY KEY, url TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tags (name TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS link_tags (link_id TEXT REFERENCES links(id) ON DELETE CASCADE, tag TEXT REFERENCES tags(name), PRIMARY KEY(link_id,tag));
      CREATE TABLE IF NOT EXISTS aliases (source TEXT PRIMARY KEY, target TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS suggestions (id TEXT PRIMARY KEY, source TEXT NOT NULL, target TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL, UNIQUE(source,target));
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, link_id TEXT REFERENCES links(id) ON DELETE CASCADE, state TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0, error TEXT, available_at INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS active_job ON jobs(kind, COALESCE(link_id,'')) WHERE state IN ('queued','running');
      CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(id UNINDEXED, title, url, summary, content, tags, tokenize='unicode61 remove_diacritics 2');`);
    if (version < 2)
      this.db.transaction(() => {
        // Both new stores and existing v1 stores retain FIFO order until a user promotes a job.
        this.db.exec(
          "ALTER TABLE jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 0; CREATE INDEX jobs_dispatch ON jobs(state, priority DESC, id); PRAGMA user_version=2;",
        );
      })();
    if (version < 3)
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS lists (id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS list_links (list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE, link_id TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE, PRIMARY KEY(list_id,link_id));
          CREATE INDEX IF NOT EXISTS list_links_by_link ON list_links(link_id,list_id);
          PRAGMA user_version=3;
        `);
      })();
    this.db.run("UPDATE jobs SET state='queued' WHERE state='running'");
  }
  getMeta<T>(key: string, fallback: T): T {
    const row = this.db
      .query("SELECT value FROM meta WHERE key=?")
      .get(key) as { value: string } | null;
    return row ? JSON.parse(row.value) : fallback;
  }
  setMeta(key: string, value: unknown) {
    this.db.run("INSERT OR REPLACE INTO meta VALUES (?,?)", [
      key,
      JSON.stringify(value),
    ]);
  }
  settings(): Settings {
    return this.getMeta("settings", {
      model: config.model,
      tagReviewHours: config.tagHours,
      backupHours: config.backupHours,
    });
  }
  get(id: string): Link | null {
    const row = this.db.query("SELECT data FROM links WHERE id=?").get(id) as {
      data: string;
    } | null;
    return row ? JSON.parse(row.data) : null;
  }
  all(): Link[] {
    return (
      this.db.query("SELECT data FROM links ORDER BY rowid DESC").all() as {
        data: string;
      }[]
    ).map((r) => JSON.parse(r.data));
  }
  lists(): (SavedList & { count: number })[] {
    return this.db
      .query(
        `SELECT l.id,l.name,l.created_at AS createdAt,
      COUNT(CASE WHEN json_extract(links.data,'$.deleted')=0 THEN 1 END) AS count
      FROM lists l LEFT JOIN list_links ll ON ll.list_id=l.id
      LEFT JOIN links ON links.id=ll.link_id GROUP BY l.id ORDER BY l.name_key,l.id`,
      )
      .all() as (SavedList & { count: number })[];
  }
  requireList(id: string): SavedList {
    const list = this.db
      .query("SELECT id,name,created_at AS createdAt FROM lists WHERE id=?")
      .get(id) as SavedList | null;
    if (!list) throw new ListError("List not found. Refresh your lists.", 404);
    return list;
  }
  private checkListName(name: string, id = "") {
    if (
      this.db
        .query("SELECT id FROM lists WHERE name_key=? AND id<>?")
        .get(name.toLowerCase(), id)
    )
      throw new ListError("A list with this name already exists.", 409);
  }
  createList(input: string): SavedList {
    const name = listName.parse(input);
    this.checkListName(name);
    const list = {
      id: crypto.randomUUID(),
      name,
      createdAt: new Date().toISOString(),
    };
    this.db.run("INSERT INTO lists VALUES (?,?,?,?)", [
      list.id,
      name,
      name.toLowerCase(),
      list.createdAt,
    ]);
    return list;
  }
  renameList(id: string, input: string): SavedList {
    const list = this.requireList(id);
    const name = listName.parse(input);
    this.checkListName(name, id);
    this.db.run("UPDATE lists SET name=?,name_key=? WHERE id=?", [
      name,
      name.toLowerCase(),
      id,
    ]);
    return { ...list, name };
  }
  deleteList(id: string) {
    this.requireList(id);
    this.db.run("DELETE FROM lists WHERE id=?", [id]);
  }
  linkLists(linkId: string): string[] {
    if (!this.get(linkId)) throw new ListError("Link not found.", 404);
    return (
      this.db
        .query(
          "SELECT list_id FROM list_links WHERE link_id=? ORDER BY list_id",
        )
        .all(linkId) as { list_id: string }[]
    ).map((row) => row.list_id);
  }
  setMembership(listId: string, linkId: string, included: boolean) {
    this.requireList(listId);
    if (!this.get(linkId)) throw new ListError("Link not found.", 404);
    this.db.run(
      included
        ? "INSERT OR IGNORE INTO list_links VALUES (?,?)"
        : "DELETE FROM list_links WHERE list_id=? AND link_id=?",
      [listId, linkId],
    );
  }
  canonical(tag: string) {
    let value = tag;
    const seen = new Set<string>();
    while (!seen.has(value)) {
      seen.add(value);
      const alias = this.db
        .query("SELECT target FROM aliases WHERE source=?")
        .get(value) as { target: string } | null;
      if (!alias) return value;
      value = alias.target;
    }
    throw new Error("Circular tag alias");
  }
  save(link: Link) {
    this.db.transaction(() => {
      link.tags = [
        ...new Set(
          link.tags
            .map((t) => this.canonical(t.trim().toLowerCase()))
            .filter(Boolean),
        ),
      ];
      this.db.run(
        "INSERT INTO links VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET url=excluded.url,data=excluded.data",
        [link.id, link.url, JSON.stringify(link)],
      );
      this.db.run("DELETE FROM link_tags WHERE link_id=?", [link.id]);
      for (const tag of link.tags) {
        this.db.run("INSERT OR IGNORE INTO tags VALUES (?)", [tag]);
        this.db.run("INSERT INTO link_tags VALUES (?,?)", [link.id, tag]);
      }
      this.db.run("DELETE FROM search WHERE id=?", [link.id]);
      this.db.run("INSERT INTO search VALUES (?,?,?,?,?,?)", [
        link.id,
        link.title,
        link.url,
        link.summary,
        link.content,
        link.tags.join(" "),
      ]);
    })();
  }
  add(url: string) {
    const existing = this.db
      .query("SELECT id FROM links WHERE url=?")
      .get(url) as { id: string } | null;
    if (existing) return { id: existing.id, duplicate: true };
    const now = new Date().toISOString();
    const link: Link = {
      id: crypto.randomUUID(),
      url,
      title: new URL(url).hostname.replace(/^www\./, ""),
      description: "",
      content: "",
      summary: "",
      highlights: [],
      tags: [],
      read: false,
      liked: false,
      archived: false,
      deleted: false,
      state: "queued",
      error: null,
      method: null,
      model: null,
      createdAt: now,
      updatedAt: now,
      summarizedAt: null,
    };
    this.db.transaction(() => {
      this.save(link);
      this.enqueue("process", link.id);
    })();
    return { id: link.id, duplicate: false };
  }
  update(id: string, patch: Partial<Link>) {
    const link = this.get(id);
    if (!link) throw new Error("Link not found");
    const next = { ...link, ...patch, id, updatedAt: new Date().toISOString() };
    this.save(next);
    return next;
  }
  trashPreview() {
    const links = this.db
      .query(
        `SELECT id, EXISTS(SELECT 1 FROM jobs WHERE link_id=links.id AND state='running') AS running
        FROM links WHERE json_extract(data,'$.deleted')=1 ORDER BY id`,
      )
      .all() as { id: string; running: number }[];
    return {
      count: links.length,
      running: links.filter((link) => link.running).length,
      token: createHash("sha256")
        .update(JSON.stringify(links.map((link) => link.id)))
        .digest("hex"),
    };
  }
  emptyTrash(token: string) {
    return this.db.transaction(() => {
      const preview = this.trashPreview();
      if (token !== preview.token)
        throw new TrashError(
          "Trash has changed. Review the current count before emptying it.",
        );
      if (preview.running)
        throw new TrashError(
          "A link in Trash is still processing. Wait for it to finish, then try again.",
        );
      if (!preview.count) return { deleted: 0, backup: null };
      // A failed snapshot or deletion rolls back the operation; no async work occurs here.
      const backup = this.backup("before-empty-trash");
      // Check each statement separately so a later failure propagates to rollback.
      this.db.run(
        "DELETE FROM search WHERE id IN (SELECT id FROM links WHERE json_extract(data,'$.deleted')=1)",
      );
      this.db.run(
        "DELETE FROM meta WHERE key IN (SELECT 'analysis:' || id FROM links WHERE json_extract(data,'$.deleted')=1)",
      );
      this.db.run("DELETE FROM links WHERE json_extract(data,'$.deleted')=1");
      // Foreign keys remove link tags, list memberships and queued/historical jobs.
      return { deleted: preview.count, backup };
    })();
  }
  list(params: URLSearchParams) {
    const query = params.get("q")?.trim() || "";
    const where: string[] = [];
    const args: (string | number)[] = [];
    const terms = query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 20) || [];
    if (terms.length) {
      where.push("l.id IN (SELECT id FROM search WHERE search MATCH ?)");
      args.push(terms.map((t) => `"${t}"*`).join(" AND "));
    }
    for (const field of ["read", "liked", "archived", "deleted"] as const) {
      const value = params.get(field);
      if (value === "true" || value === "false") {
        where.push(`json_extract(data,'$.${field}')=?`);
        args.push(value === "true" ? 1 : 0);
      }
    }
    if (params.get("tag")) {
      where.push("l.id IN (SELECT link_id FROM link_tags WHERE tag=?)");
      args.push(params.get("tag")!);
    }
    if (params.get("list")) {
      this.requireList(params.get("list")!);
      where.push("l.id IN (SELECT link_id FROM list_links WHERE list_id=?)");
      args.push(params.get("list")!);
    }
    if (params.get("state")) {
      where.push("json_extract(data,'$.state')=?");
      args.push(params.get("state")!);
    }
    const filter = where.length ? ` WHERE ${where.join(" AND ")}` : "";
    const total = (
      this.db
        .query("SELECT count(*) AS n FROM links l" + filter)
        .get(...args) as { n: number }
    ).n;
    const page = Math.max(1, Math.floor(Number(params.get("page")) || 1));
    const sort =
      params.get("sort") === "oldest"
        ? "json_extract(data,'$.createdAt') ASC"
        : params.get("sort") === "title"
          ? "json_extract(data,'$.title') COLLATE NOCASE ASC"
          : "json_extract(data,'$.createdAt') DESC";
    const rows = this.db
      .query(
        `SELECT data FROM links l${filter} ORDER BY ${sort} LIMIT 30 OFFSET ?`,
      )
      .all(...args, (page - 1) * 30) as { data: string }[];
    return {
      links: rows.map((r) => {
        const l = JSON.parse(r.data);
        const { content, ...rest } = l;
        return {
          ...rest,
          wordCount: content.split(/\s+/).filter(Boolean).length,
        };
      }),
      total,
      page,
      pages: Math.ceil(total / 30),
    };
  }
  tags() {
    return this.db
      .query(
        "SELECT t.tag AS name, count(*) AS count FROM link_tags t JOIN links l ON l.id=t.link_id WHERE json_extract(l.data,'$.deleted')=0 GROUP BY t.tag ORDER BY count DESC,t.tag",
      )
      .all() as { name: string; count: number }[];
  }
  counts() {
    return this.db
      .query(
        `SELECT
    COALESCE(SUM(NOT json_extract(data,'$.deleted') AND NOT json_extract(data,'$.archived')),0) AS 'all',
    COALESCE(SUM(NOT json_extract(data,'$.deleted') AND NOT json_extract(data,'$.archived') AND NOT json_extract(data,'$.read')),0) AS unread,
    COALESCE(SUM(NOT json_extract(data,'$.deleted') AND NOT json_extract(data,'$.archived') AND json_extract(data,'$.liked')),0) AS liked,
    COALESCE(SUM(NOT json_extract(data,'$.deleted') AND json_extract(data,'$.archived')),0) AS archived,
    COALESCE(SUM(NOT json_extract(data,'$.deleted') AND json_extract(data,'$.state')='error'),0) AS attention,
    COALESCE(SUM(json_extract(data,'$.deleted')),0) AS deleted FROM links`,
      )
      .get();
  }
  queueStatus() {
    return this.db
      .query(
        "SELECT count(*) AS activeJobs, COALESCE(SUM(kind='tags'),0) AS tagReviewPending FROM jobs WHERE state IN ('queued','running')",
      )
      .get() as { activeJobs: number; tagReviewPending: number };
  }
  enqueue(kind: Job["kind"], id: string | null = null) {
    this.db.run(
      "INSERT OR IGNORE INTO jobs(kind,link_id,created_at) VALUES (?,?,?)",
      [kind, id, new Date().toISOString()],
    );
  }
  claim(): Job | null {
    return this.db.transaction(() => {
      const job = this.db
        .query(
          "SELECT * FROM jobs WHERE state='queued' AND available_at<=? ORDER BY priority DESC, id ASC LIMIT 1",
        )
        .get(Date.now()) as Job | null;
      if (job)
        this.db.run(
          "UPDATE jobs SET state='running',attempts=attempts+1 WHERE id=?",
          [job.id],
        );
      return job ? { ...job, attempts: job.attempts + 1 } : null;
    })();
  }
  jobs() {
    return this.db
      .query("SELECT * FROM jobs ORDER BY id DESC LIMIT 50")
      .all() as Job[];
  }
  queue(page = 1, search = "", now = Date.now()) {
    const fields = `j.id, j.kind, j.link_id AS linkId, j.state, j.attempts, j.error,
      j.available_at AS availableAt, j.created_at AS createdAt, j.priority,
      CASE WHEN j.kind='tags' THEN 'Tag consolidation review' ELSE json_extract(l.data,'$.title') END AS title,
      l.url, json_extract(l.data,'$.state') AS linkState, COALESCE(json_extract(l.data,'$.deleted'),0) AS deleted`;
    const eligible =
      "j.state='queued' AND (j.link_id IS NULL OR json_extract(l.data,'$.deleted')=0)";
    const pattern = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
    return this.db.transaction(() => {
      const running = this.db
        .query(
          `SELECT ${fields}, 0 AS position FROM jobs j LEFT JOIN links l ON l.id=j.link_id WHERE j.state='running' ORDER BY j.id`,
        )
        .all() as QueueJob[];
      const counts = this.db
        .query(
          `SELECT COUNT(*) AS waitingTotal, COALESCE(SUM(j.available_at>?),0) AS retrying FROM jobs j LEFT JOIN links l ON l.id=j.link_id WHERE ${eligible}`,
        )
        .get(now) as { waitingTotal: number; retrying: number };
      const ordered = `WITH ordered AS (
        SELECT ${fields}, ROW_NUMBER() OVER (ORDER BY
          CASE WHEN j.available_at<=? THEN 0 ELSE 1 END,
          CASE WHEN j.available_at>? THEN j.available_at ELSE 0 END,
          j.priority DESC, j.id ASC) AS position
        FROM jobs j LEFT JOIN links l ON l.id=j.link_id WHERE ${eligible}
      )`;
      const filter =
        " WHERE title LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\'";
      const total = (
        this.db
          .query(`${ordered} SELECT COUNT(*) AS n FROM ordered${filter}`)
          .get(now, now, pattern, pattern) as { n: number }
      ).n;
      const pages = Math.ceil(total / 50);
      const currentPage = Math.min(Math.max(1, page), Math.max(1, pages));
      const waiting = this.db
        .query(
          `${ordered} SELECT * FROM ordered${filter} ORDER BY position LIMIT 50 OFFSET ?`,
        )
        .all(now, now, pattern, pattern, (currentPage - 1) * 50) as QueueJob[];
      return { running, waiting, ...counts, total, page: currentPage, pages };
    })();
  }
  promoteJob(id: number) {
    return this.db.transaction(() => {
      const job = this.db
        .query("SELECT * FROM jobs WHERE id=?")
        .get(id) as Job | null;
      if (!job) throw new QueueError("Job not found. Refresh the queue.", 404);
      if (job.state !== "queued")
        throw new QueueError(
          "This job has already started or finished. Refresh the queue.",
          409,
        );
      if (job.link_id && this.get(job.link_id)?.deleted)
        throw new QueueError(
          "Restore this link from Trash before prioritizing it.",
          409,
        );
      const highest = (
        this.db
          .query(
            "SELECT COALESCE(MAX(priority),0) AS n FROM jobs WHERE state IN ('queued','running')",
          )
          .get() as { n: number }
      ).n;
      this.db.run("UPDATE jobs SET priority=?,available_at=0 WHERE id=?", [
        highest + 1,
        id,
      ]);
      return { id, priority: highest + 1 };
    })();
  }
  suggestions(): Suggestion[] {
    return this.db
      .query("SELECT * FROM suggestions WHERE status='pending'")
      .all() as Suggestion[];
  }
  suggest(source: string, target: string, reason: string) {
    if (source === target) return;
    this.db.run(
      "INSERT OR IGNORE INTO suggestions VALUES (?,?,?,?,'pending')",
      [crypto.randomUUID(), source, target, reason],
    );
  }
  merge(source: string, target: string) {
    target = this.canonical(target);
    if (source === target)
      throw new Error("These tags already have the same name.");
    const affected = this.all().filter((l) => l.tags.includes(source));
    if (!affected.length)
      throw new Error("The source tag is no longer in use.");
    this.db.transaction(() => {
      this.db.run("INSERT OR REPLACE INTO aliases VALUES (?,?)", [
        source,
        target,
      ]);
      for (const link of affected)
        this.update(link.id, {
          tags: link.tags.map((t) => (t === source ? target : t)),
        });
      this.db.run(
        "UPDATE suggestions SET status='accepted' WHERE source=? OR target=?",
        [source, source],
      );
    })();
    return affected.length;
  }
  export() {
    return {
      format: "braindump",
      version: 2,
      exportedAt: new Date().toISOString(),
      links: this.all(),
      settings: this.settings(),
      aliases: this.db.query("SELECT * FROM aliases").all(),
      suggestions: this.db.query("SELECT * FROM suggestions").all(),
      lists: this.lists().map(({ id, name, createdAt }) => ({
        id,
        name,
        createdAt,
      })),
      memberships: this.db
        .query(
          "SELECT list_id AS listId,link_id AS linkId FROM list_links ORDER BY list_id,link_id",
        )
        .all() as ListMembership[],
    };
  }
  backupDirectory(): string {
    return this.getMeta("backupDirectory", resolve(this.dir, "backups"));
  }
  moveBackups(input: unknown) {
    return moveBackupDirectory(this.backupDirectory(), input, (directory) => {
      this.setMeta("backupDirectory", directory);
    });
  }
  backup(prefix = "auto") {
    const dir = this.backupDirectory();
    backupDirectory(dir, true);
    const name = `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 6)}.json`;
    writeFileSync(join(dir, name), JSON.stringify(this.export()), {
      mode: 0o600,
      flag: "wx",
    });
    if (prefix === "auto")
      for (const old of listBackups(dir)
        .map((backup) => backup.name)
        .filter((n) => n.startsWith("auto-"))
        .sort()
        .slice(0, -14))
        unlinkSync(join(dir, old));
    return name;
  }
  restore(input: unknown) {
    const snapshot = backupSchema.parse(input);
    const ids = new Set<string>();
    const urls = new Set<string>();
    const aliasMap = new Map(snapshot.aliases.map((a) => [a.source, a.target]));
    for (const l of snapshot.links) {
      l.url = normalizeUrl(l.url);
      if (ids.has(l.id) || urls.has(l.url))
        throw new Error("Backup contains duplicate links.");
      ids.add(l.id);
      urls.add(l.url);
    }
    for (const source of aliasMap.keys()) {
      const seen = new Set<string>();
      let current = source;
      while (aliasMap.has(current)) {
        if (seen.has(current))
          throw new Error("Backup contains circular tag aliases.");
        seen.add(current);
        current = aliasMap.get(current)!;
      }
    }
    const safetyBackup = this.backup("before-restore");
    const localBackupDirectory = this.backupDirectory();
    this.db.transaction(() => {
      // Bun can swallow an intermediate failure in a multi-statement exec.
      // Execute each deletion separately so the transaction always rolls back.
      for (const table of [
        "jobs",
        "list_links",
        "lists",
        "link_tags",
        "links",
        "search",
        "tags",
        "aliases",
        "suggestions",
        "meta",
      ])
        this.db.run(`DELETE FROM ${table}`);
      this.setMeta("settings", snapshot.settings);
      this.setMeta("backupDirectory", localBackupDirectory);
      for (const a of snapshot.aliases)
        this.db.run("INSERT INTO aliases VALUES (?,?)", [a.source, a.target]);
      for (const l of snapshot.links) {
        const interrupted = ["queued", "extracting", "summarizing"].includes(
          l.state,
        );
        this.save(interrupted ? { ...l, state: "queued" } : l);
        if (interrupted && !l.deleted)
          this.enqueue(l.content ? "analyze" : "process", l.id);
      }
      for (const s of snapshot.suggestions)
        this.db.run("INSERT INTO suggestions VALUES (?,?,?,?,?)", [
          s.id,
          s.source,
          s.target,
          s.reason,
          s.status,
        ]);
      if (snapshot.version === 2) {
        for (const list of snapshot.lists)
          this.db.run("INSERT INTO lists VALUES (?,?,?,?)", [
            list.id,
            list.name,
            list.name.toLowerCase(),
            list.createdAt,
          ]);
        for (const membership of snapshot.memberships)
          this.db.run("INSERT INTO list_links VALUES (?,?)", [
            membership.listId,
            membership.linkId,
          ]);
      }
    })();
    return { restored: snapshot.links.length, safetyBackup };
  }
}
