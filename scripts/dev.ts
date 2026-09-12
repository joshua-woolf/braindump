export {};
const processes = [
  Bun.spawn(["bun", "--watch", "server/index.ts"], {
    stdout: "inherit",
    stderr: "inherit",
  }),
  Bun.spawn(["bun", "run", "dev:web"], {
    stdout: "inherit",
    stderr: "inherit",
  }),
];
function stop() {
  for (const child of processes) child.kill();
}
process.on("SIGINT", () => {
  stop();
  process.exit(0);
});
process.on("SIGTERM", () => {
  stop();
  process.exit(0);
});
await Promise.race(processes.map((p) => p.exited));
stop();
