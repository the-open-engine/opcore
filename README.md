# Opcore

Status: maintainer-controlled alpha staging. Do not publish packages, docs, or
announcements from this repository until maintainers explicitly approve it.

Local code scans, honest coverage, setup guidance, and changed-file validation for coding agents.

Opcore is a robustness engine for coding agents. It gives a repository a
read-only health scan, then gives any agent that can run a command a stable
check before edits land.

## Target First Run

```bash
npm install -g @the-open-engine/opcore@0.1.0-alpha.0
opcore --repo .
opcore try
opcore init --repo .
opcore init --repo . --approve
opcore check --changed --json
opcore measure --repo .
```

The first command should work in an existing project without setup. It should
detect what Opcore can analyze, say what it cannot analyze, and limit file
writes to local Opcore artifacts: `.opcore/report.json`,
`.opcore/history.jsonl`, and bounded `.opcore/telemetry.jsonl` capped at 500
records or 1 MiB. Source files remain untouched.

`opcore init` is scan-first and ask-before-write on a TTY: it prints coverage
before findings, shows the additive setup plan, then writes after an explicit
yes. `opcore init --json` previews without writing; `opcore init
--approve --json` applies additive setup without prompting and returns scan,
language settings, interaction, and timing fields.

Alpha package artifacts target darwin-arm64 and linux-x64.

## Product Rules

- Start with the useful loop: scan, init, check, measure.
- Show coverage before findings.
- Prefer concrete counts and file locations over scores.
- Be honest about unsupported languages, missing tools, and degraded checks.
- Keep ASP concepts behind the normal product path unless a user is installing
  providers or integrating a host.
- Do not claim broad stack coverage, security scanning, automatic fixing,
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
