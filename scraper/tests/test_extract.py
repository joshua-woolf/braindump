"""Offline regression coverage for extraction boundaries; no browser or model."""

import socket
import unittest
from io import BytesIO
from types import SimpleNamespace
from unittest.mock import patch

from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject
from scraper import extract


def address(ip):
    return (socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 443))


def response(html, mime="text/html"):
    body = html.encode() if isinstance(html, str) else html
    return SimpleNamespace(
        status=200,
        url="https://example.com/",
        body=body,
        headers={"Content-Type": mime},
        html_content=body.decode(errors="replace"),
    )


def pdf_fixture(text=None, encrypted=False):
    writer = PdfWriter()
    page = writer.add_blank_page(width=612, height=792)
    if text:
        font = DictionaryObject(
            {
                NameObject("/Type"): NameObject("/Font"),
                NameObject("/Subtype"): NameObject("/Type1"),
                NameObject("/BaseFont"): NameObject("/Helvetica"),
            }
        )
        page[NameObject("/Resources")] = DictionaryObject(
            {NameObject("/Font"): DictionaryObject({NameObject("/F1"): font})}
        )
        stream = DecodedStreamObject()
        stream.set_data(f"BT /F1 12 Tf 50 700 Td ({text}) Tj ET".encode())
        page[NameObject("/Contents")] = stream
    writer.add_metadata({"/Title": "A PDF title"})
    if encrypted:
        writer.encrypt("secret")
    output = BytesIO()
    writer.write(output)
    return output.getvalue()


