import { z } from "zod";
import { paths } from "./config";
import { operationSignal } from "./cancellation";
const extraction = z.object({
  title: z.string().max(1000),
  description: z.string().max(5000),
  content: z.string().min(180).max(1_000_000),
  method: z.string(),
});
export async function extract(url: string, browser = false) {
  if (!(await Bun.file(paths.extractor).exists()))
    throw new Error(
      paths.desktop
        ? "The bundled extractor is missing. Reinstall Braindump."
        : "Scraper is not installed. Run bun run setup.",
    );
  return extraction.parse(
    await runExtractor(
      [
        paths.extractor,
        ...paths.extractorArgs,
        url,
        ...(browser ? ["--browser"] : []),
      ],
      {
        ...process.env,
        PLAYWRIGHT_BROWSERS_PATH: paths.browsers,
        PYTHONDONTWRITEBYTECODE: "1",
      },
    ),
  );
}

export async function runExtractor(
  command: string[],
  env: NodeJS.ProcessEnv,
  timeout = 150_000,
) {
  const child = Bun.spawn(command, {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    detached: true,
    env,
  });
  const operation = operationSignal(timeout);
  let force: ReturnType<typeof setTimeout> | undefined;
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  const stop = () => {
    signalGroup("SIGTERM");
    force ??= setTimeout(() => signalGroup("SIGKILL"), 1000);
  };
  operation.signal.addEventListener("abort", stop, { once: true });
  const read = async (stream: ReadableStream<Uint8Array>, limit: number) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > limit) {
        stop();
        throw new Error("Extractor output exceeded its limit.");
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  };
  try {
    const [stdout, stderr, code] = await Promise.all([
      read(child.stdout, 8 * 1024 * 1024),
      read(child.stderr, 256 * 1024),
      child.exited,
    ]);
    operation.signal.throwIfAborted();
    let result;
    try {
      result = JSON.parse(stdout.trim().split("\n").at(-1) || "{}");
    } catch {
      throw new Error(
        "Scraper returned an invalid response. Check the extraction runtime and retry.",
      );
    }
    if (code !== 0 || result.error)
      throw new Error(
        result.error ||
          `Extractor exited (${code}). ${stderr.slice(-1500) || "No diagnostic output. Check the bundled runtime or rerun setup."}`,
      );
    return result as unknown;
  } finally {
    operation.signal.removeEventListener("abort", stop);
    operation.dispose();
    // A failed read must also reap descendants before returning to the worker.
    signalGroup("SIGKILL");
    await child.exited;
    clearTimeout(force);
  }
}
