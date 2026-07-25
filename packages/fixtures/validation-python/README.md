# Python validation fixtures

`mypy-authority/` is the real-tool proof repository for `python.types`. It combines strict mypy configuration, a configured plugin, a stub-only dependency, and a namespace package. Source and configuration resources retain a `.fixture` suffix on disk so Opcore does not discover them as live repository inputs; the proof script strips that suffix in its isolated workspace. `scripts/check-python-mypy-authority.mjs` runs pinned mypy over both clean and hypothetical/materialized after-states and verifies portable manifest identity plus cleanup.

`pyright-authority/` is the real-tool Pyright proof repository. It covers JSONC, recursive extends, include/exclude/ignore, extra paths, strict execution environments, namespace/src/stub layouts, hypothetical/materialized equivalence, portable receipts, packed Opcore execution, and cleanup with pinned Pyright 1.1.411.

`pytest-authority/` contains opt-in real-tool pytest authority fixtures for pass, failure, collection failure, timeout, manifest fallback, ambient-plugin isolation, and workspace isolation. Synthetic source, test, and packaging files retain a `.fixture` suffix so repository validation and provenance checks do not treat them as live product source; the authority proof materializes canonical filenames in an isolated workspace.
