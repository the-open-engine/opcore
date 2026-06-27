---
name: repo-tooling
description: Use repo-provided crg, cix, and rox, and follow the language and quality skills before writing code.
---

# Repo Tooling

- Prefer repo-provided `crg` for indexed code search and impact analysis before broad scans.
- Use repo-provided `cix` when you need repo-aware code intelligence or refactors instead of ad hoc grep and manual edits.
- For cohesive large deltas prepared in a patch file or temporary tree, run `cix apply-patch --patch <file> --check --json` or `cix apply-tree --from <dir> --check --json` before applying.
- Apply the same `cix apply-patch` / `cix apply-tree` command without `--check` only after reviewing the reported file set. Do not pass `--skip-validation` unless debugging `cix` itself.
- Prefer structured `cix` operations (`rename`, `move`, `change-signature`, `multi-edit`, `search-replace`) when they fit; use `apply-patch` / `apply-tree` for whole-delta import.
- Use repo-provided `rox` for repository-owned validation and staged checks when the workspace exposes it.
- If Rox hypothetical validation is unavailable, say so and run scoped `rox check --files` after applying.
- If these tools are absent, fail open and use the next best local fallback instead of assuming the repo supports them.
- Treat repo-local wrappers or bootstrap scripts as compatibility or product-specific glue, not as the generic ACE contract. Generic tool/runtime/worktree behavior belongs to the packaged ACE command surface and should not be re-explained as prompt content.

## Language and quality skills (read before writing code)

This repo holds TypeScript/JavaScript and Rust. Match the engineering standard used in the covibes and orchestra repos: before writing or reviewing code, read the matching skill and follow it.

- **TypeScript / JavaScript** -> `.claude/skills/typescript/SKILL.md` - strict typing, no `any`, discriminated unions over loose booleans, exhaustive `switch`, narrow module boundaries, real error handling.
- **TypeScript / JS linting** -> `.claude/skills/eslint/SKILL.md` - keep code lint-clean; never blanket-disable rules to pass.
- **Rust** -> `.claude/skills/rust-engineer/SKILL.md` plus its `references/` (ownership, traits, error-handling, performance, documentation). For async or concurrency also read `.claude/skills/rust-async-patterns/SKILL.md`.
- **Tests (any language)** -> `.claude/skills/testing/SKILL.md` - behaviour-focused tests with real assertions; no trivial or always-true tests.

Do not weaken existing guardrails - Rox, clippy `-D warnings`, `cargo fmt --check`, `tsc`, and (where present) ESLint - to make code pass. Fix the code instead.
