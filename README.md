# Opcore

Status: maintainer-controlled alpha staging. Do not publish packages, docs, or
announcements from this repository until maintainers explicitly approve it.

Local code scans, honest coverage, setup guidance, and changed-file validation for coding agents.

Opcore is a deterministic, local, changed-file validation gate for coding
agents. It starts with read-only repository scans, reports honest coverage
before findings, and gives command-running agents a JSON gate for edits before
they land.

## First Run From This Checkout

Package publication is maintainer-controlled during alpha staging. Until
maintainers publish the alpha packages, run Opcore from a source checkout:

```bash
npm ci
npm run build
node packages/opcore/dist/index.js init --repo /path/to/repo
```

`opcore init` detects supported stacks, runs a read-only first scan, prints
Coverage before Findings, reports concrete counts and locations, proposes repo
setup, and asks before writing anything.

Scan/status/check/measure are read-only for source files. The scan loop writes
only `.opcore/report.json`, `.opcore/history.jsonl`, and bounded
`.opcore/telemetry.jsonl`. Approved init writes only additive `.opcore/config`,
one delimited guidance block in an existing agent file or new `AGENTS.md`, a
managed `.opcore/` `.gitignore` line for Git repos, and
`.opcore/init-undo.json`. Undo recorded setup with `opcore init --undo`.

Agents and hooks should use the JSON contract `opcore check --changed --json`;
humans do not need to learn that gate before onboarding.

After package publication, the one-command first-run path is:

```bash
npx @the-open-engine/opcore@0.1.0-alpha.0 init
```

After package publication, install globally for repeat use:

```bash
npm install -g @the-open-engine/opcore@0.1.0-alpha.0
opcore init
```

Run bare `opcore` after install for the read-only scan loop. A scoped scan is
available as `opcore --repo .`.

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
- Prefer concrete counts and file locations over a single rating.
- Be honest about unsupported languages, missing tools, and degraded checks.
- Keep ASP concepts behind the normal product path unless a user is installing
  providers or integrating a host.
- Do not claim broad stack coverage, vulnerability auditing, autonomous repairs,
  protocol status, or retirement of existing guardrails until evidence proves
  it.

Use `opcore check --staged --json` when the gate should inspect only staged
content.

## Coverage honesty

Opcore alpha is deep for TypeScript and JavaScript graph-backed validation:
syntax, types, imports, relevant tests, dead exports, and graph structure when
facts are available. Rust coverage is useful validation and toolchain signal
coverage: source hygiene, oversized files, module evidence, cargo, fmt,
clippy, rustdoc, and optional-tool evidence when available.

Python is experimental and degraded-honest: graph-backed `.py`/`.pyi`
structure, untested modules, dead exports, syntax, and source-hygiene signals.
`python.types` depends on mypy or pyright and reports missing tools as
degraded. Other non-TS/JS/Rust/Python languages are counted and reported
unsupported instead of receiving fake findings.

Reports use concrete counts, file paths, deltas, missing-tool notices, and
degraded-check notices. Opcore does not collapse those signals into a single
rating or claim every-project Python coverage.

## Commands

| Command | Use |
| --- | --- |
| `opcore` | Read-only scan of the current repository. |
| `opcore --repo .` | Read-only scan of an explicit repository path. |
| `opcore status --json` | Read-only readiness and coverage status for tools. |
| `opcore init --repo . --approve` | Scan-first setup that writes only the approved init artifacts. |
| `opcore check --changed --json` | Changed-file JSON gate for agents. |
| `opcore check --staged --json` | Staged-file JSON gate for pre-commit flows. |
| `opcore measure --repo .` | Read stored scan history and report concrete deltas. |
| `opcore try` | Run local TS, Rust, mixed, and unsupported-file samples without publishing anything. |

## How Opcore works

Opcore is a local CLI facade over scan, init, check, and measure flows. The
accepted runtime model is hybrid: Rust graph core plus TypeScript contracts and
CLI adapters. Scan/status/check/measure are read-only for source files. The scan
loop writes only `.opcore/report.json`, `.opcore/history.jsonl`, and bounded
`.opcore/telemetry.jsonl`. Approved init writes only additive `.opcore/config`,
one delimited guidance block in an existing agent file or new `AGENTS.md`, a
managed `.opcore/` `.gitignore` line for Git repos, and
`.opcore/init-undo.json`.

For the model behind coverage, findings, and degraded checks, see
[Concepts: coverage and findings](docs/concepts.md). For the package and CLI
ownership model, see the
[runtime and CLI architecture decision](docs/architecture/runtime-cli-ard.md)
at @docs/architecture/runtime-cli-ard.md.

## ASP provider: providers assess, hosts decide

The aggregate `@the-open-engine/opcore` package exposes only the `opcore` bin.
`opcore-asp-provider --stdio` is provided by the separate
`@the-open-engine/opcore-asp-provider` package, or by
`node packages/asp-provider/dist/index.js --stdio` from a built source checkout.
The provider returns assessments and degraded coverage details; ASP hosts own
workspace grants, policy, decisions, receipts, and apply behavior.

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
