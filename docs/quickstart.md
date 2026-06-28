# Quickstart

## From This Checkout

Package publication is maintainer-controlled during alpha staging. Until
maintainers publish the alpha packages, run Opcore from a source checkout:

```bash
npm ci
npm run build
node packages/opcore/dist/index.js init --repo /path/to/repo
```

What this shows:

- The built source command starts the interactive onboarding wizard without
  relying on npm registry publication.
- The wizard runs a read-only scan first, prints Coverage before Findings, reports concrete counts and locations, and asks before writing.
- Scan/status/check/measure are read-only for source files.
- Approved init writes only additive `.opcore/config`, one delimited guidance block in an existing agent file or new `AGENTS.md`, a managed `.opcore/` line in `.gitignore` for Git repos, and `.opcore/init-undo.json`.
- Undo recorded setup with `opcore init --undo`.

Alpha support is `darwin-arm64`, `darwin-x64`, and `linux-x64` with Node >=22. Unsupported platforms return typed degraded status instead of crashing. Windows is out of scope for `0.1.0-alpha.0`. Language coverage is deep for TypeScript/JavaScript, useful for Rust, and experimental degraded-honest for Python. Other non-TS/JS/Rust/Python files are counted in coverage; day-one checks skip them.

## Package Publication

After package publication, the one-command first-run path is:

```bash
npx @the-open-engine/opcore@0.1.0-alpha.0 init
```

After package publication, install globally when you expect to run Opcore repeatedly:

```bash
npm install -g @the-open-engine/opcore@0.1.0-alpha.0
opcore
opcore init
```

If `opcore` is not found after a global install, check npm's global prefix and put its `bin` directory on `PATH`:

```bash
npm prefix -g
export PATH="$(npm prefix -g)/bin:$PATH"
```

Restart the shell or add that export to the shell startup file used by the environment.

## After Setup Reference

Scan reads the repo and writes only `.opcore/report.json`,
`.opcore/history.jsonl`, and bounded `.opcore/telemetry.jsonl`.

Run this inside the repository you want to inspect:

```bash
opcore
opcore --repo .
opcore status
```

Use JSON when another tool consumes the result:

```bash
opcore --json
opcore status --json
```

Check changed files from agents or hooks:

```bash
opcore check --changed --json
opcore check --staged --json
opcore check --changed --checks python.syntax,python.source-hygiene --json
```

Agents should treat any non-zero exit as a blocked write unless their workflow has a typed recovery path.

`opcore check --changed --json` works in a freshly `git init` repo with no commits; it treats the empty baseline as the comparison base.

Measure progress from stored artifacts:

```bash
opcore measure
opcore measure --repo .
```

`opcore measure` compares the latest scan with the baseline or previous scan and reports concrete deltas such as type errors, untested surface, dead exports, Python syntax/source-hygiene or optional type-tool degradation, suppression abuse, oversized files, and unsupported-language coverage.

Approve setup non-interactively only when the plan is acceptable:

```bash
opcore init
opcore init --approve
opcore init --repo . --approve
```

`opcore init` runs the read-only scan first, prints coverage before findings, shows the additive setup plan, and prompts on a TTY. `opcore init --json` previews without writing. Approved init writes only the approved setup artifacts listed above. Non-Git repos skip `.gitignore`; undo removes only the managed line. The `.opcore/` ignore covers `.opcore/telemetry.jsonl`. JSON output includes scan, language settings, interaction, and timing fields.

## Coverage Honesty

Opcore alpha is deep for TypeScript/JavaScript graph-backed signals and useful for Rust validation signals. Python is experimental and degraded-honest: `.py`/`.pyi` graph-backed structure, untested modules, dead exports, syntax, and source-hygiene are reported when available; `python.types` depends on mypy or pyright and reports missing tools as degraded. Other non-TS/JS/Rust/Python languages are counted and reported as unsupported; they do not get fake findings or fake ratings.

## Demo Loop

```bash
opcore try
```

`opcore try` generates local TS, Rust, mixed, and unsupported-file samples, then runs scan, init, check, and measure without publishing anything.

## Private ASP Provider Mode

Private ASP hosts may launch the provider process behind host-owned decisions and receipts:

```bash
opcore-asp-provider --stdio
```

The aggregate `@the-open-engine/opcore` package exposes only `opcore`;
`opcore-asp-provider` comes from the separate
`@the-open-engine/opcore-asp-provider` package. From a built source checkout,
use `node packages/asp-provider/dist/index.js --stdio`.

Do not treat provider output as a gate decision. The provider returns ASP Assessments; the ASP host returns allow, deny, or indeterminate decisions plus receipts.
