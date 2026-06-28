# @the-open-engine/opcore-validation-docs

Internal Opcore validation adapter for documentation and context-health checks.

The adapter owns opt-in `docs.*` checks over repository guidance, README-style docs, and conventional docs/policy files. It reads content through the validation file view so hypothetical overlays stay in memory, and it does not write cache artifacts or mutate documentation.
