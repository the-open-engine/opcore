import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkCommandAdapter,
  createValidationResultSkeleton,
  defaultValidationGraphProvider,
  missingGraphStatus,
  normalizeValidationRequest,
  validateCommandAdapter,
  validateValidationRequestContract
} from "../packages/validation/dist/index.js";

describe("validation contract helpers", () => {
  it("validates and normalizes request contracts without runner behavior", () => {
    const normalized = normalizeValidationRequest(
      {
        requestId: "request-1",
        repo: {
          repoId: "opcore"
        },
        scope: {
          kind: "files",
          files: ["src\\index.ts"]
        },
        graph: {
          mode: "required"
        },
        overlays: [
          {
            path: "src\\index.ts",
            action: "write",
            content: "export {};",
            checksumBefore: "sha256:before"
          }
        ]
      },
      {
        checks: ["types", "types", " lint "]
      }
    );
    assert.equal(normalized.graph.provider, defaultValidationGraphProvider);
    assert.deepEqual(normalized.scope.files, ["src/index.ts"]);
    assert.equal(normalized.overlays[0].path, "src/index.ts");
    assert.deepEqual(normalized.checks, ["types", "lint"]);
    assert.equal(validateValidationRequestContract(normalized), normalized);
  });

  it("rejects malformed request contracts", () => {
    assert.throws(
      () =>
        normalizeValidationRequest({
          repo: {
            repoId: "opcore"
          },
          scope: {
            kind: "files",
            files: ["../index.ts"]
          },
          graph: {
            mode: "required"
          },
          overlays: []
        }),
      /escape/
    );
    assert.throws(
      () =>
        validateValidationRequestContract({
          repo: {
            repoId: "opcore"
          },
          scope: {
            kind: "files",
            files: ["src/index.ts"]
          },
          graph: {
            mode: "required"
          },
          overlays: [
            {
              path: "src/index.ts",
              action: "write"
            }
          ]
        }),
      /content/
    );
    assert.throws(
      () =>
        normalizeValidationRequest({
          repo: {
            repoId: "opcore"
          },
          scope: {
            kind: "files",
            files: ["src/index.ts"]
          },
          graph: {
            mode: "required"
          },
          overlays: [],
          checks: ["  "]
        }),
      /checks/
    );
    assert.throws(
      () =>
        normalizeValidationRequest(
          {
            repo: {
              repoId: "opcore"
            },
            scope: {
              kind: "files",
              files: ["src/index.ts"]
            },
            graph: {
              mode: "required"
            },
            overlays: []
          },
          {
            checks: ["types", "  "]
          }
        ),
      /checks/
    );
  });

  it("constructs typed result skeletons and graph-missing statuses", () => {
    assert.deepEqual(createValidationResultSkeleton({ status: "passed" }), {
      ok: true,
      status: "passed",
      diagnostics: []
    });
    assert.equal(
      createValidationResultSkeleton({
        status: "provider_failure",
        graphStatus: missingGraphStatus("required"),
        failure: {
          category: "provider_failure",
          message: "graph unavailable"
        },
        checks: ["types"],
        generatedAt: "2026-06-05T00:00:00.000Z",
        durationMs: 4,
        entries: [
          {
            checkId: "types",
            owner: "validation",
            adapter: "generic",
            defaultSeverity: "error",
            supportedScopes: ["files"],
            requiresGraph: false
          }
        ],
        runs: [
          {
            checkId: "types",
            status: "passed",
            durationMs: 4,
            diagnosticCount: 0
          }
        ],
        skippedChecks: []
      }).graphStatus.state,
      "required_missing"
    );
    assert.equal(
      createValidationResultSkeleton({
        status: "invalid_payload",
        failure: {
          category: "invalid_payload",
          message: "request malformed"
        }
      }).failure.category,
      "invalid_payload"
    );
    assert.equal(
      createValidationResultSkeleton({
        status: "refused",
        refusal: {
          category: "validation_failed",
          message: "preflight refused"
        }
      }).refusal.category,
      "validation_failed"
    );
    assert.throws(
      () =>
        createValidationResultSkeleton({
          status: "provider_failure",
          failure: {
            category: "policy_failure",
            message: "wrong category"
          }
        }),
      /category.*status/
    );
    assert.throws(() => createValidationResultSkeleton({ checks: ["  "] }), /checks/);
    assert.equal(missingGraphStatus("optional", "custom-provider").provider, "custom-provider");
  });

  it("stamps generated manifests with current time when generatedAt is omitted", () => {
    const before = Date.now();
    const result = createValidationResultSkeleton({ checks: ["types"] });
    const after = Date.now();
    const generatedAt = Date.parse(result.manifest.generatedAt);

    assert.notEqual(result.manifest.generatedAt, "1970-01-01T00:00:00.000Z");
    assert.ok(generatedAt >= before);
    assert.ok(generatedAt <= after);
  });

  it("exposes implemented validation manifest adapters", async () => {
    for (const adapter of [checkCommandAdapter, validateCommandAdapter]) {
      const result = await adapter({
        bin: "opcore",
        argv: ["check"],
        args: ["manifest"],
        canonicalCommand: ["opcore", "check"],
        json: true
      });
      assert.equal(result.owner, "validation");
      assert.equal(result.status, "ok");
      assert.deepEqual(result.validationResult.manifest.entries, []);
    }
  });
});
