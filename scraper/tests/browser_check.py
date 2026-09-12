"""Opt-in real Chromium transport regressions, using only disposable local servers."""

import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch
from urllib.parse import urlparse

from scraper import extract, transport
from scraper.tests.test_network import PROSE
from scrapling.fetchers import StealthyFetcher


class BrowserChecks(unittest.TestCase):
    def test_redirects_subresources_and_route_bypasses_cannot_reach_private_destinations(
        self,
    ):
        hits = []
        cookies = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                hits.append(self.path)
                if self.path == "/article":
                    cookies.append(self.headers.get("Cookie", ""))
                self.send_response(302 if self.path.startswith("/redirect") else 200)
                if self.path == "/redirect-public":
                    self.send_header("Location", "/article")
                    self.send_header("Set-Cookie", "first=retained; Path=/")
                    self.send_header("Set-Cookie", "second=retained; Path=/")
                elif self.path == "/redirect-private":
                    self.send_header(
                        "Location",
                        f"http://127.0.0.1:{self.server.server_port}/private",
                    )
                self.send_header("Content-Type", "text/html")
                self.end_headers()
                content = (
                    f"<html><title>source TITLE</title><article><p>{PROSE}</p></article>"
                    f'<script>fetch("http://127.0.0.1:{self.server.server_port}/private-fetch").catch(()=>{{}});'
                    f'new WebSocket("ws://127.0.0.1:{self.server.server_port}/private-ws");'
                    'navigator.serviceWorker.register("/sw.js").catch(()=>{});</script></html>'
                )
                self.wfile.write(content.encode())

            def log_message(self, *_):
                pass

        with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            base = f"http://fixture.invalid:{server.server_port}"

            def endpoint(url):
                parsed = urlparse(url)
                if parsed.hostname != "fixture.invalid":
                    raise ValueError("Private fixture destination blocked")
                return parsed.hostname, server.server_port, ["127.0.0.1"]

            try:
                with patch("scraper.transport.public_endpoint", side_effect=endpoint):
                    result = extract.extract(
                        base + "/redirect-public", force_browser=True
                    )
                    self.assertEqual(result["title"], "source TITLE")
                    self.assertIn("Local databases", result["content"])
                    self.assertIn("/article", hits)
                    self.assertIn("first=retained", cookies[0])
                    self.assertIn("second=retained", cookies[0])
                    with self.assertRaisesRegex(
                        ValueError, "Private fixture destination blocked"
                    ):
                        extract.extract(base + "/redirect-private", force_browser=True)
                    self.assertFalse(
                        any(path.startswith("/private") for path in hits), hits
                    )
                    self.assertNotIn("/sw.js", hits)
                # Deliberately omit interception: even literal loopback must go
                # to the deny-only proxy rather than reaching this server.
                with transport.deny_browser_network() as proxy:
                    try:
                        StealthyFetcher.fetch(
                            f"http://127.0.0.1:{server.server_port}/private-unrouted",
                            headless=True,
                            retries=1,
                            timeout=5000,
                            wait=0,
                            google_search=False,
                            block_webrtc=True,
                            additional_args={
                                "service_workers": "block",
                                "proxy": proxy,
                            },
                            extra_flags=[
                                "--disable-quic",
                                "--proxy-bypass-list=<-loopback>",
                            ],
                        )
                    except Exception:
                        pass  # Chromium may report the deliberately rejected navigation.
                self.assertNotIn("/private-unrouted", hits)
            finally:
                server.shutdown()
                thread.join()


if __name__ == "__main__":
    unittest.main()
