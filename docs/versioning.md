# Documentation versions

[Overview](../README.md) · [Getting started](getting-started.md) · [Architecture](architecture.md)

Opcore archives documentation by minor version. Each archive follows the latest
published patch in that series: `v0.3.1` updates `v0.3/`, while `v0.4.0` starts
`v0.4/`. Patch releases do not create separate directories or selector entries.
Paths below are relative to `https://the-open-engine.github.io/opcore/`.

| Path | Content | Changes later? |
| --- | --- | --- |
| `vX.Y/` | Documentation for the latest archived patch in one minor series | On a newer patch in that series |
| `stable/` | Redirects to the newest archived minor series | Yes |
| `dev/` | Documentation from current `main` | Yes |
| `versions.json` | Version selector entries, including the stable alias | Yes |
| `vX.Y/manifest.json` | Exact patch version, source identity, and named routes | With its archive |

The site root opens `stable` after the first release archive is promoted. Until
then, it opens `dev`. Existing unversioned HTML links, including
`docs/getting-started.html`, redirect to the corresponding page in the default
version and retain query parameters and anchors.

The header shows the current version. Switching versions keeps the current page
when it exists in the chosen snapshot; otherwise, the selector opens that
version's overview. The version list also works without JavaScript.

## Snapshot identity

Every snapshot contains a manifest with this structure:

```json
{
  "schemaVersion": 1,
  "docsVersion": "v0.3",
  "productVersion": "0.3.1",
  "sourceCommit": "FULL_SOURCE_COMMIT",
  "publisherCommit": "FULL_PUBLISHER_COMMIT",
  "contentDigest": "sha256:SNAPSHOT_DIGEST",
  "routes": {
    "overview": "",
    "install": "docs/getting-started.html",
    "configuration": "docs/configuration.html",
    "providers": "docs/providers.html",
    "cli": "cli.html",
    "rustApi": "api/opcore/api/index.html",
    "providerProfiles": "api/opcore/api/enum.ProviderProfile.html",
    "asp": "asp/README.html"
  }
}
```

`sourceCommit` identifies the guides, source-generated CLI and API references,
and bundled ASP definition. `publisherCommit` identifies the version selector
and publication tools. Both are full Git commit IDs. `productVersion` is `null`
for development documentation.

To link to documentation for an installed release, use its major and minor
version and resolve a named route against that archive's base URL. For example,
`v0.3/` plus `routes.cli` selects `v0.3/cli.html`. The manifest records which patch
the archive currently describes; it may be newer than the installed patch.

Checked-in README, npm README, and installed-skill sources link directly to the
complete `dev/` pages so guidance on `main` never carries a stale minor. Release
bundle staging rewrites the README and skill links to the validated binary's
`vX.Y/` archive; npm release staging does the same using the validated package
version. CLI remediation URLs derive that minor from Cargo package metadata.
Packaging tests reject a release whose documentation route does not match its
version. `stable/` and the unversioned paths remain useful browser redirects,
but fetch-only troubleshooting references must use `dev/` or an exact minor
because redirect pages do not contain the guide body.

`contentDigest` covers each sorted relative file path and its bytes, excluding
the manifest itself. Each path and content value has an unsigned 64-bit
big-endian byte-length prefix before hashing with SHA-256. The publisher checks
stored snapshots before adding another version.

## Publication and recovery

After a successful push-triggered CI run, **Publish versioned documentation**
builds the exact source commit. A `main` build updates `dev`; a completed release
build updates its `vX.Y` archive and selects the newest archived minor for
`stable`. The publisher verifies that
the source belongs to `main`, that a release tag resolves to that source, and
that its exact patch version matches the Cargo package. Stable selection uses
the published archives, so a newer tag whose build has not finished cannot
block documentation publication.

A patch for an older series updates that series without moving `stable`
backwards. Version comparisons are numeric: `0.3.10` replaces `0.3.2`. A late
`0.3.3` publication leaves the `0.3.10` archive untouched. The manifest always
records the source commit of the patch whose content remains in the archive.

GitHub Pages uses **GitHub Actions** as its publishing source. The publisher
stores the complete version tree on `gh-pages`, then deploys that tree through
the Pages actions. Publications queue so concurrent builds retain earlier
versions. The `github-pages` environment remains restricted to `main`.

For development recovery, run:

```sh
gh workflow run docs.yml --repo the-open-engine/opcore --ref main
```

To update or recover a minor archive, supply the exact release tag and source
commit to build:

```sh
docs_source_commit=$(git rev-parse 'refs/tags/v0.3.0^{commit}')
gh workflow run docs.yml --repo the-open-engine/opcore --ref main \
  -f version=v0.3.0 \
  -f release_commit="$docs_source_commit" \
  -F stable=true
```

This creates or updates `v0.3/`; it does not create `v0.3.0/`. Manual recovery
repeats the strict documentation build and provenance checks. A retry of the
currently archived release preserves its stored pages and can repair the
stable alias or retry deployment. Another source commit cannot replace that
same release, and an older patch cannot roll back the archive. Only a newer
patch replaces its content. Omit `stable=true` when updating an older minor;
explicit stable promotion rejects an older series.

Opcore 0.3.0 already contains the static documentation builder, so its exact tag
can initialize versioned documentation after this publisher lands. Legacy tags
without that builder cannot be backfilled. Never label documentation built
from a newer source commit as an older release.