class ExtractionTests(unittest.TestCase):
    def test_readability_accepts_prose_without_spaces_and_rejects_binary_noise(self):
        text = (
            "本地数据库可以保存网页内容，帮助读者搜索和整理资料，同时保护个人数据。" * 8
        )
        self.assertTrue(extract.readable(text))
        self.assertFalse(extract.readable("\ufffd\x00" * 200))

    @patch("scraper.extract.public_url")
    def test_error_page_is_rejected_even_when_it_has_navigation_and_metadata(
        self, _guard
    ):
        page = response(
            "<title>Postman</title><h1>This wasn't supposed to happen</h1><p>"
            + "Explore our public workspaces and read our documentation. " * 20
            + "</p>"
        )
        with self.assertRaisesRegex(ValueError, "error page"):
            extract.article(page, "test")

    @patch("scraper.extract.public_url")
    def test_reddit_uses_only_the_requested_post_and_rejects_removed_posts(
        self, _guard
    ):
        body = (
            "A detailed post explains SQLite transactions and their guarantees for a local application. "
            * 4
        )
        page = response(
            f'<title>A post</title><shreddit-post id="t3_abc" post-title="Source title"><div slot="text-body">{body}</div></shreddit-post><p>Unrelated advert</p>'
        )
        page.url = "https://www.reddit.com/r/test/comments/abc/title/"
        result = extract.article(page, "test")
        self.assertEqual(result["content"], body.strip())
        self.assertEqual(result["title"], "Source title")
        page.html_content = (
            '<title>A post</title><shreddit-post id="t3_abc">Sorry, this post was removed by Reddit’s filters.</shreddit-post><p>'
            + body
            + "</p>"
        )
        with self.assertRaisesRegex(ValueError, "removed or deleted"):
            extract.article(page, "test")
        page.html_content = "<title>A post</title><p>" + body + "</p>"
        with self.assertRaisesRegex(ValueError, "post body is unavailable"):
            extract.article(page, "test")

    @patch("scraper.extract.public_url")
    def test_real_pdf_text_is_extracted_instead_of_decoded_binary(self, _guard):
        text = (
            "SQLite uses transactions to keep saved links and their search indexes consistent. "
            * 5
        )
        result = extract.article(response(pdf_fixture(text), "application/pdf"), "test")
        self.assertEqual(result["method"], "pdf-text")
        self.assertEqual(result["title"], "A PDF title")
        self.assertIn(text.strip(), result["content"])
        self.assertNotIn("%PDF", result["content"])

    @patch("scraper.extract.public_url")
    def test_scanned_encrypted_and_oversized_pdfs_fail_explicitly(self, _guard):
        with self.assertRaisesRegex(ValueError, "no usable text layer"):
            extract.article(response(pdf_fixture(), "application/pdf"), "test")
        with self.assertRaisesRegex(ValueError, "Encrypted"):
            extract.article(
                response(pdf_fixture(encrypted=True), "application/pdf"), "test"
            )
        with patch("scraper.extract.MAX_PDF_PAGES", 0):
            with self.assertRaisesRegex(ValueError, "page extraction limit"):
                extract.article(response(pdf_fixture(), "application/pdf"), "test")

    @patch("scraper.extract.public_url")
    def test_binary_content_is_rejected_before_html_parsing(self, _guard):
        with patch("scraper.extract.trafilatura.bare_extraction") as parse:
            with self.assertRaisesRegex(ValueError, "not readable HTML"):
                extract.article(
                    response(b"PK\x00\x01binary", "application/zip"), "test"
                )
            parse.assert_not_called()

    @patch("scraper.extract.public_url")
    @patch("scraper.extract.trafilatura.bare_extraction")
    def test_standard_extraction_recovers_text_discarded_by_precision(
        self, parse, _guard
    ):
        text = (
            "A useful directory describes databases, search tools, link libraries and their different capabilities. "
            * 4
        )
        parse.side_effect = [
            SimpleNamespace(title="Directory", text="Too short"),
            SimpleNamespace(title="Directory", text=text, description=""),
        ]
        result = extract.article(
            response("<html><title>Directory</title></html>"), "test"
        )
        self.assertEqual(result["content"], text)
        self.assertEqual(result["method"], "test-standard")

    @patch("scraper.extract.public_url")
    def test_short_useful_descriptions_keep_source_and_metadata_disclosure(
        self, _guard
    ):
        descriptions = [
            "A bespoke retail experience - focusing on timeless products with crafted detailing",
            "EXHOTEL creates considered interiors and bespoke furniture, from concept to fabrication.",
            "Stitch generates UIs for mobile and web applications, making design ideation fast and easy.",
        ]
        for description in descriptions:
            with self.subTest(description=description):
                page = response(
                    '<title>Source title</title><meta name="description" '
                    f'content="{description}"><main></main>'
                )
                result = extract.article(page, "test")
                self.assertEqual(result["description"], description)
                self.assertEqual(result["title"], "Source title")
                self.assertEqual(result["method"], "test-metadata")
                self.assertIn("metadata only", result["content"])
                self.assertIn(f"Source: {page.url}", result["content"])
                self.assertIn(f"Description: {description}", result["content"])
                self.assertGreaterEqual(len(result["content"]), 180)

    @patch("scraper.extract.public_url")
    def test_metadata_context_cannot_make_an_empty_or_meaningless_blurb_readable(
        self, _guard
    ):
        for description in ["", "Welcome to our website", "abcdefghij " * 9]:
            with self.subTest(description=description):
                page = response(
                    "<title>" + "An elaborate website title " * 10 + "</title>"
                    f'<meta name="description" content="{description}">'
                )
                with self.assertRaisesRegex(ValueError, "enough readable"):
                    extract.article(page, "test")

    @patch("scraper.extract.public_url")
    def test_sparse_public_metadata_is_labeled_and_login_metadata_is_rejected(
        self, _guard
    ):
        description = "A Cape Town studio making custom furniture and lighting for homes, with a showroom displaying locally designed chairs and tables."
        html = f'<html><head><title>Studio</title><meta name="description" content="{description}"></head><body><p>Studio</p></body></html>'
        result = extract.article(response(html), "test")
        self.assertEqual(result["method"], "test-metadata")
        self.assertIn("metadata only", result["content"])
        self.assertIn(description, result["content"])
        with self.assertRaisesRegex(ValueError, "requires a login"):
            extract.article(
                response(html.replace("<title>Studio", "<title>Log in")), "test"
            )
        with self.assertRaisesRegex(ValueError, "enough readable"):
            extract.article(
                response(html.replace("<p>Studio</p>", '<input type="password">')),
                "test",
            )

    @patch("scraper.extract.socket.getaddrinfo", return_value=[address("1.1.1.1")])
    def test_html_refresh_is_resolved_and_private_destinations_are_guarded(
        self, _lookup
    ):
        page = response('<meta http-equiv="refresh" content="0; URL=\'/new-page\'">')
        self.assertEqual(extract.html_redirect(page), "https://example.com/new-page")
        private = response(
            '<meta http-equiv="refresh" content="0;url=http://127.0.0.1/private">'
        )
        with (
            patch("scraper.extract.Fetcher.get", return_value=private) as fetcher,
            patch(
                "scraper.extract.StealthyFetcher.fetch",
                side_effect=ValueError("blocked"),
            ),
        ):

            def lookup(host, *_args, **_kwargs):
                return [address("127.0.0.1" if host == "127.0.0.1" else "1.1.1.1")]

            with patch("scraper.extract.socket.getaddrinfo", side_effect=lookup):
                with self.assertRaisesRegex(ValueError, "Private and local"):
                    extract.extract("https://example.com/")
            fetcher.assert_called_once()

    @patch("scraper.extract.socket.getaddrinfo", return_value=[address("1.1.1.1")])
    def test_public_web_url_is_allowed(self, _lookup):
        self.assertEqual(
            extract.public_url("https://example.com/article"),
            "https://example.com/article",
        )

    def test_mixed_public_and_private_dns_is_rejected(self):
        with patch(
            "scraper.extract.socket.getaddrinfo",
            return_value=[address("1.1.1.1"), address("127.0.0.1")],
        ):
            with self.assertRaisesRegex(ValueError, "Private and local"):
                extract.public_url("https://example.com/")

    def test_non_web_urls_credentials_and_nonstandard_ports_are_rejected_before_dns(
        self,
    ):
        with patch("scraper.extract.socket.getaddrinfo") as lookup:
            for url in [
                "file:///etc/passwd",
                "https://user:secret@example.com/",
                "http://example.com:3210/",
            ]:
                with self.subTest(url=url), self.assertRaises(ValueError):
                    extract.public_url(url)
            lookup.assert_not_called()

    @patch("scraper.extract.public_url")
    @patch("scraper.extract.trafilatura.bare_extraction")
    def test_challenge_page_is_not_saved_as_article(self, parse, _guard):
        parse.return_value = SimpleNamespace(
            title="Just a moment", text="Verify you are human. " * 20
        )
        page = SimpleNamespace(
            status=200, url="https://example.com/", html_content="<html/>"
        )
        with self.assertRaisesRegex(ValueError, "bot challenge"):
            extract.article(page, "test")

    @patch("scraper.extract.public_url")
    @patch("scraper.extract.trafilatura.bare_extraction")
    def test_short_article_is_rejected(self, parse, _guard):
        parse.return_value = SimpleNamespace(title="Small", text="Too short")
        page = SimpleNamespace(
            status=200, url="https://example.com/", html_content="<html/>"
        )
        with self.assertRaisesRegex(ValueError, "enough readable"):
            extract.article(page, "test")

    @patch("scraper.extract.public_url")
    @patch("scraper.extract.trafilatura.bare_extraction")
    def test_success_keeps_article_text_and_metadata(self, parse, guard):
        text = "A detailed explanation of a useful engineering idea. " * 20
        parse.return_value = SimpleNamespace(
            title="An article", text=text, description="Description"
        )
        page = SimpleNamespace(
            status=200, url="https://example.com/final", html_content="<html/>"
        )
        self.assertEqual(
            extract.article(page, "test"),
            {
                "title": "An article",
                "content": text,
                "description": "Description",
                "method": "test",
            },
        )
        guard.assert_called_once_with(page.url)


if __name__ == "__main__":
    unittest.main()
