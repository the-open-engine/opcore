# Graph Hub Inventory

This inventory records source files currently classified as graph hubs by
`docs.hub-coverage`. It is grouped by ownership track so architectural context
remains discoverable after module splits. Update the inventory when graph
topology adds or removes a hub; inclusion documents location, not public API
status or cross-package ownership.

## crates/graph-core

```text
crates/graph-core/src/clone/analysis.rs
crates/graph-core/src/daemon/lifecycle.rs
crates/graph-core/src/daemon/session.rs
crates/graph-core/src/extraction/diagnostics.rs
crates/graph-core/src/extraction/discovery.rs
crates/graph-core/src/extraction/language.rs
crates/graph-core/src/extraction/tests/support.rs
crates/graph-core/src/extraction/tsconfig.rs
crates/graph-core/src/lib.rs
crates/graph-core/src/pipeline.rs
crates/graph-core/src/protocol.rs
crates/graph-core/src/protocol/daemon.rs
crates/graph-core/src/protocol/facts.rs
crates/graph-core/src/protocol/provider.rs
crates/graph-core/src/query.rs
crates/graph-core/src/query/common.rs
crates/graph-core/src/query/index.rs
crates/graph-core/src/search.rs
crates/graph-core/src/store/metadata.rs
crates/graph-core/src/store/read.rs
crates/graph-core/src/store/schema.rs
crates/graph-core/src/store/types.rs
crates/graph-core/src/test_support.rs
crates/graph-core/src/watch.rs
```

## packages/asp-provider

```text
packages/asp-provider/src/json-rpc.ts
packages/asp-provider/src/protocol.ts
```

## packages/contracts

```text
packages/contracts/src/command/adapter-validator.ts
packages/contracts/src/command/contracts.ts
packages/contracts/src/command/helper-validators.ts
packages/contracts/src/command/router-02.ts
packages/contracts/src/command/router-contracts.ts
packages/contracts/src/command/validators.ts
packages/contracts/src/command/vocabulary.ts
packages/contracts/src/edit/contracts.ts
packages/contracts/src/edit/refusal-validator.ts
packages/contracts/src/edit/validators.ts
packages/contracts/src/edit/vocabulary.ts
packages/contracts/src/graph/daemon-validators-01.ts
packages/contracts/src/graph/daemon-validators-02.ts
packages/contracts/src/graph/helper-validators.ts
packages/contracts/src/graph/payload-validators.ts
packages/contracts/src/graph/pipeline-contracts.ts
packages/contracts/src/graph/protocol-validators.ts
packages/contracts/src/graph/provider-contracts-01.ts
packages/contracts/src/graph/provider-contracts-02.ts
packages/contracts/src/graph/provider-validators.ts
packages/contracts/src/graph/query-contracts-01.ts
packages/contracts/src/graph/query-contracts-02.ts
packages/contracts/src/graph/query-validators.ts
packages/contracts/src/graph/search-contracts.ts
packages/contracts/src/graph/search-validators.ts
packages/contracts/src/graph/vocabulary-01.ts
packages/contracts/src/graph/vocabulary-02.ts
packages/contracts/src/inspect/contracts-01.ts
packages/contracts/src/inspect/contracts-02.ts
packages/contracts/src/inspect/helper-validators-01.ts
packages/contracts/src/inspect/validators.ts
packages/contracts/src/managed/contracts.ts
packages/contracts/src/managed/helper-validators.ts
packages/contracts/src/managed/validators-01.ts
packages/contracts/src/managed/validators-02.ts
packages/contracts/src/managed/validators-03.ts
packages/contracts/src/product/init-contracts.ts
packages/contracts/src/product/init-validators-01.ts
packages/contracts/src/product/latency-contracts.ts
packages/contracts/src/product/metrics-contracts-01.ts
packages/contracts/src/product/metrics-contracts-02.ts
packages/contracts/src/product/metrics-coverage-validators.ts
packages/contracts/src/product/metrics-validators-01.ts
packages/contracts/src/product/metrics-validators-02.ts
packages/contracts/src/product/metrics-validators-03.ts
packages/contracts/src/product/metrics-validators-04.ts
packages/contracts/src/product/metrics-validators-05.ts
packages/contracts/src/product/status-contracts.ts
packages/contracts/src/product/status-validators.ts
packages/contracts/src/release/asp-contracts-01.ts
packages/contracts/src/release/asp-validators-02.ts
packages/contracts/src/release/cutover-contracts.ts
packages/contracts/src/release/cutover-validators-02.ts
packages/contracts/src/release/graph-contracts.ts
packages/contracts/src/release/graph-optional-validators.ts
packages/contracts/src/release/graph-validators-02.ts
packages/contracts/src/release/graph-validators-03.ts
packages/contracts/src/release/graph-vocabulary-01.ts
packages/contracts/src/release/graph-vocabulary-02.ts
packages/contracts/src/release/receipt-contracts-01.ts
packages/contracts/src/release/receipt-contracts-02.ts
packages/contracts/src/release/receipt-validators-01.ts
packages/contracts/src/release/receipt-validators-02.ts
packages/contracts/src/release/receipt-validators-03.ts
packages/contracts/src/release/vocabulary-01.ts
packages/contracts/src/release/vocabulary-02.ts
packages/contracts/src/shared/json.ts
packages/contracts/src/shared/path-validators.ts
packages/contracts/src/shared/primitives.ts
packages/contracts/src/shared/validators-01.ts
packages/contracts/src/shared/validators-02.ts
packages/contracts/src/validation/capability-contracts.ts
packages/contracts/src/validation/diagnostic-contracts.ts
packages/contracts/src/validation/prewrite-status-validators-01.ts
packages/contracts/src/validation/python-project-contracts-01.ts
packages/contracts/src/validation/python-project-contracts-02.ts
packages/contracts/src/validation/python-project-validators-01.ts
packages/contracts/src/validation/python-project-validators-02.ts
packages/contracts/src/validation/python-pytest-validators-02.ts
packages/contracts/src/validation/python-ruff-validators-03.ts
packages/contracts/src/validation/python-types-validators.ts
packages/contracts/src/validation/python-validator-primitives.ts
packages/contracts/src/validation/request-contracts.ts
packages/contracts/src/validation/request-validators-01.ts
packages/contracts/src/validation/request-validators-02.ts
packages/contracts/src/validation/result-validator.ts
packages/contracts/src/validation/status-contracts.ts
packages/contracts/src/validation/vocabulary-01.ts
packages/contracts/src/validation/vocabulary-02.ts
```

