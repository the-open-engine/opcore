"""Publish one documentation archive per minor series and mutable development docs."""

import argparse
import hashlib
import html
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
from urllib.parse import quote


ASSETS = Path(__file__).resolve().parent / "docs"
RELEASE = re.compile(r"v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\Z")
MINOR = re.compile(r"v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\Z")
COMMIT = re.compile(r"[0-9a-f]{40}\Z")
STATE = ".opcore-pages.json"
ROUTES = {
    "overview": "",
    "install": "docs/getting-started.html",
    "configuration": "docs/configuration.html",
    "providers": "docs/providers.html",
    "cli": "cli.html",
    "rustApi": "api/opcore/api/index.html",
    "providerProfiles": "api/opcore/api/enum.ProviderProfile.html",
    "asp": "asp/README.html",
}


def version_key(version):
    match = MINOR.fullmatch(version)
    if version == "dev":
        return (-1, -1)
    if match is None:
        raise ValueError("documentation archive must be dev or vX.Y")
    return tuple(int(part) for part in match.groups())


def release_key(version):
    match = RELEASE.fullmatch(version)
    if match is None:
        raise ValueError("release version must be vX.Y.Z")
    return tuple(int(part) for part in match.groups())


def archive_version(release):
    if release == "dev":
        return release
    major, minor, _ = release_key(release)
    return f"v{major}.{minor}"


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def regular_tree(root):
    if root.is_symlink() or not root.is_dir():
        raise ValueError("documentation root must be a regular directory")
    for path in root.rglob("*"):
        if ".git" in path.relative_to(root).parts:
            continue
        if path.is_symlink() or not (path.is_file() or path.is_dir()):
            raise ValueError(f"documentation contains a non-regular entry: {path}")


def content_digest(root):
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*")):
        if path.is_file() and path != root / "manifest.json":
            name = path.relative_to(root).as_posix().encode()
            content = path.read_bytes()
            digest.update(len(name).to_bytes(8, "big") + name)
            digest.update(len(content).to_bytes(8, "big") + content)
    return "sha256:" + digest.hexdigest()


def verify_snapshot(root, version):
    manifest = read_json(root / "manifest.json")
    if manifest.get("schemaVersion") != 1 or manifest.get("docsVersion") != version:
        raise ValueError(f"invalid documentation manifest for {version}")
    if not COMMIT.fullmatch(manifest.get("sourceCommit", "")):
        raise ValueError(f"invalid source commit for {version}")
    if version != "dev" and archive_version("v" + manifest.get("productVersion", "")) != version:
        raise ValueError(f"product version does not belong to {version}")
    if manifest.get("contentDigest") != content_digest(root):
        raise ValueError(f"published snapshot {version} has changed")
    return manifest


def relative_url(target, page):
    return quote(os.path.relpath(target, page.parent), safe="/")


def redirect(page, target):
    url = relative_url(target, page)
    page.parent.mkdir(parents=True, exist_ok=True)
    page.write_text(
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        '<title>Opcore documentation</title>'
        f'<meta http-equiv="refresh" content="0; url={html.escape(url, quote=True)}">'
        f'<script>location.replace({json.dumps(url)} + location.search + location.hash);</script>'
        f'</head><body><a href="{html.escape(url, quote=True)}">Open documentation</a></body></html>\n',
        encoding="utf-8",
    )


