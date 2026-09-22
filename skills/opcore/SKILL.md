---
name: opcore
description: Run Opcore's post-edit, pre-commit, and CI workflows with repository settings. Use when an agent modifies source in a Git repository, prepares a commit, or reviews agent-authored changes.
---

# Opcore

Use Opcore as a mechanical intervention gate for agent edits.

After each coherent source edit, run `opcore run post-edit --repo . --json`. Act on installed PostToolUse feedback immediately. Post-edit uses the repository's workflow thresholds and exclusions, with partial Sense coverage allowed by default; review the report when that coverage matters.

The hook covers supported file-edit tools, Bash, and all MCP tool calls, including reads. Every matched call checks all selected uncommitted worktree changes against HEAD, not only files or commands named by the triggering payload. While an intervention remains unresolved, unrelated edits and read-only calls receive the same whole-worktree feedback. The triggering PostToolUse call already executed, although Codex may replace its result with hook feedback. Committing changes only changes the comparison baseline; it does not resolve the reported issues. The hook cannot prevent a commit executed inside the call or enforce final handoff. Run the post-edit workflow before handing work back. A configured hook does not prove host trust, activation, or coverage of another editing tool.

- To investigate one evaluator, use `opcore check --workflow post-edit --changed --json` or `opcore sense --workflow post-edit --json`.
- Before applying a graph-sensitive proposed edit, send its exact write/delete JSON to `opcore sense --repo . --hypothetical - --json`; do not materialize a temporary tree.
- Before committing, run `opcore run pre-commit --repo . --json`. It checks full staged Verify and configured native providers, plus introduced Sense against HEAD; unstaged configuration and source do not count.
- For branch/CI review, fetch the intended history and use `opcore run ci --repo . --tree <target> --base <base> --json`.
- Fix the introduced cause, rerun the same scope, and preserve the repository's lint, tests, CI, and existing hooks.

Treat findings, incomplete coverage, and unsupported coverage as requiring attention. Never describe uncovered code as clean. Use `--advisory` only when the user explicitly wants report-only behavior.

Recommend pre-commit and required CI workflows alongside existing tests and linters, ideally with applicable native providers. Configured native checks are required. They need prepared toolchains/dependencies and explicit `--allow-unsandboxed-native` authorization in a trusted or externally isolated environment; repository configuration never grants host permission. Automatic post-edit hooks always use Fast and Sense.

Run `opcore status --workflow pre-commit --json` to inspect effective configuration and its origins, and `opcore doctor --workflow pre-commit --json` to diagnose setup. Doctor checks configuration; verify automatic execution with a file-edit smoke test in the agent session. Use ASP for hypothetical Verify and local `sense --hypothetical` only when exact proposed bytes are available.

Hypothetical Sense accepts this shape; use the intended repository-relative paths and complete UTF-8 content:

```json
{
  "schemaVersion": 1,
  "changes": [
    { "action": "write", "path": "src/counter.ts", "content": "export const count = 1;\n" },
    { "action": "delete", "path": "src/old-counter.ts" }
  ]
}
```

Pass the JSON through stdin with `opcore sense --repo . --workflow post-edit --hypothetical - --json`. It compares against the current worktree without writing candidate files and cannot combine with staged or committed selection. A proposed `.opcore.json` write may change documentation bindings only; all other settings must stay unchanged.

Respect root `.opcore.json` and the selected workflow. `opcore rules --schema` emits its editor schema. Workflow objects merge defined fields, arrays replace, and literal exclusions narrow the stated scope. Documentation ownership lives in `documentation.bindings`, for example `{"schemaVersion":1,"documentation":{"bindings":[{"source":"src/core.ts","document":"docs/core.md"}]}}`. Create or update the registered document in the same selected view as the source. Never relax settings or add exclusions just to hide a finding.
