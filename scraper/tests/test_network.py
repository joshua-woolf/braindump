"""Exercise extraction orchestration with fake DNS, HTTP and browser transports."""

import json
import runpy
import socket
import unittest
from contextlib import redirect_stdout
from io import StringIO
from types import SimpleNamespace
from unittest.mock import patch

from scraper import extract
from scraper.tests.test_extract import address, pdf_fixture, response

PROSE = (
    "Local databases preserve saved articles and allow readers to search their complete library without a remote service. "
    "Each record contains the source title, readable text and independent read and archive flags. "
    "A transaction updates the article and search index together so a failure cannot leave inconsistent records. "
    "Background jobs fetch pages, generate summaries and offer useful tags for later review. "
    "Regular backups let the reader recover their collection when a disk fails or an edit removes important information."
)


def article_page():
    return response(
        f"<html><head><title>original PAGE title</title></head><body><article><p>{PROSE}</p></article></body></html>"
    )


class TransportTests(unittest.TestCase):
    def setUp(self):
        self.dns = self.enterContext(
            patch(
                "scraper.transport.socket.getaddrinfo",
                return_value=[address("1.1.1.1")],
            )
        )
        self.http = self.enterContext(
            patch(
                "scraper.extract.fetch_page",
                side_effect=AssertionError("Unexpected HTTP request"),
            )
        )
        self.browser = self.enterContext(
            patch(
                "scraper.extract.fetch_browser",
                side_effect=AssertionError("Unexpected browser request"),
            )
        )

    def test_http_success_preserves_source_title_and_does_not_launch_a_browser(self):
        self.http.side_effect = None
        self.http.return_value = article_page()
        result = extract.extract("https://example.com/")
        self.assertEqual(result["title"], "original PAGE title")
        self.assertIn("Local databases", result["content"])
        self.assertTrue(result["method"].startswith("scrapling-http"))
        self.browser.assert_not_called()

    def test_http_redirects_resolve_relative_and_absolute_destinations_explicitly(self):
        final = article_page()
        final.url = "https://other.example.com/article"
        self.http.side_effect = [
            SimpleNamespace(status=301, headers={"Location": "/next"}),
            SimpleNamespace(status=302, headers={"location": final.url}),
            final,
        ]
        result = extract.extract("https://example.com/start")
        self.assertIn("Local databases", result["content"])
        self.assertEqual(
            [call.args[0] for call in self.http.call_args_list],
            ["https://example.com/start", "https://example.com/next", final.url],
        )
        self.browser.assert_not_called()

    def test_missing_redirect_location_and_redirect_loops_leave_actionable_errors(self):
        for headers, message, calls in [
            ({}, "Redirect has no destination", 1),
            ({"Location": "/loop"}, "Too many redirects", 8),
        ]:
            with self.subTest(headers=headers):
                self.http.reset_mock()
                self.http.side_effect = None
                self.http.return_value = SimpleNamespace(status=302, headers=headers)
                self.browser.side_effect = RuntimeError(
                    "Browser dependencies unavailable"
                )
                with self.assertRaisesRegex(ValueError, message):
                    extract.extract("https://example.com/")
                self.assertEqual(self.http.call_count, calls)

    def test_browser_fallback_recovers_a_failed_http_request(self):
        self.http.side_effect = TimeoutError("HTTP timed out")
        self.browser.side_effect = None
        self.browser.return_value = article_page()
        result = extract.extract("https://example.com/")
        self.assertTrue(result["method"].startswith("scrapling-browser"))
        self.browser.assert_called_once()

    def test_forced_browser_uses_isolation_and_skips_the_http_fast_path(self):
        self.browser.side_effect = None
        self.browser.return_value = article_page()
        extract.extract("https://example.com/", force_browser=True)
        self.http.assert_not_called()

    def test_unsupported_file_does_not_launch_browser_fallback(self):
        self.http.side_effect = None
        self.http.return_value = response(b"PK\x00\x01archive", "application/zip")
        with self.assertRaises(extract.UnsupportedContent):
            extract.extract("https://example.com/file.zip")
        self.browser.assert_not_called()

    def test_empty_dns_and_lookup_failures_stop_before_fetching(self):
        self.dns.return_value = []
        with self.assertRaisesRegex(ValueError, "Private and local"):
            extract.extract("https://example.com/")
        self.dns.side_effect = socket.gaierror("DNS unavailable")
        with self.assertRaises(socket.gaierror):
            extract.extract("https://example.com/")
        self.http.assert_not_called()
        self.browser.assert_not_called()

    def test_http_errors_and_oversized_html_are_rejected_before_parsing(self):
        page = article_page()
        page.status = 429
        with self.assertRaisesRegex(ValueError, "HTTP 429"):
            extract.article(page, "test")
        page.status = 200
        with patch("scraper.extract.MAX_HTML", 10):
            with self.assertRaisesRegex(extract.UnsupportedContent, "8 MB"):
                extract.article(page, "test")
        page.body = b""
        with patch("scraper.extract.MAX_HTML", 10):
            with self.assertRaisesRegex(ValueError, "8 MB"):
                extract.article(page, "test")

    def test_html_refresh_ignores_unrelated_metadata_invalid_declarations_and_pdf(self):
        for html in [
            "",
            '<meta http-equiv="content-type" content="text/html">',
            '<meta http-equiv="refresh" content="not a redirect">',
            "<a href='/other'>Other page</a>",
        ]:
            with self.subTest(html=html):
                self.assertIsNone(extract.html_redirect(response(html)))
        self.assertIsNone(extract.html_redirect(response(b"%PDF-1.5")))
        page = response('<meta http-equiv="refresh" content="0;url=/next">')
        page.status = 404
        self.assertIsNone(extract.html_redirect(page))

    def test_pdf_limits_and_invalid_documents_return_supported_failure_messages(self):
        page = response(pdf_fixture(PROSE), "application/pdf")
        for setting, limit, message in [
            ("MAX_PDF", 10, "20 MB"),
            ("MAX_HTML", 10, "decoded-content"),
            ("MAX_TEXT", 10, "one-million-character"),
        ]:
            with (
                self.subTest(setting=setting),
                patch(f"scraper.extract.{setting}", limit),
            ):
                with self.assertRaisesRegex(extract.UnsupportedContent, message):
                    extract.pdf_article(page)
        with self.assertRaisesRegex(
            extract.UnsupportedContent, "PDF text extraction failed"
        ):
            extract.pdf_article(response(b"%PDF-invalid", "application/pdf"))

    def test_reddit_post_without_readable_body_cannot_use_advertising_as_content(self):
        page = response(
            f'<shreddit-post id="t3_abc" post-title="Source"><div slot="text-body">short</div></shreddit-post><p>{PROSE}</p>'
        )
        page.url = "https://www.reddit.com/r/test/comments/abc/title/"
        with self.assertRaisesRegex(ValueError, "post body is unavailable"):
            extract.article(page, "test")

    def test_command_line_emits_json_for_success_and_errors_with_failure_exit_status(
        self,
    ):
        self.http.side_effect = None
        self.http.return_value = article_page()
        output = StringIO()
        with (
            patch("sys.argv", ["extract.py", "https://example.com/"]),
            redirect_stdout(output),
            patch("scraper.transport.fetch_page", self.http),
            patch("scraper.transport.fetch_browser", self.browser),
        ):
            runpy.run_module("scraper.extract", run_name="__main__")
        self.assertEqual(json.loads(output.getvalue())["title"], "original PAGE title")
        self.http.side_effect = TimeoutError("HTTP failed")
        self.browser.side_effect = RuntimeError("Browser failed")
        output = StringIO()
        with (
            patch("sys.argv", ["extract.py", "https://example.com/"]),
            redirect_stdout(output),
            patch("scraper.transport.fetch_page", self.http),
            patch("scraper.transport.fetch_browser", self.browser),
        ):
            with self.assertRaises(SystemExit) as caught:
                runpy.run_module("scraper.extract", run_name="__main__")
        self.assertEqual(caught.exception.code, 1)
        error = json.loads(output.getvalue())["error"]
        self.assertIn("HTTP failed", error)
        self.assertIn("Browser failed", error)
        self.assertIn("paste the article text", error)
