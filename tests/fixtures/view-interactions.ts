// Keep browser globals and fake HTTP responses isolated from backend tests.
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const browser = new Window({ url: "http://localhost/" });
const listId = "672290b1-f560-4c22-b6f0-3a4b2d92ed63";
let lists = [{ id: listId, name: "my reading", count: 0 }];
const requests: URL[] = [];
Object.assign(globalThis, {
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  localStorage: browser.localStorage,
  HTMLElement: browser.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  fetch: (input: string) => {
    const url = new URL(input, "http://localhost");
    requests.push(url);
    let result: unknown;
    switch (url.pathname) {
      case "/api/status":
        result = { online: true, counts: {}, models: [], jobs: [] };
        break;
      case "/api/tags":
        result = { tags: [{ name: "design", count: 0 }], suggestions: [] };
        break;
      case "/api/lists":
        result = { lists };
        break;
      case "/api/links":
        result = { links: [], total: 0, page: 1, pages: 1 };
        break;
      case "/api/backups":
        result = { backups: [] };
        break;
      case "/api/settings":
        result = { model: "test", backupHours: 0, tagReviewHours: 0 };
        break;
      case "/api/queue":
        result = {
          running: [],
          waiting: [],
          current: null,
          model: "test",
          total: 0,
          waitingTotal: 0,
          retrying: 0,
          page: Number(url.searchParams.get("page")),
          pages: 4,
        };
        break;
      default:
        throw new Error(`Unexpected request ${url}`);
    }
    return Promise.resolve(Response.json(result));
  },
});
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: App } = await import("../../src/App");
const { readViewState, saveViewState } =
  await import("../../src/lib/view-state");
saveViewState({
  view: "attention",
  query: "MiXeD case",
  tag: "design",
  listId,
  archived: "all",
  deleted: "false",
  read: "false",
  sort: "title",
  advanced: true,
  queue: { query: "article", page: 3 },
});
const container = browser.document.createElement("div");
browser.document.body.append(container);
let root = createRoot(container as unknown as HTMLElement);
async function refresh() {
  await act(async () => root.unmount());
  requests.length = 0;
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => root.render(createElement(App)));
}
async function navigate(label: string) {
  const button = Array.from(
    browser.document.querySelectorAll(".nav-item"),
  ).find((element) => element.textContent.startsWith(label));
  assert.ok(button);
  await act(async () => (button as typeof browser.document.body).click());
}
try {
  await act(async () => root.render(createElement(App)));
  await refresh();
  const library = requests.filter((url) => url.pathname === "/api/links");
  assert.ok(library.length > 0);
  for (const url of library) {
    assert.equal(url.searchParams.get("view"), "attention");
    assert.equal(url.searchParams.get("q"), "MiXeD case");
    assert.equal(url.searchParams.get("list"), listId);
    assert.equal(url.searchParams.get("archived"), "all");
    assert.equal(url.searchParams.get("state"), "error");
    assert.equal(url.searchParams.get("sort"), "title");
  }
  assert.equal(readViewState().listId, listId);
  assert.equal(
    browser.document
      .querySelector("button[aria-expanded]")
      ?.getAttribute("aria-expanded"),
    "true",
  );

  // A list removed elsewhere clears only that obsolete filter after lists load.
  lists = [];
  await refresh();
  assert.equal(readViewState().listId, "");
  assert.equal(readViewState().tag, "design");
  assert.equal(readViewState().query, "MiXeD case");

  await navigate("Settings & Backups");
  await refresh();
  assert.equal(readViewState().view, "settings");
  assert.equal(
    browser.document.querySelector("h1")?.textContent,
    "Settings & Backups",
  );
  assert.equal(
    requests.some((url) => url.pathname === "/api/links"),
    false,
  );
  assert.equal(browser.document.querySelector('[role="dialog"]'), null);

  await navigate("Queue");
  await refresh();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 350));
  });
  const queue = requests.filter((url) => url.pathname === "/api/queue");
  assert.ok(queue.length > 0);
  for (const url of queue) {
    assert.equal(url.searchParams.get("q"), "article");
    assert.equal(url.searchParams.get("page"), "3");
  }
  assert.equal(readViewState().queue.page, 3);
  console.log("View interactions passed");
} finally {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
}
