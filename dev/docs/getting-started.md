# Getting started

[Overview](../README.md) · [Configuration](configuration.md) · [Providers](providers.md) · [Examples](examples.md)

## Choose an installation

Published binaries support Linux x86-64 with glibc 2.39 or newer and Apple silicon macOS. Linux binaries require glibc; Alpine Linux's musl environment is outside that release target. Windows, Linux ARM64, and Intel macOS have no published binaries or npm source-build fallback.

Every installation needs Bash and standard Unix command-line utilities. Git must be on `PATH` to check projects. The installer detects Codex through `CODEX_HOME` or `$HOME/.codex`, and Claude through `CLAUDE_CONFIG_DIR` or `$HOME/.claude`. If both exist, it installs both integrations. If neither exists, select an agent explicitly or use CLI-only npm installation.

### npm

Use Node.js 18 or newer and npm:

```sh
npm install -g --foreground-scripts @the-open-engine-company/opcore
opcore --version
```

Postinstall downloads and verifies the native release. `--foreground-scripts` makes its setup and activation instructions visible. If scripts were skipped, run `opcore setup`; help, package version, and setup diagnostics remain available before native installation.

To select only one agent, set `OPCORE_AGENT`:

```sh
OPCORE_AGENT=codex npm install -g --foreground-scripts @the-open-engine-company/opcore
```

To retain that agent's skill, four provider manifests, ownership receipt, and shared executable without changing its user-level hook configuration, add `OPCORE_AGENT_NO_HOOKS=1`:

```sh
OPCORE_AGENT=codex OPCORE_AGENT_NO_HOOKS=1 npm install -g --foreground-scripts @the-open-engine-company/opcore
```

Keep `OPCORE_AGENT_NO_HOOKS=1` on later npm updates. This uses the installer's existing `hooks no` receipt state, so updates, rollback, and `opcore uninstall` preserve the same ownership behavior as other agent integrations. It does not change the separate `OPCORE_NO_HOOKS=1` CLI-only mode below.

Use `claude` for Claude. Keep custom agent directory variables set when installing or updating.

### Project-local and CI installation

For a pinned project dependency without agent integration:

```sh
OPCORE_NO_HOOKS=1 npm install --save-dev --foreground-scripts @the-open-engine-company/opcore
npx --no-install opcore doctor --repo .
```

Commit the npm lockfile and keep `OPCORE_NO_HOOKS=1` on subsequent `npm ci` and update commands. This mode installs only the verified executable inside the package; it needs no agent directories and creates no skills or hooks. It still requires a supported npm platform.

If your install skips lifecycle scripts, complete setup explicitly:

```sh
npx --no-install opcore setup --no-hooks
```

Use `npx --no-install opcore` wherever this guide shows `opcore` for a project-local installation. For an isolated CI install outside a Node project, use `OPCORE_NO_HOOKS=1 npm install -g --foreground-scripts @the-open-engine-company/opcore@<version>` and pin the reviewed release version.

### Release archive

