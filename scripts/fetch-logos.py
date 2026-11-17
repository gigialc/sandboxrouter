#!/usr/bin/env python3
"""Fetch each provider's own site icon into web/public/logos/<id>.<ext>, for the website's tables.

Run by hand when a provider is added (python3 -I scripts/fetch-logos.py [id ...]); the files are committed.
It reads the provider's homepage for <link rel="icon">, "apple-touch-icon" or "shortcut icon", prefers SVG,
then the largest PNG, then /favicon.ico, and keeps only real images under 200 KB.
"""
import html.parser
import os
import re
import sys
import urllib.parse
import urllib.request

HOMES = {
    "agent37": "https://www.agent37.com",
    "agentcore": "https://aws.amazon.com",
    "lambda": "https://aws.amazon.com",
    "aws-workspaces": "https://aws.amazon.com",
    "alibaba": "https://www.alibabacloud.com",
    "azure": "https://azure.microsoft.com",
    "beam": "https://www.beam.cloud",
    "blaxel": "https://blaxel.ai",
    "boat": "https://boat.dev",
    "cloudflare": "https://www.cloudflare.com",
    "codesandbox": "https://codesandbox.io",
    "daytona": "https://www.daytona.io",
    "dedalus": "https://www.dedaluslabs.ai",
    "deno": "https://deno.com",
    "e2b": "https://e2b.dev",
    "exedev": "https://exe.dev",
    "freestyle": "https://www.freestyle.sh",
    "hopx": "https://hopx.ai",
    "instabox": "https://instabox.sh",
    "koyeb": "https://www.koyeb.com",
    "langsmith": "https://www.langchain.com",
    "limrun": "https://limrun.com",
    "maritime": "https://maritime.sh",
    "mobilerun": "https://mobilerun.ai",
    "modal": "https://modal.com",
    "morph": "https://morph.so",
    "northflank": "https://northflank.com",
    "novita": "https://novita.ai",
    "openscale": "https://openscale.so",
    "orgo": "https://orgo.ai",
    "runloop": "https://runloop.ai",
    "sail": "https://sailresearch.com",
    "sprites": "https://fly.io",
    "superserve": "https://superserve.ai",
    "tensorlake": "https://tensorlake.ai",
    "upstash": "https://upstash.com",
    "vercel": "https://vercel.com",
}
OUT = os.path.join(os.path.dirname(__file__), "..", "web", "public", "logos")
UA = {"User-Agent": "Mozilla/5.0 (compatible; sandboxrouter-logos/1.0)"}
TYPES = {"image/svg+xml": "svg", "image/png": "png", "image/x-icon": "ico", "image/vnd.microsoft.icon": "ico", "image/webp": "webp"}


class Icons(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.found = []

    def handle_starttag(self, tag, attrs):
        if tag != "link":
            return
        a = dict(attrs)
        rel = (a.get("rel") or "").lower()
        if "icon" in rel and a.get("href"):
            self.found.append(a)


def get(url, limit=2_000_000):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=15) as r:
        return r.headers.get("content-type", "").split(";")[0].strip().lower(), r.read(limit), r.geturl()


def rank(a):
    href, typ, sizes = a["href"], (a.get("type") or "").lower(), a.get("sizes") or ""
    if href.lower().endswith(".svg") or "svg" in typ:
        return 10_000
    try:
        return max(int(s.lower().split("x")[0]) for s in sizes.split()) if sizes and sizes != "any" else (180 if "apple" in a.get("rel", "") else 32)
    except ValueError:
        return 32


def fetch(pid, home):
    _, page, final = get(home)
    p = Icons()
    p.feed(page.decode("utf-8", "ignore"))
    candidates = [urllib.parse.urljoin(final, a["href"]) for a in sorted(p.found, key=rank, reverse=True)]
    candidates.append(urllib.parse.urljoin(final, "/favicon.ico"))
    for url in candidates:
        if url.startswith("data:"):
            continue
        try:
            typ, body, _ = get(url, 250_000)
        except Exception:
            continue
        ext = TYPES.get(typ) or ("svg" if body.lstrip()[:5] in (b"<svg ", b"<?xml") else None)
        if not ext or len(body) > 200_000 or len(body) < 60:
            continue
        # An SVG is a document: refuse any that could run script if opened directly.
        if ext == "svg" and re.search(rb"<script|\bon[a-z]+\s*=|javascript:|<foreignObject|<iframe", body, re.I):
            continue
        for old in os.listdir(OUT):
            if old.rsplit(".", 1)[0] == pid:
                os.remove(os.path.join(OUT, old))
        with open(os.path.join(OUT, f"{pid}.{ext}"), "wb") as f:
            f.write(body)
        return f"{pid}.{ext} ({len(body)} bytes) from {url}"
    return None


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    for pid in sys.argv[1:] or HOMES:
        try:
            print(fetch(pid, HOMES[pid]) or f"{pid}: no icon found")
        except Exception as e:
            print(f"{pid}: {e}")
