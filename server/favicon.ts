import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { decodeHTMLAttribute } from "entities";
import { normalizeUrl } from "./urls";

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const)
  blocked.addSubnet(address, prefix, "ipv6");

export function isPublicIconAddress(address: string) {
  const family = isIP(address);
  return family === 4
    ? !blocked.check(address, "ipv4")
    : family === 6 &&
        globalV6.check(address, "ipv6") &&
        !blocked.check(address, "ipv6");
}

type Resource = { data: Buffer; type: string; url: string };
type Icon = { data: Uint8Array<ArrayBuffer>; type: string };
type ReadResource = typeof readResource;
const imageLimit = 256 * 1024;

async function readResource(
  value: string,
  signal: AbortSignal,
  limit: number,
): Promise<Resource> {
  let current = value;
  for (let redirects = 0; redirects <= 3; redirects++) {
    const url = new URL(normalizeUrl(current));
    if (isIP(url.hostname) && !isPublicIconAddress(url.hostname))
      throw new Error("Non-public icon address");
    const result = await new Promise<{
      data: Buffer;
      type: string;
      location?: string;
    }>((resolve, reject) => {
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
        url,
        {
          signal,
          agent: false,
          headers: {
            "User-Agent": "Braindump/1.0",
            Accept: "image/*,text/html;q=0.8",
            "Accept-Encoding": "identity",
          },
          // Use the checked DNS result for the actual connection, including redirects.
          lookup(host, options, callback) {
            void lookup(host, { all: true }).then(
              (addresses) => {
                if (
                  !addresses.length ||
                  addresses.some((a) => !isPublicIconAddress(a.address))
                )
                  return callback(new Error("Non-public icon address"), "", 4);
                if (options.all) return callback(null, addresses);
                const address =
                  addresses.find((a) => a.family === 4) || addresses[0];
                callback(null, address.address, address.family);
              },
              (error) => callback(error, "", 4),
            );
          },
        },
        (response) => {
          const status = response.statusCode || 0;
          if (
            [301, 302, 303, 307, 308].includes(status) &&
            response.headers.location
          ) {
            resolve({
              data: Buffer.alloc(0),
              type: "",
              location: response.headers.location,
            });
            response.destroy();
            return;
          }
          if (
            status !== 200 ||
            Number(response.headers["content-length"]) > limit ||
            (response.headers["content-encoding"] &&
              response.headers["content-encoding"] !== "identity")
          ) {
            reject(new Error("Icon response unavailable or too large"));
            response.destroy();
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > limit) {
              reject(new Error("Icon response too large"));
              response.destroy();
            } else chunks.push(chunk);
          });
          response.on("error", reject);
          response.on("end", () =>
            resolve({
              data: Buffer.concat(chunks),
              type: response.headers["content-type"] || "",
            }),
          );
        },
      );
      request.on("error", reject);
      request.end();
    });
    if (!result.location) return { ...result, url: url.href };
    current = new URL(result.location, url).href;
  }
  throw new Error("Too many icon redirects");
}

export function iconType(data: Buffer): string | null {
  if (!data.length || data.length > imageLimit) return null;
  const hex = data.subarray(0, 12).toString("hex");
  if (hex.startsWith("00000100")) return "image/x-icon";
  if (hex.startsWith("89504e470d0a1a0a")) return "image/png";
  if (hex.startsWith("ffd8ff")) return "image/jpeg";
  if (/^474946383[79]61/.test(hex)) return "image/gif";
  if (
    data.toString("ascii", 0, 4) === "RIFF" &&
    data.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";
  const text = data
    .toString("utf8")
    .replace(/^\uFEFF/, "")
    .trimStart();
  if (/^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(text))
    return "image/svg+xml";
  return null;
}

export function discoverIcons(html: string, pageUrl: string) {
  let base = pageUrl;
  let hasBase = false;
  const hrefs: string[] = [];
  new HTMLRewriter()
    .on("head base[href]", {
      element(element) {
        if (hasBase) return;
        hasBase = true;
        try {
          base = new URL(
            decodeHTMLAttribute(element.getAttribute("href")!),
            pageUrl,
          ).href;
        } catch {
          // An invalid base URL leaves relative icons resolved against the page.
        }
      },
    })
    .on("head link[href]", {
      element(element) {
        const rel = decodeHTMLAttribute(element.getAttribute("rel") || "")
          .toLowerCase()
          .split(/\s+/);
        if (
          hrefs.length < 12 &&
          (rel.includes("icon") || rel.includes("apple-touch-icon"))
        )
          hrefs.push(decodeHTMLAttribute(element.getAttribute("href")!));
      },
    })
    .transform(html);
  return [
    ...new Set(
      hrefs.flatMap((href) => {
        try {
          return [normalizeUrl(new URL(href, base).href)];
        } catch {
          return [];
        }
      }),
    ),
  ].slice(0, 3);
}

export async function loadFavicon(
  origin: string,
  read: ReadResource = readResource,
): Promise<Icon | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  const tryIcon = async (url: string) => {
    try {
      const result = await read(url, controller.signal, imageLimit);
      const type = iconType(result.data);
      return type ? { data: new Uint8Array(result.data), type } : null;
    } catch {
      return null;
    }
  };
  try {
    const root = new URL("/favicon.ico", normalizeUrl(origin)).href;
    const common = await tryIcon(root);
    if (common) return common;
    const page = await read(
      new URL("/", origin).href,
      controller.signal,
      512 * 1024,
    );
    if (!page.type.toLowerCase().includes("text/html")) return null;
    for (const url of discoverIcons(page.data.toString("utf8"), page.url)) {
      if (url === root) continue;
      const icon = await tryIcon(url);
      if (icon) return icon;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const fallback =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#5e63a5" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a18 18 0 0 1 0 18 18 18 0 0 1 0-18Z"/></svg>';

export class FaviconCache {
  private cache = new Map<string, { icon: Icon | null; expires: number }>();
  private pending = new Map<string, Promise<Icon | null>>();
  private active = 0;
  private waiting: (() => void)[] = [];
  constructor(private load = loadFavicon) {}

  private async get(origin: string) {
    const cached = this.cache.get(origin);
    if (cached && cached.expires > Date.now()) return cached.icon;
    const pending = this.pending.get(origin);
    if (pending) return pending;
    if (this.pending.size >= 32) return null;
    const task = (async () => {
      if (this.active >= 6)
        await new Promise<void>((resolve) => this.waiting.push(resolve));
      else this.active++;
      try {
        const icon = await this.load(origin).catch(() => null);
        this.cache.delete(origin);
        this.cache.set(origin, {
          icon,
          expires: Date.now() + (icon ? 86_400_000 : 3_600_000),
        });
        if (this.cache.size > 128)
          this.cache.delete(this.cache.keys().next().value!);
        return icon;
      } finally {
        const next = this.waiting.shift();
        if (next) next();
        else this.active--;
      }
    })();
    this.pending.set(origin, task);
    try {
      return await task;
    } finally {
      this.pending.delete(origin);
    }
  }

  async response(url: string) {
    const icon = await this.get(new URL(normalizeUrl(url)).origin);
    return new Response(icon?.data || fallback, {
      headers: {
        "Content-Type": icon?.type || "image/svg+xml",
        "Cache-Control": `private, max-age=${icon ? 86400 : 3600}`,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        "Referrer-Policy": "no-referrer",
        "Cross-Origin-Resource-Policy": "same-origin",
      },
    });
  }
}
