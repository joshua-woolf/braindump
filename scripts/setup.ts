import { resolve } from "node:path";
async function run(command: string[], env = process.env) {
  const p = Bun.spawn(command, { stdout: "inherit", stderr: "inherit", env });
  if ((await p.exited) !== 0)
    throw new Error(`Setup failed: ${command.join(" ")}`);
}
if (!Bun.which("uv")) throw new Error("Install uv first: brew install uv");
if (!Bun.which("ollama"))
  throw new Error("Install Ollama first from https://ollama.com/download");
await run([
  "uv",
  "sync",
  "--project",
  "scraper",
  "--python",
  "3.13",
  "--locked",
]);
await run(
  ["scraper/.venv/bin/python", "-m", "patchright", "install", "chromium"],
  { ...process.env, PLAYWRIGHT_BROWSERS_PATH: resolve(".browsers") },
);
const model = process.env.OLLAMA_MODEL || "gemma4:12b-mlx";
console.log(
  `Preparing local model ${model}. Start Ollama first if this step cannot connect.`,
);
await run(["ollama", "pull", model]);
console.log("Ready. Run bun run dev, or bun run build followed by bun start.");
