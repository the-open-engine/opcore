# Opcore Native Policy Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Opcore natively represent and enforce the same repo-local robustness policy capabilities the team depends on today, without importing, translating, loading, or depending on external policy config or runtime.

**Non-negotiable boundary:** Active behavior must come only from Opcore-owned `.opcore/config` policy, Opcore packages, and Opcore check packs. Do not add config importers, translation shims, public fields that describe imported policy, or active runtime branches that inspect external policy config.

**Architecture:** Add a first-class repo validation policy model under `.opcore/config`, then route every Opcore validation entrypoint through one policy-aware check factory. Existing validation packages already implement many primitives; this work wires configurable thresholds, selection, docs, clone, path policy, TypeScript architecture rules, dead-code entrypoints, repo lint plugins, Rust command gates, and custom check packs through supported Opcore-owned APIs.

**Tech Stack:** TypeScript, Node >=22, existing `@the-open-engine/opcore-validation*` packages, Rust graph-core clone subcommand, Node test runner.

---

## Clean Target

Opcore must support this native config shape:

```json
{
  "schemaVersion": 1,
  "kind": "opcore_init_config",
  "validation": {
    "adapters": ["typescript", "rust", "docs", "clone"],
    "timeoutMs": 120000,
    "pathPolicy": {
      "include": ["packages/", "scripts/"],
      "exclude": ["node_modules", "dist", ".ace", ".agents", ".claude", ".codex", ".opcore"]
    },
    "checks": {
      "packs": ["./.opcore/checks/covibes-policy.cjs"],
      "disabled": ["typescript.types"],
      "defaults": ["docs.existence", "docs.freshness"],
      "typescript": {
        "fileLength": { "maxFileLines": 600 },
        "functionMetrics": { "maxFunctionLines": 120, "maxComplexity": 10, "maxParams": 4 },
        "lint": { "repoPlugin": "./eslint-local-rules/index.cjs", "cacheDependencyGlobs": ["AGENTS.md", "eslint-local-rules/**/*.cjs"] },
        "importGraph": {
          "ignoreTypeOnlyImports": true,
          "layerRules": [
            { "name": "no-client-to-server", "from": "%/client/src/%", "to": "%/server/%" }
          ]
        },
        "deadCode": { "entrypoints": ["server/shared/types/preview-surface.ts"] }
      },
      "rust": {
        "fileLength": { "maxFileLines": 500 },
        "functionMetrics": { "maxFunctionLines": 80, "maxComplexity": 10, "maxParams": 4 },
        "commandGates": [
          { "id": "rust-gate.cargo-test", "command": "cargo", "args": ["test"], "cwd": ".", "timeoutMs": 120000 }
        ]
      },
      "docs": {
        "enabled": { "existence": true, "freshness": true, "staleness": false, "length": true, "hubCoverage": true, "subtreeCoverage": true },
        "policy": {
          "filenames": ["AGENTS.md", "CLAUDE.md"],
          "requiredPaths": ["."],
          "requireRoot": true,
          "minimumContentLength": 1,
          "maxLines": 220,
          "maxSectionLines": 80
        },
        "history": { "maxStaleDays": 90 },
        "hubCoverage": { "minFanIn": 5, "minFanOut": 5, "requireExplicitMention": true },
        "subtreeCoverage": { "minLoc": 20000 }
      },
      "clone": {
        "windowSize": 16,
        "minLines": 16,
        "threshold": 5,
        "partitions": [["server", "shared"], ["client"], ["platform-cli"]],
        "exclude": ["docs/**", "generated/**"],
        "modes": ["staged", "changed", "files"]
      }
    }
  }
}
```

Root-level fields outside `validation` may remain as install metadata, but they are not active validation behavior. In particular, do not read or translate a root-level `checks` object.

## Current Gaps

- Repo config parsing needs a normalized native `validation` policy model.
- All validation entrypoints need to construct checks through the same policy-aware factory.
- Built-in check enable/disable and default-scope controls need to apply consistently.
- Thresholds need to flow into TypeScript and Rust file/function checks.
- Path policy needs to filter file views before checks run.
- Clone detection needs native policy knobs for window size, threshold, partitions, excludes, and scope modes.
- Docs checks need native existence/freshness/staleness/length/hub/subtree configuration.
- TypeScript checks need native import-layer rules, type-only handling, dead-code entrypoints, and repo lint plugin rules.
- Rust checks need native command gates for repo-specific commands.
- Status, doctor, reports, package wiring, and packlists need to expose the native policy without implying replacement claims.

