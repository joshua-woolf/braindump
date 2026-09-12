const checks = [
  "check:locks",
  "check:audit",
  "check:repo",
  "format:check",
  "lint",
  "lint:docs",
  "check:docs",
  "check:python",
  "test:coverage",
  "build",
];
for (const check of checks) {
  console.log(`\nChecking ${check}…`);
  const child = Bun.spawn([process.execPath, "--bun", "run", check], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await child.exited) !== 0) {
    console.error(
      `Verification failed at ${check}. Fix the reported issue and run bun run verify again.`,
    );
    process.exit(1);
  }
}
console.log(
  "\nAll automated repository standards passed. Complete the applicable manual checks in docs/standards.md.",
);
export {};
