# Pre-Write Validation Integration

Issue #58 defines the hook-safe validation route for ACE and Codex cutover:

```bash
opcore validate pre-write --request-file <validation-request.json> --timeout-ms 30000 --json
```

`--request-file` is required. `--timeout-ms` is optional and defaults to `30000`. The timeout must be a positive integer. Stdin is unsupported.

## Request File

Hooks write a temporary JSON file containing a published `ValidationRequest`:

```json
{
  "requestId": "hook-2026-06-05T19-00-00Z",
  "repo": { "repoRoot": "/repo" },
  "scope": { "kind": "files", "files": ["src/index.ts"] },
  "graph": { "mode": "optional", "provider": "opcore-graph" },
  "overlays": [
    { "path": "src/index.ts", "action": "write", "content": "export const value = 1;\n" }
  ],
  "checks": ["typescript.syntax"]
}
```

Hook inputs map only to `ValidationRequest.scope` and `ValidationRequest.overlays`. `pre-write` rejects command-line scope, repo, check, and graph overrides so the request file remains the auditable input.

## Semantics

The route runs the same normalized validation path as `opcore validate --request-file`. Overlays are hypothetical: checks read proposed writes and deletes through `ValidationCheckContext.fileView`, and the worktree is not mutated.

Exit code `0` means validation passed. Exit code `1` means fail closed. Malformed JSON, invalid contracts, timeout, missing required graph provider, stale graph, schema mismatch, provider errors, policy failures, and checksum conflicts all return stable JSON diagnostics.

## Receipt

JSON output includes `validationResult` and `receipt`.

Pass receipts include:

- `schemaVersion`, `kind: "pre_write_validation"`, `route: "validate.pre-write"`
- `canonicalCommand`, `generatedAt`, `durationMs`, `timeoutMs`, `ok: true`
- `requestId` when supplied
- repo identity, scope, checks, graph mode/status, overlay counts and paths
- `validationStatus: "passed"` and `diagnosticCount`

Failure receipts include the same timing and route metadata plus `ok: false`, `validationStatus`, `diagnosticCount`, and `failureSummary`.

Consumers must treat any non-zero exit, missing receipt, invalid receipt, or timeout as a blocked write.
