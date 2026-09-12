import { parseLinkFile } from "../server/urls";
import { config } from "../server/config";

const args = process.argv.slice(2);
const path = args.find((arg) => !arg.startsWith("--"));
if (!path || args.some((arg) => arg.startsWith("--") && arg !== "--dry-run")) {
  console.error("Usage: bun run import <url-file> [--dry-run]");
  process.exit(1);
}
const parsed = parseLinkFile(await Bun.file(path).text());
console.log(
  JSON.stringify(
    {
      entries: parsed.entries,
      unique: parsed.urls.length,
      duplicates: parsed.duplicates,
      invalid: parsed.invalid,
    },
    null,
    2,
  ),
);
if (parsed.invalid.length)
  throw new Error(
    "Correct the listed lines before importing. No links were added.",
  );
if (args.includes("--dry-run") || !parsed.urls.length) process.exit(0);

const base = `http://127.0.0.1:${config.port}`;
const backupResponse = await fetch(`${base}/api/backups/before-import`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{}",
  signal: AbortSignal.timeout(15000),
});
if (!backupResponse.ok)
  throw new Error(
    "Cannot back up the running app. Start it with bun start, then retry.",
  );
const { backup } = (await backupResponse.json()) as { backup: string };

let added = 0;
let existing = 0;
for (let i = 0; i < parsed.urls.length; i += 100) {
  const batch = parsed.urls.slice(i, i + 100);
  const response = await fetch(`${base}/api/links`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: batch.join("\n") }),
    signal: AbortSignal.timeout(30000),
  });
  const result = (await response.json()) as {
    error?: string;
    results?: { id: string; duplicate: boolean }[];
  };
  if (!response.ok || !result.results)
    throw new Error(
      `Import stopped after ${i} URLs: ${result.error || response.status}. Rerun safely; existing links are skipped.`,
    );
  for (const link of result.results) {
    if (link.duplicate) existing++;
    else added++;
  }
  console.log(
    `${Math.min(i + 100, parsed.urls.length)}/${parsed.urls.length}: ${added} added, ${existing} already saved`,
  );
}
console.log(
  `Import complete. ${added} links added and queued; ${existing} already saved. Safety backup: ${backup} (in the app's configured backup folder).`,
);
