# External ASP check providers (proposal)

Status: proposed. Opcore does not yet load external providers through `opcore check`.
This design is for cooperative coding agents and local developer feedback. It is
not an ASP Core host-conformance or tamper-resistance claim.

## Smallest useful product change

1. `opcore provider enroll --repo . --manifest /absolute/path/asp-server.json`
   records one provider ID and its launch binding for this Git repository in
   user-owned state outside the repository. Enrollment validates the manifest
   and records exact identities for the executable and declared assets, such as
   the AST-grep scanner and provider script. Changed or missing assets fail the
   run instead of silently changing the checker. Enrollment is the user's
   decision to allow this external process to run for this repository; Opcore
   must still describe the run as unsandboxed and advisory assurance.
2. `.opcore.json` contains the provider's declarative rules and workflow
   selection. The host passes that resolved configuration through ASP
   `check/evaluate.configuration`; the provider never opens `.opcore.json`
   itself. A configured workflow provider is required: if it is unavailable,
   crashes, or returns incomplete coverage, the workflow cannot report clean.
3. `opcore check --providers fast,<id>` selects an enrolled provider explicitly.
   Default Check remains Fast-only, and `--providers all` keeps its existing
   bundled-only meaning. No executable path, shell command, or package lookup
   comes from repository configuration.
4. An agent `PreToolUse` hook rejects direct Write/Edit/apply-patch operations
   targeting the repository's `.opcore.json`, including deletion or rename.
   Human edits in an ordinary editor remain possible. The existing
   `PostToolUse` feedback continues to report source findings. A shell command
   can have effects that a pre-tool hook cannot predict, so this is a
   cooperative-agent safeguard, not an identity or security boundary.

For example, a future configuration could contain:

```json
{
  "schemaVersion": 2,
  "providers": {
    "external": {
      "example-ast-grep": {
        "configuration": {
          "rules": [{
            "id": "redundant-boolean-return",
            "language": "python",
            "severity": "error",
            "rule": {"pattern": "if $COND:\n  return True\nelse:\n  return False"}
          }]
        }
      }
    }
  },
  "workflows": {"post-edit": {"external": ["example-ast-grep"]}}
}
```

This requires a new configuration schema version while keeping v1 readable.
The provider validates its rule language and bounds; Opcore validates the
generic JSON envelope and checks that the assessment's provider identity,
source evidence, configuration digest, coverage, and freshness match the
request. ASP `check/evaluate.rules` selects rule IDs; the definitions belong
in `configuration`. The current example under `contrib/asp-ast-grep/` has a
fixed `rules.yaml` and rejects nonempty configuration, so it must be adapted
before the example above works.

## SCBench evaluation boundary

The benchmark runner records the exact Opcore, provider, scanner, rules,
`.opcore.json`, agent, and SCBench evaluator identities before each trial. It
checks that the candidate did not alter `.opcore.json` or the checker assets;
such a trial is reported as an invalid intervention, never as zero erosion.
Official SCBench output remains the outcome measure. Opcore interventions,
agent retries, time, tokens, and cost are measured separately. This guard is
adequate for the intended cooperative-agent study; it does not imply that a
same-user agent cannot bypass a local hook.

No separate active-policy snapshot, candidate-policy preview, grant registry,
or protected-tree resolver is proposed for the first release. The existing
local CLI reads configuration from the selected source view, so a deliberately
modified configuration can still weaken a check. A future adversarial gate
would need a distinct trusted policy authority. CI authority must come from
the CI environment and repository protection, not from this local hook.
