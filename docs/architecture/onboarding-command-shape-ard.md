# Onboarding Command Shape

Status: Accepted
Date: 2026-06-26
Decision: npx-primary, install-as-wizard
Owner: EPIC #9 (one-command install / onboarding)

## Context

Opcore needs one command a new user can run on a clean machine to install Opcore and
enter onboarding for an existing repository. The published package
`opcore` ships the public `opcore` bin and pulls a platform-specific native
graph-core through optional dependencies (`@the-open-engine/opcore-graph-core-darwin-arm64`,
`-darwin-x64`, `-linux-x64`) gated by npm `os`/`cpu`. Unsupported platforms must degrade
to a typed `required_missing` graph status, never crash.

The onboarding UX must be honest and reversible: run a read-only scan first, show coverage
before findings, propose additive repo setup, ask before writing, and write only approved
files. EPIC #9 also requires onboarding to work in a freshly `git init`'d repo with no
commits, across TS/JS, Rust, Python, mixed, and unsupported (counted not faked) stacks,
and to be proven on installed artifacts including the bin invoked outside `node_modules/.bin`.

This ADR fixes the **command shape** so the implementation sub-issues (#40 wizard, #41 repo
policy, #43 docs) build against a stable contract. It is subordinate to
[runtime-cli-ard.md](runtime-cli-ard.md) (the hybrid runtime/CLI decision) and to the #2
public command/native identity cutover; command names here are kept identity-agnostic.

## Decision

1. **The primary one-command entry is `npx opcore install`.**
   `npx`/`npm exec` resolves the package into the npm cache and runs its bin with the
   package's bin directory injected onto the child process `PATH`. This is the decisive
   property: it works on a clean machine **without assuming a global bin directory is on the
   user's `PATH`**, which is the most common first-run failure for globally installed CLIs.
   npm bin-inference selects the bin whose name matches the unscoped package name
   (`opcore` → `opcore`) even though the package ships two bins, so the
   user does not need to disambiguate. The platform native graph-core resolves through the
   optional-dependency `os`/`cpu` gates during the npx install step; an unsupported platform
   still onboards (validation/Rust-toolchain coverage) with a typed `required_missing` graph
   status.

2. **The repeat-use entry is a global install:** `npm install -g opcore@<ver>`
   then `opcore` / `opcore install`. Docs (#43) must include PATH troubleshooting
   (`npm prefix -g`; add `$(npm prefix -g)/bin` to `PATH`).

3. **The onboarding flow is the interactive `opcore install` wizard.**
   `opcore install` runs the read-only scan, prints coverage before findings, proposes the
   additive setup, asks on a TTY with a default-yes install prompt, and writes only approved
   files. A non-interactive caller uses `opcore install --yes [--json]` (deterministic);
   without approval it stays plan-only. Bare `opcore` remains the read-only scan. The older
   `opcore init` route remains as a conservative compatibility setup command with explicit
   `--approve` semantics.

## Options Compared

| Option | Outcome | Reason |
|---|---|---|
| `npx opcore install` (+ global for repeat use) | **Accepted** | Runs from cache with bin injected onto child PATH -> no global-PATH assumption on a clean machine; bin-inference picks `opcore`; native dep resolves via os/cpu; lands in the install wizard. |
| Global install only, as the primary path | Rejected as *primary* (kept as repeat-use) | Requires the global bin dir to be on `PATH`, the most common first-run failure; still useful once installed, so documented with PATH troubleshooting. |
| `postinstall`-driven onboarding | Rejected | Non-interactive, output buffered, `ignore-scripts=true` is common, npm 11 gates install scripts in several global contexts, and there is no informed consent to mutate a repo. This repo deliberately ships **zero lifecycle scripts**; onboarding must never run from one. |
| `npm create opcore` / `create-opcore` | Rejected | `npm create X` implies scaffolding a *new* project. Opcore onboards an *existing* repo, so this shape misleads users about what will happen. |
| New `opcore onboard` top-level verb | Rejected | Adds a third onboarding door when `opcore install` and compatibility `opcore init` already cover first-run setup. |

## Fresh-Machine Flow

```
npx opcore@<ver> install
  → npm resolves opcore + matching native graph-core into the cache
  → runs the `opcore` bin with `install`
  → read-only scan (no source writes)
  → prints Coverage before Findings (deep TS/JS graph; Rust validation/toolchain;
    unsupported-language counts — honest, never faked)
  → proposes additive setup (.opcore/config, delimited agent-guidance block,
    agent skill files, Claude Code/Codex write-gate hooks, active pre-commit when safe,
    .opcore/ gitignore line in Git repos covering telemetry)
  → asks on a TTY (or applies deterministically with --yes)
  → writes only approved files; skips .gitignore outside Git; records undo metadata (.opcore/init-undo.json)
  → undo removes only the managed .gitignore line
```

`opcore install --json` previews without writing (release-gate invariant). On an unsupported
platform the same flow runs with a typed `required_missing` graph status and no crash.

## Per-Language Onboarding Settings (model for #40)

Onboarding settings are a named, extensible map keyed by detected stack so adding a language
later does not reshape the contract:

- **typescript/javascript** — deep graph + validation; suggest `opcore check --changed` as the agent gate.
- **rust** — validation/toolchain coverage; honest degraded status when optional tools are missing.
- **unsupported (e.g. python, go, java)** — counted in the census, never faked; onboarding
  still configures the agent gate for the supported portions of the repo.

Each entry contributes only additive, reversible guidance. The deterministic non-interactive
path is `init --approve`; the **agent-assisted** block is an opt-in, delimited, removable
guidance section that must never weaken existing lint/test/CI/pre-commit or agent guardrails.

## Constraints Inherited

- Command names stay **#2-deferred / identity-agnostic**; this ADR refers to "the `opcore`
  product bin" and "the `init` route," not to any final package string.
- Public wording rules: no old-tool-replacement, all-stack, security/SAST, AI-authorship,
  automatic-fix, blended-score, or "Opcore"-as-product claims.
- No public release, npm publish, visibility change, announcement, or registry/certification
  claim without explicit maintainer approval.

## Migration Impact

Implementation sub-issues #40 (interactive `opcore install` wizard), #41 (repo-setup policy:
managed `.opcore/` ignore coverage + additive/reversible hardening), and #43 (npx-primary docs + PATH
troubleshooting) build against this decision. #39 (fresh-Git `opcore check --changed`) is an
independent prerequisite for the wizard's first-check step. The canonical command table in
[runtime-cli-ard.md](runtime-cli-ard.md) is unchanged — `init` remains the only writer and no
new verb is added.
