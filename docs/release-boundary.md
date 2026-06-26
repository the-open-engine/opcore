# Opcore Release Boundary

This repo is the release-facing Opcore home. It should contain the product
surface users see, the package metadata they install, and the docs they read
first.

The previous implementation workspace can remain an internal source of code,
receipts, fixtures, and history. Do not copy internal history into this repo
unless it is needed for the public package or maintainer release proof.

## Export Shape

The release export must choose one shape:

1. **Single product package**: bundle internal modules behind
   `@the-open-engine/opcore` plus platform native packages.
2. **Opcore monorepo**: publish explicit `@the-open-engine/opcore-*` packages
   for contracts, graph, validation, provider, and native artifacts.

The chosen shape must not expose legacy package names or repository metadata to
users through npm package names, imports, generated schemas, install output, or
quickstart docs.

## Required Public Surfaces

- `@the-open-engine/opcore` with `opcore` bin.
- Platform native packages for supported alpha targets.
- Optional ASP provider package or subpath, named as Opcore.
- README quickstart.
- Agent setup guidance.
- Release receipt or maintainer proof that is clearly private until approval.

## Things To Keep Out Of The First-Reader Path

- ASP conformance internals.
- Provider authority axes.
- Host receipts and hostile-provider matrices.
- Historical guardrail migration details.
- Internal package split details unless the user is developing providers.

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
