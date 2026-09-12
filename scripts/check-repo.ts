import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { basename, join, posix, resolve } from "node:path";
import { parseDocument } from "yaml";
import { repositoryFiles } from "./checks/files";

export function importBoundaryIssues(path: string, source: string): string[] {
  if (!/^(?:src|server)\/.*\.tsx?$/.test(path)) return [];
  const issues: string[] = [];
  const imports = new Bun.Transpiler({
    loader: path.endsWith(".tsx") ? "tsx" : "ts",
  }).scanImports(source);
  for (const { path: specifier } of imports) {
    const target = specifier.startsWith(".")
      ? posix.normalize(posix.join(posix.dirname(path), specifier))
      : specifier.replace(/^@\//, "src/");
    if (path.startsWith("src/")) {
      if (
        /^(?:node|bun):/.test(specifier) ||
        builtinModules.includes(specifier)
      )
        issues.push(
          `Browser code must use the local API instead of ${specifier}.`,
        );
      if (
        target.startsWith("server/") &&
        !/^server\/(?:schema|queue-types)(?:\.ts)?$/.test(target)
      )
        issues.push(
          `Browser code must not import server implementation: ${specifier}.`,
        );
    } else if (target.startsWith("src/"))
      issues.push(`Server code must not import UI modules: ${specifier}.`);
  }
  return issues;
}

export function fileStandardIssues(path: string, text: string): string[] {
  const issues: string[] = [];
  if (text.includes("\r")) issues.push("Use LF line endings.");
  if (text && !text.endsWith("\n")) issues.push("End the file with a newline.");
  if (/[^\S\n]+$/m.test(text)) issues.push("Remove trailing whitespace.");
  if (/^(?:<<<<<<< |=======\s*$|>>>>>>> )/m.test(text))
    issues.push("Resolve merge conflict markers.");
  const name = basename(path);
  if (
    /^src\/components\/(?!ui\/).*\.tsx$/.test(path) &&
    !/^[A-Z][A-Za-z0-9]*\.tsx$/.test(name)
  )
    issues.push("React component filenames use PascalCase.tsx.");
  if (
    /^(?:server|scripts|src\/lib)\/.*\.ts$/.test(path) &&
    !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*\.ts$/.test(name)
  )
    issues.push("TypeScript module filenames use kebab-case.ts.");
  if (
    /^tests\/[^/]+\.ts$/.test(path) &&
    !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*\.test\.ts$/.test(name)
  )
    issues.push("Bun tests belong in tests/kebab-case.test.ts.");
  if (
    /^docs\/.*\.md$/.test(path) &&
    !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*\.md$/.test(name)
  )
    issues.push("Documentation filenames use kebab-case.md.");
  if (/\.py$/.test(path) && !/^[a-z_][a-z0-9_]*\.py$/.test(name))
    issues.push("Python filenames use snake_case.py.");
  return issues;
}

export function manifestIssues(manifest: {
  packageManager?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}) {
  const issues: string[] = [];
  if (!/^bun@\d+\.\d+\.\d+$/.test(manifest.packageManager || ""))
    issues.push("Pin packageManager to bun@x.y.z.");
  for (const [name, version] of Object.entries({
    ...manifest.dependencies,
    ...manifest.devDependencies,
  }))
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
      issues.push(`Pin ${name} to an exact version.`);
  return issues;
}

export function workflowIssues(text: string) {
  const document = parseDocument(text, { uniqueKeys: true });
  const issues = document.errors.map((error) => error.message);
  if (issues.length) return issues;
  const workflow = document.toJS() as {
    on?: Record<string, unknown>;
    permissions?: { contents?: string };
    jobs?: Record<
      string,
      {
        "timeout-minutes"?: number;
        steps?: {
          uses?: string;
          run?: string;
          "continue-on-error"?: boolean;
        }[];
      }
    >;
  };
  if (
    !workflow.on ||
    !("pull_request" in workflow.on) ||
    !("push" in workflow.on)
  )
    issues.push("Run verification on pull requests and pushes.");
  if (workflow.permissions?.contents !== "read")
    issues.push("Use read-only repository permissions.");
  const jobs = Object.values(workflow.jobs || {});
  if (
    !jobs.some((job) =>
      job.steps?.some((step) => step.run === "bun run verify"),
    )
  )
    issues.push("CI must run bun run verify.");
  for (const job of jobs) {
    if (!job["timeout-minutes"]) issues.push("Bound CI jobs with a timeout.");
    for (const step of job.steps || []) {
      if (step.uses && !/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(step.uses))
        issues.push(`Pin action ${step.uses} to a full commit SHA.`);
      if (step["continue-on-error"])
        issues.push("Verification steps must not ignore failures.");
    }
  }
  return issues;
}

export function checkRepository(root: string) {
  const issues: string[] = [];
  for (const path of repositoryFiles(root)) {
    const source = readFileSync(join(root, path), "utf8");
    for (const issue of fileStandardIssues(path, source))
      issues.push(`${path}: ${issue}`);
    try {
      issues.push(
        ...importBoundaryIssues(path, source).map(
          (issue) => `${path}: ${issue}`,
        ),
      );
    } catch (error) {
      issues.push(`${path}: Cannot parse imports: ${(error as Error).message}`);
    }
  }
  const required = [
    "AGENTS.md",
    "README.md",
    "CONTRIBUTING.md",
    "docs/architecture.md",
    "docs/standards.md",
    "bun.lock",
    "scraper/uv.lock",
    "src-tauri/Cargo.lock",
    ".github/workflows/verify.yml",
  ];
  for (const path of required)
    if (!existsSync(join(root, path)))
      issues.push(`Missing required file: ${path}`);
  for (const path of [
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "Pipfile.lock",
    "poetry.lock",
  ])
    if (existsSync(join(root, path)))
      issues.push(`Remove competing package-manager lockfile: ${path}`);
  issues.push(
    ...manifestIssues(
      JSON.parse(readFileSync(join(root, "package.json"), "utf8")),
    ),
  );
  if (existsSync(join(root, ".github/workflows/verify.yml")))
    issues.push(
      ...workflowIssues(
        readFileSync(join(root, ".github/workflows/verify.yml"), "utf8"),
      ),
    );
  const tracked = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root });
  if (tracked.exitCode !== 0) issues.push("Cannot inspect Git tracking state.");
  for (const path of tracked.stdout.toString().split("\0"))
    if (
      /^(?:\.desktop-build\/|src-tauri\/(?:target|resources|gen)\/|data\/|dist\/|node_modules\/|\.browsers\/|scraper\/\.venv\/|\.env(?:$|\.))/.test(
        path,
      ) &&
      path !== ".env.example"
    )
      issues.push(
        `Live data, dependencies, build output or secrets must not be tracked: ${path}`,
      );
  const source = repositoryFiles(root).filter((path) =>
    /^(?:src|src-tauri|desktop|server|scripts|tests|docs|scraper|\.github)\//.test(
      path,
    ),
  );
  const ignored = Bun.spawnSync(
    ["git", "check-ignore", "--no-index", "--stdin"],
    { cwd: root, stdin: Buffer.from(source.join("\n") + "\n") },
  );
  if (ignored.exitCode > 1) issues.push("Cannot inspect source ignore rules.");
  if (ignored.exitCode === 0)
    issues.push(
      `Source files must not be ignored by Git:\n${ignored.stdout.toString().trim()}`,
    );
  return issues;
}

if (import.meta.main) {
  const issues = checkRepository(resolve(import.meta.dir, ".."));
  if (issues.length) {
    console.error(issues.join("\n"));
    process.exitCode = 1;
  } else
    console.log(
      "Repository layout, filenames, whitespace, dependency pins, CI policy and Git hygiene passed.",
    );
}
