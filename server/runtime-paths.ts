import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";

export function runtimePaths(
  env = process.env,
  home = homedir(),
  sourceRoot = resolve(import.meta.dir, ".."),
  executable = process.execPath,
) {
  const desktop = env.BRAINDUMP_DESKTOP === "1";
  const resources = desktop
    ? env.BRAINDUMP_RESOURCES || resolve(dirname(executable), "../Resources")
    : sourceRoot;
  if (!isAbsolute(resources))
    throw new Error("Resource directory must be absolute.");
  return {
    desktop,
    resources,
    dataDir: resolve(
      env.DATA_DIR ||
        (desktop
          ? join(home, "Library/Application Support/Braindump")
          : join(sourceRoot, "data")),
    ),
    logDir: resolve(
      env.BRAINDUMP_LOG_DIR || join(home, "Library/Logs/Braindump"),
    ),
    cacheDir: resolve(
      env.BRAINDUMP_CACHE_DIR || join(home, "Library/Caches/Braindump"),
    ),
    dist: join(resources, desktop ? "web" : "dist"),
    extractor: desktop
      ? join(resources, "runtime/scraper/braindump-extractor")
      : join(resources, "scraper/.venv/bin/python"),
    extractorArgs: desktop ? [] : [join(resources, "scraper/extract.py")],
    browsers: join(resources, desktop ? "runtime/browsers" : ".browsers"),
  };
}
