import { join, resolve, sep } from "node:path";
import { config } from "./config";
import { Store } from "./db";
import { Worker } from "./worker";
import { createApi } from "./api";

let api: ReturnType<typeof createApi>;
const dist = resolve(import.meta.dir, "../dist");
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: config.port,
  idleTimeout: 60,
  maxRequestBodySize: 256 * 1024 * 1024,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return api(request);
    if (!["GET", "HEAD"].includes(request.method))
      return new Response("Method not allowed", { status: 405 });
    const filePath = resolve(dist, "." + decodeURIComponent(url.pathname));
    if (filePath !== dist && !filePath.startsWith(dist + sep))
      return new Response("Not found", { status: 404 });
    let file = Bun.file(filePath);
    if (!(await file.exists()) || url.pathname === "/")
      file = Bun.file(join(dist, "index.html"));
    if (!(await file.exists()))
      return new Response(
        "Run bun run build, or use bun run dev and open http://127.0.0.1:5173.",
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
  },
  error(error) {
    console.error(error);
    return new Response("Internal server error", { status: 500 });
  },
});
// Bind first: a duplicate start must fail before touching the persistent queue.
const store = new Store(config.dataDir);
const worker = new Worker(store);
api = createApi(store, worker);
worker.start();
console.log(`Braindump is running at http://127.0.0.1:${server.port}`);
console.log(`Database: ${join(config.dataDir, "braindump.sqlite")}`);
process.on("SIGINT", () => {
  worker.stop();
  void server
    .stop()
    .catch((error) => console.error("HTTP shutdown failed:", error));
  process.exit(0);
});
process.on("SIGTERM", () => {
  worker.stop();
  void server
    .stop()
    .catch((error) => console.error("HTTP shutdown failed:", error));
  process.exit(0);
});
