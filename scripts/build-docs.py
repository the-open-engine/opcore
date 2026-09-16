#!/usr/bin/env python3
"""Assemble rustdoc API, source-derived CLI help, and guides into a portable static site."""

import json
from html.parser import HTMLParser
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from urllib.parse import quote, unquote, urlsplit

from docs_theme import ASSETS, render_guide, style_api


ROOT = Path(__file__).resolve().parent.parent


def rewrite_links(markdown, relative, pages):
    """Convert local Markdown destinations while leaving code and external URLs intact."""
    historical = []

    def replace(match):
        destination = match.group(1)
        parsed = urlsplit(destination)
        if parsed.scheme or parsed.netloc or not parsed.path:
            return match.group(0)
        source = (ROOT / relative.parent / unquote(parsed.path)).resolve()
        suffix = ("?" + parsed.query if parsed.query else "") + ("#" + parsed.fragment if parsed.fragment else "")
        target = pages.get(source)
        if target is None:
            if relative.parts[0] != "asp" or not source.is_relative_to(ROOT / "asp") or source.exists():
                return match.group(0)
            # The definition intentionally excludes historical upstream tooling and evidence.
            upstream = json.loads((ROOT / "asp/SOURCE.json").read_text())["upstream"]
            historical.append(source)
            target = quote(source.relative_to(ROOT / "asp").as_posix(), safe="/")
            rendered = f'{upstream["repository"]}/blob/{upstream["commit"]}/{target}'
            return match.group(0).replace(destination, rendered + suffix, 1)
        rendered = os.path.relpath(target, pages[(ROOT / relative).resolve()].parent)
        return match.group(0).replace(destination, rendered + suffix, 1)

    pieces = re.split(r"(```[^\n]*\n.*?\n```)", markdown, flags=re.DOTALL)
    for index in range(0, len(pieces), 2):
        pieces[index] = re.sub(r"\]\(([^\s)]+)\)", replace, pieces[index])
    return "".join(pieces), bool(historical)


def render_page(source, destination, site, pages, temporary):
    relative = source.relative_to(ROOT)
    text, historical = rewrite_links(source.read_text(), relative, pages)
    notice = (
        "Historical implementation and evidence links on this page point to the original "
        "upstream repository and may require repository access. Those files are outside the "
        "bundled ASP definition; the specification, schemas, and fixtures are included here."
    ) if historical else ""
    render_markdown(text, destination, site, temporary, notice)


def render_markdown(markdown, destination, site, temporary, notice=""):
    destination.parent.mkdir(parents=True, exist_ok=True)
    source = temporary / "page.md"
    frontmatter = re.match(r"\A---\n(.*?)\n---\n", markdown, flags=re.DOTALL)
    if frontmatter:
        markdown = markdown[frontmatter.end():].lstrip()
        heading, _, body = markdown.partition("\n")
        metadata = "<details><summary>Specification metadata</summary>\n\n```yaml\n"
        markdown = heading + "\n\n" + metadata + frontmatter.group(1) + "\n```\n</details>\n" + body
    if not markdown.startswith(("# ", "%")):
        markdown = f"# {destination.stem}\n\n{markdown}"
    if notice:
        heading, _, body = markdown.partition("\n")
        markdown = heading + "\n\n> " + notice + "\n" + body
    source.write_text(markdown)
    subprocess.run(
        ["rustdoc", "--edition", "2024", str(source), "-o", str(temporary / "rendered")],
        check=True,
    )
    rendered = (temporary / "rendered/page.html").read_text()
    # A README-style title makes rustdoc number subsections 0.1; keep the useful TOC
    # and anchors while presenting the author's unnumbered headings.
    rendered = re.sub(r'(<a class="doc-anchor"[^>]*>§</a>)\d+(?:\.\d+)* ', r'\1', rendered)
    rendered = re.sub(r'(<a href="#[^"]*" title="[^"]*">)\d+(?:\.\d+)* ', r'\1', rendered)
    destination.write_text(render_guide(rendered, destination, site))


def prepare_api(api, site):
    """Apply the shared theme and qualify inherited tracing documentation links."""
    lock = (ROOT / "Cargo.lock").read_text()
    version = re.search(r'name = "tracing"\nversion = "([^"]+)"', lock).group(1)
    root = f"https://docs.rs/tracing/{version}/tracing/"
    replacements = {
        "dispatcher#setting-the-default-subscriber": root + "dispatcher/index.html#setting-the-default-subscriber",
        "super::Subscriber": root + "trait.Subscriber.html",
    }
    for page in api.rglob("*.html"):
        original = page.read_text()
        updated = style_api(page, site)
        for relative, absolute in replacements.items():
            updated = updated.replace(f'href="{relative}"', f'href="{absolute}"')
        if original != updated:
            page.write_text(updated)


class LocalLinks(HTMLParser):
    """Collect browser-local link and asset destinations in rendered HTML."""

    def __init__(self):
        super().__init__()
        self.links = []
        self.anchors = set()

    def handle_starttag(self, tag, attrs):
        for name, value in attrs:
            if name in ("href", "src") and value:
                self.links.append(value)
            if value and (name == "id" or (tag == "a" and name == "name")):
                self.anchors.add(value)


