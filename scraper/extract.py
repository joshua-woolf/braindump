"""One-shot public-page extraction. Diagnostics on stderr, JSON on stdout."""

import ipaddress
import json
import logging
import re
import socket
import sys
from io import BytesIO
from urllib.parse import urljoin, urlparse

import trafilatura
from lxml import html as lxml_html
from pypdf import PdfReader
from scrapling.fetchers import Fetcher, StealthyFetcher

logging.basicConfig(stream=sys.stderr, level=logging.WARNING)
MAX_HTML = 8_000_000
MAX_PDF = 20_000_000
MAX_TEXT = 1_000_000
MAX_PDF_PAGES = 500


class UnsupportedContent(ValueError):
    """A browser retry cannot turn this response into supported text."""


def reject_gate(title, text):
    challenge = (title + " " + text[:500]).lower()
    if any(
        phrase in challenge
        for phrase in (
            "this wasn't supposed to happen",
            "this wasn’t supposed to happen",
            "page not found",
            "this page isn't available",
            "this page isn’t available",
            "you've been blocked by network security",
            "you’ve been blocked by network security",
        )
    ):
        raise ValueError(
            "The site returned an error page instead of the requested content."
        )
    if any(
        phrase in challenge
        for phrase in (
            "just a moment",
            "verify you are human",
            "checking your browser",
            "attention required!",
            "access denied",
            "verifying your request",
            "enable javascript and cookies to continue",
            "security verification",
        )
    ):
        raise ValueError(
            "The site returned a bot challenge instead of readable content."
        )
    if re.search(r"^(log ?in|sign ?in|sign ?up)(\b|\s*[-|])", title.lower()) or any(
        phrase in challenge
        for phrase in (
            "log in to continue",
            "sign in to continue",
            "login to continue",
            "sign up to see photos",
            "you must be logged in",
            "enable javascript to run this app",
        )
    ):
        raise ValueError(
            "The page requires a login or an interactive app. Paste readable text instead."
        )


def readable(text, minimum=180, minimum_words=15):
    stripped = text.strip()
    # CJK prose does not use the word separators assumed by the Latin-text heuristic.
    words = len(re.findall(r"[^\W\d_]+", stripped))
    cjk = len(re.findall(r"[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]", stripped))
    return (
        len(stripped) >= minimum
        and (words >= minimum_words or cjk >= 80)
        and sum(c.isalpha() for c in stripped) / max(len(stripped), 1) > 0.4
        and "\x00" not in stripped
        and stripped.count("\ufffd") / max(len(stripped), 1) < 0.01
    )


def reddit_article(tree, url, method):
    """Restrict post URLs to their own body; ads/comments are not the saved post."""
    parsed = urlparse(url)
    match = re.search(r"/comments/([a-z0-9]+)/", parsed.path)
    if (
        parsed.hostname not in ("reddit.com", "www.reddit.com", "old.reddit.com")
        or not match
    ):
        return None
    posts = tree.xpath("//shreddit-post[@id=$id]", id=f"t3_{match[1]}")
    if not posts:
        raise ValueError(
            "The Reddit post body is unavailable. Paste the accessible post text instead."
        )
    post = posts[0]
    notice = " ".join(post.text_content().split()).lower()
    if re.search(r"(post was|post has been|\[)\s*(removed|deleted)", notice):
        raise UnsupportedContent(
            "The Reddit post was removed or deleted. Comments and adverts are not the original post."
        )
    bodies = post.xpath('.//*[@slot="text-body"]')
    text = "\n\n".join(" ".join(body.text_content().split()) for body in bodies)
    if not readable(text):
        raise ValueError(
            "The Reddit post body is unavailable. Paste the accessible post text instead."
        )
    return {
        "title": post.get("post-title", "Reddit post")[:1000],
        "description": "",
        "content": text[:MAX_TEXT],
        "method": f"{method}-reddit-post",
    }


