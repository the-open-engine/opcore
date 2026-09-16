# Configuration

[Overview](../README.md) · [Getting started](getting-started.md) · [Providers](providers.md)

## One repository file

Check, Sense, hooks, and workflows share root `.opcore.json`. Every section is optional; omitting the file uses built-in defaults. Cargo, TypeScript, and Python keep their own compiler configuration.

```json
{
  "schemaVersion": 1,
  "verify": { "maxParameters": 5 },
  "targets": { "exclude": ["vendor", "generated"] },
  "providers": {
    "node-native": { "roots": ["apps/web"] }
  },
  "workflows": {
    "post-edit": {
      "verify": { "maxParameters": 8 },
      "targets": { "exclude": ["vendor", "generated", "legacy"] }
    },
    "pre-commit": { "native": ["node-native"] },
    "ci": {
      "native": ["node-native"],
      "targets": { "exclude": ["vendor"] }
    }
  }
}
```

Post-edit permits eight parameters and excludes legacy code. Pre-commit inherits the five-parameter limit and checks the selected TypeScript project too. CI also includes generated code.

| Section | Settings |
| --- | --- |
| `verify` | `maxFileLines`, `maxLineBytes`, `maxFunctionLines`, `maxParameters`, `maxNesting`, `maxCyclomaticComplexity`. |
| `sense` | `importantFanIn`, `minimumIdenticalBytes`, `maxDependencyTargets`, `maxEdgeSelectors`, `maxModuleExports`, `maxShapeMembers`. |
| `documentation` | Exact source-to-document `bindings`, shared by every workflow. |
| `targets` | Literal excluded file and subtree paths. |
| `providers` | Project `roots` for `rust-native`, `node-native`, and `python-native`; each defaults to `["."]`. |
| `native` | Required native providers for pre-commit and CI; defaults to `[]`. |
| `coverage` | `allowPartial` and `allowNodeBuiltins` acknowledgments for Sense. |
| `workflows` | Overrides for `post-edit`, `pre-commit`, and `ci`. |

Inspect settings and generate the editor schema from the installed definitions:

```sh
opcore rules
opcore rules --schema > .opcore.schema.json
opcore status --workflow pre-commit --json
opcore doctor --workflow pre-commit
```

Add `"$schema": "./.opcore.schema.json"` to the configuration for editor completion and validation. Regenerate the schema after upgrading Opcore. `rules` also contains `policy.defaults` in the configuration-file shape; the outer rule manifest is not a valid configuration file.

Unknown or duplicate fields, explicit `null`, unsafe paths, unsupported schema versions, symlinks, files over 256 KiB, and settings outside hard bounds fail validation. Doctor identifies configuration errors without evaluating source. The entire file must be valid, including unselected workflows.

## Workflow overrides

Resolution is built-in defaults, then repository settings, then the selected workflow, then explicitly supplied CLI options. Objects merge by their defined fields; scalar values and arrays replace inherited values. Omission inherits, and `[]` clears a list. Workflows inherit directly from repository settings and cannot inherit another workflow.

Workflows may override `verify`, `sense`, `targets`, `providers`, `native`, and `coverage`. Documentation ownership remains repository-wide. Configuration cannot select executable commands, grant native execution permission, or change hard resource limits. Post-edit always uses Fast Verify and Sense; selecting native providers inside `workflows.post-edit` is invalid.

`status --workflow <name>` reports the effective settings and their origins. Use `check --workflow <name>` or `sense --workflow <name>` to run one evaluator with those settings; their source-selection flags retain their normal meaning. `run <name>` selects the workflow's complete sequence and Git view.

Pre-commit and CI require complete Sense coverage by default. Post-edit allows partial Sense coverage by default; explicit repository or workflow coverage settings override that default. Set `coverage.allowPartial` only after reviewing the reported gaps. `coverage.allowNodeBuiltins` accepts only known explicit `node:` built-ins; unknown names and unresolved packages still require attention. Neither setting accepts incomplete evaluation.

## Select targets

`targets.exclude` contains up to 256 distinct normalized repository-relative paths. Each entry excludes that exact file or subtree. `legacy` matches `legacy/api.ts`, but not `legacy-utils/api.ts`. Paths are literal: `*`, `?`, and brackets have no wildcard meaning. Absolute paths, `..`, empty components, and `.` are invalid exclusions.

Fast Verify filters excluded paths before reading and parsing source. Sense uses the selected graph and reports any loss of graph coverage; excluded source never becomes evidence that the whole repository is clean. A full check that selects no supported source fails rather than returning a clean result.

Native tools need intact compiler inputs. Use provider `roots` to select non-overlapping packages or projects, and override those roots per workflow for monorepos. Opcore retains required ancestor configuration and dependency context. An exclusion that the selected backend cannot honor produces an explanation; it never deletes required compiler inputs or hides a compiler failure. See [native target selection](providers.md#work-in-a-monorepo).

## Match configuration to source

Worktree checks use worktree configuration. Staged checks use the index, and committed checks use the selected commit's file. `run pre-commit` therefore ignores an unstaged threshold change; `run ci --tree <target> --base <base>` reads target-commit settings even in a dirty checkout. `status --workflow ci --tree <target>` inspects that same view.

Introduced comparisons use the selected effective thresholds for both source versions. A threshold change alone does not fabricate a source regression. Full pre-commit and CI Verify checks still detect existing source that exceeds a stricter limit. Sense keeps its introduced-regression semantics: unchanged or reduced baseline debt does not block.

The host resolves configuration once per attempt and supplies each provider's settings explicitly. Direct Fast and ASP Fast use the same thresholds. Reports bind their effective configuration and source identities; concurrent source or configuration changes trigger a retry or an incomplete result.

## Register documentation ownership

Add exact bindings to the same `.opcore.json`:

```json
{
  "schemaVersion": 1,
  "documentation": {
    "bindings": [
      { "source": "src/core.ts", "document": "docs/core.md" }
    ]
  }
}
```

Create the referenced document too. Each source gets one binding, with at most 4,096 bindings in the configuration. Paths are literal repository-relative paths; duplicate sources, unsafe paths, source-to-self bindings, and binding the configuration as a document are invalid.

When an important module changes its public surface, its registered document must change in the same selected view. Stage configuration and document updates with the source change for pre-commit. Rebinding to an unchanged document does not satisfy the obligation. [Documentation ownership](agent-signals.md#documentation-ownership) defines the exact triggers.

## Check proposed changes in memory

`sense --hypothetical` compares the current worktree with exact proposed writes and deletes without applying them. For example, save this as `proposed-changes.json`:

```json
{
  "schemaVersion": 1,
  "changes": [
    { "action": "write", "path": "src/counter.ts", "content": "export const count = 1;\n" },
    { "action": "delete", "path": "src/old-counter.ts" }
  ]
}
```

```sh
opcore sense --hypothetical proposed-changes.json --json
```

Use `--hypothetical -` to read stdin. Writes contain complete UTF-8 contents, including the final newline; deletes have no `content`. Each path must be unique and normalized. The request may change supported source, relevant `go.mod` files, documents, and `documentation.bindings` in the configuration. Other configuration settings must remain unchanged. This mode cannot combine with staged or committed selection; hypothetical Verify uses [ASP](../asp/README.md).
