# Latency Budgets

Opcore latency budgets are trend gates over named command and phase timings. They are evidence, not a score.

The machine-readable budgets live in `docs/performance/latency-budgets.json` and use the shared `LatencyBudget` contract from `@the-open-engine/opcore-contracts`. `scripts/check-latency-budgets.mjs` reads those budgets plus source-safe `CommandLatencyRecord` JSONL and emits contract-valid `LatencyBudgetResult` entries.

Default `npm run latency:check` uses synthetic passing fixture telemetry from `tests/fixtures/latency/telemetry-pass.jsonl` so CI has a deterministic trend signal before #35 adds Docker E2E benchmark evidence. When supplied custom records exceed budgets, the checker exits non-zero and prints per-command evidence. Use `--warn-only` for non-blocking trend collection.

Repo shape buckets are intentionally coarse:

- `small`: `totalFiles <= 100`
- `medium`: `totalFiles <= 5000`

Cold and warm are represented by `LatencyBudget.scope` and matched against `CommandTiming.processState`. Budget command ids may be stable prefixes of sanitized telemetry commands, so a budget for `opcore check changed` can cover bounded telemetry that also records safe flags such as `--base HEAD`. Phase budgets are optional and are checked only when a matching phase is present in telemetry; missing phases are reported as skipped evidence.

The gate must stay source-safe. Telemetry records are validated before comparison and must not contain source content, secrets, repo roots, raw file operands, or opaque score fields.
