import { join } from "node:path";
import { z } from "zod";
const extraction = z.object({
  title: z.string().max(1000),
  description: z.string().max(5000),
  content: z.string().min(180).max(1_000_000),
  method: z.string(),
});
export async function extract(url: string) {
  const python = join(import.meta.dir, "../scraper/.venv/bin/python");
  if (!(await Bun.file(python).exists()))
    throw new Error("Scraper is not installed. Run bun run setup.");
  const child = Bun.spawn(
    [python, join(import.meta.dir, "../scraper/extract.py"), url],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        PLAYWRIGHT_BROWSERS_PATH: join(import.meta.dir, "../.browsers"),
      },
    },
  );
  const timeout = setTimeout(() => child.kill(), 150_000);
  try {
    const [stdout, , code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    let result;
    try {
      result = JSON.parse(stdout.trim().split("\n").at(-1) || "{}");
    } catch {
      throw new Error(
        "Scraper returned an invalid response. Run bun run setup and retry.",
      );
    }
    if (code !== 0 || result.error)
      throw new Error(
        result.error ||
          "Page extraction timed out. Retry or paste the content.",
      );
    return extraction.parse(result);
  } finally {
    clearTimeout(timeout);
  }
}
