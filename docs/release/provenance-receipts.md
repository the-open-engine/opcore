# Provenance Receipts

Maintainer provenance evidence for the Opcore release gate.

- Current repository and package outputs are scanned.
- Generated provider/build state is forbidden from tracked source.
- Package dependencies and TypeScript outputs must remain repository-confined.
- Native artifact metadata must use package-relative paths.
- Copied Git-history markers are rejected.

Run `npm run provenance:check` to refresh the executable proof.
