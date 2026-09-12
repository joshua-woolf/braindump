export const MAX_URL_LENGTH = 8192;

export function normalizeUrl(value: string): string {
  const url = new URL(value.trim());
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Use an HTTP or HTTPS URL without embedded credentials.");
  if (url.port && !["80", "443"].includes(url.port))
    throw new Error("Only public web ports 80 and 443 are supported.");
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    !hostname.includes(".") ||
    /^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/.test(
      hostname,
    ) ||
    hostname.includes(":")
  )
    throw new Error(
      "Use a public webpage URL. Local and private network addresses are blocked.",
    );
  url.hash = "";
  for (const key of [...url.searchParams.keys()])
    if (/^utm_/i.test(key) || ["fbclid", "gclid", "msclkid"].includes(key))
      url.searchParams.delete(key);
  if (url.href.length > MAX_URL_LENGTH)
    throw new Error(`The normalized URL exceeds ${MAX_URL_LENGTH} characters.`);
  return url.href;
}

export function parseUrls(text: string) {
  const candidates = text.match(/https?:\/\/[^\s<>"']+/gi) || [];
  if (!candidates.length)
    throw new Error("Paste at least one http:// or https:// link.");
  if (candidates.length > 100)
    throw new Error("Add up to 100 links at a time.");
  const standalone = new Set(text.split(/\r?\n/).map((line) => line.trim()));
  return [
    ...new Set(
      candidates.map((candidate) => {
        // A URL on its own line is exact input: punctuation can be part of its path.
        if (standalone.has(candidate)) return normalizeUrl(candidate);
        let value = candidate.replace(/[.,;]+$/, "");
        for (const [open, close] of [
          ["(", ")"],
          ["[", "]"],
        ]) {
          while (
            value.endsWith(close) &&
            value.split(close).length > value.split(open).length
          )
            value = value.slice(0, -1);
        }
        return normalizeUrl(value);
      }),
    ),
  ];
}

export function parseLinkFile(text: string) {
  const urls = new Set<string>();
  const invalid: { line: number; error: string }[] = [];
  let entries = 0;
  let duplicates = 0;
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    entries++;
    try {
      const url = normalizeUrl(line);
      if (urls.has(url)) duplicates++;
      urls.add(url);
    } catch (error) {
      invalid.push({
        line: index + 1,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  return { entries, urls: [...urls], duplicates, invalid };
}
