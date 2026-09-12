// Keep DOM globals and delayed fetches isolated from other test files.
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { Link } from "../../src/types";

const browser = new Window({
  url: "http://localhost/",
  settings: {
    disableJavaScriptEvaluation: true,
    disableJavaScriptFileLoading: true,
    disableCSSFileLoading: true,
  },
});
for (const key of [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "Element",
  "Node",
  "NodeFilter",
  "CustomEvent",
  "MutationObserver",
  "DocumentFragment",
  "Event",
] as const)
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: key === "window" ? browser : browser[key],
  });
Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
});
const first: Link = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "original FIRST title",
  url: "https://example.com/a",
  content: "Source content",
  summary: "Summary A",
  description: "",
  tags: ["a"],
  read: false,
  liked: false,
  archived: false,
  deleted: false,
  state: "ready",
  error: null,
  method: "test",
  highlights: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  summarizedAt: null,
  model: null,
};
const second: Link = {
  ...first,
  id: "22222222-2222-4222-8222-222222222222",
  title: "original SECOND title",
  url: "https://example.com/b",
  summary: "Summary B",
  tags: ["b"],
};
let complete!: (response: Response) => void;
const requests: { path: string; method: string; body: unknown }[] = [];
Object.assign(globalThis, {
  fetch: (path: string, init?: RequestInit) => {
    if (path === "/api/lists")
      return Promise.resolve(Response.json({ lists: [] }));
    if (path.endsWith("/lists"))
      return Promise.resolve(Response.json({ listIds: [] }));
    const method = init?.method || "GET";
    requests.push({ path, method, body: init?.body });
    if (method !== "GET" && path.includes(first.id))
      return new Promise<Response>((resolve) => {
        complete = resolve;
      });
    return Promise.resolve(
      Response.json(path.includes(second.id) ? second : first),
    );
  },
});
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Reader } = await import("../../src/components/Reader");
const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container as unknown as HTMLElement);
let changes = 0;
async function render(id: string | null) {
  await act(async () =>
    root.render(
      createElement(Reader, {
        id,
        changed: () => {
          changes++;
        },
        close: () => {},
      }),
    ),
  );
}
function title() {
  return browser.document.querySelector('[role="dialog"] h2')?.textContent;
}
function button(text: string) {
  const found = [...browser.document.querySelectorAll("button")].find(
    (item) => item.textContent === text,
  );
  assert.ok(found, `Missing ${text}`);
  return found;
}
try {
  // Exercise both status PATCH and POST-then-reload while the selected link changes.
  for (const action of ["Mark read", "Reanalyze saved text"] as const) {
    await render(first.id);
    if (action === "Reanalyze saved text") {
      await act(async () =>
        button("Manage").dispatchEvent(
          new browser.MouseEvent("mousedown", { bubbles: true, button: 0 }),
        ),
      );
    }
    await act(async () => button(action).click());
    await render(null);
    await render(second.id);
    assert.equal(title(), second.title);
    await act(async () => complete(Response.json({ ...first, read: true })));
    assert.equal(title(), second.title);
    assert.equal(button("Mark read").disabled, false);
    await act(async () => button("Mark read").click());
    assert.deepEqual(requests.at(-1), {
      path: `/api/links/${second.id}`,
      method: "PATCH",
      body: JSON.stringify({ read: true }),
    });
    await render(null);
  }
  assert.equal(changes, 4);
  console.log("Reader ignores completed mutations from previous selections.");
} finally {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
}
