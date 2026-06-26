# Opcore

Status: maintainer-controlled alpha staging. Do not publish packages, docs, or
announcements from this repository until maintainers explicitly approve it.

Local code scans, honest coverage, setup guidance, and changed-file validation for coding agents.

Opcore is a robustness engine for coding agents. It gives a repository a
read-only health scan, then gives any agent that can run a command a stable
check before edits land.

## Target First Run

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
opcore init
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

## Product Rules

- Start with the useful loop: scan, init, check, measure.
- Show coverage before findings.
- Prefer concrete counts and file locations over scores.
- Be honest about unsupported languages, missing tools, and degraded checks.
- Keep ASP concepts behind the normal product path unless a user is installing
  providers or integrating a host.
- Do not claim broad stack coverage, vulnerability auditing, autonomous repairs,
  public standard status, or replacement of existing guardrails until evidence
  proves it.

## Architecture

Opcore is an independently installed ASP provider and product surface. ASP is
the host/protocol/manager surface that can enroll many providers. Opcore should
work without being provisioned by a downstream agent harness.

The current architecture is hybrid: Rust graph core plus TypeScript contracts,
router adapters, validation, edit planning, and the Opcore facade. See
@docs/architecture/runtime-cli-ard.md.

Normal users should not need to learn the ASP model before seeing value from
Opcore.
