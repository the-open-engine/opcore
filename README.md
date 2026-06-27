# Opcore

Status: maintainer-controlled alpha staging. Do not publish packages, docs, or
announcements from this repository until maintainers explicitly approve it.

Local code scans, honest coverage, setup guidance, and changed-file validation for coding agents.

Opcore is a deterministic, local, changed-file validation gate for coding
agents. It starts with read-only repository scans, reports honest coverage
before findings, and gives command-running agents a JSON gate for edits before
they land.

## Install and first run

Start with the npx-first onboarding command from an existing repository:

```bash
npx @the-open-engine/opcore@0.1.0-alpha.0 init
```

The first-run path scans before setup, prints Coverage before Findings, shows
what Opcore can and cannot inspect, then asks for explicit approval before
writing guidance, config, hooks, or ignore entries.

Install globally for repeat use:

```bash
npx @the-open-engine/opcore@0.1.0-alpha.0 init
```

The one-command onboarding path starts the interactive wizard in an existing
project. It runs a read-only scan first, prints Coverage before Findings, says
what Opcore can and cannot analyze, shows the additive setup plan, and asks for
explicit approval before writing guidance, config, hooks, or ignore entries.

Run bare `opcore` after install for the read-only scan loop. A scoped scan is
available as `opcore --repo .`.

## Repeat Use

Install globally when you expect to run Opcore repeatedly:

```bash
npm install -g @the-open-engine/opcore@0.1.0-alpha.0
opcore
opcore --repo .
opcore init --repo . --approve
opcore check --changed --json
opcore measure --repo .
opcore try
```

`opcore init` is scan-first and ask-before-write on a TTY: it prints coverage
before findings, shows the additive setup plan, then writes only after an
explicit yes. `opcore init --json` previews without writing; `opcore init
--approve --json` applies additive setup without prompting and returns scan,
language settings, interaction, and timing fields.

If `opcore` is not found after a global install, check npm's global prefix and
put its `bin` directory on `PATH`:

```bash
npm prefix -g
export PATH="$(npm prefix -g)/bin:$PATH"
```

Restart the shell or add that export to the shell startup file used by the
environment.

`opcore check --changed --json` works in a freshly `git init` repo with no commits; it treats the empty baseline as the comparison base.

Alpha package artifacts target `darwin-arm64`, `darwin-x64`, and `linux-x64`.
Unsupported platforms return typed degraded status instead of crashing. Windows is out of scope for `0.1.0-alpha.0`.

## Changed-file gate for agents

`opcore check --changed --json` is the stable agent gate. It checks changed
files by default, works in a freshly `git init` repo with no commits by
using the empty baseline as the comparison base, and exits non-zero when a
write should be blocked unless the caller has a typed recovery path.

- Start with the useful loop: scan, init, check, measure.
- Show coverage before findings.
- Prefer concrete counts and file locations over scores.
- Be honest about unsupported languages, missing tools, and degraded checks.
- Keep ASP concepts behind the normal product path unless a user is installing
  providers or integrating a host.
- Do not claim broad stack coverage, vulnerability auditing, autonomous repairs,
  public standard status, or replacement of existing guardrails until evidence
  proves it.

Use `opcore check --staged --json` when the gate should inspect only staged
content.

## Coverage honesty

Opcore alpha is deep for TypeScript and JavaScript graph-backed validation.
Rust coverage is validation and toolchain signal coverage only. Other
languages are counted and reported unsupported instead of receiving fake
findings.

Reports use concrete counts, file paths, deltas, missing-tool notices, and
degraded-check notices. Opcore does not collapse those signals into a single
rating.

## Commands

| Command | Use |
| --- | --- |
| `opcore` | Read-only scan of the current repository. |
| `opcore --repo .` | Read-only scan of an explicit repository path. |
| `opcore status --json` | Read-only readiness and coverage status for tools. |
| `opcore init --repo . --approve` | Scan-first, approval-gated setup that writes only additive guidance/config when approved. |
| `opcore check --changed --json` | Changed-file JSON gate for agents. |
| `opcore check --staged --json` | Staged-file JSON gate for pre-commit flows. |
| `opcore measure --repo .` | Read stored scan history and report concrete deltas. |
| `opcore try` | Run local TS, Rust, mixed, and unsupported-file samples without publishing anything. |

## How Opcore works

Opcore is a local CLI facade over scan, init, check, and measure flows. The
accepted runtime model is hybrid: Rust graph core plus TypeScript contracts and
CLI adapters. The scan path is read-only with respect to source files and writes
only `.opcore/report.json`, `.opcore/history.jsonl`, and bounded
`.opcore/telemetry.jsonl`. Init is additive,
approval-gated, and reversible through recorded undo metadata where supported.

For the model behind coverage, findings, and degraded checks, see
[Concepts: coverage and findings](docs/concepts.md). For the package and CLI
ownership model, see the
[runtime and CLI architecture decision](docs/architecture/runtime-cli-ard.md)
at @docs/architecture/runtime-cli-ard.md.

## ASP provider: providers assess, hosts decide

`opcore-asp-provider --stdio` launches the ASP provider facade. The provider
returns assessments and degraded coverage details; ASP hosts own workspace
grants, policy, decisions, receipts, and apply behavior.

Provider output is assessment evidence, not a host decision.

## Docs and examples

- [Quickstart: install and first scan](docs/quickstart.md)
- [Concepts: coverage and findings](docs/concepts.md)
- [Examples: command output shapes](docs/examples.md)
- [Agent integration: JSON gates](docs/agent-integration.md)
- [Demo: local try loop](docs/demo.md)

## Project status

Opcore is a maintainer-controlled alpha. Package artifacts target
`darwin-arm64`, `darwin-x64`, and `linux-x64`. Windows is out of scope for `0.1.0-alpha.0`.
Unsupported platforms return typed degraded status instead of crashing.

Repository metadata recommendations require maintainer approval before any
metadata change is applied.

Recommended GitHub description:

```text
Local code scans, honest coverage, setup guidance, and changed-file validation for coding agents.
```

Recommended GitHub topics:

```text
coding-agents, ai-agents, code-review, static-analysis, developer-tools, typescript, rust, cli, pre-commit, validation, code-graph, agent-tools
```
