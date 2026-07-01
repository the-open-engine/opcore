# Changelog

## 0.1.0

Initial public release.

- `opcore`: read-only scan, changed-file validation gate (`opcore check`), approval-gated setup (`opcore init`), metric deltas (`opcore measure`), and a local demo loop (`opcore try`).
- Hybrid runtime: a Rust graph core owns extraction, persistence, and queries; TypeScript owns contracts, the CLI, and validation adapters.
- Coverage: deep TypeScript/JavaScript, useful Rust, and experimental Python; other stacks are counted.
- Native graph artifacts for `darwin-arm64`, `darwin-x64`, and `linux-x64`; Windows is unsupported.
- Ships public packages for the CLI, contracts, graph, edit, and validation adapters; fixtures stay internal.
