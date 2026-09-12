"""Bounded, DNS-pinned HTTP for extraction and intercepted browser requests."""

import ipaddress
import re
import socket
from contextlib import closing, contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from types import SimpleNamespace
from urllib.parse import urljoin, urlparse

from curl_cffi import Curl, CurlInfo, CurlOpt
from scrapling.fetchers import StealthySession

MAX_HTML = 8_000_000
MAX_PDF = 20_000_000
MAX_BROWSER_BYTES = 40_000_000
MAX_BROWSER_REQUESTS = 100


class UnsupportedContent(ValueError):
    """A browser retry cannot turn this response into supported text."""


def public_endpoint(url):
    parsed = urlparse(url)
    if (
        parsed.scheme not in ("https", "http")
        or not parsed.hostname
        or parsed.username
        or parsed.password
    ):
        raise ValueError("Only public HTTP(S) pages are supported.")
    port = (
        parsed.port
        if parsed.port is not None
        else (443 if parsed.scheme == "https" else 80)
    )
    if port not in (80, 443):
        raise ValueError("Only standard public web ports are supported.")
    host = parsed.hostname.encode("idna").decode("ascii").lower()
    addresses = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    ips = list(dict.fromkeys(a[4][0] for a in addresses))
    if not ips or any(
        not (address := ipaddress.ip_address(ip)).is_global
        or address.is_multicast
        or address.is_reserved
        for ip in ips
    ):
        raise ValueError("Private and local network addresses are blocked.")
    return host, port, ips


def public_url(url):
    public_endpoint(url)
    return url


def fetch_page(url, *, method="GET", headers=None, data=None, budget=None):
    """One request, no redirects/proxies: libcurl connects to the checked IPs.

    Callbacks bound decoded body bytes during transfer, without the unbounded
    producer queue used by requests.stream(). TLS still verifies the URL host.
    """
    host, port, ips = public_endpoint(url)
    body = bytearray()
    response_headers = {}
    header_bytes = 0
    if budget is not None:
        budget["requests"] += 1
        if budget["requests"] > MAX_BROWSER_REQUESTS:
            raise UnsupportedContent("Browser exceeded the 100-request limit.")

    def receive_header(chunk):
        nonlocal header_bytes
        header_bytes += len(chunk)
        if header_bytes > 65_536:
            raise UnsupportedContent("Response headers exceed the 64 KB limit.")
        line = chunk.decode("latin-1").strip()
        if line.startswith("HTTP/"):
            response_headers.clear()
        elif ":" in line:
            key, value = line.split(":", 1)
            key = key.lower()
            value = value.strip()
            if key == "set-cookie" and key in response_headers:
                value = response_headers[key] + "\n" + value
            if key == "content-length" and value.isdecimal() and int(value) > MAX_PDF:
                raise UnsupportedContent("Response exceeds the 20 MB download limit.")
            response_headers[key] = value
        return len(chunk)

    def receive_body(chunk):
        prefix = (body[:5] + chunk[:5])[:5]
        pdf = (
            response_headers.get("content-type", "").split(";", 1)[0].lower()
            == "application/pdf"
            or prefix == b"%PDF-"
        )
        limit = MAX_PDF if pdf else MAX_HTML
        if len(body) + len(chunk) > limit:
            raise UnsupportedContent(
                "PDF exceeds the 20 MB extraction limit."
                if pdf
                else "Page exceeds the 8 MB extraction limit."
            )
        if budget is not None:
            budget["bytes"] += len(chunk)
            if budget["bytes"] > MAX_BROWSER_BYTES:
                raise UnsupportedContent("Browser exceeded the 40 MB transfer limit.")
        body.extend(chunk)
        return len(chunk)

    with closing(Curl()) as curl:
        curl.impersonate("chrome")
        # Use the same ASCII host in the URL and DNS cache key, including IDNs.
        authority = f"[{host}]" if ":" in host else host
        request_url = (
            urlparse(url)._replace(netloc=f"{authority}:{port}", fragment="").geturl()
        )
        curl.setopt(CurlOpt.URL, request_url.encode())
        curl.setopt(CurlOpt.SSL_VERIFYPEER, 1)
        curl.setopt(CurlOpt.SSL_VERIFYHOST, 2)
        # A fresh handle per request prevents reuse/coalescing across DNS checks.
        resolved = ",".join(f"[{ip}]" if ":" in ip else ip for ip in ips)
        curl.setopt(CurlOpt.RESOLVE, [f"{authority}:{port}:{resolved}".encode()])
        curl.setopt(CurlOpt.PROXY, b"")
        curl.setopt(CurlOpt.PROTOCOLS, 3)  # CURLPROTO_HTTP | CURLPROTO_HTTPS
        curl.setopt(CurlOpt.FOLLOWLOCATION, 0)
        curl.setopt(CurlOpt.TIMEOUT_MS, 25_000)
        curl.setopt(CurlOpt.CONNECTTIMEOUT_MS, 10_000)
        curl.setopt(CurlOpt.MAXFILESIZE_LARGE, MAX_PDF)
        curl.setopt(CurlOpt.ACCEPT_ENCODING, b"gzip, deflate, br")
        curl.setopt(CurlOpt.HEADERFUNCTION, receive_header)
        curl.setopt(CurlOpt.WRITEFUNCTION, receive_body)
        if headers:
            curl.setopt(
                CurlOpt.HTTPHEADER,
                [
                    f"{key}: {value}".encode()
                    for key, value in headers.items()
                    if key.lower()
                    not in ("host", "content-length", "accept-encoding", "connection")
                    and not key.lower().startswith("proxy-")
                ],
            )
        if data is not None:
            if len(data) > MAX_HTML:
                raise UnsupportedContent("Browser request body exceeds 8 MB.")
            curl.setopt(CurlOpt.POSTFIELDS, data)
        curl.setopt(CurlOpt.CUSTOMREQUEST, method.encode())
        curl.perform()
        status = curl.getinfo(CurlInfo.RESPONSE_CODE)
    encoding = re.search(
        r"charset=([\w-]+)", response_headers.get("content-type", ""), re.I
    )
    try:
        html = body.decode(encoding[1] if encoding else "utf-8", errors="replace")
    except LookupError:
        html = body.decode("utf-8", errors="replace")
    return SimpleNamespace(
        url=url,
        status=status,
        headers=response_headers,
        body=bytes(body),
        html_content=html,
    )