def decorate(snapshot, version):
    for name in ("versions.js", "versions.css"):
        shutil.copyfile(ASSETS / name, snapshot / "assets" / name)
    for page in snapshot.rglob("*.html"):
        text = page.read_text(encoding="utf-8")
        if '<div class="header-actions">' not in text:
            continue
        site_root = relative_url(snapshot.parent, page) + "/"
        page_path = page.relative_to(snapshot).as_posix()
        label = "Development" if version == "dev" else version
        control = (
            f'<div class="docs-version" data-site-root="{site_root}" '
            f'data-page-path="{html.escape(page_path, quote=True)}" data-version="{version}">'
            f'<a href="{site_root}versions.html">{label} ▾</a>'
            f'<select hidden aria-label="Documentation version"><option>{label}</option></select></div>'
        )
        text = text.replace('<div class="header-actions">', '<div class="header-actions">' + control, 1)
        assets = "".join((
            f'<link rel="stylesheet" href="{relative_url(snapshot / "assets/versions.css", page)}">',
            f'<script defer src="{relative_url(snapshot / "assets/versions.js", page)}"></script>',
        ))
        page.write_text(text.replace("</head>", assets + "</head>", 1), encoding="utf-8")


def snapshot_identity(options):
    version = archive_version(options.version)
    if not COMMIT.fullmatch(options.source_commit) or not COMMIT.fullmatch(options.publisher_commit):
        raise ValueError("source and publisher commits must be full lowercase Git commits")
    if options.version != "dev" and options.version != "v" + options.product_version:
        raise ValueError("documentation version does not match the product version")
    if (options.stable or options.auto_stable) and options.version == "dev":
        raise ValueError("development documentation cannot become stable")
    return {
        "schemaVersion": 1,
        "docsVersion": version,
        "productVersion": None if options.version == "dev" else options.product_version,
        "sourceCommit": options.source_commit,
        "publisherCommit": options.publisher_commit,
        "routes": ROUTES,
    }


def keep_release(current, identity):
    previous = release_key("v" + current["productVersion"])
    incoming = release_key("v" + identity["productVersion"])
    if incoming == previous and current["sourceCommit"] != identity["sourceCommit"]:
        raise ValueError(f"release {identity['productVersion']} is immutable and belongs to another source")
    return incoming <= previous


def install_snapshot(site, options):
    identity = snapshot_identity(options)
    version = identity["docsVersion"]
    destination = site / version
    if destination.exists() and options.version != "dev":
        current = verify_snapshot(destination, version)
        if keep_release(current, identity):
            return
    if destination.exists():
        shutil.rmtree(destination)
    if not (options.snapshot / ".opcore-docs").is_file():
        raise ValueError("input is not an Opcore documentation build")
    for route in ROUTES.values():
        if not (options.snapshot / (route or "index.html")).is_file():
            raise ValueError(f"snapshot is missing required route: {route}")
    shutil.copytree(options.snapshot, destination)
    decorate(destination, version)
    identity["contentDigest"] = content_digest(destination)
    write_json(destination / "manifest.json", identity)


def verify_entry(site, entry):
    version_key(entry["version"])
    verify_snapshot(site / entry["version"], entry["version"])
    if entry["aliases"] not in ([], ["stable"]):
        raise ValueError("unknown documentation alias")


def read_state(site):
    if not any(site.iterdir()):
        return {"schemaVersion": 1, "rootPages": []}, []
    state = read_json(site / STATE)
    entries = read_json(site / "versions.json")
    if state.get("schemaVersion") != 1 or not isinstance(entries, list):
        raise ValueError("unknown published documentation state")
    versions = [entry["version"] for entry in entries]
    if len(set(versions)) != len(versions):
        raise ValueError("duplicate documentation version")
    stable = []
    for entry in entries:
        verify_entry(site, entry)
        if entry["aliases"]:
            stable.append(entry["version"])
    if len(stable) > 1 or "dev" in stable:
        raise ValueError("invalid stable alias")
    return state, entries


def update_entries(entries, options):
    version = archive_version(options.version)
    by_version = {entry["version"]: dict(entry) for entry in entries}
    by_version.setdefault(version, {
        "version": version,
        "title": "Development" if version == "dev" else version,
        "aliases": [],
    })
    newest = max(by_version, key=version_key)
    if options.stable:
        if newest != version:
            raise ValueError("stable cannot move backwards")
    if options.stable or options.auto_stable:
        for entry in by_version.values():
            entry["aliases"] = ["stable"] if entry["version"] == newest else []
    return sorted(by_version.values(), key=lambda entry: version_key(entry["version"]), reverse=True)


