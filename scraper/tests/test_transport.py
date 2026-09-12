"""Real libcurl transfers against disposable loopback servers; no public network."""

import gzip
import socket
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import Mock, patch
from urllib.parse import urlparse

from scraper import transport
from scraper.tests.test_extract import address


class TransportServer:
    def __init__(self):
        self.paths = []
        self.sent = 0
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                fixture.paths.append(self.path)
                if self.path == "/redirect":
                    self.send_response(302)
                    self.send_header("Location", "/ok")
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                if self.path == "/compressed":
                    self.send_header("Content-Encoding", "gzip")
                self.end_headers()
                try:
                    if self.path == "/large":
                        for _ in range(100):
                            self.wfile.write(b"x" * 1024)
                            self.wfile.flush()
                            fixture.sent += 1024
                            time.sleep(0.001)
                    elif self.path == "/compressed":
                        self.wfile.write(gzip.compress(b"x" * 1_000_000))
                    else:
                        self.wfile.write(
                            b"<title>original TITLE</title><p>Fixture body</p>"
                        )
                except (BrokenPipeError, ConnectionResetError):
                    pass  # The bounded client deliberately closes an oversized transfer.

            def log_message(self, *_):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://fixture.invalid:{self.server.server_port}"

    def endpoint(self, url):
        parsed = urlparse(url)
        if parsed.hostname != "fixture.invalid":
            raise ValueError("Blocked fixture destination")
        return parsed.hostname, self.server.server_port, ["127.0.0.1"]

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()


class TransferTests(unittest.TestCase):
    def setUp(self):
        self.fixture = TransportServer()
        self.addCleanup(self.fixture.close)
        self.endpoint = self.enterContext(
            patch(
                "scraper.transport.public_endpoint", side_effect=self.fixture.endpoint
            )
        )

    def test_pinned_connection_never_resolves_again_or_uses_environment_proxy(self):
        # The synthetic host has no DNS record. Only the checked address can work.
        with (
            patch(
                "socket.getaddrinfo", side_effect=AssertionError("Second DNS lookup")
            ),
            patch.dict(
                "os.environ",
                {"http_proxy": "http://127.0.0.1:1", "ALL_PROXY": "http://127.0.0.1:1"},
            ),
        ):
            result = transport.fetch_page(self.fixture.url + "/ok")
        self.assertEqual(result.status, 200)
        self.assertIn("original TITLE", result.html_content)
        self.endpoint.assert_called_once()
        self.assertEqual(self.fixture.paths, ["/ok"])

    def test_international_hostname_uses_the_checked_ascii_host_for_the_socket(self):
        host = "fíxture.invalid"
        ascii_host = host.encode("idna").decode("ascii")
        self.endpoint.side_effect = None
        self.endpoint.return_value = (
            ascii_host,
            self.fixture.server.server_port,
            ["127.0.0.1"],
        )
        result = transport.fetch_page(
            f"http://{host}:{self.fixture.server.server_port}/ok"
        )
        self.assertEqual(result.status, 200)
        self.assertEqual(self.fixture.paths, ["/ok"])

    def test_redirect_is_returned_without_sending_a_second_request(self):
        result = transport.fetch_page(self.fixture.url + "/redirect")
        self.assertEqual(result.status, 302)
        self.assertEqual(result.headers["location"], "/ok")
        self.assertEqual(self.fixture.paths, ["/redirect"])

    def test_oversized_chunked_download_stops_before_the_server_finishes(self):
        with patch("scraper.transport.MAX_HTML", 4096):
            with self.assertRaisesRegex(transport.UnsupportedContent, "8 MB"):
                transport.fetch_page(self.fixture.url + "/large")
        self.assertLess(self.fixture.sent, 100 * 1024)

    def test_compressed_content_is_limited_during_decompression(self):
        with patch("scraper.transport.MAX_HTML", 4096):
            with self.assertRaisesRegex(transport.UnsupportedContent, "8 MB"):
                transport.fetch_page(self.fixture.url + "/compressed")

    def test_browser_total_bytes_and_request_count_are_bounded(self):
        budget = {"requests": 0, "bytes": 0}
        with patch("scraper.transport.MAX_BROWSER_BYTES", 70):
            transport.fetch_page(self.fixture.url + "/ok", budget=budget)
            with self.assertRaisesRegex(transport.UnsupportedContent, "40 MB"):
                transport.fetch_page(self.fixture.url + "/ok", budget=budget)
        budget["requests"] = transport.MAX_BROWSER_REQUESTS
        with self.assertRaisesRegex(transport.UnsupportedContent, "100-request"):
            transport.fetch_page(self.fixture.url + "/ok", budget=budget)
        self.assertEqual(len(self.fixture.paths), 2)

    def test_browser_fulfills_checked_bytes_and_never_continues_a_network_request(self):
        context = Mock()
        budget = {"requests": 0, "bytes": 0, "error": ""}
        transport.browser_setup(Mock(context=context), budget)
        guard = context.route.call_args.args[1]
        request = Mock(
            url=self.fixture.url + "/ok",
            method="GET",
            resource_type="document",
            post_data_buffer=None,
        )
        request.all_headers.return_value = {}
        route = Mock(request=request)
        guard(route)
        route.continue_.assert_not_called()
        self.assertIn(b"Fixture body", route.fulfill.call_args.kwargs["body"])
        request.url = "http://127.0.0.1/private"
        guard(route)
        route.abort.assert_called_once()
        self.assertIn("Blocked", budget["error"])
        self.assertEqual(self.fixture.paths, ["/ok"])