def pdf_article(page):
    body = page.body
    if len(body) > MAX_PDF:
        raise UnsupportedContent("PDF exceeds the 20 MB extraction limit.")
    try:
        reader = PdfReader(BytesIO(body))
        if reader.is_encrypted:
            raise UnsupportedContent("Encrypted PDFs need an unlocked text copy.")
        if len(reader.pages) > MAX_PDF_PAGES:
            raise UnsupportedContent("PDF exceeds the 500-page extraction limit.")
        texts = []
        length = 0
        for page_number, pdf_page in enumerate(reader.pages, 1):
            stream = pdf_page.get_contents()
            if stream is not None and len(stream.get_data()) > MAX_HTML:
                raise UnsupportedContent(
                    "PDF page exceeds the 8 MB decoded-content limit."
                )
            text = pdf_page.extract_text() or ""
            length += len(text) + len(f"[Page {page_number}]\n\n")
            if length > MAX_TEXT:
                raise UnsupportedContent(
                    "PDF exceeds the one-million-character text limit."
                )
            if text.strip():
                texts.append(f"[Page {page_number}]\n{text.strip()}")
        content = "\n\n".join(texts)
        if not readable(content):
            raise UnsupportedContent(
                "PDF has no usable text layer. Paste text from OCR instead."
            )
        title = (reader.metadata.title if reader.metadata else None) or urlparse(
            str(page.url)
        ).path.rsplit("/", 1)[-1]
        return {
            "title": str(title)[:1000],
            "description": "",
            "content": content,
            "method": "pdf-text",
        }
    except UnsupportedContent:
        raise
    except Exception as error:
        raise UnsupportedContent(f"PDF text extraction failed: {error}") from error


def html_redirect(page):
    """Follow only explicit refresh declarations, never arbitrary page links."""
    if (
        page.status != 200
        or len(page.body) > MAX_HTML
        or page.body.lstrip().startswith(b"%PDF-")
    ):
        return None
    try:
        tree = lxml_html.fromstring(page.html_content)
        for meta in tree.xpath("//meta[@http-equiv]"):
            if meta.get("http-equiv", "").lower() != "refresh":
                continue
            match = re.fullmatch(
                r"\s*\d+(?:\.\d+)?\s*;\s*url\s*=\s*(.+)\s*",
                meta.get("content", ""),
                re.I,
            )
            if match:
                return urljoin(str(page.url), match[1].strip().strip("\"'"))
    except (ValueError, lxml_html.etree.ParserError):
        return None
    return None


def public_url(url):
    parsed = urlparse(url)
    if (
        parsed.scheme not in ("https", "http")
        or not parsed.hostname
        or parsed.username
        or parsed.password
    ):
        raise ValueError("Only public HTTP(S) pages are supported.")
    if parsed.port not in (None, 80, 443):
        raise ValueError("Only standard public web ports are supported.")
    addresses = socket.getaddrinfo(
        parsed.hostname, parsed.port or 443, type=socket.SOCK_STREAM
    )
    if not addresses or any(
        not ipaddress.ip_address(a[4][0]).is_global for a in addresses
    ):
        raise ValueError("Private and local network addresses are blocked.")
    return url


