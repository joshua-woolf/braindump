import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  fileStandardIssues,
  importBoundaryIssues,
  manifestIssues,
  workflowIssues,
} from "../scripts/check-repo";

const repo = resolve(import.meta.dir, "..");
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "braindump-standards-"));
  symlinkSync(join(repo, "node_modules"), join(dir, "node_modules"), "dir");
  copyFileSync(join(repo, ".oxlintrc.json"), join(dir, ".oxlintrc.json"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function command(args: string[], env = process.env) {
  const child = Bun.spawn(args, {
    cwd: dir,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, output: stdout + stderr };
}
async function lintFixture(source: string, file = "example.ts") {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { target: "ES2022", module: "ESNext", strict: true },
      include: ["**/*.ts"],
    }),
  );
  writeFileSync(join(dir, file), source);
  const result = await command(
    [
      process.execPath,
      join(repo, "node_modules/.bin/oxlint"),
      "--config",
      join(dir, ".oxlintrc.json"),
      "--type-aware",
      "--deny-warnings",
      "--format=json",
      file,
    ],
    // Exercise CI detection without inheriting agent-specific formatter overrides.
    { PATH: process.env.PATH, CI: "true", GITHUB_ACTIONS: "true" },
  );
  const report: unknown = JSON.parse(result.output);
  return { ...result, report };
}

describe("repository standards reject violations", () => {
  test("file rules reject ambiguous names, conflict markers and invalid whitespace", () => {
    expect(
      fileStandardIssues(
        "src/components/bad-name.tsx",
        "const value = 1; \r\n<<<<<<< branch\n",
      ),
    ).toEqual(
      expect.arrayContaining([
        "React component filenames use PascalCase.tsx.",
        "Use LF line endings.",
        "Remove trailing whitespace.",
        "Resolve merge conflict markers.",
      ]),
    );
    expect(fileStandardIssues("tests/example.ts", "export {};")).toHaveLength(
      2,
    );
    expect(fileStandardIssues("scripts/check-docs.ts", "export {};\n")).toEqual(
      [],
    );
  });
  test("manifest rules reject floating dependency and toolchain versions", () => {
    expect(
      manifestIssues({
        packageManager: "bun@latest",
        dependencies: { example: "^1.0.0" },
      }),
    ).toHaveLength(2);
    expect(
      manifestIssues({
        packageManager: "bun@1.4.2",
        devDependencies: { example: "1.0.0" },
      }),
    ).toEqual([]);
  });
  test("workflow rules reject missing gates, write access, unpinned actions and ignored failures", () => {
    const issues = workflowIssues(
      "on: {push: null}\npermissions: {contents: write}\njobs:\n  verify:\n    steps:\n      - uses: actions/checkout@v4\n        continue-on-error: true\n",
    );
    expect(issues).toHaveLength(6);
    expect(issues.join("\n")).toContain("CI must run bun run verify");
    expect(workflowIssues("name: one\nname: two\n").length).toBeGreaterThan(0);
  });
  test("type-aware lint rejects floating promises and accepts explicit handling", async () => {
    const bad = await lintFixture(
      "export {};\nasync function work() { return 1; }\nwork();\n",
    );
    expect(bad.code).toBe(1);
    expect(bad.report).toMatchObject({
      diagnostics: [
        { code: "typescript(no-floating-promises)", severity: "error" },
      ],
    });
    const good = await lintFixture(
      "export {};\nasync function work() { return 1; }\nvoid work().catch(() => {});\n",
    );
    expect(good.code).toBe(0);
    expect(good.report).toMatchObject({ diagnostics: [] });
  });
  test("Bun test lint rejects focused, skipped and todo tests including aliases under GitHub Actions", async () => {
    const result = await lintFixture(
      'import { test as check, expect } from "bun:test";\ncheck.only("focused", () => { expect(1).toBe(1); });\ncheck["skip"]("skipped", () => { expect(1).toBe(1); });\ncheck.todo("later");\n',
      "tests/example.test.ts",
    );
    expect(result.code).toBe(1);
    expect(result.report).toMatchObject({
      diagnostics: [
        "Do not focus tests in the default suite.",
        "Do not skip tests in the default suite.",
        "Implement tests before adding them to the default suite.",
      ].map((help) => ({
        code: "eslint(no-restricted-properties)",
        severity: "error",
        filename: "tests/example.test.ts",
        help,
      })),
    });
    const good = await lintFixture(
      'import { test, expect } from "bun:test";\ntest("runs", () => { expect(1).toBe(1); });\n',
      "tests/example.test.ts",
    );
    expect(good.code).toBe(0);
    expect(good.report).toMatchObject({ diagnostics: [] });
  });
  test("module boundaries reject forbidden imports, re-exports and dynamic imports", () => {
    const bad = importBoundaryIssues(
      "src/example.ts",
      'export { Store } from "../server/store";\nexport { readFile } from "node:fs/promises";\nconst api = import("../server/api");\n',
    );
    expect(bad).toHaveLength(3);
    expect(bad.join("\n")).toContain(
      "Browser code must not import server implementation",
    );
    expect(bad.join("\n")).toContain("Browser code must use the local API");
    expect(
      importBoundaryIssues(
        "server/example.ts",
        'export { App } from "../src/App";',
      ),
    ).toHaveLength(1);
    const good = importBoundaryIssues(
      "src/example.ts",
      'import { settingsSchema } from "../server/schema";\nimport type { Store } from "../server/store";\nexport { settingsSchema };\nexport type { Store };\n',
    );
    expect(good).toEqual([]);
  });
  test("documentation checks reject missing files, anchors and invalid Mermaid", async () => {
    writeFileSync(
      join(dir, "README.md"),
      "# Guide\n\n[Missing](missing.md)\n[Missing heading](guide.md#unknown)\n\n```mermaid\nflowchart TB\nA -->\n```\n",
    );
    writeFileSync(join(dir, "guide.md"), "# Guide\n");
    const result = await command([
      process.execPath,
      join(repo, "scripts/check-docs.ts"),
      dir,
    ]);
    expect(result.code).toBe(1);
    expect(result.output).toContain("Broken link missing.md");
    expect(result.output).toContain("Heading anchor does not exist");
    expect(result.output).toContain("Invalid Mermaid diagram");
  });
  test("documentation checks accept reference links, duplicate heading anchors and Mermaid", async () => {
    writeFileSync(
      join(dir, "README.md"),
      '# Guide\n\n[Reference][guide]\n\n[guide]: guide.md#example-1\n\n```mermaid\nflowchart TB\nA["Source"] --> B["Result"]\n```\n',
    );
    writeFileSync(
      join(dir, "guide.md"),
      "# Guide\n\n## Example\n\n## Example\n",
    );
    const result = await command([
      process.execPath,
      join(repo, "scripts/check-docs.ts"),
      dir,
    ]);
    expect(result.code).toBe(0);
    expect(result.output).toContain("parsed 1 Mermaid diagrams");
  });
});
