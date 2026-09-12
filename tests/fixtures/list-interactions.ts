// Simulated browser globals stay in a subprocess; all API calls use a temporary store.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Window } from "happy-dom";
import { Store } from "../../server/db";
import { createApi } from "../../server/api";
import { Worker } from "../../server/worker";

const dir = mkdtempSync(join(tmpdir(), "braindump-list-ui-"));
const store = new Store(dir);
const api = createApi(store, new Worker(store));
const browser = new Window({
  url: "http://127.0.0.1:3210/",
  settings: {
    disableJavaScriptEvaluation: true,
    disableJavaScriptFileLoading: true,
    disableCSSFileLoading: true,
  },
});
let failMutation = false;
let changes = 0;
Object.assign(globalThis, {
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  IS_REACT_ACT_ENVIRONMENT: true,
  fetch: (input: string, init?: RequestInit) => {
    if (failMutation && init?.method !== "GET")
      return Promise.resolve(
        Response.json({ error: "Connection interrupted" }, { status: 503 }),
      );
    return api(new Request(new URL(input, browser.location.href), init));
  },
});
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ListMembershipEditor } =
  await import("../../src/components/ListMembershipEditor");
const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container as unknown as HTMLElement);
const changed = () => {
  changes++;
};

function checkbox(name: string) {
  const label = [...container.querySelectorAll("label")].find(
    (item) => item.textContent === name,
  );
  const input = label?.querySelector("input");
  assert.ok(input, `Missing checkbox for ${name}`);
  return input;
}
async function render(linkId: string) {
  await act(async () => {
    root.render(
      createElement(ListMembershipEditor, { key: linkId, linkId, changed }),
    );
  });
}
async function typeName(name: string) {
  const input = container.querySelector('input:not([type="checkbox"])');
  assert.ok(input);
  await act(async () => {
    // Use the native setter so React sees a user edit instead of its own value tracker.
    Object.getOwnPropertyDescriptor(
      browser.HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, name);
    input.dispatchEvent(new browser.Event("input", { bubbles: true }));
  });
}

try {
  const first = store.add("https://example.com/first");
  const second = store.add("https://example.com/second");
  const reading = store.createList("Weekend READING");
  const research = store.createList("research");
  store.setMembership(reading.id, first.id, true);
  await render(first.id);
  assert.equal(checkbox(reading.name).checked, true);
  assert.equal(checkbox(research.name).checked, false);
  await act(async () => checkbox(research.name).click());
  assert.deepEqual(
    new Set(store.linkLists(first.id)),
    new Set([reading.id, research.id]),
  );
  assert.equal(checkbox(research.name).checked, true);
  await act(async () => checkbox(reading.name).click());
  assert.deepEqual(store.linkLists(first.id), [research.id]);

  failMutation = true;
  await act(async () => checkbox(research.name).click());
  assert.equal(checkbox(research.name).checked, true);
  assert.deepEqual(store.linkLists(first.id), [research.id]);
  assert.ok(
    container
      .querySelector('[role="alert"]')
      ?.textContent.includes("Connection interrupted"),
  );
  assert.ok(!container.textContent.includes("All changes saved."));
  failMutation = false;
  await act(async () => checkbox(research.name).click());
  assert.equal(checkbox(research.name).checked, false);

  await typeName("My new LIST");
  await act(async () =>
    container
      .querySelector("form")!
      .dispatchEvent(
        new browser.Event("submit", { bubbles: true, cancelable: true }),
      ),
  );
  const created = store.lists().find((list) => list.name === "My new LIST");
  assert.ok(created);
  assert.equal(checkbox(created.name).checked, true);
  assert.deepEqual(store.linkLists(first.id), [created.id]);
  assert.equal(changes, 4);

  await render(second.id);
  assert.equal(checkbox(created.name).checked, false);
  await act(async () => checkbox(reading.name).click());
  assert.deepEqual(store.linkLists(second.id), [reading.id]);
  assert.deepEqual(store.linkLists(first.id), [created.id]);
  assert.equal(changes, 5);
  console.log("List interactions passed");
} finally {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
}
