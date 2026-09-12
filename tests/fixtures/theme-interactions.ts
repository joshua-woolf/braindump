// A separate process keeps simulated browser globals out of server/store tests.
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const browser = new Window({
  url: "http://localhost/",
  settings: {
    disableJavaScriptEvaluation: true,
    disableJavaScriptFileLoading: true,
    disableCSSFileLoading: true,
  },
});
const listeners = new Set<(event: { matches: boolean }) => void>();
const media = {
  matches: false,
  addListener: (listener: (event: { matches: boolean }) => void) =>
    listeners.add(listener),
  removeListener: (listener: (event: { matches: boolean }) => void) =>
    listeners.delete(listener),
};
Object.defineProperty(browser, "matchMedia", { value: () => media });
Object.assign(globalThis, {
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  localStorage: browser.localStorage,
  setTimeout: browser.setTimeout.bind(browser),
  clearTimeout: browser.clearTimeout.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AppearanceProvider, AppearanceSettings, ThemeToggle } =
  await import("../../src/components/Appearance");
const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container as unknown as HTMLElement);

function selectedTheme() {
  return browser.document.documentElement.style.colorScheme;
}
async function changeDevice(dark: boolean) {
  await act(async () => {
    media.matches = dark;
    for (const listener of listeners) listener(media);
  });
}

try {
  await act(async () => {
    root.render(
      createElement(
        AppearanceProvider,
        null,
        createElement(ThemeToggle),
        createElement(AppearanceSettings),
        createElement("input", {
          id: "current-search",
          defaultValue: "saved search",
        }),
      ),
    );
  });
  const select = browser.document.querySelector("select")!;
  const toggle = browser.document.querySelector("button")!;
  assert.equal(select.value, "system");
  assert.equal(selectedTheme(), "light");
  assert.equal(
    browser.document.querySelector("script")?.getAttribute("src"),
    "/theme.js",
  );

  await act(async () => toggle.click());
  assert.equal(selectedTheme(), "dark");
  assert.equal(select.value, "dark");
  assert.equal(browser.localStorage.getItem("braindump.theme"), "dark");
  assert.equal(toggle.getAttribute("aria-label"), "Switch to Light Mode");
  assert.equal(
    browser.document.querySelector("#current-search")?.getAttribute("value"),
    "saved search",
  );

  await changeDevice(true);
  await changeDevice(false);
  assert.equal(selectedTheme(), "dark");
  await act(async () => {
    select.value = "system";
    select.dispatchEvent(new browser.Event("change", { bubbles: true }));
  });
  assert.equal(selectedTheme(), "light");
  await changeDevice(true);
  assert.equal(selectedTheme(), "dark");

  await act(async () => {
    browser.localStorage.setItem("braindump.theme", "light");
    browser.dispatchEvent(
      new browser.StorageEvent("storage", {
        key: "braindump.theme",
        newValue: "light",
      }),
    );
  });
  assert.equal(selectedTheme(), "light");
  assert.equal(select.value, "light");

  await act(async () => {
    browser.localStorage.setItem("braindump.theme", "invalid theme");
    browser.dispatchEvent(
      new browser.StorageEvent("storage", {
        key: "braindump.theme",
        newValue: "invalid theme",
      }),
    );
  });
  assert.equal(select.value, "system");
  assert.equal(selectedTheme(), "dark");
  assert.equal(browser.localStorage.getItem("braindump.theme"), "system");

  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new Error("Storage blocked");
    },
  });
  await act(async () => toggle.click());
  assert.equal(selectedTheme(), "light");
  console.log("Theme interactions passed");
} finally {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
}
