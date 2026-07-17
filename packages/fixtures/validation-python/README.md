# Python validation fixtures

`mypy-authority/` is the real-tool proof repository for `python.types`. It combines strict mypy configuration, a configured plugin, a stub-only dependency, and a namespace package. `scripts/check-python-mypy-authority.mjs` runs pinned mypy over both clean and hypothetical/materialized after-states and verifies portable manifest identity plus cleanup.
