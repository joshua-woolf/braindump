import { rejection } from "./fixtures/rejection";
import {
  afterEach,
  beforeEach,
  expect,
  spyOn,
  test,
  type Mock,
} from "bun:test";
import { extract } from "../server/extract";
import { tmpdir } from "node:os";
import { join } from "node:path";

const realFile = Bun.file;
const realSpawn = Bun.spawn;
const realSetTimeout = setTimeout;
let fileMock: Mock<typeof Bun.file>;
let spawnMock: Mock<typeof Bun.spawn>;
let timeoutMock: Mock<typeof setTimeout>;
let clearMock: Mock<typeof clearTimeout>;
const article = {
  title: "original PAGE title",
  description: "A source description",
  content: "Readable article text about local databases. ".repeat(10),
  method: "scrapling-http",
};

beforeEach(() => {
  // A real Bun subprocess stands in for Python; these tests need no scraper,
  // Chromium, network or model installation.
  fileMock = spyOn(Bun, "file").mockReturnValue(realFile(import.meta.filename));
  spawnMock = spyOn(Bun, "spawn").mockImplementation(() => {
    throw new Error("Unexpected subprocess in extraction test");
  });
  timeoutMock = spyOn(globalThis, "setTimeout");
  clearMock = spyOn(globalThis, "clearTimeout");
});
afterEach(() => {
  fileMock.mockRestore();
  spawnMock.mockRestore();
  timeoutMock.mockRestore();
  clearMock.mockRestore();
});

function childOutput(output: string, code = 0) {
  spawnMock.mockImplementation(() =>
    realSpawn(
      [
        process.execPath,
        "-e",
        "await Bun.write(Bun.stdout, await Bun.stdin.text()); console.error('scraper diagnostic'); process.exit(Number(process.argv[1]));",
        String(code),
      ],
      {
        stdin: new Blob([output]),
        stdout: "pipe",
        stderr: "pipe",
      },
    ),
  );
}

test("extraction reads the final JSON line and launches an isolated browser environment", async () => {
  childOutput(`diagnostic line\n${JSON.stringify(article)}\n`);
  expect(await extract("https://example.com/article")).toEqual(article);
  expect(spawnMock.mock.calls[0]).toMatchObject([
    [
      expect.stringContaining("scraper/.venv/bin/python"),
      expect.stringContaining("scraper/extract.py"),
      "https://example.com/article",
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: { PLAYWRIGHT_BROWSERS_PATH: expect.stringContaining("/.browsers") },
    },
  ]);
  expect(timeoutMock.mock.calls[0][1]).toBe(150_000);
  expect(clearMock).toHaveBeenCalledTimes(1);
});

test("missing scraper installation fails before starting a subprocess", async () => {
  fileMock.mockReturnValue(
    realFile(join(tmpdir(), `braindump-missing-${crypto.randomUUID()}`)),
  );
  expect(await rejection(extract("https://example.com/"))).toMatchObject({
    message: expect.stringContaining("Run bun run setup"),
  });
  expect(spawnMock).not.toHaveBeenCalled();
});

test("malformed subprocess JSON is rejected and its deadline is cleared", async () => {
  childOutput("not JSON\n");
  expect(await rejection(extract("https://example.com/"))).toMatchObject({
    message: expect.stringContaining("invalid response"),
  });
  expect(clearMock).toHaveBeenCalledTimes(1);
});

test("reported extraction errors are preserved even when the process exits successfully", async () => {
  childOutput(JSON.stringify({ error: "A login is required" }));
  expect(await rejection(extract("https://example.com/"))).toMatchObject({
    message: expect.stringContaining("A login is required"),
  });
  expect(clearMock).toHaveBeenCalledTimes(1);
});

test("nonzero exit cannot turn otherwise valid output into a saved article", async () => {
  childOutput(JSON.stringify(article), 1);
  expect(await rejection(extract("https://example.com/"))).toMatchObject({
    message: expect.stringContaining("Retry or paste the content"),
  });
});

test("empty, short and oversized extraction results fail validation", async () => {
  for (const output of [
    "",
    JSON.stringify({ ...article, content: "short" }),
    JSON.stringify({ ...article, title: "x".repeat(1001) }),
    JSON.stringify({ ...article, description: "x".repeat(5001) }),
    JSON.stringify({ ...article, content: "x".repeat(1_000_001) }),
  ]) {
    childOutput(output);
    expect(await rejection(extract("https://example.com/"))).toBeInstanceOf(
      Error,
    );
  }
});

test("a stalled subprocess is terminated and reports a retryable extraction error", async () => {
  spawnMock.mockImplementation(() =>
    realSpawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  timeoutMock.mockImplementation(((callback: () => void) =>
    realSetTimeout(callback, 20)) as typeof setTimeout);
  expect(await rejection(extract("https://example.com/"))).toMatchObject({
    message: expect.stringContaining("timed out"),
  });
  expect(clearMock).toHaveBeenCalledTimes(1);
});
