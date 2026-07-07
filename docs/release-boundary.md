# Opcore Release Boundary

This repo is the release-facing Opcore home. It should contain the product
surface users see, the package metadata they install, and the docs they read
first.

The previous implementation workspace can remain an internal source of code,
receipts, fixtures, and history. Do not copy internal history into this repo
unless it is needed for the public package or maintainer release proof.

## Export Shape Decision

Decision: use a full monorepo export, not a thin wrapper repo.

A thin wrapper would either depend on old implementation package names or vendor
their build output. Both make the public release depend on an internal repo and
leak the wrong product identity through npm metadata, stack traces, generated
schemas, or release receipts.

The release repo should keep the current source package boundaries, but publish
only the `opcore` npm package. Internal workspace packages, the ASP provider,
and the native graph artifacts are bundled inside that tarball as implementation
payloads, not published as user-installable packages.

- root workspace: private `opcore`;
- public npm package: `opcore`;
- public bins from that package: `opcore` and `opcore-asp-provider`;
- internal bundled packages: contracts, graph, edit, validation adapters, ASP
  provider, and `opcore-graph-core-*` native artifacts.

No public package, dependency, generated schema, tarball file list, install
output, or quickstart should expose legacy product naming.

## Required Public Surfaces

- `opcore` with `opcore` and `opcore-asp-provider` bins.
- Bundled platform native artifacts for supported alpha targets.
- ASP provider metadata that names the `opcore` package.
- README quickstart.
- Agent setup guidance.
- Release receipt or maintainer proof that is clearly private until approval.

## Things To Keep Out Of The First-Reader Path

- ASP conformance internals.
- Provider authority axes.
- Host receipts and hostile-provider matrices.
- Historical guardrail migration details.
- Internal package split details unless the user is developing providers.

## Export Work Order

1. Import source from the implementation workspace into this repo without old
   Git history.
2. Rename public package names, dependency imports, repository metadata,
   packlists, release package lists, generated schema names, descriptor names,
   native artifact names, and lockfile entries together.
3. Hide or rename every public legacy product-name bin, command identity,
   provider name, JSON field, descriptor, schema, and receipt value.
4. Keep internal directory names only when they are not emitted in public docs,
   package metadata, JSON output, generated schemas, tarballs, or help text.
5. Regenerate contracts, schemas, fixtures, receipts, descriptors, package
   metadata, and native checksums from the renamed repo.
6. Tighten release hygiene so public first-reader docs cannot mention ASP,
   legacy guardrails, old tool names, broad coverage claims, security/SAST,
   automatic fixing, or scores.
7. Run installed-artifact gates from this repo before any publication step.

## Claim Guardrails

Do not claim:

- public standard status;
- all-language or all-platform support;
- security/SAST coverage;
- AI authorship detection;
- autonomous fixing;
- replacement of existing guardrails;
- direct write prevention unless the deployment actually enforces it.

Do claim, once verified:

- read-only first scan;
- TypeScript/JavaScript and Rust day-one support boundaries;
- honest unsupported-language and missing-tool coverage;
- CLI compatibility with any agent that can run commands;
- ASP provider compatibility for host integrations.
