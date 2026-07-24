# Python validation fixtures

`mypy-authority/` is the real-tool proof repository for `python.types`. It combines strict mypy configuration, a configured plugin, a stub-only dependency, and a namespace package. Source and configuration resources retain a `.fixture` suffix on disk so Opcore does not discover them as live repository inputs; the proof script strips that suffix in its isolated workspace. `scripts/check-python-mypy-authority.mjs` runs pinned mypy over both clean and hypothetical/materialized after-states and verifies portable manifest identity plus cleanup.

`pyright-authority/` is the real-tool Pyright proof repository. It covers JSONC, recursive extends, include/exclude/ignore, extra paths, strict execution environments, namespace/src/stub layouts, hypothetical/materialized equivalence, portable receipts, packed Opcore execution, and cleanup with pinned Pyright 1.1.411.
