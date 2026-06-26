# Contributing

Lattice is a public alpha for local code intelligence, edit planning, and pre-write validation for coding agents.

## Setup

```bash
npm ci
npm run build
npm test
```

## Before A Pull Request

Run:

```bash
npm run ci
```

For packaging or release changes, also run:

```bash
npm run release:dry-run
npm run release:hygiene
npm run pack:check
```

Maintainers may also run:

```bash
npm run ci:local
```

`ci:local` includes maintainer-only current-tool validation and should not be required for ordinary downstream users.

## Package Boundaries

- Graph extraction, persistence, query, search, and impact belong in `@the-open-engine/lattice-graph`.
- Edit planning, patch/tree planning, symbol edit previews, and validation-gated apply belong in `@the-open-engine/lattice-edit`.
- Validation scopes, overlays, graph-provider policy, and check/validate adapters belong in `@the-open-engine/lattice-validation`.
- TypeScript-specific checks belong in `@the-open-engine/lattice-validation-typescript`.
- Shared types, schemas, command envelopes, and validation helpers belong in `@the-open-engine/lattice-contracts`.
- CLI composition, help, status, doctor, and descriptor output belong in `@the-open-engine/lattice-cli`.

Do not expose old command aliases or new bins. The public CLI bin is `lattice`.

## Release Line

The first public line is `0.1.x-alpha`. Alpha releases may change contracts, but changes should be documented in `CHANGELOG.md` and reflected in JSON schema tests.