## Files

Create or keep:

- `packages/validation-policy/`
  - Shared native policy parser, path-policy helper, check-pack loader, and policy-aware check factory.
- `packages/opcore/src/repo-validation-config.ts`
  - Thin public re-export for Opcore facade consumers.
- `packages/opcore/src/repo-validation-policy.ts`
  - Thin public re-export plus clone invoker injection for the Opcore facade.
- `packages/opcore/src/path-policy.ts`
  - Thin public re-export for tests and downstream use.
- `packages/opcore/src/repo-check-packs.ts`
  - Thin public re-export for check-pack helpers.
- `packages/validation-typescript/src/import-layer-rules-check.ts`
- `packages/validation-typescript/src/dead-code-entrypoints.ts`
- `packages/validation-typescript/src/lint-plugin-check.ts`
- `packages/validation-rust/src/command-gate-check.ts`

Modify:

- `packages/opcore/src/validation-composition.ts`
- `packages/opcore/src/advanced/validation-composition.ts`
- `packages/asp-provider/src/validation-composition.ts`
- `packages/opcore/src/scan.ts`
- `packages/opcore/src/status.ts`
- `packages/opcore/src/doctor.ts`
- `packages/opcore/src/reporting.ts`
- `packages/validation-typescript/src/index.ts`
- `packages/validation-rust/src/index.ts`
- `packages/validation-docs/src/index.ts`
- `packages/validation-clone/src/clone-check.ts`
- `packages/contracts`
- package metadata, workspace checks, release package dirs, packlists, and AGENTS.md where architecture changes require it.

## Task 1: Native Repo Validation Config

- [x] Add normalized `.opcore/config.validation` parser.
- [x] Validate adapters, arrays, positive integers, thresholds, path policy, docs policy, clone policy, and TypeScript policy.
- [x] Keep unknown top-level config fields inert.
- [x] Keep check-pack loading repo-relative and package-resolvable through native `validation.checks.packs`.
- [x] Remove root-level `checks` translation and tests.

Verification:

```bash
node --test --test-name-pattern "repo validation config|native check pack config|native disabled|native docs" tests/validation-cli.test.mjs
```

## Task 2: Native Path Policy

- [x] Add repo-relative include/exclude matching.
- [x] Filter validation file-view scope files, visible files, overlays, reads, existence checks, and overlay lookup.
- [x] Confirm graph-backed checks do not bypass the filtered file view through unfiltered graph requirements.

Verification:

```bash
node --test --test-name-pattern "path policy" tests/validation-cli.test.mjs
```

## Task 3: Policy-Aware Check Construction

- [x] Add shared `@the-open-engine/opcore-validation-policy` package.
- [x] Route public `opcore check`, advanced check/validate, scan, and ASP provider validation through the same policy-aware factory.
- [x] Validate unknown check ids after built-ins and packs are assembled.
- [x] Apply adapter selection, disabled checks, default-scope promotion, and path policy wrappers.
- [x] Add policy evidence to status, doctor, and reports.

Verification:

```bash
node --test tests/validation-cli.test.mjs tests/asp-provider.test.mjs
```

## Task 4: Built-In Thresholds And Check Selection

- [x] Wire TypeScript file/function thresholds.
- [x] Wire Rust file/function thresholds.
- [x] Wire docs enabled flags to docs default/disabled selection.
- [x] Reject unknown native check ids.

Verification:

```bash
node --test --test-name-pattern "configured TypeScript thresholds|configured Rust thresholds|unknown check id" tests/validation-cli.test.mjs
```

## Task 5: Clone Policy

- [x] Extend clone contract request fields for `windowSize`, `threshold`, `partitions`, `exclude`, and `modes`.
- [x] Pass clone policy through TypeScript validation adapter to graph-core clone analysis.
- [x] Implement native graph-core clone filtering for window, threshold, partitions, excludes, and scope modes.

Verification:

```bash
node --test tests/validation-clone.test.mjs
cargo test -p opcore-graph-core clone::
```

## Task 6: Docs Policy

- [x] Add docs length max-line and max-section checks.
- [x] Add hub fan-out and explicit mention policy.
- [x] Add subtree coverage policy.
- [x] Wire docs config through the shared policy factory.

Verification:

```bash
node --test tests/validation-docs.test.mjs
```

## Task 7: TypeScript Import-Layer Rules

