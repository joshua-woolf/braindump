import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";

const root = resolve(import.meta.dir, "..");
const source = resolve(
  process.argv.find((arg) => arg.endsWith(".app")) ||
    join(
      root,
      ".desktop-build/target/aarch64-apple-darwin/release/bundle/macos/Braindump.app",
    ),
);
const live = process.argv.includes("--live");
const dir = mkdtempSync(join(tmpdir(), "braindump-installed-"));
const installed = join(dir, "Applications with spaces", "Braindump.app");
cpSync(source, installed, { recursive: true, verbatimSymlinks: true });
const resources = join(installed, "Contents/Resources");
const binary = join(resources, "runtime/braindump-server");
const env = {
  PATH: "/usr/bin:/bin",
  HOME: homedir(),
  TMPDIR: dir,
  BRAINDUMP_DESKTOP: "1",
  BRAINDUMP_RESOURCES: resources,
  DATA_DIR: join(dir, "library"),
  BRAINDUMP_LOG_DIR: join(dir, "logs"),
  BRAINDUMP_CACHE_DIR: join(dir, "cache"),
  PORT: "0",
  TAG_REVIEW_HOURS: "0",
  BACKUP_HOURS: "0",
  OLLAMA_URL: live
    ? process.env.OLLAMA_URL || "http://127.0.0.1:11434"
    : "http://127.0.0.1:1",
  OLLAMA_MODEL: process.env.OLLAMA_MODEL || "gemma4:12b-mlx",
};
async function command(args: string[]) {
  const child = Bun.spawn(args, {
    cwd: dir,
    env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 180_000,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  assert.equal(code, 0, stderr.slice(-4000));
  return stdout;
}
let child: ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">> | undefined;
try {
  await command([
    "/usr/bin/codesign",
    "--verify",
    "--deep",
    "--strict",
    installed,
  ]);
  const runtime = JSON.parse(await command([binary, "--check-runtime"])) as {
    extractor: boolean;
    sqlite: { text: string };
  };
  assert.equal(runtime.extractor, true);
  assert.match(runtime.sqlite.text, /packaging/);
  if (live) {
    for (const [url, browser, method] of [
      ["https://www.rfc-editor.org/rfc/rfc8259.html", false, "scrapling-http"],
      ["https://arxiv.org/pdf/1706.03762", false, "pdf"],
      [
        "https://www.rfc-editor.org/rfc/rfc8259.html",
        true,
        "scrapling-browser",
      ],
    ] as const) {
      const result = JSON.parse(
        await command([
          binary,
          "--extract",
          url,
          ...(browser ? ["--browser"] : []),
        ]),
      ) as { method: string; content: string; title: string };
      assert.ok(result.content.length >= 180);
      assert.ok(
        result.method.includes(method),
        `Expected ${method}, received ${result.method}`,
      );
      console.log(
        JSON.stringify({
          extraction: result.method,
          title: result.title,
          characters: result.content.length,
        }),
      );
    }
  }
  const token = randomBytes(32).toString("hex");
  child = Bun.spawn([binary], {
    cwd: dir,
    env: { ...env, BRAINDUMP_TOKEN: token },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  let text = "";
  const deadline = Date.now() + 15_000;
  let base = "";
  while (!base && Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      Bun.sleep(15_000).then(() => ({ done: true, value: undefined })),
    ]);
    if (chunk.done) break;
    text += Buffer.from(chunk.value || []).toString();
    for (const line of text.split("\n")) {
      try {
        const event = JSON.parse(line) as { type: string; url: string };
        if (event.type === "ready") base = event.url;
      } catch {
        /* A partial line is completed by the next chunk. */
      }
    }
  }
  reader.releaseLock();
  assert.ok(base, "Installed backend failed to become ready.");
  assert.equal((await fetch(`${base}/api/backup`)).status, 401);
  const bootstrap = await fetch(`${base}/__desktop/${token}`, {
    redirect: "manual",
  });
  assert.equal(bootstrap.status, 303);
  const cookie = bootstrap.headers.get("set-cookie")!.split(";")[0];
  async function api(
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
  ) {
    const response = await fetch(`${base}/api${path}`, {
      method,
      headers: {
        cookie,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.ok(
      response.ok,
      `${path}: ${response.status} ${response.ok ? "" : await response.text()}`,
    );
    return (await response.json()) as Record<string, unknown>;
  }
  assert.equal((await fetch(base, { headers: { cookie } })).status, 200);
  const saved = (await api("/links", {
    text: live
      ? "https://www.rfc-editor.org/rfc/rfc8259.html"
      : "https://example.com/packaging",
  })) as { results: { id: string }[] };
  const id = saved.results[0].id;
  if (live) {
    const timeout = Date.now() + 600_000;
    let ready = false;
    while (Date.now() < timeout) {
      const link = await api(`/links/${id}`);
      if (link.state === "ready") {
        assert.ok(link.summary);
        ready = true;
        console.log(
          JSON.stringify({
            pipeline: "ready",
            title: link.title,
            model: link.model,
          }),
        );
        break;
      }
      assert.notEqual(link.state, "error", String(link.error));
      await Bun.sleep(1000);
    }
    assert.ok(
      ready,
      "The installed worker did not finish real inference before the deadline.",
    );
  }
  const backup = await api("/backup");
  assert.equal((backup.links as unknown[]).length, 1);
  await api("/backups", {});
  await api("/restore", backup);
  const results = await api(`/links?q=${live ? "JSON" : "example"}`);
  assert.equal(results.total, 1);
  // Interrupt an unfinished upload as well as the parent pipe. SQLite must
  // remain open until its async API handler has unwound.
  const uploadController = new AbortController();
  const upload = fetch(`${base}/api/restore`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"format":'));
      },
    }),
    signal: uploadController.signal,
  }).catch(() => null);
  await Bun.sleep(100);
  // EOF models the native app exiting, including a force-quit.
  await child.stdin.end();
  assert.equal(
    await Promise.race([child.exited, Bun.sleep(10_000).then(() => -1)]),
    0,
  );
  uploadController.abort();
  await upload;
  assert.ok(!(await stderr).includes("Shutdown failed"));
  console.log(
    "Installed app: signatures, relocation, bundled SQLite/FTS, session protection, API, backup/restore and parent-death shutdown passed.",
  );
} finally {
  if (child && child.exitCode === null) {
    child.kill();
    await child.exited;
  }
  rmSync(dir, { recursive: true, force: true });
}
