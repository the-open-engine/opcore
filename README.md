# Opcore

Status: private pre-release staging repo. Do not publish packages, docs, or
announcements from this repository until maintainers explicitly approve it.

Opcore is a robustness engine for coding agents. It gives a repository a
read-only health scan, then gives any agent that can run a command a stable
check before edits land.

## Target First Run

```bash
npx @the-open-engine/opcore
opcore init
opcore check --changed --json
opcore measure
```

The first command should work in an existing project without setup. It should
detect what Opcore can analyze, say what it cannot analyze, write only local
Opcore report/history artifacts, and never edit source files.

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
work without ACE and without being provisioned by a downstream agent harness.

Normal users should not need to learn the ASP model before seeing value from
Opcore.