- [x] Add native `typescript.import-layer-rules` check.
- [x] Support `ignoreTypeOnlyImports`, `layerRules`, and `fromNot`.
- [x] Wire TypeScript import graph policy into check construction.

Verification:

```bash
node --test --test-name-pattern "import layer|type-only imports" tests/validation-typescript.test.mjs
```

## Task 8: TypeScript Dead-Code Entrypoints

- [x] Add native dead-code `entrypoints` option.
- [x] Treat configured entrypoint files as graph reachability roots.
- [x] Keep unsupported graph coverage visible instead of claiming clean coverage when evidence is missing.
- [x] Wire entrypoints through `.opcore/config.validation.checks.typescript.deadCode`.

Verification:

```bash
node --test --test-name-pattern "configured TypeScript dead-code entrypoints" tests/validation-typescript.test.mjs
node --test --test-name-pattern "configured TypeScript dead-code entrypoints" tests/validation-cli.test.mjs
```

## Task 9: TypeScript Repo Lint Plugin

- [x] Add native `typescript.lint-plugin` check only when `validation.checks.typescript.lint.repoPlugin` is configured.
- [x] Use repo-relative plugin paths only; reject absolute paths, parent traversal, and resolved paths outside the repo.
- [x] Load plugin rules with `createRequire(join(repoRoot, "package.json"))`.
- [x] Cache plugin loading by plugin path and configured dependency mtimes.
- [x] Preserve the default `typescript.lint` check.

Verification:

```bash
node --test --test-name-pattern "repo lint plugin" tests/validation-typescript.test.mjs
```

## Task 10: Rust Command Gates

- [x] Add native Rust command-gate check definitions from `validation.checks.rust.commandGates`.
- [x] Restrict commands to repo-contained cwd and explicit command/args arrays.
- [x] Honor per-gate timeout and repo-level timeout.
- [x] Return command stdout/stderr/status evidence without mutating source files.
- [x] Wire command gates through the shared policy factory.

Verification:

```bash
node --test --test-name-pattern "Rust command gate" tests/validation-rust.test.mjs tests/validation-cli.test.mjs
```

## Task 11: Status, Doctor, Reports

- [x] `opcore status --json` reports whether native validation policy is loaded, check count, disabled ids, default ids, packs, and degraded policy fields without running checks.
- [x] `opcore doctor --json` reports config parse errors, loaded packs, native policy readiness, and next actions.
- [x] Scan/reporting includes configured/disabled check evidence and policy degradations.
- [x] No status, doctor, report, or install output suggests config import or translation mode.

Verification:

```bash
node --test --test-name-pattern "policy readiness|doctor|report" tests/opcore-facade.test.mjs tests/validation-cli.test.mjs
```

## Task 12: Packaging, Docs, And Guardrails

- [x] Update package exports, workspace checks, release package dirs, lockfile, and packlists for new package/files.
- [x] Update AGENTS.md for the new `packages/validation-policy` ownership boundary and native policy rules.
- [x] Ensure launch-facing docs and package metadata say Opcore and do not claim replacement of external tools.
- [x] Ensure no new active code path imports, translates, or loads external policy config.

Verification:

```bash
npm run build
npm run workspace:check
npm run pack:check
```

## Task 13: Final Verification

- [x] Run targeted test suites for changed packages.
- [x] Run local CI-equivalent or the strongest feasible repo gate.
- [x] Run current external retained guardrail comparison only as evidence that no guardrail coverage was lost; do not make Opcore depend on those tools.
  - Attempted `npm run current-tools:validate-changed`; it fails before running retained analysis with `Cannot read properties of undefined (reading 'trim')`.
- [x] Record exact commands and outcomes in the final handoff.

Minimum verification:

```bash
npm run build
node --test tests/validation-cli.test.mjs
node --test tests/validation-typescript.test.mjs
node --test tests/validation-docs.test.mjs
node --test tests/validation-clone.test.mjs
node --test tests/validation-rust.test.mjs
node --test tests/asp-provider.test.mjs
cargo test -p opcore-graph-core clone::
```

## Completion Criteria

- Native `.opcore/config.validation` can express the depended-on policy surface.
- Every validation entrypoint uses the native policy-aware check factory.
- TypeScript, Rust, docs, clone, path policy, check packs, and ASP provider paths honor native policy.
- Unsupported or degraded evidence is explicit.
- No config importer, external-policy loader, or active translation layer exists.
- No public/product surface claims replacement of external tools.
