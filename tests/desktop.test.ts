import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { acquireLibraryLock } from "../server/library-lock";
import { runtimePaths } from "../server/runtime-paths";
import { desktopSession } from "../server/desktop-session";
import { runExtractor } from "../server/extract";
import { Store } from "../server/db";

const root = resolve(import.meta.dir, "..");
const directories: string[] = [];
function temporary() {
  const dir = mkdtempSync(join(tmpdir(), "braindump-desktop-"));
  directories.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of directories.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

test("desktop paths separate immutable resources, library, caches and logs", () => {
  const paths = runtimePaths(
    { BRAINDUMP_DESKTOP: "1" },
    "/Users/example",
    "/source",
    "/Applications/Braindump.app/Contents/MacOS/braindump",
  );
  expect(paths.dataDir).toBe(
    "/Users/example/Library/Application Support/Braindump",
  );
  expect(paths.extractor).toBe(
    "/Applications/Braindump.app/Contents/Resources/runtime/scraper/braindump-extractor",
  );
  expect(paths.dist).toBe("/Applications/Braindump.app/Contents/Resources/web");
  expect(paths.cacheDir).toBe("/Users/example/Library/Caches/Braindump");
  expect(runtimePaths({}, "/Users/example", "/source").dataDir).toBe(
    "/source/data",
  );
  expect(
    runtimePaths({ DATA_DIR: "/isolated" }, "/Users/example", "/source")
      .dataDir,
  ).toBe("/isolated");
  expect(() =>
    runtimePaths({ BRAINDUMP_DESKTOP: "1", BRAINDUMP_RESOURCES: "relative" }),
  ).toThrow("absolute");
});

test("library lock excludes aliases and releases without deleting its marker", () => {
  const dir = temporary();
  const data = join(dir, "data");
  const release = acquireLibraryLock(data);
  symlinkSync(data, join(dir, "alias"));
  try {
    expect(() => acquireLibraryLock(join(dir, "alias"))).toThrow(
      "already open",
    );
  } finally {
    release();
    release();
  }
  acquireLibraryLock(data)();
});

test("library lock rejects a symlink marker without touching its target", async () => {
  const dir = temporary();
  const target = join(dir, "protected");
  writeFileSync(target, "untouched");
  symlinkSync(target, join(dir, ".worker.lock"));
  expect(() => acquireLibraryLock(dir)).toThrow();
  expect(await Bun.file(target).text()).toBe("untouched");
});

test("a second startup on another port cannot recover jobs and a crashed owner releases its lock", async () => {
  const dir = temporary();
  const store = new Store(dir);
  store.add("https://example.com/packaging");
  store.db.run("UPDATE jobs SET state='running',attempts=2");
  const owner = Bun.spawn(
    [process.execPath, "tests/fixtures/library-lock.ts"],
    {
      cwd: root,
      env: { ...process.env, LOCK_DIRECTORY: dir },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  try {
    const reader = owner.stdout.getReader();
    const ready = await reader.read();
    reader.releaseLock();
    expect(Buffer.from(ready.value || []).toString()).toContain("locked");
    const duplicate = Bun.spawn([process.execPath, "server/index.ts"], {
      cwd: root,
      env: { ...process.env, DATA_DIR: dir, PORT: "0" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await duplicate.exited).not.toBe(0);
    expect(await new Response(duplicate.stderr).text()).toContain(
      "already open",
    );
    expect(store.db.query("SELECT state,attempts FROM jobs").get()).toEqual({
      state: "running",
      attempts: 2,
    });
  } finally {
    owner.kill("SIGKILL");
    await owner.exited;
    store.db.close();
  }
  acquireLibraryLock(dir)();
}, 10_000);

test("desktop session protects reads, writes and downloads without broadening origins", () => {
  const token = "a".repeat(64);
  const authorize = desktopSession(token);
  const request = (path: string, headers: Record<string, string> = {}) =>
    new Request(`http://127.0.0.1:3210${path}`, { headers });
  expect(authorize(request("/api/backup"))?.status).toBe(401);
  expect(
    authorize(
      request("/api/backup", { cookie: `braindump-session=${"é".repeat(64)}` }),
    )?.status,
  ).toBe(401);
  const bootstrap = authorize(request(`/__desktop/${token}`));
  expect(bootstrap?.status).toBe(303);
  expect(bootstrap?.headers.get("set-cookie")).toContain(
    "HttpOnly; SameSite=Strict",
  );
  const cookie = `braindump-session=${token}`;
  expect(authorize(request("/api/links", { cookie }))).toBeNull();
  expect(
    authorize(request("/api/links", { cookie, origin: "https://example.com" }))
      ?.status,
  ).toBe(403);
  expect(
    authorize(request("/api/links", { cookie, "sec-fetch-site": "cross-site" }))
      ?.status,
  ).toBe(403);
  expect(
    desktopSession("b".repeat(64))(request("/api/links", { cookie }))?.status,
  ).toBe(401);
});

test("an extraction timeout terminates a resistant subprocess and its descendants", async () => {
  const dir = temporary();
  const pidFile = join(dir, "pid");
  const script = `const child=Bun.spawn([process.execPath,"-e","setInterval(()=>{},1000)"],{stdout:"inherit",stderr:"inherit"}); await Bun.write(process.env.PID_FILE,String(child.pid)); process.on("SIGTERM",()=>{}); setInterval(()=>{},1000);`;
  expect(
    await runExtractor(
      [process.execPath, "-e", script],
      { ...process.env, PID_FILE: pidFile },
      500,
    ).then(
      () => null,
      (error: unknown) => error,
    ),
  ).toBeInstanceOf(Error);
  const pid = Number(await Bun.file(pidFile).text());
  // Allow the OS to reap the grandchild after killing the entire owned group.
  let alive = true;
  for (let i = 0; i < 40 && alive; i++) {
    try {
      process.kill(pid, 0);
      await Bun.sleep(25);
    } catch {
      alive = false;
    }
  }
  expect(alive).toBe(false);
}, 10_000);
