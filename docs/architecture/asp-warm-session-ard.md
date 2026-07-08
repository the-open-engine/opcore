# ASP Warm Session ARD

## Status

Accepted for issue #153.

## Context

The standalone `opcore-asp-provider --stdio` process is the cold ASP Core check provider. It handles `initialize`, `initialized`, and `check/evaluate` with host-owned `workspace/listTree` and `workspace/readBlob` callbacks, and it intentionally advertises only the `check` capability family.

Inspect and edit parity need lower latency for repeated agent calls, but Opcore alpha still forbids a public `opcore asp` command group, always-on daemons, auto-spawned background processes, source mutation, ASP host authority, and old-tool replacement claims.

## Decision

Add a hidden, host-launched advanced route: `opcore asp serve --stdio`. The route is intercepted in `packages/opcore/src/advanced/index.ts` like `opcore graph serve`; it is not present in `commandRouterManifest`, `opcore --help`, README examples, provider manifests, or public human-facing command lists.

Warm ASP code lives under `packages/opcore/src/advanced/asp-warm/` because only the Opcore advanced router may compose ASP JSON-RPC, inspect language-service code, edit language-service materialization, and a warm `ts-morph` Project. The dependency direction is `opcore -> asp-provider`; `packages/asp-provider` remains a check-only facade and must not import Opcore advanced code, ts-morph, edit, or inspect internals.

The warm server reuses the ASP provider JSON-RPC peer and delegates `check/evaluate` to the unchanged provider mapping. It extends the initialized warm process with:

- `inspect/references` over an injected whole-repo `ts-morph` Project.
- `edit/rename` preview over the edit package language-service materializer.
- `session/shutdown` for explicit lifecycle termination.

The warm project registry keeps a bounded process-local Project, reconciles it against Git HEAD and file-system changes, snapshots before in-memory edits, reverts after preview, and poisons/rebuilds after unexpected mid-edit faults. It never calls `save()` and never writes source files.

Lifecycle state is stored under `.opcore/asp/session.json` with singleton PID/liveness, idle timeout, and shutdown state. This is session bookkeeping only; no socket, daemon manager, auto-spawn, or background service is introduced.

## Consequences

- Hosts can opt into a warm inspect/edit/check session when they launch `opcore asp serve --stdio`.
- Humans still use public `opcore inspect`, `opcore edit`, and `opcore check` routes for cold one-shot behavior.
- `opcore-asp-provider --stdio` remains the package-owned cold check provider with `capabilityFamilies:["check"]`.
- Warm inspect/edit JSON shapes are recorded in `packages/contracts` and the JSON schema, but the route remains hidden from public command manifests.
- If future ASP inspect/edit behavior requires cross-process persistence or a daemon manager, that must be a new issue and architecture decision; issue #153 does not authorize it.