Download the archive for your platform and its `SHA256SUMS` from the same [GitHub Release](https://github.com/the-open-engine/opcore/releases). Check the archive's SHA-256 digest against its entry in that file, then extract it. The archive contains an installer and binary, so this route doesn't need Node.js or Cargo.

From the extracted `opcore-linux-x86_64` or `opcore-macos-arm64` directory:

```sh
./install.sh
```

Follow any printed `PATH` instruction to run `opcore` by name. `./install.sh --agent codex` restricts setup to Codex; `./install.sh --no-hooks` installs the CLI and skill without enrolling hooks.

### Source checkout

Install Rust with rustup and a C compiler/linker before building. The package supports Rust 1.95 and newer; ordinary Cargo commands in the checkout select the toolchain and components pinned in `rust-toolchain.toml`. rustup may download them on the first run.

```sh
git clone https://github.com/the-open-engine/opcore.git
cd opcore
./scripts/install.sh
```

The source installer builds a release binary. It accepts the same `--agent codex|claude` and `--no-hooks` options as the archive installer. `--no-hooks` leaves any existing hooks in place. Follow the printed `PATH` instruction if the install directory isn't already in your shell's search path.

## Run the first check
### Upgrade from an earlier installation

Opcore 0.3 replaces the earlier TypeScript/Rust implementation with the verification engine developed in Opcore Zero. The npm package is now `@the-open-engine-company/opcore`; the command is `opcore`. Installing or updating the old unscoped package does not switch packages.

Before replacing `opcore` 0.2.x, use the old executable to remove the integrations it owns. Run the repository command in each project where you installed it, and the global command if you installed global hooks:

```sh
opcore uninstall --repo . --local --yes
opcore uninstall --global --yes
npm uninstall -g opcore
```

For a project dependency, run its installed executable with `npx --no-install opcore`, then use `npm uninstall opcore` in that project. Keep any custom configuration roots set during cleanup. Resolve cleanup errors before removing the old package; npm removal alone does not remove its agent hooks.

For an Opcore Zero development installation, run its `opcore-zero uninstall` command before removing `@the-open-engine-company/opcore-zero`. For a source or archive installation, use the standalone uninstaller recorded by that installation. The replacement does not adopt Zero's receipts or rename existing hooks.

Then install the new scoped package using the instructions above and run `opcore doctor --repo .`. Review the [configuration guide](configuration.md): the new engine reads `.opcore.json` and `OPCORE_*` environment variables. An old `.opcore/config` is a different format. An Opcore Zero `.opcore-zero.json` uses the same configuration schema and can be renamed after review.

The new engine supplies `check`, `sense`, and workflow commands. The old `graph`, `edit`, `inspect`, and `opcore-asp-provider` interfaces do not carry over; ASP callers launch `opcore serve --stdio`. Update automation before relying on the new installation, then run the activation smoke test below. The [legacy branch](https://github.com/the-open-engine/opcore/tree/legacy) and existing release tags retain the previous implementation.

### Verify the installation

Run these commands from a Git project:

```sh
opcore --version
opcore doctor --repo .
opcore check --repo . --all
```

Doctor reads repository configuration, integration state, and native-tool setup without checking source. Use `doctor --workflow pre-commit` to inspect that workflow's selected settings and prerequisites. A successful doctor result doesn't prove an active hook or a complete compiler run; confirm host activation below and run the selected workflow.

`check --all` inspects the current supported source. It can find existing issues on its first run; that means the checker ran successfully and found work to review. For later edits, plain `check` compares current worktree changes with HEAD and reports introduced findings. `check --staged` checks the index while ignoring unstaged edits.

## Confirm hook activation

The installer enrolls hooks at user scope. They apply across that agent's Git projects, with each project's `.opcore.json` controlling its post-edit thresholds and exclusions. A mixed-language project can report unsupported files as non-blocking coverage warnings; [target exclusions](configuration.md#select-targets) define source the project intentionally leaves out of scope. Use CLI-only installation if you want manual checks without global agent hooks.

Restart the agent after installation. In the Codex CLI, open `/hooks`, review the Opcore command, and trust it; see the [Codex hook permission model](https://developers.openai.com/codex/hooks). In the Claude Code CLI, open `/hooks` and inspect the user-settings hook; it is already active in trusted workspaces. Doctor can check the receipt and configuration but can't determine host trust, feature enablement, or whether a session executed the command.

Desktop interfaces may not provide `/hooks`. Review the settings path printed by the installer and use the smoke edit below in that desktop session, accepting its normal workspace and tool permission prompts. CLI activation does not establish desktop activation.

Use a disposable Git project to test the edit loop:

```sh
mkdir opcore-smoke
cd opcore-smoke
git init
```

Open that directory in your agent and ask it to create `smoke.ts` with its normal file-edit tool:

```ts
export function total(a: number, b: number, c: number, d: number, e: number, f: number) {
  return a + b + c + d + e + f;
}
```

The session should receive `complexity.max-parameters` with `function parameters: 6; configured maximum is 5`. Ask it to reduce the function to five parameters, then confirm the next check has no finding. If you only see output after manually running `opcore check --repo .`, the CLI works but automatic activation remains unverified.

The hook matches supported file-edit tools, Bash, and all MCP tool calls. Reads can trigger it too. It sends feedback after the tool call completes; it doesn't inspect every filesystem write, undo a commit, or enforce the agent's final handoff. Run `opcore run post-edit` before handing work back, and add the following checks before committing and in CI.

## Add pre-commit and CI checks

Use the built-in workflows alongside the repository's tests, linters, and existing hooks:

| Workflow | Selected view and checks |
| --- | --- |
| `post-edit` | Worktree changes against HEAD: introduced Verify and Sense findings. |
| `pre-commit` | Staged Verify and configured native checks; introduced Sense against HEAD. Verify/native default to all findings. |
| `ci` | Target-commit Verify and configured native checks; introduced Sense against an explicit base commit. Verify/native default to all findings. |

The staged workflow also reads staged configuration and documents; unstaged edits cannot change its result. CI defaults to target `HEAD`, or accepts `--tree <target>`. Existing Verify/compiler findings can fail these full checks. Review exclusions and the effective policy before adopting them:

```sh
opcore status --workflow pre-commit --json
opcore doctor --workflow pre-commit
opcore run pre-commit
```

### Adopt on an existing codebase

If existing Fast Verify findings make the default full comparison impractical, opt into the brownfield gate instead of excluding owned source. Native findings can also be compared when the selected provider establishes a comparison-safe baseline:

```sh
opcore run pre-commit --comparison introduced
opcore run ci --comparison introduced --base <base-commit>
```

This keeps the combined workflow's single configuration capture, freshness check, Sense evaluation, native-provider sequence, coverage requirements, and explicit native authorization. Fast Verify grandfathers unchanged findings but still blocks a new finding added to an already-dirty file. A native provider does the same only when its baseline run yields an exhaustive diagnostic set; otherwise the workflow is incomplete rather than guessing. In particular, a failing Rust-native baseline is not comparison-safe because Cargo may stop before checking every crate or target. See the [native-provider comparison limitations](providers.md#rust-native). Structured workflow output records `"comparison":"introduced"`; omit the option, or pass `--comparison all`, for the default full comparison.

`targets.exclude` is a scope boundary, not a findings baseline: excluded source is not checked for new violations. Use exclusions only for source the workflow intentionally does not own, such as vendored or generated trees.

On an older Opcore release without combined introduced mode, the immediate Fast/Sense fallback is:

```sh
opcore check --staged --workflow pre-commit
opcore sense --staged --workflow pre-commit
```

That fallback does not preserve the combined workflow's native sequencing or whole-run freshness check.

Ideally, configure the applicable [native providers](providers.md) in pre-commit and CI for compiler or type-checker coverage. Prepare each provider's tools and dependency cache first. Repository settings select the checks; the host must also authorize native execution with `--allow-unsandboxed-native`. Use trusted repositories or an externally isolated CI environment. Native checks never enter automatic agent hooks.

Have your existing hook manager run `opcore run pre-commit --repo . --allow-unsandboxed-native` and propagate its exit status. For a new hook, save the following as `.githooks/pre-commit`:

```sh
#!/bin/sh
exec opcore run pre-commit --repo . --allow-unsandboxed-native
```

Then run `chmod +x .githooks/pre-commit` and `git config core.hooksPath .githooks`. The latter changes Git's hook directory; preserve an existing hook manager or hook directory instead of replacing it. A project-local npm installation uses `npx --no-install opcore` in the hook. Opcore's installer never changes Git hooks for you.

In CI, fetch both the target and intended base history, install the pinned CLI, and prepare native tools/dependencies through the project's normal setup. For example, a branch compared with `origin/main` can run:

```sh
opcore run ci --base "$(git merge-base HEAD origin/main)" --allow-unsandboxed-native
```

Use your CI provider's base commit when appropriate. Missing base history, unavailable native tools, and incomplete checks fail with an explanation; none count as successful checks. Make this job required in your repository's CI settings.

## Read the result

```sh
opcore check --repo . --json
opcore sense --repo . --json
```

Workflows, Check, and Sense return exit `0` when the selected evaluation permits continuation and exit `1` for blocking findings or evaluation failures. Argument-parsing errors, such as unknown options, return `2`. The installed hook uses `2` for intervention feedback; a hook that continues returns `0`.

An empty changed or staged Check reports `not_checked` and exits `0`; it hasn't assessed the whole project. Use `check --all` for that. A full or explicit Check with no source candidates is also `not_checked`. Recognized source that Fast Verify cannot analyze remains in `coverage.gaps` with status `unsupported`; it is reported as a warning and does not change the `clean` or `findings` verdict or exit status. An empty Sense comparison also exits `0`, even if the unchanged baseline has partial coverage.

`--advisory` accepts findings for reporting purposes; Fast unsupported coverage warnings do not require it. For a changed project, Sense can report confirmed findings alongside coverage gaps, and `--allow-partial` acknowledges partial Sense coverage. A Sense report with both needs both flags to exit successfully. Neither option accepts incomplete evaluation. Workflows use `coverage.allowPartial` and `coverage.allowNodeBuiltins` from their [configuration](configuration.md); pre-commit and CI default to requiring complete Sense coverage. Post-edit defaults to allowing partial Sense coverage while retaining confirmed findings.

Sense doesn't inspect external dependency implementations. Imports of known explicit Node built-ins, such as `node:fs/promises`, have a narrower acknowledgment:

```sh
opcore sense --repo . --allow-node-builtins
```

That flag accepts only explicit `node:` names in the pinned public built-in list. Unknown names, bare packages, missing relative imports, aliases, and dynamic references remain coverage gaps. Inspect `before.resolutionGaps` and `after.resolutionGaps` in JSON; each provides up to five examples, with a truncation marker when more exist. The [Sense reference](sense.md#dependency-envelope) describes the language boundaries.

## Update or remove

For npm:

```sh
npm update -g --foreground-scripts @the-open-engine-company/opcore
```

Keep custom agent directory variables set so the installer can find every integration that shares the executable. A restricted installation refuses an upgrade that would leave another agent on incompatible installed artifacts. CLI-only updates retain `OPCORE_NO_HOOKS=1`; a repeated `setup --no-hooks` verifies and reinstalls the same package version.

Current npm versions don't run uninstall lifecycle scripts. Remove the integrations first, then the npm package:

```sh
opcore uninstall
npm uninstall -g @the-open-engine-company/opcore
```

For a project-local package, use `npx --no-install opcore uninstall` followed by `npm uninstall @the-open-engine-company/opcore`. To switch an integrated npm installation to CLI-only mode, run the first cleanup command, then `opcore setup --no-hooks` while the wrapper remains installed.

For a source installation, run `./scripts/install.sh --uninstall` from the checkout. For an archive installation, run `./install.sh --uninstall` from the extracted bundle. Both also print a standalone uninstaller when installed; keep that path if you remove the original checkout or bundle. Add `--agent codex` or `--agent claude` to remove one integration while preserving the other.

Cleanup checks the recorded artifacts before removing them and retains modified files. If a step fails, read the named path and repair the reported conflict before retrying; don't delete the shared executable while another integration still owns it.

## If setup doesn't work

| Symptom | Recovery |
| --- | --- |
| `command not found`, or `uninstall` is unknown | For a global npm install, run `export PATH="$(npm prefix -g)/bin:$PATH"` and `hash -r`. Check `command -v opcore`; use the npm wrapper, not the package's private `native` directory. Project-local installs use `npx --no-install opcore`. |
| `NATIVE_SETUP_REQUIRED` or missing npm install state | Run `opcore setup`, or `setup --no-hooks` for CLI-only use. `doctor --json` identifies the package path and setup failure even before a native binary is available. |
| Unsupported platform or glibc | Use the [source installer](#source-checkout) on a supported build host; npm has no source fallback. |
| Download failed or timed out | Check access to the named GitHub Release URL, then retry `setup`. A checksum mismatch requires a fresh verified download; never bypass the digest check. |
| No supported agent detected | Set `OPCORE_AGENT=codex` or `claude`, set the intended agent directory, or explicitly choose CLI-only installation with `OPCORE_NO_HOOKS=1`. |
| Permission denied | Use a writable npm prefix or project-local install. For executable preflight failures, ensure the temporary filesystem permits execution; npm's `TMPDIR` can select an appropriate temporary directory. |
| CLI checks work but no automatic feedback appears | Restart the agent, review hook trust and settings, and repeat the edit smoke test in that session. |
| Native coverage is unavailable | Run `doctor --workflow <name>` and follow the selected [provider's prerequisites](providers.md). A present compiler can still lack dependencies or usable project configuration. |

For a malformed agent settings file, correct the named JSON error while preserving unrelated settings, then retry setup. For a modified owned artifact, compare it with your backup before restoring its expected bytes or moving a reviewed custom file aside. Keep integration receipts and shared ownership records; they identify which files cleanup may remove. A corrupt receipt needs its original backup or a report for manual recovery, because the installer cannot infer ownership from filenames.

For a damaged CLI-only npm installation with no agent owners, back up its `install-state.json` and `native/opcore` outside the package directory, move those two files out, and run `setup --no-hooks`. Setup downloads and verifies the release again. Use `doctor --json` to locate the package first.

If hook setup fails, the installer attempts to remove new, unmodified integrations while the binary is available. It retains existing or modified integrations and reports their paths. After repairing the named conflict, retry `setup`; if npm already removed the wrapper, reinstall the same package version with `--foreground-scripts`. Follow the same sequence if npm was removed before `opcore uninstall`: restore the package at its original prefix and with the original agent directory settings, then run the two-step cleanup. A retained standalone uninstaller may depend on the missing binary.

An interrupted installer can leave an empty ownership lock directory. Confirm no installation or removal is still running, then use `rmdir` on the exact reported `.lock` path and retry. Preserve the adjacent ownership directory. [Report a reproducible problem](../CONTRIBUTING.md#report-a-problem) when the retained state cannot be recovered from its receipts or backups.
