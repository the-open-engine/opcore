import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaultAspProviderValidationChecks } from "../packages/asp-provider/dist/validation-composition.js";
import { defaultValidationChecks as defaultOpcoreValidationChecks } from "../packages/opcore/dist/repo-validation-policy.js";
import { createBuiltInValidationChecks } from "../packages/validation-policy/dist/index.js";

describe("Python import analyzer composition", () => {
  it("forwards the structural analyzer through validation-policy", async () => {
    let calls = 0;
    const checks = createBuiltInValidationChecks(undefined, {
      clone: false,
      pythonImportAnalyzer: {
        async analyze() {
          calls += 1;
          return [{ fromPath: "src/app.py", toPath: "src/pkg/dep.py" }];
        }
      }
    });

    await importGraphRequirements(checks);
    assert.equal(calls, 1);
  });

  it("injects the graph-owned analyzer into Opcore and ASP compositions", async () => {
    await importGraphRequirements(defaultOpcoreValidationChecks);
    await importGraphRequirements(defaultAspProviderValidationChecks);
  });
});

async function importGraphRequirements(checks) {
  const check = checks.find((candidate) => candidate.id === "python.import-graph");
  assert.ok(check?.graphRequirements);
  const requirements = await check.graphRequirements(validationContext());
  assert.deepEqual(requirements.map((requirement) => requirement.selector.kind), ["edges", "nodes"]);
}

function validationContext() {
  const files = new Map([
    ["src/app.py", "from pkg import (\n    dep,\n)\n"],
    ["src/pkg/dep.py", "VALUE = 1\n"]
  ]);
  return {
    request: {
      requestId: "python-import-composition",
      repo: { repoId: "python-import-composition" },
      scope: { kind: "files", files: ["src/app.py"] },
      graph: { mode: "optional", provider: "opcore-graph" },
      overlays: [],
      checks: ["python.import-graph"]
    },
    fileView: {
      overlays: [],
      scopeFiles: ["src/app.py"],
      defaultReadState: "after",
      listVisibleFiles: async () => [...files.keys()],
      readFile: async (path) => files.has(path)
        ? { status: "found", content: files.get(path) }
        : { status: "missing" },
      readBefore: async (path) => files.has(path)
        ? { status: "found", content: files.get(path) }
        : { status: "missing" },
      readAfter: async (path) => files.has(path)
        ? { status: "found", content: files.get(path) }
        : { status: "missing" },
      exists: async (path) => files.has(path),
      hasOverlay: () => false,
      overlayFor: () => undefined
    }
  };
}
