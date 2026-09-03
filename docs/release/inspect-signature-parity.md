# Inspect Signature Evidence

Issue: #101

`opcore inspect signature` is read-only inspect-owned language-service evidence after graph freshness evaluation.
It returns symbol identity, source location/span, rendered signature, kind, parameters, type parameters, return type,
export/async state, overload index, graph node ids, and resolver provenance.

The fixture suite covers functions, methods, constructors, classes, interfaces, type aliases, overloads,
imported/aliased symbols, path aliases, TS/TSX, JS, JSX, file-symbol targets, and node-id targets.