def local_target(page, link):
    url = urlsplit(link)
    if url.scheme or url.netloc or not (url.path or url.fragment):
        return None
    target = (page.parent / unquote(url.path)).resolve() if url.path else page
    if target.is_dir():
        target = target / "index.html"
    return target, url.fragment


def is_source_reference(target, site):
    parts = target.relative_to(site).parts
    if parts[:2] == ("api", "src"):
        return True
    version = parts[0] in ("dev", "stable") or re.fullmatch(r"v[0-9]+\.[0-9]+", parts[0])
    return bool(version) and parts[1:3] == ("api", "src")


def has_anchor(target, fragment, document, site):
    if not {fragment, unquote(fragment)}.isdisjoint(document.anchors):
        return True
    if not is_source_reference(target, site):
        return False
    # rustdoc's JavaScript interprets source ranges using the individual line IDs.
    lines = re.fullmatch(r"([1-9][0-9]*)-([1-9][0-9]*)", fragment)
    if lines is None:
        return False
    first, last = lines.groups()
    return int(first) <= int(last) and {first, last}.issubset(document.anchors)


def link_error(page, link, site, documents):
    destination = local_target(page, link)
    if destination is None:
        return None
    target, fragment = destination
    if not target.is_relative_to(site) or not target.exists():
        return link
    document = documents.get(target)
    if fragment and document:
        if not has_anchor(target, fragment, document, site):
            return f"missing anchor in {link}"
    return None


def check_links(site):
    missing = []
    documents = {}
    for page in sorted(site.rglob("*.html")):
        parser = LocalLinks()
        parser.feed(page.read_text())
        documents[page.resolve()] = parser
    for page, parser in documents.items():
        for link in parser.links:
            error = link_error(page, link, site, documents)
            if error:
                missing.append(f"{page.relative_to(site)}: {error}")
    if missing:
        raise ValueError("broken local documentation links:\n" + "\n".join(missing[:30]))


def directory_indexes(site, temporary):
    for root in (site / "docs", site / "asp"):
        directories = [root] + sorted(path for path in root.rglob("*") if path.is_dir())
        for directory in directories:
            index = directory / "index.html"
            if index.exists():
                continue
            entries = []
            for entry in sorted(directory.iterdir()):
                if entry.suffix == ".md" and entry.with_suffix(".html").exists():
                    continue
                name = entry.name + ("/" if entry.is_dir() else "")
                entries.append(f"- [{name}]({quote(name)})")
            heading = directory.relative_to(site).as_posix()
            render_markdown(f"# {heading}\n\n" + "\n".join(entries), index, site, temporary)


def build(api, reference, output):
    output = output.absolute()
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.is_symlink() or (output.exists() and not (output / ".opcore-docs").is_file()):
        raise ValueError("output already exists without the documentation-build marker")
    with tempfile.TemporaryDirectory(prefix=".opcore-docs-", dir=output.parent) as scratch:
        temporary = Path(scratch)
        site = temporary / "site"
        site.mkdir()
        shutil.copytree(api, site / "api")
        prepare_api(site / "api", site)
        shutil.copytree(ROOT / "docs", site / "docs")
        shutil.copytree(ROOT / "asp", site / "asp")
        for name in ("README.md", "CONTRIBUTING.md", "CODE_OF_CONDUCT.md", "SECURITY.md", "LICENSE"):
            shutil.copy2(ROOT / name, site / name)
        sources = [ROOT / name for name in ("README.md", "CONTRIBUTING.md", "CODE_OF_CONDUCT.md", "SECURITY.md")]
        sources += sorted((ROOT / "docs").rglob("*.md")) + sorted((ROOT / "asp").rglob("*.md"))
        pages = {source.resolve(): source.relative_to(ROOT).with_suffix(".html") for source in sources}
        pages[(ROOT / "README.md").resolve()] = Path("index.html")
        shutil.copytree(ASSETS, site / "assets")
        for source in sources:
            render_page(source, site / pages[source.resolve()], site, pages, temporary)
        cli = subprocess.check_output([str(reference)], text=True)
        render_markdown(cli, site / "cli.html", site, temporary)
        render_markdown(
            "# API reference\n\n[Opcore public API](opcore/api/index.html)\n",
            site / "api/index.html", site, temporary,
        )
        directory_indexes(site, temporary)
        check_links(site)
        (site / ".nojekyll").touch()
        (site / ".opcore-docs").write_text("Generated by scripts/build-docs.sh\n")
        if output.exists():
            shutil.rmtree(output)
        site.rename(output)
    print(f"Built documentation: {output / 'index.html'}")


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit("usage: build-docs.py RUSTDOC_DIRECTORY CLI_REFERENCE_EXECUTABLE OUTPUT_DIRECTORY")
    build(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve(), Path(sys.argv[3]))
