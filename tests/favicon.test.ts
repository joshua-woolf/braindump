import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverIcons,
  FaviconCache,
  iconType,
  isPublicIconAddress,
  loadFavicon,
} from "../server/favicon";
import { Store } from "../server/db";
import { Worker } from "../server/worker";
import { createApi } from "../server/api";

const svg = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>',
);
const icon = { data: new Uint8Array(svg), type: "image/svg+xml" };

describe("site favicons", () => {
  test("blocks local, private, reserved and mapped addresses while allowing public DNS results", () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "100.64.1.1",
      "169.254.169.254",
      "172.31.0.1",
      "192.168.1.1",
      "0.0.0.0",
      "198.18.0.1",
      "192.0.2.1",
      "224.0.0.1",
      "255.255.255.255",
      "::1",
      "::ffff:127.0.0.1",
      "fc00::1",
      "fe80::1",
      "2001:db8::1",
      "2002:7f00:1::",
      "not-an-address",
    ])
      expect(isPublicIconAddress(address)).toBe(false);
    expect(isPublicIconAddress("1.1.1.1")).toBe(true);
    expect(isPublicIconAddress("2606:4700:4700::1111")).toBe(true);
  });
  test("discovers declared icons with base URLs, entities and case-insensitive rel tokens", () => {
    const urls = discoverIcons(
      `<html><head><base href="/assets/"><link rel="stylesheet" href="no.css"><link href="icon.svg?a=1&amp;b=2" rel="SHORTCUT ICON"><link rel="apple-touch-icon" href="//cdn.example.com/apple.png"><link rel="icon" href="icon.svg?a=1&amp;b=2"><link rel="icon" href="http://127.0.0.1/private"><link rel="icon" href="data:image/png;base64,bad"></head></html>`,
      "https://example.com/docs/page",
    );
    expect(urls).toEqual([
      "https://example.com/assets/icon.svg?a=1&b=2",
      "https://cdn.example.com/apple.png",
    ]);
  });
  test("bounds discovered candidates and does not treat body content as icon declarations", () => {
    const html = `<head>${Array.from({ length: 20 }, (_, i) => `<link rel="icon" href="/${i}.png">`).join("")}</head><body><link rel="icon" href="/body.png"></body>`;
    expect(discoverIcons(html, "https://example.com/")).toEqual([
      "https://example.com/0.png",
      "https://example.com/1.png",
      "https://example.com/2.png",
    ]);
  });
  test("rejects HTML challenge pages and oversized payloads regardless of declared MIME type", () => {
    expect(iconType(Buffer.from("<html>Access denied</html>"))).toBeNull();
    expect(iconType(Buffer.alloc(256 * 1024 + 1))).toBeNull();
    expect(iconType(svg)).toBe("image/svg+xml");
    expect(iconType(Buffer.from("89504e470d0a1a0a00000000", "hex"))).toBe(
      "image/png",
    );
    expect(iconType(Buffer.from("000001000100", "hex"))).toBe("image/x-icon");
  });
  test("uses the conventional icon without fetching the homepage", async () => {
    const calls: string[] = [];
    const result = await loadFavicon("https://example.com", async (url) => {
      calls.push(url);
      return { data: svg, type: "application/octet-stream", url };
    });
    expect(calls).toEqual(["https://example.com/favicon.ico"]);
    expect(result?.type).toBe("image/svg+xml");
  });
  test("falls back to declared icons relative to the redirected homepage", async () => {
    const calls: string[] = [];
    const result = await loadFavicon(
      "https://example.com",
      async (url, _signal, limit) => {
        calls.push(url);
        if (url.endsWith("favicon.ico"))
          return {
            data: Buffer.from("<html>Not found</html>"),
            type: "text/html",
            url,
          };
        if (url === "https://example.com/") {
          expect(limit).toBe(512 * 1024);
          return {
            data: Buffer.from(
              '<head><link rel="icon" href="assets/icon.svg"></head>',
            ),
            type: "text/html; charset=utf-8",
            url: "https://www.example.com/home/",
          };
        }
        expect(limit).toBe(256 * 1024);
        return { data: svg, type: "image/svg+xml", url };
      },
    );
    expect(calls).toEqual([
      "https://example.com/favicon.ico",
      "https://example.com/",
      "https://www.example.com/home/assets/icon.svg",
    ]);
    expect(result?.type).toBe("image/svg+xml");
  });
  test("uses a cached neutral fallback when a site has no usable icon", async () => {
    let calls = 0;
    const cache = new FaviconCache(async () => {
      calls++;
      throw new Error("Unavailable");
    });
    for (let i = 0; i < 2; i++) {
      const response = await cache.response("https://example.com/article");
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("<svg");
      expect(response.headers.get("Cache-Control")).toContain("max-age=3600");
    }
    expect(calls).toBe(1);
  });
  test("deduplicates requests by origin, caches results and isolates returned SVGs", async () => {
    let calls = 0;
    const cache = new FaviconCache(async () => {
      calls++;
      await Bun.sleep(5);
      return icon;
    });
    const results = await Promise.all([
      cache.response("https://example.com/a"),
      cache.response("https://example.com/b"),
    ]);
    await cache.response("https://example.com/c");
    expect(calls).toBe(1);
    for (const result of results) {
      expect(result.headers.get("Content-Type")).toBe("image/svg+xml");
      expect(result.headers.get("Content-Security-Policy")).toContain(
        "sandbox",
      );
      expect(result.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(result.headers.get("Cross-Origin-Resource-Policy")).toBe(
        "same-origin",
      );
      expect(await result.text()).toBe(svg.toString());
    }
  });
  test("limits concurrent icon lookups independently of the model queue", async () => {
    let active = 0,
      maximum = 0;
    const cache = new FaviconCache(async () => {
      active++;
      maximum = Math.max(active, maximum);
      await Bun.sleep(5);
      active--;
      return icon;
    });
    await Promise.all(
      Array.from({ length: 15 }, (_, i) =>
        cache.response(`https://site${i}.example.com/`),
      ),
    );
    expect(maximum).toBe(6);
    expect(active).toBe(0);
  });
  test("the API serves icons only for saved links without changing library or jobs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "braindump-icon-test-"));
    const store = new Store(dir);
    try {
      const calls: string[] = [];
      const cache = new FaviconCache(async (origin) => {
        calls.push(origin);
        return icon;
      });
      const api = createApi(store, new Worker(store), cache);
      const { id } = store.add("https://example.com/article");
      const before = store.export();
      const jobs = store.jobs();
      const url = `http://127.0.0.1:3210/api/links/${id}/favicon`;
      const response = await api(new Request(url));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(svg.toString());
      expect(calls).toEqual(["https://example.com"]);
      expect(store.export().links).toEqual(before.links);
      expect(store.jobs()).toEqual(jobs);
      expect(
        (
          await api(
            new Request(url, { headers: { Origin: "https://evil.example" } }),
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await api(
            new Request(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: "{}",
            }),
          )
        ).status,
      ).toBe(405);
      expect(
        (
          await api(
            new Request(
              `http://127.0.0.1:3210/api/links/${crypto.randomUUID()}/favicon`,
            ),
          )
        ).status,
      ).toBe(404);
      expect(calls).toHaveLength(1);
    } finally {
      store.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