def browser_setup(page, budget):
    def guard(route):
        try:
            request = route.request
            if request.resource_type in ("media", "font", "image"):
                route.abort()
                return
            url = request.url
            method = request.method
            headers = request.all_headers()
            data = request.post_data_buffer
            for _ in range(8):
                response = fetch_page(
                    url, method=method, headers=headers, data=data, budget=budget
                )
                if not 300 <= response.status < 400:
                    break
                if not response.headers.get("location"):
                    raise ValueError("Redirect has no destination.")
                target = urljoin(url, response.headers["location"])
                public_url(target)
                if request.is_navigation_request() and request.frame == page.main_frame:
                    if method not in ("GET", "HEAD") and response.status in (307, 308):
                        raise UnsupportedContent(
                            "Redirected form navigation requires an interactive browser."
                        )
                    # Complete locally so Chromium accepts Set-Cookie, then let
                    # the session navigate afresh; never follow its redirect chain.
                    budget["redirect"] = target
                    route.fulfill(
                        status=200,
                        headers={"set-cookie": response.headers["set-cookie"]}
                        if "set-cookie" in response.headers
                        else {},
                        body="",
                    )
                    return
                if urlparse(url)[:2] != urlparse(target)[:2]:
                    headers = {
                        key: value
                        for key, value in headers.items()
                        if key.lower() not in ("cookie", "authorization")
                    }
                if response.status == 303 or (
                    response.status in (301, 302) and method == "POST"
                ):
                    method, data = "GET", None
                url = target
            else:
                raise ValueError("Too many redirects.")
            headers = {
                key: value
                for key, value in response.headers.items()
                if key
                not in ("content-encoding", "content-length", "transfer-encoding")
            }
            # Never continue a request: browser redirects must come back through
            # this handler or hit the deny-only proxy, including routing gaps.
            route.fulfill(status=response.status, headers=headers, body=response.body)
        except Exception as error:
            budget["error"] = str(error)
            route.abort()

    page.context.route("**/*", guard)
    page.context.route_web_socket("**/*", lambda route: route.close())


@contextmanager
def deny_browser_network():
    """Fail closed if Chromium emits traffic outside request interception."""

    class Deny(BaseHTTPRequestHandler):
        def handle(self):
            self.request.settimeout(1)
            self.request.sendall(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")

    with ThreadingHTTPServer(("127.0.0.1", 0), Deny) as server:
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield {
                "server": f"http://127.0.0.1:{server.server_port}",
                "bypass": "<-loopback>",
            }
        finally:
            server.shutdown()
            thread.join()


def fetch_browser(url):
    budget = {"requests": 0, "bytes": 0, "error": "", "redirect": ""}
    with (
        deny_browser_network() as proxy,
        StealthySession(
            headless=True,
            solve_cloudflare=True,
            timeout=45000,
            wait=1500,
            retries=1,
            network_idle=False,
            google_search=False,
            block_webrtc=True,
            additional_args={"service_workers": "block", "proxy": proxy},
            extra_flags=["--disable-quic", "--proxy-bypass-list=<-loopback>"],
        ) as browser,
    ):
        for _ in range(8):
            budget["redirect"] = ""
            try:
                page = browser.fetch(
                    url, page_setup=lambda page: browser_setup(page, budget)
                )
            except Exception as error:
                raise ValueError(f"{error} | {budget['error']}") from error
            if not budget["redirect"]:
                return page
            url = budget["redirect"]
        raise ValueError("Too many browser redirects.")
