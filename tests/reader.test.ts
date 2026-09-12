import { expect, test } from "bun:test";

test("late status and reanalysis responses cannot replace the selected reader or its action target", async () => {
  const child = Bun.spawn(
    [process.execPath, "tests/fixtures/reader-interactions.ts"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [output, errors, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(errors).toBe("");
  expect(code).toBe(0);
  expect(output).toContain("Reader ignores completed mutations");
});