class AddressTests(unittest.TestCase):
    def test_mixed_public_private_dns_and_empty_answers_fail_closed(self):
        for answers in (
            [address("1.1.1.1"), address("127.0.0.1")],
            [address("224.0.0.1")],
            [address("ff02::1")],
            [],
        ):
            with patch("socket.getaddrinfo", return_value=answers):
                with self.assertRaisesRegex(ValueError, "Private"):
                    transport.fetch_page("https://example.com/")

    def test_explicit_zero_port_is_rejected_before_dns(self):
        with patch("socket.getaddrinfo") as lookup:
            with self.assertRaisesRegex(ValueError, "standard public web ports"):
                transport.public_endpoint("http://example.com:0/")
            lookup.assert_not_called()

    def test_checked_dns_values_are_the_exact_values_returned_for_pinning(self):
        answers = [address("1.1.1.1"), address("1.0.0.1")]
        with patch(
            "socket.getaddrinfo", side_effect=[answers, socket.gaierror("rebound")]
        ) as lookup:
            self.assertEqual(
                transport.public_endpoint("http://example.com/a"),
                ("example.com", 80, ["1.1.1.1", "1.0.0.1"]),
            )
            lookup.assert_called_once_with("example.com", 80, type=socket.SOCK_STREAM)

    def test_international_dns_lookup_is_canonicalized_before_validation(self):
        with patch("socket.getaddrinfo", return_value=[address("1.1.1.1")]) as lookup:
            host, port, ips = transport.public_endpoint("https://fíxture.invalid/")
            self.assertEqual(host, "fíxture.invalid".encode("idna").decode("ascii"))
            lookup.assert_called_once_with(host, 443, type=socket.SOCK_STREAM)
            self.assertEqual((port, ips), (443, ["1.1.1.1"]))


