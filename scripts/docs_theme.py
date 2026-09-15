"""Build-only page chrome shared by the guides and rustdoc references."""

import html
import os
from pathlib import Path
import re


ASSETS = Path(__file__).resolve().parent / "docs"
NAVIGATION = (
    ("Opcore", (("Overview", "index.html"),)),
    ("Get started", (("Installation and first check", "docs/getting-started.html"),)),
    ("Guides", (
        ("Configuration", "docs/configuration.html"),
        ("Providers", "docs/providers.html"),
        ("Examples", "docs/examples.html"),
        ("Project Sense", "docs/sense.html"),
        ("Agent feedback", "docs/agent-signals.html"),
    )),
    ("Reference", (
        ("CLI", "cli.html"),
        ("Rust API", "api/opcore/api/index.html"),
        ("Provider profiles", "api/opcore/api/enum.ProviderProfile.html"),
        ("ASP specification", "asp/README.html"),
    )),
    ("Project", (
        ("Architecture", "docs/architecture.html"),
        ("Contributing", "CONTRIBUTING.html"),
        ("Code of conduct", "CODE_OF_CONDUCT.html"),
        ("Security", "SECURITY.html"),
    )),
)


def relative_link(path, destination, site):
    return html.escape(os.path.relpath(site / path, destination.parent), quote=True)


def navigation(destination, site):
    groups = []
    current = destination.relative_to(site).as_posix()
    for label, entries in NAVIGATION:
        links = []
        for title, path in entries:
            selected = ' aria-current="page"' if current == path else ""
            url = relative_link(path, destination, site)
            links.append(f'<li><a href="{url}"{selected}>{title}</a></li>')
        groups.append(f'<div class="nav-group"><p>{label}</p><ul>{"".join(links)}</ul></div>')
    return '<nav id="site-navigation" aria-label="Documentation">' + "".join(groups) + "</nav>"


def site_header(destination, site):
    root = relative_link("index.html", destination, site)
    logo = relative_link("assets/oec-crow.png", destination, site)
    return f'''<a class="skip-link" href="#main-content">Skip to content</a>
<header class="site-header"><div class="header-inner">
<button class="menu-toggle" type="button" aria-expanded="false" aria-controls="site-navigation">Menu</button>
<a class="brand" href="{root}"><img src="{logo}" alt="" width="32" height="36"><span>Opcore</span></a>
<a class="header-label" href="{root}">Documentation</a>
<div class="header-actions"><button class="theme-toggle" type="button" aria-label="Use dark mode" title="Use dark mode"><svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M20.8 13.1A9 9 0 0 1 10.9 3.2 9 9 0 1 0 20.8 13.1Z"/></svg></button>
<a class="repository-link" href="https://github.com/the-open-engine/opcore">GitHub <span aria-hidden="true">↗</span></a></div>
</div></header>'''


def site_head(destination, site):
    links = [f'<link rel="stylesheet" href="{relative_link("assets/site.css", destination, site)}">']
    for name in ("theme.js", "site.js"):
        defer = " defer" if name == "site.js" else ""
        links.append(f'<script{defer} src="{relative_link("assets/" + name, destination, site)}"></script>')
    icon = relative_link("assets/oec-favicon.svg", destination, site)
    links.append(f'<link rel="icon" type="image/svg+xml" href="{icon}">')
    return "\n".join(links)


def site_footer():
    return '''<footer class="site-footer"><div>© The Open Engine
<a href="https://github.com/the-open-engine/opcore">Opcore on GitHub ↗</a></div></footer>'''


def guide_body(rendered):
    body = re.search(r'<body class="rustdoc">(.*?)</body>', rendered, re.DOTALL).group(1)
    body = re.sub(r'<!--.*?-->', "", body, flags=re.DOTALL).strip()
    match = re.search(r'<nav id="rustdoc">.*?</nav>', body, flags=re.DOTALL)
    contents = match.group(0) if match else ""
    body = body.replace(contents, "", 1) if contents else body
    # Guide source files retain their compact cross-links for readers on GitHub.
    body = re.sub(r'<p><a [^>]+>Overview</a> · .*?</p>', "", body, count=1)
    body = re.sub(r'<blockquote>\s*<p>\[!IMPORTANT\](?:<br\s*/?>)?\s*',
                  '<blockquote class="admonition"><p class="admonition-title">Important</p><p>', body)
    return body, contents


def page_sequence(destination, site):
    entries = [entry for _, group in NAVIGATION for entry in group]
    paths = [path for _, path in entries]
    current = destination.relative_to(site).as_posix()
    if current not in paths:
        return ""
    index = paths.index(current)
    links = []
    for offset, label in ((-1, "Previous"), (1, "Next")):
        neighbor = index + offset
        if 0 <= neighbor < len(entries):
            title, path = entries[neighbor]
            url = relative_link(path, destination, site)
            links.append(f'<a href="{url}"><span>{label}</span>{title}</a>')
    return '<nav class="page-sequence" aria-label="Adjacent pages">' + "".join(links) + '</nav>'


def render_guide(rendered, destination, site):
    body, contents = guide_body(rendered)
    title = re.search(r'<title>(.*?)</title>', rendered, re.DOTALL).group(1)
    toc = '<aside class="page-toc" aria-label="On this page"><p>On this page</p>' + contents + '</aside>'
    return f'''<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>{title} · Opcore</title>{site_head(destination, site)}</head>
<body class="guide-page">{site_header(destination, site)}
<div class="docs-layout"><aside class="docs-sidebar">{navigation(destination, site)}</aside>
<main id="main-content" class="guide-content" tabindex="-1">
<p class="docs-kicker">Core documentation</p>{body}{page_sequence(destination, site)}</main>{toc}</div>
{site_footer()}</body></html>'''


def style_api(page, site):
    rendered = page.read_text()
    # Reexport redirects have no article or controls to style.
    if '<body class="rustdoc' not in rendered:
        return rendered
    rendered = rendered.replace('</head>', site_head(page, site) + '</head>', 1)
    rendered = re.sub(r'<body class="rustdoc([^"]*)">',
                      lambda match: '<body class="rustdoc api-page' + match.group(1) + '">'
                      + site_header(page, site), rendered, count=1)
    return rendered
