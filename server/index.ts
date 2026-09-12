import { join, resolve, sep } from "node:path";
import { mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { Database } from "bun:sqlite";
import { config, paths } from "./config";
import { Store } from "./db";
import { Worker } from "./worker";
import { createApi } from "./api";
import { acquireLibraryLock } from "./library-lock";
import { desktopSession } from "./desktop-session";
import { cancelOperations } from "./cancellation";
import { extract } from "./extract";

// Diagnostic modes use no library and work from the installed bundle.
if (process.argv.includes("--check-runtime")) {
  const db = new Database(":memory:");
  db.run("CREATE VIRTUAL TABLE check_fts USING fts5(text)");
  db.run("INSERT INTO check_fts VALUES ('SQLite packaging works')");
  const result = db
    .query("SELECT text FROM check_fts WHERE check_fts MATCH 'packaging'")
    .get();
  db.close();
  console.log(
    JSON.stringify({
      sqlite: result,
      resources: paths.resources,
      extractor: await Bun.file(paths.extractor).exists(),
    }),
  );
} else if (process.argv.includes("--extract")) {
  const url = process.argv[process.argv.indexOf("--extract") + 1];
  if (!url) throw new Error("Supply a public URL after --extract.");
  console.log(
    JSON.stringify(await extract(url, process.argv.includes("--browser"))),
  );
} else {
  const authorize = paths.desktop
    ? desktopSession(process.env.BRAINDUMP_TOKEN || "")
    : () => null;
  delete process.env.BRAINDUMP_TOKEN;
  if (paths.desktop) {
    mkdirSync(paths.cacheDir, { recursive: true, mode: 0o700 });
    mkdirSync(paths.logDir, { recursive: true, mode: 0o700 });
    process.env.XDG_CACHE_HOME = paths.cacheDir;
  }
  const unlock = acquireLibraryLock(config.dataDir);
  let store: Store | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    let api: ReturnType<typeof createApi>;
    let stopping = false;
    let inFlight = 0;
    const dist = paths.dist;
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: config.port,
      idleTimeout: 60,
      maxRequestBodySize: 256 * 1024 * 1024,
      async fetch(request) {
        if (stopping)
          return new Response("Braindump is shutting down.", { status: 503 });
        inFlight++;
        try {
          const denied = authorize(request);
          if (denied) return denied;
          const url = new URL(request.url);
          if (url.pathname.startsWith("/api/")) return api(request);
          if (!["GET", "HEAD"].includes(request.method))
            return new Response("Method not allowed", { status: 405 });
          const filePath = resolve(
            dist,
            "." + decodeURIComponent(url.pathname),
          );
          if (filePath !== dist && !filePath.startsWith(dist + sep))
            return new Response("Not found", { status: 404 });
          let file = Bun.file(filePath);
          if (!(await file.exists()) || url.pathname === "/")
            file = Bun.file(join(dist, "index.html"));
          if (!(await file.exists()))
            return new Response(
              paths.desktop
                ? "The app resources are missing. Reinstall Braindump."
                : "Run bun run build, or use bun run dev and open http://127.0.0.1:5173.",
              { status: 503 },
            );
          return new Response(file, {
            headers: {
              "X-Content-Type-Options": "nosniff",
              "Referrer-Policy": "no-referrer",
              "Content-Security-Policy":
                "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'",
            },
          });
        } finally {
          inFlight--;
        }
      },
      error(error) {
        console.error(error);
        return new Response("Internal server error", { status: 500 });
      },
    });
    // Both the kernel library lock and port are acquired before Store can recover jobs.
    store = new Store(config.dataDir);
    const worker = new Worker(store);
    api = createApi(store, worker);
    worker.start();
    const appServer = server;
    const appStore = store;
    const shutdown = async () => {
      if (stopping) return;
      stopping = true;
      const deadline = setTimeout(() => process.exit(1), 6000);
      try {
        const idle = worker.shutdown();
        cancelOperations();
        await Promise.all([idle, appServer.stop(true)]);
        // Connection closure alone need not finish an async request handler.
        while (inFlight)
          await new Promise((resolve) => setTimeout(resolve, 10));
        appStore.db.close();
        unlock();
        clearTimeout(deadline);
        process.exit(0);
      } catch (error) {
        console.error("Shutdown failed:", error);
        process.exit(1);
      }
    };
    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());
    if (paths.desktop) {
      const parent = createInterface({ input: process.stdin });
      parent.on("line", (line) => {
        if (line === "shutdown") void shutdown();
      });
      parent.on("close", () => void shutdown());
      console.log(
        JSON.stringify({
          type: "ready",
          url: `http://127.0.0.1:${server.port}`,
        }),
      );
    } else {
      console.log(`Braindump is running at http://127.0.0.1:${server.port}`);
      console.log(`Database: ${join(config.dataDir, "braindump.sqlite")}`);
    }
  } catch (error) {
    await server?.stop(true);
    store?.db.close();
    unlock();
    throw error;
  }
}
