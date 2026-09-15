# Documentation versions

[Overview](../README.md) · [Getting started](getting-started.md) · [Architecture](architecture.md)

Opcore uses the same documentation URLs as Zeroshot. Paths below are relative to
`https://the-open-engine.github.io/opcore/`.

| Path | Content | Changes later? |
| --- | --- | --- |
| `vX.Y.Z/` | Documentation for one exact release | No |
| `stable/` | Redirects to the newest published release snapshot | Yes |
| `dev/` | Documentation from current `main` | Yes |
| `versions.json` | Version selector entries, including the stable alias | Yes |
| `vX.Y.Z/manifest.json` | Source identity and named documentation routes | No |

The site root opens `stable` after the first release snapshot is published. Until
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
  "docsVersion": "v0.3.0",
  "productVersion": "0.3.0",
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

To link to documentation for an installed release, read its exact manifest,
check `schemaVersion` and `productVersion`, and resolve a named route against
that version's base URL. For example, `v0.3.0/` plus `routes.cli` selects
`v0.3.0/cli.html`.

`contentDigest` covers each sorted relative file path and its bytes, excluding
the manifest itself. Each path and content value has an unsigned 64-bit
big-endian byte-length prefix before hashing with SHA-256. The publisher checks
stored snapshots before adding another version.

## Publication and recovery

After a successful push-triggered CI run, **Publish versioned documentation**
builds the exact source commit. A `main` build updates `dev`; a completed release
build adds its `vX.Y.Z` snapshot and updates `stable`. The publisher verifies that
the source belongs to `main`, that a release tag resolves to that source, and
that its version matches the Cargo package. Stable promotion also requires the
newest release tag.

GitHub Pages uses **GitHub Actions** as its publishing source. The publisher
stores the complete version tree on `gh-pages`, then deploys that tree through
the Pages actions. Publications queue so concurrent builds retain earlier
versions. The `github-pages` environment remains restricted to `main`.

For development recovery, run:

```sh
gh workflow run docs.yml --repo the-open-engine/opcore --ref main
```

To publish or recover an exact release, supply its tag and source commit:

```sh
docs_source_commit=$(git rev-parse 'refs/tags/v0.3.0^{commit}')
gh workflow run docs.yml --repo the-open-engine/opcore --ref main \
  -f version=v0.3.0 \
  -f release_commit="$docs_source_commit" \
  -F stable=true
```

Manual recovery repeats the strict documentation build and provenance checks.
A retry from the same source preserves the stored release pages and can repair
the stable alias or retry deployment. Another source commit cannot overwrite
that version. Omit `stable=true` when adding an older release snapshot.

Opcore 0.3.0 already contains the static documentation builder, so its exact tag
can initialize versioned documentation after this publisher lands. Legacy tags
without that builder cannot be backfilled. Never label documentation built
from a newer source commit as an older release.
