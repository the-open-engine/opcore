import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  aggregateValidationResults,
  createValidationCheckManifest,
  createValidationCheckRegistry,
  registerValidationCheck,
  selectValidationChecks
} from "../packages/validation/dist/index.js";

describe("validation check registry", () => {
  it("exports package-owned registry and aggregation APIs", () => {
    for (const api of [
      aggregateValidationResults,
      createValidationCheckManifest,
      createValidationCheckRegistry,
      registerValidationCheck,
      selectValidationChecks
    ]) {
      assert.equal(typeof api, "function");
    }
  });

  it("does not derive aggregate skipped when at least one check ran", () => {
    const result = aggregateValidationResults({
      checks: ["a", "b"],
      generatedAt: "2026-06-05T00:00:00.000Z",
      runs: [
        {
          checkId: "a",
          status: "passed",
          diagnosticCount: 0
        },
        {
          checkId: "b",
          status: "skipped",
          diagnosticCount: 0
        }
      ]
    });

    assert.equal(result.status, "passed");
    assert.equal(result.ok, true);
    assert.equal(result.failure, undefined);
  });

  it("refuses duplicate and malformed check ids", () => {
    assert.throws(() => createValidationCheckRegistry([check("types"), check("types")]), /Duplicate validation check id: types/);
    assert.throws(() => createValidationCheckRegistry([check("Types")]), /check id/);
    assert.throws(
      () =>
        createValidationCheckRegistry([
          {
            ...check("imports.no-cycles"),
            graphRequirements: []
          }
        ]),
      /graphRequirements/
    );
  });

  it("selects checks in registry order by default and requested order when present", () => {
    const registry = createValidationCheckRegistry([check("types"), check("imports.no-cycles"), check("lint")]);

    assert.deepEqual(
      selectValidationChecks(registry).map((entry) => entry.id),
      ["types", "imports.no-cycles", "lint"]
    );
    assert.deepEqual(
      selectValidationChecks(registry, ["lint", "types", "lint"]).map((entry) => entry.id),
      ["lint", "types"]
    );
  });

  it("rejects unknown requested checks", () => {
    const registry = createValidationCheckRegistry([check("types")]);

    assert.throws(() => selectValidationChecks(registry, ["missing"]), /Unknown validation check: missing/);
  });

  it("creates manifest entries with stable ownership and scope metadata", () => {
    const registry = registerValidationCheck(createValidationCheckRegistry([check("types")]), {
      ...check("imports.no-cycles"),
      requiresGraph: true,
      defaultSeverity: "warning",
      supportedScopes: ["files", "repo"]
    });

    assert.deepEqual(createValidationCheckManifest(registry), [
      {
        checkId: "types",
        owner: "validation",
        adapter: "generic",
        defaultSeverity: "error",
        supportedScopes: ["files", "changed", "staged", "tree", "all", "repo", "package"],
        requiresGraph: false
      },
      {
        checkId: "imports.no-cycles",
        owner: "validation",
        adapter: "generic",
        defaultSeverity: "warning",
        supportedScopes: ["files", "repo"],
        requiresGraph: true
      }
    ]);
  });

  it("registers graph requirement functions without changing public manifest entries", () => {
    const registry = createValidationCheckRegistry([
      {
        ...check("imports.no-cycles"),
        requiresGraph: true,
        graphRequirements: () => [
          {
            operation: "factQuery",
            selector: {
              kind: "edges",
              edgeKinds: ["IMPORTS_FROM"]
            }
          }
        ]
      }
    ]);

    assert.equal(typeof registry.byId.get("imports.no-cycles").graphRequirements, "function");
    assert.deepEqual(createValidationCheckManifest(registry), [
      {
        checkId: "imports.no-cycles",
        owner: "validation",
        adapter: "generic",
        defaultSeverity: "error",
        supportedScopes: ["files", "changed", "staged", "tree", "all", "repo", "package"],
        requiresGraph: true
      }
    ]);
  });
});

function check(id) {
  return {
    id,
    owner: "validation",
    adapter: "generic",
    defaultSeverity: "error",
    supportedScopes: ["files", "changed", "staged", "tree", "all", "repo", "package"],
    requiresGraph: false,
    run: () => ({
      diagnostics: []
    })
  };
}