def stable_alias(site, version):
    alias = site / "stable"
    if alias.exists():
        shutil.rmtree(alias)
    shutil.copytree(site / version, alias)
    for page in alias.rglob("*.html"):
        redirect(page, site / version / page.relative_to(alias))


def clear_root_pages(site, state):
    for name in state["rootPages"]:
        path = Path(name)
        if path.is_absolute() or ".." in path.parts or path.suffix != ".html":
            raise ValueError("invalid compatibility redirect path")
        if path.parts[0] in ("dev", "stable") or MINOR.fullmatch(path.parts[0]) or RELEASE.fullmatch(path.parts[0]):
            raise ValueError("compatibility redirects cannot replace version snapshots")
        (site / path).unlink(missing_ok=True)


def compatibility_pages(snapshot):
    pages = sorted(path.relative_to(snapshot) for path in snapshot.rglob("*.html"))
    for page in pages:
        if page.parts[0] in ("dev", "stable") or MINOR.fullmatch(page.parts[0]) or RELEASE.fullmatch(page.parts[0]):
            raise ValueError("snapshot route collides with a documentation version")
    return pages


def write_aliases(site, state, entries):
    clear_root_pages(site, state)
    stable = next((entry["version"] for entry in entries if entry["aliases"]), None)
    default = stable or ("dev" if (site / "dev").is_dir() else entries[0]["version"])
    if stable:
        stable_alias(site, stable)
    alias = "stable" if stable else default
    pages = compatibility_pages(site / default)
    for page in pages:
        redirect(site / page, site / alias / page)
    write_json(site / STATE, {
        "schemaVersion": 1, "default": alias, "rootPages": [path.as_posix() for path in pages],
    })


def versions_page(site, entries):
    links = []
    for entry in entries:
        version = entry["version"]
        label = entry["title"] + (" (stable)" if entry["aliases"] else "")
        links.append(f'<li><a href="{version}/index.html">{html.escape(label)}</a></li>')
    default = read_json(site / STATE)["default"]
    page = (
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        '<title>Documentation versions · Opcore</title>'
        f'<link rel="stylesheet" href="{default}/assets/site.css"></head>'
        '<body class="guide-page"><main class="guide-content" style="max-width:50rem;margin:3rem auto;padding:1rem">'
        '<h1>Documentation versions</h1><p>Each minor version follows its latest published patch. '
        'Stable opens the newest minor version. Development follows main.</p>'
        f'<ul>{"".join(links)}</ul></main></body></html>\n'
    )
    (site / "versions.html").write_text(page, encoding="utf-8")


def compose(options):
    if options.output.exists():
        raise ValueError("output must be a new directory")
    regular_tree(options.snapshot)
    options.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=options.output.parent, prefix=".opcore-versions-") as scratch:
        site = Path(scratch) / "site"
        if options.published:
            regular_tree(options.published)
            shutil.copytree(options.published, site, ignore=shutil.ignore_patterns(".git"))
        else:
            site.mkdir()
        state, entries = read_state(site)
        snapshot_identity(options)
        entries = update_entries(entries, options)
        install_snapshot(site, options)
        write_aliases(site, state, entries)
        write_json(site / "versions.json", entries)
        versions_page(site, entries)
        (site / ".nojekyll").touch()
        site.rename(options.output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", required=True, type=Path)
    parser.add_argument("--published", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--version", required=True, help="exact release tag vX.Y.Z, or dev")
    parser.add_argument("--product-version", required=True)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--publisher-commit", required=True)
    promotion = parser.add_mutually_exclusive_group()
    promotion.add_argument("--stable", action="store_true")
    promotion.add_argument("--auto-stable", action="store_true", help="select the newest archived minor")
    compose(parser.parse_args())


if __name__ == "__main__":
    main()
