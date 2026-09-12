import {
  cpSync,
  mkdirSync,
  rmSync,
  readdirSync,
  statSync,
  symlinkSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error(
    "The desktop proof currently builds on Apple Silicon macOS only.",
  );
const work = join(root, ".desktop-build");
const resources = join(root, "src-tauri/resources");
const env = {
  ...process.env,
  UV_CACHE_DIR: process.env.UV_CACHE_DIR || join(work, "uv-cache"),
  CARGO_TARGET_DIR: join(work, "target"),
  CARGO_HOME: process.env.CARGO_HOME || join(work, "cargo-home"),
  PYINSTALLER_CONFIG_DIR: join(work, "pyinstaller-cache"),
  MACOSX_DEPLOYMENT_TARGET: "15.0",
};
async function run(command: string[]) {
  const child = Bun.spawn(command, {
    cwd: root,
    env,
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await child.exited) !== 0)
    throw new Error(
      `Desktop build failed: ${command[0]} ${command.slice(1, 3).join(" ")}`,
    );
}
mkdirSync(work, { recursive: true });
// These are owned build outputs, never runtime library folders.
rmSync(resources, { recursive: true, force: true });
mkdirSync(join(resources, "runtime"), { recursive: true });
await run([process.execPath, "run", "build"]);
cpSync(join(root, "dist"), join(resources, "web"), { recursive: true });
await run([
  process.execPath,
  "build",
  "server/index.ts",
  "--compile",
  "--target=bun-darwin-arm64",
  "--outfile",
  join(resources, "runtime/braindump-server"),
]);
await run([
  "uv",
  "sync",
  "--locked",
  "--project",
  "scraper",
  "--group",
  "packaging",
  "--python",
  "3.13",
]);
await run([
  "uv",
  "run",
  "--locked",
  "--project",
  "scraper",
  "--group",
  "packaging",
  "pyinstaller",
  "--noconfirm",
  "--distpath",
  join(work, "python-dist"),
  "--workpath",
  join(work, "python-work"),
  "--specpath",
  work,
  "--name",
  "braindump-extractor",
  "--onedir",
  "--collect-all",
  "trafilatura",
  "--collect-all",
  "scrapling",
  "--collect-all",
  "patchright",
  "--collect-all",
  "curl_cffi",
  "--collect-all",
  "browserforge",
  "--collect-all",
  "apify_fingerprint_datapoints",
  join(root, "scraper/extract.py"),
]);
cpSync(
  join(work, "python-dist/braindump-extractor"),
  join(resources, "runtime/scraper"),
  { recursive: true, verbatimSymlinks: true },
);
const browsers = join(work, "browsers");
const install = Bun.spawn(
  [
    "uv",
    "run",
    "--locked",
    "--project",
    "scraper",
    "--group",
    "packaging",
    "python",
    "-m",
    "patchright",
    "install",
    "chromium",
  ],
  {
    cwd: root,
    env: { ...env, PLAYWRIGHT_BROWSERS_PATH: browsers },
    stdout: "inherit",
    stderr: "inherit",
  },
);
if ((await install.exited) !== 0)
  throw new Error("Could not prepare the pinned Chromium runtime.");
cpSync(browsers, join(resources, "runtime/browsers"), {
  recursive: true,
  verbatimSymlinks: true,
});
cpSync(join(root, "LICENSE"), join(resources, "LICENSE"));
await run([
  process.execPath,
  "x",
  "--no-install",
  "tauri",
  "build",
  "--bundles",
  "app",
  "--target",
  "aarch64-apple-darwin",
]);
const app = join(
  work,
  "target/aarch64-apple-darwin/release/bundle/macos/Braindump.app",
);
const identity = process.env.BRAINDUMP_SIGN_IDENTITY || "-";
const code: string[] = [];
const bundles: string[] = [];
function collect(directory: string) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      collect(path);
      if (/\.(app|framework)$/.test(path)) bundles.push(path);
    } else if (entry.isFile()) {
      const fd = openSync(path, "r");
      const magic = Buffer.alloc(4);
      try {
        readSync(fd, magic, 0, 4, 0);
      } finally {
        closeSync(fd);
      }
      if (
        [
          0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe,
          0xbebafeca,
        ].includes(magic.readUInt32BE())
      )
        code.push(path);
    }
  }
}
collect(app);
for (const path of [
  ...code,
  ...bundles.sort((a, b) => b.split("/").length - a.split("/").length),
  app,
]) {
  await run([
    "/usr/bin/codesign",
    "--force",
    "--sign",
    identity,
    ...(identity === "-" ? [] : ["--options", "runtime", "--timestamp"]),
    "--entitlements",
    join(root, "src-tauri/Entitlements.plist"),
    path,
  ]);
}
await run(["/usr/bin/codesign", "--verify", "--deep", "--strict", app]);
const output = join(work, "output");
mkdirSync(output, { recursive: true });
const version = (
  (await Bun.file(join(root, "package.json")).json()) as { version: string }
).version;
const dmg = join(output, `Braindump_${version}_aarch64.dmg`);
if (!process.argv.includes("--app-only")) {
  const imageRoot = join(work, "dmg-root");
  rmSync(imageRoot, { recursive: true, force: true });
  mkdirSync(imageRoot, { recursive: true });
  cpSync(app, join(imageRoot, "Braindump.app"), {
    recursive: true,
    verbatimSymlinks: true,
  });
  symlinkSync("/Applications", join(imageRoot, "Applications"));
  await run([
    "/usr/bin/hdiutil",
    "create",
    "-volname",
    "Braindump",
    "-srcfolder",
    imageRoot,
    "-ov",
    "-format",
    "UDZO",
    dmg,
  ]);
}
console.log(
  JSON.stringify(
    {
      app,
      dmg: process.argv.includes("--app-only") ? null : dmg,
      bytes: process.argv.includes("--app-only") ? null : statSync(dmg).size,
      signing:
        identity === "-"
          ? "ad-hoc; not notarized"
          : "Developer ID; notarization still required",
    },
    null,
    2,
  ),
);
