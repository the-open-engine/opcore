# Inspect Implementations Evidence

Issue: #102

`opcore inspect implementations` is read-only evidence over fresh graph `IMPLEMENTS` and `INHERITS` facts plus
TypeScript/TSX language-service locations. Results include implementation file, line, column, span, symbol, relation
kind, target identity, graph node ids, and resolver provenance.

Covered behavior includes class implementation and inheritance, interface inheritance, TSX declarations, path aliases,
same-name disambiguation, node-id targets, and typed unavailable/stale/missing/ambiguous/unsupported failures.

Constructor parameter usage remains reference evidence rather than implementation evidence.