## packages/edit

```text
packages/edit/src/atomic-writer.ts
packages/edit/src/codex-patch-parser.ts
packages/edit/src/command-parser.ts
packages/edit/src/content-policy.ts
packages/edit/src/hash.ts
packages/edit/src/language-service.ts
packages/edit/src/operations.ts
packages/edit/src/patch-parser.ts
packages/edit/src/patch-tree-command.ts
packages/edit/src/path-policy.ts
packages/edit/src/planner.ts
packages/edit/src/symbol-command.ts
packages/edit/src/symbol-graph.ts
packages/edit/src/symbol-preview.ts
packages/edit/src/symbol-requests.ts
packages/edit/src/tree-planner.ts
packages/edit/src/typescript-project/filesystem-discovery.ts
packages/edit/src/typescript-project/path-policy.ts
packages/edit/src/typescript-project/source-discovery.ts
packages/edit/src/typescript-project/tsconfig.ts
packages/edit/src/typescript-project/types.ts
packages/edit/src/validated-apply.ts
packages/edit/src/validation-request.ts
packages/edit/src/validation.ts
```

## packages/fixtures

Fixture roots are excluded from repository self-validation, so their graph hubs
are recorded by basename without claiming file-view freshness evidence.

```text
helpers.py
models.py
relative_target.py
stubs.pyi
math.js
```

## packages/graph

```text
packages/graph/src/artifact.ts
packages/graph/src/ephemeral-snapshot.ts
packages/graph/src/native-targets.ts
packages/graph/src/sidecar.ts
```

## packages/opcore

```text
packages/opcore/src/advanced/asp-warm/asp-warm-lifecycle.ts
packages/opcore/src/advanced/asp-warm/warm-project-registry.ts
packages/opcore/src/advanced/inspect-language-service.ts
packages/opcore/src/advanced/inspect-typescript-project.ts
packages/opcore/src/advanced/router.ts
packages/opcore/src/agent-gate.ts
packages/opcore/src/doctor.ts
packages/opcore/src/init-action-helpers.ts
packages/opcore/src/init-actions.ts
packages/opcore/src/init-apply.ts
packages/opcore/src/init-constants.ts
packages/opcore/src/init-context-payload.ts
packages/opcore/src/init-data.ts
packages/opcore/src/init-files.ts
packages/opcore/src/init-format.ts
packages/opcore/src/init-gitignore.ts
packages/opcore/src/init-guidance.ts
packages/opcore/src/init-hooks.ts
packages/opcore/src/init-messages.ts
packages/opcore/src/init-paths.ts
packages/opcore/src/init-payloads.ts
packages/opcore/src/init-plan.ts
packages/opcore/src/init-prompts.ts
packages/opcore/src/init-result.ts
packages/opcore/src/init-timing.ts
packages/opcore/src/init-types.ts
packages/opcore/src/init-undo-metadata.ts
packages/opcore/src/init-undo-plan.ts
packages/opcore/src/init-wizard-render.ts
packages/opcore/src/install-wizard.ts
packages/opcore/src/json-output.ts
packages/opcore/src/plate.ts
packages/opcore/src/repo-paths.ts
packages/opcore/src/repo-validation-policy.ts
packages/opcore/src/runtime-info.ts
packages/opcore/src/scan-presentation.ts
packages/opcore/src/scan-validation-preview.ts
packages/opcore/src/scan.ts
packages/opcore/src/serve-telemetry.ts
packages/opcore/src/source-policy.ts
packages/opcore/src/status-errors.ts
packages/opcore/src/status-git.ts
packages/opcore/src/status-repo.ts
packages/opcore/src/status-state.ts
packages/opcore/src/status-validation.ts
packages/opcore/src/status.ts
packages/opcore/src/stream-output.ts
packages/opcore/src/timing.ts
packages/opcore/src/validation-graph-session.ts
```

