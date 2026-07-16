# @the-open-engine/opcore-graph

Opcore graph provider package for repository graph extraction, query, search, and impact surfaces.

The package also owns canonical Python repo-import analysis. `analyzePythonImports` accepts only supplied `.py`/`.pyi` after-state files, materializes them in an isolated temporary repository, runs the installed graph-core build/query path, returns sorted directed `IMPORTS_FROM` file edges, and always removes temporary state. It never reads or writes the target worktree.
