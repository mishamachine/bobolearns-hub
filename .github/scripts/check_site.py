#!/usr/bin/env python3
"""Cheap pre-merge checks for this static site. Standard library only.

1. Every local href/src in the HTML pages points to a file that exists
   (query strings and #fragments are ignored for the file lookup).
2. Every #fragment link points to an id that exists on the target page.
3. sites.json parses and each site has the fields the home page and dashboard read.
4. sitemap.xml parses and each of its URLs on this domain maps to a page in the repo.
5. Every indexable page (one without <meta name="robots" content="noindex">) has a canonical link,
   an og:image, a twitter:card and, if it carries JSON-LD, only blocks that parse as JSON.
   The home page must carry at least one JSON-LD block. An og:image on this domain must exist in the repo.

Run from the repo root: python3 .github/scripts/check_site.py
"""
import json
import pathlib
import re
import sys
import xml.etree.ElementTree as ET
from urllib.parse import urlsplit

ROOT = pathlib.Path(__file__).resolve().parents[2]
SITE_HOST = "bobolearns.com"
SKIP_DIRS = {".git", "node_modules", "scripts", "supabase"}

ATTR_RE = re.compile(r'\b(?:href|src)\s*=\s*"([^"]*)"', re.I)
ID_RE = re.compile(r'\bid\s*=\s*"([^"]+)"', re.I)
JSONLD_RE = re.compile(r'<script[^>]*type\s*=\s*"application/ld\+json"[^>]*>(.*?)</script>', re.I | re.S)

errors = []


def html_pages():
    for p in sorted(ROOT.rglob("*.html")):
        if not SKIP_DIRS.intersection(p.relative_to(ROOT).parts):
            yield p


def resolve(url_path):
    """Map a site path like /login/ or /assets/x.css to a file in the repo, or None."""
    target = ROOT / url_path.lstrip("/")
    if url_path.endswith("/") or target.is_dir():
        target = target / "index.html"
    return target if target.is_file() else None


def ids_in(page, cache={}):
    if page not in cache:
        cache[page] = set(ID_RE.findall(page.read_text(encoding="utf-8")))
    return cache[page]


def check_html():
    for page in html_pages():
        rel = page.relative_to(ROOT)
        text = page.read_text(encoding="utf-8")
        if not text.lstrip().lower().startswith("<!doctype html"):
            errors.append(f"{rel}: missing <!doctype html>")
        if "<title>" not in text.lower():
            errors.append(f"{rel}: missing <title>")
        for url in ATTR_RE.findall(text):
            parts = urlsplit(url)
            if parts.scheme or parts.netloc or url.startswith(("mailto:", "tel:", "javascript:")):
                continue  # external links are not checked (no network in this check)
            if not parts.path:  # same-page fragment, e.g. #main
                if parts.fragment and parts.fragment not in ids_in(page):
                    errors.append(f"{rel}: link {url} has no matching id on this page")
                continue
            if not parts.path.startswith("/"):
                errors.append(f"{rel}: relative link {url} (this site uses root-relative paths)")
                continue
            target = resolve(parts.path)
            if target is None:
                errors.append(f"{rel}: {url} does not exist in the repo")
            elif parts.fragment and target.suffix == ".html" and parts.fragment not in ids_in(target):
                errors.append(f"{rel}: {url} has no matching id in {target.relative_to(ROOT)}")


def meta_content(text, attr, name):
    """Content of the first <meta {attr}="{name}" content="..."> (either attribute order), or None."""
    for tag in re.findall(r"<meta\b[^>]*>", text, re.I):
        if re.search(rf'\b{attr}\s*=\s*"{re.escape(name)}"', tag, re.I):
            m = re.search(r'\bcontent\s*=\s*"([^"]*)"', tag, re.I)
            return m.group(1) if m else ""
    return None


def check_seo():
    for page in html_pages():
        rel = page.relative_to(ROOT)
        text = page.read_text(encoding="utf-8")
        robots = meta_content(text, "name", "robots") or ""
        blocks = JSONLD_RE.findall(text)
        for i, raw in enumerate(blocks):
            try:
                json.loads(raw)
            except ValueError as e:
                errors.append(f"{rel}: JSON-LD block {i + 1} does not parse ({e})")
        if "noindex" in robots.lower():
            continue  # pages kept out of search (login, dashboard, 404) need no social tags
        if not re.search(r'<link\b[^>]*\brel\s*=\s*"canonical"[^>]*\bhref\s*=\s*"https://[^"]+"', text, re.I):
            errors.append(f"{rel}: indexable page has no https canonical link")
        image = meta_content(text, "property", "og:image")
        if not image:
            errors.append(f"{rel}: indexable page has no og:image")
        else:
            parts = urlsplit(image)
            if parts.netloc == SITE_HOST and resolve(parts.path) is None:
                errors.append(f"{rel}: og:image {image} does not exist in the repo")
        if not meta_content(text, "name", "twitter:card"):
            errors.append(f"{rel}: indexable page has no twitter:card")
        if rel == pathlib.Path("index.html") and not blocks:
            errors.append(f"{rel}: home page has no JSON-LD block")


def check_sites_json():
    path = ROOT / "sites.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        errors.append(f"sites.json: does not parse ({e})")
        return
    sites = data.get("sites") if isinstance(data, dict) else None
    if not isinstance(sites, list) or not sites:
        errors.append("sites.json: expected a non-empty 'sites' list")
        return
    seen = set()
    for i, site in enumerate(sites):
        label = f"sites.json: sites[{i}]"
        if not isinstance(site, dict):
            errors.append(f"{label} is not an object")
            continue
        for key in ("slug", "name", "status", "tagline"):
            if not isinstance(site.get(key), str) or not site[key].strip():
                errors.append(f"{label} is missing '{key}'")
        if site.get("status") == "live" and not str(site.get("url", "")).startswith("https://"):
            errors.append(f"{label} is live but has no https url")
        if "stats" in site and not isinstance(site["stats"], list):
            errors.append(f"{label}: 'stats' must be a list")
        slug = site.get("slug")
        if slug in seen:
            errors.append(f"{label}: duplicate slug '{slug}'")
        seen.add(slug)


def check_sitemap():
    path = ROOT / "sitemap.xml"
    if not path.exists():
        return
    try:
        tree = ET.parse(path)
    except ET.ParseError as e:
        errors.append(f"sitemap.xml: does not parse ({e})")
        return
    for loc in tree.iter("{http://www.sitemaps.org/schemas/sitemap/0.9}loc"):
        parts = urlsplit((loc.text or "").strip())
        if parts.netloc == SITE_HOST and resolve(parts.path or "/") is None:
            errors.append(f"sitemap.xml: {loc.text} has no page in the repo")


def main():
    check_html()
    check_seo()
    check_sites_json()
    check_sitemap()
    if errors:
        print(f"{len(errors)} problem(s) found:")
        for e in errors:
            print(f"  - {e}")
        return 1
    print(f"OK: {len(list(html_pages()))} HTML pages, sites.json, sitemap.xml and SEO tags checked.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