## packages/validation-clone

```text
packages/validation-clone/src/check-constants.ts
packages/validation-clone/src/check-ids.ts
packages/validation-clone/src/source-files.ts
```

## packages/validation-docs

```text
packages/validation-docs/src/check-constants.ts
packages/validation-docs/src/check-definition.ts
packages/validation-docs/src/check-ids.ts
packages/validation-docs/src/check-results.ts
packages/validation-docs/src/diagnostics.ts
packages/validation-docs/src/history.ts
packages/validation-docs/src/options.ts
packages/validation-docs/src/snapshot.ts
```

## packages/validation-policy

```text
packages/validation-policy/src/check-packs.ts
packages/validation-policy/src/config.ts
packages/validation-policy/src/path-policy.ts
packages/validation-policy/src/types.ts
```

## packages/validation-python

```text
packages/validation-python/src/check-constants.ts
packages/validation-python/src/check-ids.ts
packages/validation-python/src/diagnostics.ts
packages/validation-python/src/environment-resolution.ts
packages/validation-python/src/graph-requirements.ts
packages/validation-python/src/import-analysis.ts
packages/validation-python/src/ini-config.ts
packages/validation-python/src/mypy-config-values.ts
packages/validation-python/src/mypy-runner-types.ts
packages/validation-python/src/process.ts
packages/validation-python/src/project-config-files.ts
packages/validation-python/src/project-context.ts
packages/validation-python/src/project-fingerprint.ts
packages/validation-python/src/project-groups.ts
packages/validation-python/src/project-workspace.ts
packages/validation-python/src/pyright-config-values.ts
packages/validation-python/src/pytest-result.ts
packages/validation-python/src/pytest-types.ts
packages/validation-python/src/pytest-workspace.ts
packages/validation-python/src/python-context-result.ts
packages/validation-python/src/ruff-capability-run.ts
packages/validation-python/src/ruff-check-definition.ts
packages/validation-python/src/ruff-check-shared.ts
packages/validation-python/src/ruff-execution.ts
packages/validation-python/src/ruff-invocation-failure.ts
packages/validation-python/src/source-files.ts
packages/validation-python/src/source-types.ts
packages/validation-python/src/strict-json.ts
packages/validation-python/src/toml-config.ts
packages/validation-python/src/toolchain.ts
packages/validation-python/src/type-authority.ts
packages/validation-python/src/type-capability-run.ts
packages/validation-python/src/type-result.ts
packages/validation-python/src/type-runner-runtime.ts
packages/validation-python/src/type-runner-types.ts
packages/validation-python/src/version-constraint.ts
```

## packages/validation-rust

```text
packages/validation-rust/src/cargo-metadata.ts
packages/validation-rust/src/cargo-target-cache.ts
packages/validation-rust/src/check-constants.ts
packages/validation-rust/src/check-ids.ts
packages/validation-rust/src/diagnostics.ts
packages/validation-rust/src/import-graph-check.ts
packages/validation-rust/src/materialize.ts
packages/validation-rust/src/process.ts
packages/validation-rust/src/retained-compatibility.ts
packages/validation-rust/src/source-files.ts
packages/validation-rust/src/toolchain.ts
```

## packages/validation-typescript

```text
packages/validation-typescript/src/check-constants.ts
packages/validation-typescript/src/check-ids.ts
packages/validation-typescript/src/compiler-host.ts
packages/validation-typescript/src/dead-code-entrypoints.ts
packages/validation-typescript/src/diagnostics.ts
packages/validation-typescript/src/graph-requirements.ts
packages/validation-typescript/src/lint-helpers.ts
packages/validation-typescript/src/script-kind.ts
packages/validation-typescript/src/source-files.ts
packages/validation-typescript/src/test-paths.ts
```

## packages/validation

```text
packages/validation/src/aggregation.ts
packages/validation/src/command-options.ts
packages/validation/src/registry.ts
packages/validation/src/request.ts
packages/validation/src/resources.ts
packages/validation/src/runner.ts
packages/validation/src/scope.ts
```
