import { timingSafeEqual } from "node:crypto";

export function desktopSession(token: string) {
  if (!/^[a-f0-9]{64}$/.test(token))
    throw new Error("Missing desktop session token.");
  const equal = (value: string) => {
    const bytes = Buffer.from(value);
    return (
      bytes.length === token.length &&
      timingSafeEqual(bytes, Buffer.from(token))
    );
  };
  return (request: Request): Response | null => {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");
    const headers = {
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    };
    if (
      url.hostname !== "127.0.0.1" ||
      (origin && origin !== url.origin) ||
      request.headers.get("sec-fetch-site") === "cross-site"
    )
      return new Response("Local desktop requests only.", {
        status: 403,
        headers,
      });
    if (
      request.method === "GET" &&
      url.pathname.startsWith("/__desktop/") &&
      equal(url.pathname.slice(11))
    )
      return new Response(null, {
        status: 303,
        headers: {
          ...headers,
          Location: "/",
          "Set-Cookie": `braindump-session=${token}; HttpOnly; SameSite=Strict; Path=/`,
        },
      });
    const cookie =
      request.headers
        .get("cookie")
        ?.split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith("braindump-session="))
        ?.slice(18) || "";
    if (!equal(cookie))
      return new Response("Open this library through the Braindump app.", {
        status: 401,
        headers,
      });
    return null;
  };
}
