# Python validation fixtures

Synthetic fixtures for Python validation conformance:

- `clean`: syntax/source-hygiene pass fixture.
- `failing`: syntax, source-hygiene, and import-graph diagnostics.
- `degraded-tools`: type-check degradation when optional Python type tools are absent.
- `compiler-truth`: valid multiline/stub grammar plus compiler-only invalid control-flow and future-import fixtures. Files use a `.fixture` suffix so repository validation does not mistake intentionally synthetic inputs for product source; tests remove the suffix before validation.
