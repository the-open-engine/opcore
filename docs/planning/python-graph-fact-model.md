# Python Graph Fact Model

Issue: #17.

## Parser Decision

Use `tree-sitter-python` with `tree-sitter` in `crates/graph-core`.

- `tree-sitter-python` (`https://docs.rs/tree-sitter-python/0.25.0/tree_sitter_python/`) has maintained Python grammar coverage, error recovery, and small C grammar build weight on the supported native targets: `darwin-arm64`, `darwin-x64`, and `linux-x64`.
- `tree-sitter` (`https://docs.rs/tree-sitter/0.26.9/tree_sitter/`) returns partial syntax trees with `root_node().has_error()`, which lets extraction emit non-fatal `parse_error` warnings and preserve available graph facts.
- `rustpython-parser` was rejected for this issue because it is a full RustPython parser surface with less useful recovery behavior for partial graph extraction and higher semantic weight than the fact collector needs.
- `rustpython-ruff_python_parser` was rejected because it is not the maintained public Ruff parser crate for downstream graph providers and current docs indicate a newer Rust baseline than this alpha line should assume.

## Nodes

Python extraction emits:

- `File`: source file node with `language: "python"` and `parser: "tree_sitter_python"`.
- `Module`: one module node per `.py` or `.pyi`; `__init__.py` maps to its package dotted name.
- `Class`: class declarations, including test classes.
- `Function`: functions, methods, nested functions, and `async def`; method IDs use lexical qualifiers such as `Class.method`.
- `Variable`: module-level assignments only.

Decorators are recorded on class/function attributes as best-effort strings. Nested functions remain lexical children but are not exported. `async def` records `async: true`.

## Edges

- `CONTAINS`: `File -> Module`, then lexical parent to child.
- `IMPORTS_FROM` and `DEPENDS_ON`: repo-local `import` and `from ... import ...` targets.
- `CALLS`: identifier and dotted call targets resolved through local declarations and imports.
- `INHERITS`: class base names resolved through local declarations and imports.
- `TESTED_BY`: pytest-style `test_*` functions and `Test*`/`unittest.TestCase` test methods linked to resolved call targets.

Import resolution covers absolute dotted modules, relative imports, package `__init__.py`, and `.pyi` candidates. Unresolved relative or repo-local imports emit warning category `unresolved_import`; external imports are ignored.

## Exports

Python has no enforced export boundary, so `attributes.exported` is best-effort:

- If module-level `__all__` is present, members listed there are exported with `exportPolicy: "__all__"`.
- Otherwise, module-level names without a leading underscore are exported with `exportPolicy: "underscore_convention"`.
- Nested declarations and methods are not exported.
- `File.attributes.exports[]` entries include `kind: "named"`, `source: null`, `supportedSymbol`, and `policy`.

This is public-API evidence, not an authoritative runtime import or packaging claim.
