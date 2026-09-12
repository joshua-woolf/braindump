import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as os from "node:os";
import { join } from "node:path";
import { Store } from "../server/db";
import { Worker } from "../server/worker";
import { createApi } from "../server/api";
import { listBackups, readBackup } from "../server/backup-files";
import { backupSchema } from "../server/schema";

let dir: string;
let store: Store;
beforeEach(() => {
  dir = fs.mkdtempSync(join(tmpdir(), "braindump-backup-directory-"));
  store = new Store(dir);
  store.setMeta("settings", {
    model: "test",
    tagReviewHours: 0,
    backupHours: 0,
  });
});
afterEach(() => {
  store.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
function request(path: string, method = "GET", body?: unknown) {
  return new Request(`http://127.0.0.1:3210/api${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const move = (directory: string) =>
  request("/settings/backup-directory", "PUT", { directory });

test("changing the folder moves every visible backup with exact bytes and dates and preserves unrelated files", async () => {
  const { id } = store.add("https://example.com/kept");
  store.update(id, { title: "original TITLE", liked: true, deleted: true });
  const list = store.createList("Reading");
  store.setMembership(list.id, id, true);
  store.setMeta("lastBackup", 123);
  const names = [
    store.backup("manual"),
    store.backup("auto"),
    store.backup("before-restore"),
  ];
  const previous = store.backupDirectory();
  fs.writeFileSync(
    join(previous, "custom.JSON"),
    Buffer.alloc(2 * 1024 * 1024 + 19, 65),
  );
  names.push("custom.JSON");
  fs.writeFileSync(join(previous, "notes.txt"), "Keep me");
  fs.writeFileSync(join(previous, ".hidden.json"), "Keep me too");
  fs.mkdirSync(join(previous, "folder.json"));
  fs.symlinkSync(join(previous, "notes.txt"), join(previous, "alias.json"));
  const bytes = names.map((name, i) => {
    fs.utimesSync(join(previous, name), i + 1, i + 1);
    return fs.readFileSync(join(previous, name));
  });
  const snapshot = store.export();
  const jobs = store.jobs();
  const worker = new Worker(store);
  worker.busy = true;
  const api = createApi(store, worker);
  expect(
    (await (await api(request("/settings/backup-directory"))).json()).directory,
  ).toBe(previous);
  const destination = join(dir, "elsewhere", "new backups");
  const response = await api(move(destination));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    directory: fs.realpathSync(destination),
    moved: names.length,
    leftBehind: [],
  });
  expect(fs.readdirSync(previous).sort()).toEqual([
    ".hidden.json",
    "alias.json",
    "folder.json",
    "notes.txt",
  ]);
  for (const [i, name] of names.entries()) {
    expect(readBackup(store.backupDirectory(), name)).toEqual(bytes[i]);
    expect(fs.statSync(join(destination, name)).mtimeMs).toBe((i + 1) * 1000);
    expect(fs.statSync(join(destination, name)).mode & 0o777).toBe(0o600);
  }
  expect((await (await api(request("/backups"))).json()).backups).toHaveLength(
    4,
  );
  expect(await (await api(request(`/backups/${names[0]}`))).bytes()).toEqual(
    new Uint8Array(bytes[0]),
  );
  const afterMove = store.export();
  expect(afterMove).toEqual({
    ...snapshot,
    exportedAt: afterMove.exportedAt,
  });
  expect(store.jobs()).toEqual(jobs);
  expect(store.getMeta("lastBackup", 0)).toBe(123);
  expect(worker.busy).toBe(true);
  store.db.close();
  store = new Store(dir);
  expect(store.backupDirectory()).toBe(fs.realpathSync(destination));
  const next = store.backup("manual");
  expect(fs.existsSync(join(destination, next))).toBe(true);
  expect(fs.existsSync(join(previous, next))).toBe(false);
});

test("empty folders can be changed and selecting the same folder is a no-op", () => {
  const destination = join(dir, "empty");
  expect(store.moveBackups({ directory: destination })).toEqual({
    directory: fs.realpathSync(destination),
    moved: 0,
    leftBehind: [],
  });
  const file = store.backup();
  expect(
    store.moveBackups({ directory: destination + "/../empty/" }).moved,
  ).toBe(0);
  expect(listBackups(store.backupDirectory())[0].name).toBe(file);
});

test("home-relative paths resolve on the server and preserve unrelated destination files", () => {
  const name = store.backup("manual");
  const home = spyOn(os, "homedir").mockReturnValue(dir);
  fs.mkdirSync(join(dir, "home-backups"));
  fs.writeFileSync(join(dir, "home-backups", "existing.json"), "Preserved");
  try {
    expect(
      store.moveBackups({ directory: "  ~/home-backups  " }).directory,
    ).toBe(fs.realpathSync(join(dir, "home-backups")));
  } finally {
    home.mockRestore();
  }
  expect(
    fs.readFileSync(join(store.backupDirectory(), "existing.json"), "utf8"),
  ).toBe("Preserved");
  expect(fs.existsSync(join(store.backupDirectory(), name))).toBe(true);
});

test("destination conflicts preserve both originals and existing destination files", async () => {
  const first = store.backup("manual");
  const second = store.backup("manual");
  const previous = store.backupDirectory();
  const destination = join(dir, "conflict");
  fs.mkdirSync(destination);
  fs.writeFileSync(join(destination, second), "Do not overwrite");
  const api = createApi(store, new Worker(store));
  expect((await api(move(destination))).status).toBe(409);
  expect(store.backupDirectory()).toBe(previous);
  expect(
    listBackups(previous)
      .map((backup) => backup.name)
      .sort(),
  ).toEqual([first, second].sort());
  expect(fs.readdirSync(destination)).toEqual([second]);
  expect(fs.readFileSync(join(destination, second), "utf8")).toBe(
    "Do not overwrite",
  );
});

test("copy failures and settings commit failures leave all original backups and roll back copied files", () => {
  const name = store.backup("manual");
  const previous = store.backupDirectory();
  const bytes = readBackup(previous, name);
  const destination = join(dir, "failed");
  const write = spyOn(fs, "writeSync").mockImplementationOnce(() => {
    throw new Error("Disk full fixture");
  });
  try {
    expect(() => store.moveBackups({ directory: destination })).toThrow(
      "Disk full fixture",
    );
  } finally {
    write.mockRestore();
  }
  expect(fs.readdirSync(destination)).toEqual([]);
  expect(store.backupDirectory()).toBe(previous);
  expect(readBackup(previous, name)).toEqual(bytes);
  store.db.run(
    "CREATE TRIGGER block_path BEFORE INSERT ON meta WHEN NEW.key='backupDirectory' BEGIN SELECT RAISE(ABORT,'Path commit failed'); END;",
  );
  expect(() => store.moveBackups({ directory: destination })).toThrow(
    "Path commit failed",
  );
  expect(store.backupDirectory()).toBe(previous);
  expect(fs.readdirSync(destination)).toEqual([]);
  expect(readBackup(previous, name)).toEqual(bytes);
});

test("a source cleanup failure retains a complete destination and reports the undeleted original", () => {
  const name = store.backup("manual");
  const oldFile = join(store.backupDirectory(), name);
  const destination = join(dir, "cleanup");
  const unlink = fs.unlinkSync;
  const remove = spyOn(fs, "unlinkSync").mockImplementation((path) => {
    if (path === fs.realpathSync(oldFile))
      throw new Error("Cannot delete fixture");
    return unlink(path);
  });
  try {
    expect(store.moveBackups({ directory: destination })).toEqual({
      directory: fs.realpathSync(destination),
      moved: 0,
      leftBehind: [fs.realpathSync(oldFile)],
    });
  } finally {
    remove.mockRestore();
  }
  expect(store.backupDirectory()).toBe(fs.realpathSync(destination));
  expect(fs.readFileSync(join(destination, name))).toEqual(
    fs.readFileSync(oldFile),
  );
});

test("a source edited during copying is preserved and prevents committing the new folder", () => {
  const name = store.backup("manual");
  const previous = store.backupDirectory();
  const destination = join(dir, "changed-source");
  const timestamps = fs.futimesSync;
  const change = spyOn(fs, "futimesSync").mockImplementation(
    (fd, atime, mtime) => {
      timestamps(fd, atime, mtime);
      fs.writeFileSync(join(previous, name), "External edit fixture");
    },
  );
  try {
    expect(() => store.moveBackups({ directory: destination })).toThrow(
      "backup changed",
    );
  } finally {
    change.mockRestore();
  }
  expect(store.backupDirectory()).toBe(previous);
  expect(fs.readFileSync(join(previous, name), "utf8")).toBe(
    "External edit fixture",
  );
  expect(fs.readdirSync(destination)).toEqual([]);
});

test("failed rollback cleanup reports remaining copies while retaining the original folder", () => {
  const name = store.backup("manual");
  const previous = store.backupDirectory();
  const destination = join(dir, "rollback-cleanup");
  store.db.run(
    "CREATE TRIGGER block_path BEFORE INSERT ON meta WHEN NEW.key='backupDirectory' BEGIN SELECT RAISE(ABORT,'Path commit failed'); END;",
  );
  const unlink = fs.unlinkSync;
  const remove = spyOn(fs, "unlinkSync").mockImplementation((path) => {
    if (String(path).endsWith(name)) throw new Error("Cleanup failed fixture");
    unlink(path);
  });
  try {
    expect(() => store.moveBackups({ directory: destination })).toThrow(
      "all originals are safe",
    );
  } finally {
    remove.mockRestore();
  }
  expect(store.backupDirectory()).toBe(previous);
  expect(fs.readFileSync(join(destination, name))).toEqual(
    fs.readFileSync(join(previous, name)),
  );
});

test("invalid paths and symlinks cannot change the backup folder or expose unrelated files", async () => {
  const name = store.backup("manual");
  const previous = store.backupDirectory();
  const destination = join(dir, "regular");
  fs.mkdirSync(destination);
  fs.symlinkSync(destination, join(dir, "linked"));
  fs.writeFileSync(join(dir, "file"), "Private");
  const api = createApi(store, new Worker(store));
  for (const path of [
    "",
    "relative/path",
    "~/bad\npath",
    join(dir, "linked"),
    join(dir, "file"),
    join(previous, "child"),
    dir,
  ]) {
    expect((await api(move(path))).status).toBe(400);
    expect(store.backupDirectory()).toBe(previous);
    expect(fs.existsSync(join(previous, name))).toBe(true);
  }
  fs.symlinkSync(join(previous, name), join(destination, name));
  expect((await api(move(destination))).status).toBe(409);
  const foreign = move(destination);
  foreign.headers.set("Origin", "https://foreign.example");
  expect((await api(foreign)).status).toBe(403);
  expect(
    (
      await api(
        request("/settings/backup-directory", "PUT", {
          directory: destination,
          extra: true,
        }),
      )
    ).status,
  ).toBe(400);
  const nonJson = move(destination);
  nonJson.headers.set("Content-Type", "text/plain");
  expect((await api(nonJson)).status).toBe(415);
});

test("restoring either backup version preserves the installation folder and creates its safety snapshot there", () => {
  store.add("https://example.com/saved");
  const snapshot = store.export();
  const destination = join(dir, "restores");
  store.moveBackups({ directory: destination });
  for (const version of [1, 2]) {
    const restored = store.restore({
      ...snapshot,
      version,
      settings: {
        ...snapshot.settings,
        backupDirectory: join(dir, "untrusted"),
      },
    });
    expect(store.backupDirectory()).toBe(fs.realpathSync(destination));
    expect(fs.existsSync(join(destination, restored.safetyBackup))).toBe(true);
    expect(backupSchema.parse(store.export()).settings).not.toHaveProperty(
      "backupDirectory",
    );
    expect(store.export()).not.toHaveProperty("backupDirectory");
    expect(fs.existsSync(join(dir, "untrusted"))).toBe(false);
  }
});

test("automatic retention and import safety snapshots use the configured folder", async () => {
  const manual = store.backup("manual");
  const destination = join(dir, "scheduled");
  store.moveBackups({ directory: destination });
  for (let i = 0; i < 15; i++) store.backup();
  const api = createApi(store, new Worker(store));
  const response = await api(request("/backups/before-import", "POST", {}));
  expect(response.status).toBe(201);
  const { backup } = await response.json();
  expect(backup).toStartWith("before-import-");
  const names = listBackups(store.backupDirectory()).map((file) => file.name);
  expect(names).toContain(manual);
  expect(names).toContain(backup);
  expect(names.filter((name) => name.startsWith("auto-"))).toHaveLength(14);
  expect(
    (await api(request("/backups/before-import", "POST", { directory: dir })))
      .status,
  ).toBe(400);
});

test("the import command asks the running server for a safety snapshot before importing", async () => {
  const destination = join(dir, "import-backups");
  store.moveBackups({ directory: destination });
  const urlFile = join(dir, "fixture-urls.txt");
  fs.writeFileSync(urlFile, "https://example.com/imported\n");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createApi(store, new Worker(store)),
  });
  try {
    const child = Bun.spawn([process.execPath, "scripts/import.ts", urlFile], {
      env: {
        ...process.env,
        PORT: String(server.port),
        DATA_DIR: join(dir, "wrong-data"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(stdout).toContain("1 links added and queued");
    const files = listBackups(store.backupDirectory());
    expect(files).toHaveLength(1);
    expect(files[0].name).toStartWith("before-import-");
    expect(
      JSON.parse(readBackup(store.backupDirectory(), files[0].name).toString())
        .links,
    ).toEqual([]);
    expect(store.all()).toHaveLength(1);
    expect(fs.existsSync(join(dir, "wrong-data"))).toBe(false);
  } finally {
    await server.stop(true);
  }
});
