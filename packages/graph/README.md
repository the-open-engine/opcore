# @the-open-engine/opcore-graph

Opcore graph provider package for repository graph extraction, query, search, and impact surfaces.

The package also owns canonical Python repo-import analysis. `analyzePythonImports` accepts only supplied `.py`/`.pyi` after-state files, materializes them in an isolated temporary repository, runs the installed graph-core build/query path, returns sorted directed `IMPORTS_FROM` file edges, and always removes temporary state. It never reads or writes the target worktree.

`createEphemeralGraphSnapshot` materializes a complete, bounded validation-visible source universe under an isolated root, builds graph-core once, binds query metadata to the logical target repository, and provides idempotent recursive disposal. Incomplete/truncated listings and file, depth, byte, build, or query failures are loud; target sources and persistent graph artifacts are never mutated.
