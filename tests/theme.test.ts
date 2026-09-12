import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const bootstrap = readFileSync(
  new URL("../public/theme.js", import.meta.url),
  "utf8",
);

function openPage(saved: string | null, systemDark: boolean, blocked = false) {
  const classes = new Set(["app", "light", "dark"]);
  const style = { colorScheme: "" };
  const storage = new Map(saved === null ? [] : [["braindump.theme", saved]]);
  runInNewContext(bootstrap, {
    localStorage: {
      getItem(key: string) {
        if (blocked) throw new Error("Storage unavailable");
        return storage.get(key) ?? null;
      },
      removeItem(key: string) {
        storage.delete(key);
      },
    },
    window: { matchMedia: () => ({ matches: systemDark }) },
    document: {
      documentElement: {
        classList: {
          remove: (...names: string[]) =>
            names.forEach((n) => classes.delete(n)),
          add: (name: string) => classes.add(name),
        },
        style,
      },
    },
  });
  return { classes: [...classes], scheme: style.colorScheme, storage };
}

describe("theme before first paint", () => {
  test("a saved choice overrides the device and preserves unrelated classes", () => {
    expect(openPage("dark", false).classes).toEqual(["app", "dark"]);
    expect(openPage("dark", false).scheme).toBe("dark");
    expect(openPage("light", true).classes).toEqual(["app", "light"]);
    expect(openPage("light", true).scheme).toBe("light");
  });

  test("new and system preferences follow the current device appearance", () => {
    for (const saved of [null, "system"]) {
      expect(openPage(saved, true).scheme).toBe("dark");
      expect(openPage(saved, false).scheme).toBe("light");
    }
  });

  test("blocked storage still renders the device theme without throwing", () => {
    expect(openPage("light", true, true).scheme).toBe("dark");
    expect(openPage("dark", false, true).scheme).toBe("light");
  });

  test("invalid saved values are removed and cannot become CSS classes", () => {
    for (const saved of ["", "unknown", "dark light", "<script>"]) {
      const result = openPage(saved, true);
      expect(result.classes).toEqual(["app", "dark"]);
      expect(result.storage.has("braindump.theme")).toBe(false);
    }
  });
});

test("theme controls persist choices, follow system changes and synchronize tabs", async () => {
  const child = Bun.spawn(
    [process.execPath, "tests/fixtures/theme-interactions.ts"],
    {
      cwd: new URL("..", import.meta.url).pathname,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  expect(stdout).toContain("Theme interactions passed");
});

test("text and status palettes meet a 4.5:1 contrast ratio in both themes", () => {
  const css = readFileSync(
    new URL("../src/index.css", import.meta.url),
    "utf8",
  );
  const luminance = (hex: string) => {
    const color =
      hex.length === 3
        ? hex
            .split("")
            .map((c) => c + c)
            .join("")
        : hex;
    const channels = [0, 2, 4].map((offset) => {
      const channel =
        Number.parseInt(color.slice(offset, offset + 2), 16) / 255;
      return channel <= 0.04045
        ? channel / 12.92
        : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  for (const selector of [":root", ":root.dark"]) {
    const block = css.split(`${selector} {`)[1].split("}")[0];
    const colors = Object.fromEntries(
      [...block.matchAll(/--([\w-]+): #([\da-f]+);/g)].map((m) => [m[1], m[2]]),
    );
    for (const [foreground, background] of [
      ["foreground", "background"],
      ["foreground", "card"],
      ["muted-foreground", "background"],
      ["muted-foreground", "card"],
      ["content", "card"],
      ["primary-foreground", "primary"],
      ["destructive-foreground", "destructive"],
      ["danger", "danger-soft"],
      ["success", "success-soft"],
      ["warning", "warning-soft"],
      ["tag-foreground", "tag-background"],
      ["notice-foreground", "notice-background"],
    ]) {
      const a = luminance(colors[foreground]);
      const b = luminance(colors[background]);
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      expect({
        selector,
        foreground,
        background,
        passes: ratio >= 4.5,
      }).toEqual({
        selector,
        foreground,
        background,
        passes: true,
      });
    }
  }
});
