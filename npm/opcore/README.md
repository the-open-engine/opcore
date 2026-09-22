# `@the-open-engine-company/opcore`

[Documentation](https://the-open-engine.github.io/opcore/dev/) · [Upgrade guide](https://the-open-engine.github.io/opcore/dev/docs/getting-started.html#upgrade-from-an-earlier-installation)

Opcore checks source changes while coding agents work. It returns syntax, hygiene, and complexity findings, then uses Project Sense to check repository relationships such as introduced cycles and duplication.

This package installs the native release for Linux x64 with glibc 2.39 or newer, or Apple silicon macOS. You'll need Node.js 18 or newer, npm, Bash, and Git; agent integration requires Codex or Claude. Other platforms stop before download; npm has no source-build fallback.

```sh
npm install -g --foreground-scripts @the-open-engine-company/opcore
opcore --version
```

Postinstall downloads and verifies the native release, then installs the integrations. `--foreground-scripts` keeps setup and activation instructions visible. Opcore detects Codex through `CODEX_HOME` or `$HOME/.codex`, and Claude through `CLAUDE_CONFIG_DIR` or `$HOME/.claude`. When both are present, each receives a skill, manifests, and hook configuration; they share one executable. These user-level hooks apply across the agent's Git projects.

Set `OPCORE_AGENT=codex` or `OPCORE_AGENT=claude` to select one agent. If neither exists, select an agent explicitly or use CLI-only setup below.

To install the selected agent skill and provider manifests without enrolling its user-level hook, set `OPCORE_AGENT_NO_HOOKS=1`:

```sh
OPCORE_AGENT=claude OPCORE_AGENT_NO_HOOKS=1 npm install -g --foreground-scripts @the-open-engine-company/opcore
```

Keep `OPCORE_AGENT_NO_HOOKS=1` on updates. This remains an agent integration with an ownership receipt and shared executable; `opcore uninstall` removes it normally. It is distinct from `OPCORE_NO_HOOKS=1`, which installs only the CLI.

If npm skipped lifecycle scripts, `opcore --help` still explains setup, `--version` identifies the package, and `doctor --json` reports the missing installation state. Run `opcore setup` to retry verified installation; the wrapper never executes an unverified native binary.

## Project-local or CI installation

Install only the CLI, without agent directories, skills, or hooks:

```sh
OPCORE_NO_HOOKS=1 npm install --save-dev --foreground-scripts @the-open-engine-company/opcore
npx --no-install opcore --version
```

Keep `OPCORE_NO_HOOKS=1` on later `npm ci` or update commands. If scripts were skipped, run `npx --no-install opcore setup --no-hooks`. The command is safe to repeat for an unchanged CLI installation. An installation with agent integrations must complete `opcore uninstall` before switching to CLI-only mode.

## Run a first check

From a Git project (use `npx --no-install opcore` for a project-local installation):

```sh
opcore doctor --repo .
opcore check --repo . --all
opcore sense --repo .
```

`check --all` inspects current source even on a clean worktree. Later, plain `check` reports introduced findings in your worktree changes. Add `--json` for structured evidence or run `opcore rules` to inspect the built-in rules.

Restart the agent after setup. In Codex, open `/hooks`, review the command, and trust it. In Claude, open `/hooks` to inspect the user-settings hook, which is already active in trusted workspaces. Doctor inspects configuration but can't establish host trust or execution; follow the [activation smoke test](https://the-open-engine.github.io/opcore/dev/docs/getting-started.html#confirm-hook-activation) before relying on automatic feedback.

The post-edit hook sends Verify and Sense feedback after supported file edits, Bash, and MCP tool calls, including reads. It checks the written state and does not enforce a final handoff. Default partial Sense coverage produces one hint and continues. Configure full `run pre-commit` and `run ci --base <base-commit>` checks, ideally with the applicable native providers, alongside your existing tests and linters. Native execution requires explicit host authorization.

### Troubleshoot Sense coverage

Sense resolves only uniquely confirmed local dependencies. The full [resolution table](https://the-open-engine.github.io/opcore/dev/docs/sense.html#dependency-envelope) explains what is confirmed and what is **Deliberately not resolved**, including bare Node packages, missing, dotted, or colliding Python absolute imports, Cargo-configured Rust roots, external Go modules, and HCL, Shell, or Protobuf loading semantics. A one-component Python import resolves only when it has one sibling module or package target. `effectivePolicy.importantFanIn` is the configured direct-dependent threshold for important modules. Fixed duplicate-analysis limits such as `dedup_region_file_limit` cannot be raised at runtime.

For generated or vendored trees, use literal repository-relative exclusions such as `{"schemaVersion":1,"targets":{"exclude":["generated","vendor"]}}`. `targets.exclude` entries are files or subtrees, not globs; do not exclude maintained source merely to hide a finding. See [Select targets](https://the-open-engine.github.io/opcore/dev/docs/configuration.html#select-targets).

In JSON, `documentationCoverage.evaluated: false` means no qualifying documentation obligation was evaluated, while a registry state of `not_read` means the registry was not needed for that view. `publicSurfaceAuthoritative: false` means Opcore could not establish a complete explicit public surface.

Read the static [main guide](https://the-open-engine.github.io/opcore/dev/) for language coverage, [configuration](https://the-open-engine.github.io/opcore/dev/docs/configuration.html), and [provider setup](https://the-open-engine.github.io/opcore/dev/docs/providers.html). These pages contain complete HTML without requiring JavaScript. Release staging rewrites the development routes in this README to the package's exact `vX.Y` archive.

## Update or remove

Run `npm update -g --foreground-scripts @the-open-engine-company/opcore` to update all detected agents. Keep custom directory variables set so the installer can find every integration. A restricted installation refuses a shared binary upgrade that would leave another agent's artifacts out of date.

The skill, hook configuration, and cleanup receipts live outside the npm package directory. Current npm versions don't run uninstall lifecycle scripts, so remove the integrations first:

```sh
opcore uninstall
npm uninstall -g @the-open-engine-company/opcore
```

For a project-local install, run `npx --no-install opcore uninstall`, then omit `-g` from npm removal.

The first command verifies each recorded integration before cleanup, then removes the shared binary after its last owner. It refuses modified or ambiguous state. If postinstall fails, the installer attempts to remove new, unmodified integrations while the binary is available. It retains existing or modified integrations; repair the reported problem and rerun npm installation before removing them. npm may remove the wrapper and binary after a failed lifecycle script. See [setup recovery](https://the-open-engine.github.io/opcore/dev/docs/getting-started.html#if-setup-doesnt-work).

The package version selects the matching GitHub Release. Embedded archive hashes, the release `SHA256SUMS`, archive-entry validation, and an inner binary checksum bind the downloaded installer to that version. [Report installation problems](https://github.com/the-open-engine/opcore/issues) with the version, platform, and full installer error.