class BrowserRoutingTests(unittest.TestCase):
    def setUp(self):
        self.enterContext(
            patch(
                "scraper.transport.socket.getaddrinfo",
                return_value=[address("1.1.1.1")],
            )
        )
        self.page = Mock()
        self.budget = {"requests": 0, "bytes": 0, "error": "", "redirect": ""}
        transport.browser_setup(self.page, self.budget)
        self.guard = self.page.context.route.call_args.args[1]
        self.request = Mock(
            url="https://example.com/start",
            method="POST",
            resource_type="script",
            post_data_buffer=b"body",
        )
        self.request.is_navigation_request.return_value = False
        self.request.all_headers.return_value = {
            "Cookie": "private=value",
            "Authorization": "secret",
            "accept": "*/*",
        }
        self.route = Mock(request=self.request)

    def test_cross_host_subresource_redirect_drops_credentials_and_post_body(self):
        responses = [
            Mock(status=302, headers={"location": "https://other.example/final"}),
            Mock(
                status=200,
                headers={"content-encoding": "gzip", "content-type": "text/javascript"},
                body=b"script",
            ),
        ]
        with patch("scraper.transport.fetch_page", side_effect=responses) as fetch:
            self.guard(self.route)
        self.assertEqual(fetch.call_count, 2)
        self.assertEqual(fetch.call_args.kwargs["method"], "GET")
        self.assertIsNone(fetch.call_args.kwargs["data"])
        self.assertEqual(fetch.call_args.kwargs["headers"], {"accept": "*/*"})
        self.assertEqual(
            self.route.fulfill.call_args.kwargs["headers"],
            {"content-type": "text/javascript"},
        )
        self.route.continue_.assert_not_called()

    def test_protocol_downgrade_drops_credentials_even_on_the_same_host(self):
        responses = [
            Mock(status=307, headers={"location": "http://example.com/final"}),
            Mock(status=200, headers={}, body=b"script"),
        ]
        with patch("scraper.transport.fetch_page", side_effect=responses) as fetch:
            self.guard(self.route)
        self.assertEqual(fetch.call_args.kwargs["headers"], {"accept": "*/*"})
        self.assertEqual(fetch.call_args.kwargs["method"], "POST")
        self.assertEqual(fetch.call_args.kwargs["data"], b"body")
        self.route.continue_.assert_not_called()

    def test_missing_location_private_targets_and_redirect_loops_abort(self):
        for headers, message in [
            ({}, "no destination"),
            ({"location": "http://127.0.0.1/"}, "Private"),
            ({"location": "/loop"}, "Too many"),
        ]:
            with (
                self.subTest(headers=headers),
                patch(
                    "scraper.transport.fetch_page",
                    return_value=Mock(status=302, headers=headers),
                ),
            ):
                if "127.0.0.1" in headers.get("location", ""):
                    with patch(
                        "socket.getaddrinfo", return_value=[address("127.0.0.1")]
                    ):
                        self.guard(self.route)
                else:
                    self.guard(self.route)
                self.assertIn(message, self.budget["error"])
                self.route.fulfill.assert_not_called()
        self.assertEqual(self.route.abort.call_count, 3)

    def test_main_redirect_keeps_cookies_and_requests_a_fresh_navigation(self):
        self.request.is_navigation_request.return_value = True
        self.request.frame = self.page.main_frame
        with patch(
            "scraper.transport.fetch_page",
            return_value=Mock(
                status=302,
                headers={"location": "/final", "set-cookie": "session=value; Path=/"},
            ),
        ):
            self.guard(self.route)
        self.assertEqual(self.budget["redirect"], "https://example.com/final")
        self.assertEqual(
            self.route.fulfill.call_args.kwargs,
            {
                "status": 200,
                "headers": {"set-cookie": "session=value; Path=/"},
                "body": "",
            },
        )
        self.route.continue_.assert_not_called()

    def test_browser_session_navigation_loop_and_isolation_are_bounded(self):
        with patch("scraper.transport.StealthySession") as session:
            browser = session.return_value.__enter__.return_value

            def redirect(url, page_setup):
                page_setup(self.page)
                guard = self.page.context.route.call_args.args[1]
                self.request.method = "GET"
                self.request.is_navigation_request.return_value = True
                self.request.frame = self.page.main_frame
                self.request.url = url
                guard(self.route)
                return Mock()

            browser.fetch.side_effect = redirect
            with patch(
                "scraper.transport.fetch_page",
                return_value=Mock(status=302, headers={"location": "/loop"}),
            ):
                with self.assertRaisesRegex(ValueError, "Too many browser redirects"):
                    transport.fetch_browser("https://example.com/start")
            self.assertEqual(browser.fetch.call_count, 8)
            options = session.call_args.kwargs
            self.assertEqual(options["additional_args"]["service_workers"], "block")
            self.assertEqual(
                options["additional_args"]["proxy"]["bypass"], "<-loopback>"
            )
            self.assertTrue(options["block_webrtc"])
            self.assertIn("--disable-quic", options["extra_flags"])