def article(page, method):
    if page.status >= 400:
        raise ValueError(f"Website returned HTTP {page.status}.")
    public_url(str(page.url))
    body = getattr(page, "body", b"")
    headers = {
        str(k).lower(): str(v).lower() for k, v in getattr(page, "headers", {}).items()
    }
    mime = headers.get("content-type", "").split(";", 1)[0].strip()
    if body.lstrip().startswith(b"%PDF-") or mime == "application/pdf":
        return pdf_article(page)
    if len(body) > MAX_HTML:
        raise UnsupportedContent("Page exceeds the 8 MB extraction limit.")
    if (
        mime and mime not in ("text/html", "application/xhtml+xml", "text/plain")
    ) or b"\x00" in body[:4096]:
        raise UnsupportedContent(
            "This file is not readable HTML, plain text, or a text PDF."
        )
    html = page.html_content
    if len(html) > MAX_HTML:
        raise ValueError("Page exceeds the 8 MB extraction limit.")
    tree = lxml_html.fromstring(html)
    page_title = " ".join(tree.xpath("//title/text()"))
    headings = " ".join(tree.xpath("//h1//text() | //h2//text()"))
    reject_gate(page_title, headings)
    reddit = reddit_article(tree, str(page.url), method)
    if reddit:
        return reddit
    password_form = bool(
        tree.xpath("//input[translate(@type, 'PASSWORD', 'password')='password']")
    )
    for mode in ("precision", "standard", "recall"):
        result = trafilatura.bare_extraction(
            html,
            url=str(page.url),
            include_comments=False,
            include_tables=True,
            favor_precision=mode == "precision",
            favor_recall=mode == "recall",
            with_metadata=True,
        )
        text = (result.text or "") if result else ""
        title = (result.title or "") if result else ""
        reject_gate(title or page_title, text)
        if readable(text) and not (password_form and len(text) < 1000):
            return {
                "title": (title or page_title or urlparse(str(page.url)).hostname)[
                    :1000
                ],
                "description": (getattr(result, "description", "") or "")[:5000],
                "content": text[:MAX_TEXT],
                "method": method if mode == "precision" else f"{method}-{mode}",
            }
    # A public description can describe a sparse website, but is not the article.
    descriptions = tree.xpath(
        "//meta[@name='description' or @property='og:description']/@content"
    )
    description = max(descriptions, key=len, default="").strip()
    reject_gate(page_title, description)
    if not password_form and readable(description, minimum=80, minimum_words=10):
        title = (page_title or urlparse(str(page.url)).hostname)[:1000]
        return {
            "title": title,
            "description": description[:5000],
            "content": (
                "Website overview from public metadata only. Full page content was not available.\n\n"
                f"Title: {title}\nSource: {page.url}\nDescription: {description[:5000]}"
            ),
            "method": f"{method}-metadata",
        }
    raise ValueError(
        "The page did not contain enough readable text. Paste accessible content instead."
    )


def extract(url, force_browser=False):
    public_url(url)
    errors = []
    if not force_browser:
        try:
            current = url
            for _ in range(8):
                public_url(current)
                page = Fetcher.get(
                    current,
                    impersonate="chrome",
                    stealthy_headers=True,
                    timeout=25,
                    retries=0,
                    allow_redirects=False,
                )
                if 300 <= page.status < 400:
                    location = page.headers.get("location") or page.headers.get(
                        "Location"
                    )
                    if not location:
                        raise ValueError("Redirect has no destination.")
                    current = urljoin(current, location)
                    continue
                redirect = html_redirect(page)
                if redirect:
                    current = redirect
                    continue
                return article(page, "scrapling-http")
            raise ValueError("Too many redirects.")
        except UnsupportedContent:
            raise
        except Exception as error:
            errors.append(str(error))

    # Validate every browser request, including redirects and subresources.
    def page_setup(page):
        def guard(route):
            try:
                public_url(route.request.url)
                route.continue_()
            except Exception:
                route.abort()

        page.context.route("**/*", guard)

    try:
        page = StealthyFetcher.fetch(
            url,
            headless=True,
            solve_cloudflare=True,
            timeout=45000,
            wait=1500,
            network_idle=False,
            google_search=False,
            block_webrtc=True,
            page_setup=page_setup,
        )
        return article(page, "scrapling-browser")
    except Exception as error:
        errors.append(str(error))
        raise ValueError(
            "Extraction failed. The page may need a login, manual challenge, or unavailable browser dependencies. Retry or paste the article text. Details: "
            + " | ".join(errors)[-1500:]
        ) from error


if __name__ == "__main__":
    try:
        print(
            json.dumps(
                extract(sys.argv[1], "--browser" in sys.argv), ensure_ascii=False
            )
        )
    except Exception as error:
        print(json.dumps({"error": str(error)}))
        sys.exit(1)
