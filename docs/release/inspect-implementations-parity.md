# Inspect Implementations Parity

Issue: #102

`lattice inspect implementations` is read-only inspect evidence. It requires fresh graph provider status, uses graph `IMPLEMENTS` and `INHERITS` facts as mandatory input evidence, and materializes TypeScript/TSX locations through the inspect language-service path. It does not return edit plans, apply receipts, validation results, ASP host decisions, or gate authority.

## CIX Field Mapping

| Old `cix impls` field | Lattice field |
|-----------------------|---------------|
| implementation file | `inspectResult.implementations[].file` |
| line and column | `line`, `column`, `span` |
| implementation name | `symbol.name` |
| implementation kind | `kind`: `implements`, `inherited_implements`, `extends`, `interface_extends` |
| queried target | `target.id`, `target.name`, `target.kind` |
| source proof | `evidence.graphNodeIds`, `evidence.resolver` |

## Covered Evidence

- Classes implementing interfaces, including inherited interface satisfaction.
- Classes extending classes, including imported and aliased base names.
- Interface inheritance.
- TSX component/model declarations.
- `tsconfig` path aliases through TypeScript project materialization.
- Same-name symbol disambiguation with `--line` and optional `--column`.
- Node-id class/type targets.
- Typed failures for unavailable/stale graph, missing symbols, malformed targets, ambiguous targets, and unsupported JS/JSX/other files.

## Retained Gap

Constructor parameter usage from old `cix impls` output is retained as a compatibility gap. Lattice classifies constructor usage as reference evidence, not implementation evidence, so it is covered by inspect references rather than implementation results.

This evidence does not claim old-tool retirement, public certification, ASP host authority, or ACE-managed Lattice replacement.
