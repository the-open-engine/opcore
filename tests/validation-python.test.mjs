import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createValidationCheckRegistry, createValidationRunner } from "../packages/validation/dist/index.js";
import {
  PYTHON_DEAD_CODE_CHECK_ID,
  PYTHON_IMPORT_GRAPH_CHECK_ID,
  PYTHON_RELEVANT_TESTS_CHECK_ID,
  PYTHON_SOURCE_HYGIENE_CHECK_ID,
  PYTHON_SYNTAX_CHECK_ID,
  PYTHON_TYPES_CHECK_ID,
  createPythonValidationAdapterStatus,
  createPythonValidationChecks,
  findPythonConfigFile,
  isPythonSourcePath,
  resolvePythonInterpreter,
  resolvePythonTool,
  validationPythonAdapterName
} from "../packages/validation-python/dist/index.js";

const repoRoot = dirname(fileURLToPath(import.meta.url));
const validationFixtureRoot = join(repoRoot, "../packages/fixtures/validation-python");

describe("validation-python adapter", () => {
  it("keeps compiler-truth fixture resources out of repository Python source discovery", () => {
    const fixturePaths = walkFiles(join(validationFixtureRoot, "compiler-truth"));
    assert.ok(fixturePaths.length > 0);
    assert.ok(fixturePaths.every((path) => !isPythonSourcePath(path)));
    assert.deepEqual(
      Object.keys(fixtureFiles("compiler-truth")).sort(),
      ["invalid/misplaced-future.py", "invalid/module-return.py", "pkg/valid.py", "pkg/valid.pyi"]
    );
  });

  it("exports stable Python check ids and definitions", () => {
    const checks = createPythonValidationChecks();
    const registry = createValidationCheckRegistry(checks);

    assert.equal(validationPythonAdapterName, "python");
    assert.deepEqual(
      checks.map((check) => check.id),
      [
        PYTHON_SYNTAX_CHECK_ID,
        PYTHON_SOURCE_HYGIENE_CHECK_ID,
        PYTHON_TYPES_CHECK_ID,
        PYTHON_IMPORT_GRAPH_CHECK_ID,
        PYTHON_DEAD_CODE_CHECK_ID,
        PYTHON_RELEVANT_TESTS_CHECK_ID
      ]
    );
    assert.equal(registry.byId.get(PYTHON_SYNTAX_CHECK_ID)?.requiresGraph, false);
    assert.equal(registry.byId.get(PYTHON_SOURCE_HYGIENE_CHECK_ID)?.requiresGraph, false);
    assert.equal(registry.byId.get(PYTHON_IMPORT_GRAPH_CHECK_ID)?.requiresGraph, true);
  });

  it("reports missing Python type tooling as degraded instead of a silent pass", async () => {
    const env = { PATH: "" };
    const isolatedRepoRoot = mkdtempSync(join(tmpdir(), "opcore-python-adapter-status-"));
    try {
      const status = createPythonValidationAdapterStatus({ env, repoRoot: isolatedRepoRoot });
      assert.equal(status.status, "degraded");
      assert.equal(status.degradedChecks?.[0]?.checkId, PYTHON_TYPES_CHECK_ID);
      assert.equal(status.degradedChecks?.[0]?.requiredTool, "mypy or pyright");
    } finally {
      rmSync(isolatedRepoRoot, { recursive: true, force: true });
    }

    const result = await runner({
      files: {
        "pkg/app.py": "value: int = 'wrong'\n"
      },
      checks: createPythonValidationChecks({ env })
    }).runValidation(
      request({
        checks: [PYTHON_TYPES_CHECK_ID]
      })
    );

    assert.equal(result.status, "unsupported_request");
    assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), ["PYTHON_TYPES_UNSUPPORTED"]);
  });

  it("executes repo-local mypy and maps type diagnostics", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-types-mypy-"));
    try {
      writeToolShim(
        repoRoot,
        "mypy",
        [
          "#!/bin/sh",
          "if [ \"$1\" = \"--version\" ]; then echo 'mypy 1.8.0'; exit 0; fi",
          "while IFS= read -r line; do",
          "  case \"$line\" in",
          "    *\"'wrong'\"*) echo \"$1:1: error: Incompatible types in assignment (expression has type \\\"str\\\", variable has type \\\"int\\\")  [assignment]\"; exit 1 ;;",
          "  esac",
          "done < \"$1\"",
          "exit 0",
          ""
        ].join("\n")
      );

      const result = await runner({
        files: {
          "pkg/app.py": "value: int = 'wrong'\n"
        },
        checks: createPythonValidationChecks({ env: { PATH: "" }, repoRoot })
      }).runValidation(
        request({
          repo: { repoRoot },
          checks: [PYTHON_TYPES_CHECK_ID]
        })
      );

      assert.equal(result.status, "policy_failure");
      assert.equal(result.diagnostics[0].path, "pkg/app.py");
      assert.equal(result.diagnostics[0].category, "types");
      assert.equal(result.diagnostics[0].code, "MYPY_ASSIGNMENT");
      assert.match(result.diagnostics[0].message, /Incompatible types in assignment/);
      assert.equal(result.diagnostics[0].line, 1);
      assert.equal(result.diagnostics[0].tool.name, "mypy");
      assert.equal(result.diagnostics[0].tool.command.endsWith(join(".venv", "bin", "mypy")), true);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("checks overlay after-state content instead of the original Python file", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-types-overlay-"));
    try {
      writeToolShim(
        repoRoot,
        "mypy",
        [
          "#!/bin/sh",
          "if [ \"$1\" = \"--version\" ]; then echo 'mypy 1.8.0'; exit 0; fi",
          "while IFS= read -r line; do",
          "  case \"$line\" in",
          "    *\"'wrong'\"*) echo \"$1:1: error: overlay type failure  [assignment]\"; exit 1 ;;",
          "  esac",
          "done < \"$1\"",
          "exit 0",
          ""
        ].join("\n")
      );

      const result = await runner({
        files: {
          "pkg/app.py": "value: int = 1\n"
        },
        checks: createPythonValidationChecks({ env: { PATH: "" }, repoRoot })
      }).runValidation(
        request({
          repo: { repoRoot },
          checks: [PYTHON_TYPES_CHECK_ID],
          overlays: [{ path: "pkg/app.py", action: "write", content: "value: int = 'wrong'\n" }]
        })
      );

      assert.equal(result.status, "policy_failure");
      assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), ["MYPY_ASSIGNMENT"]);
      assert.match(result.diagnostics[0].message, /overlay type failure/);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("prefers pyright when pyright project config is present", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-types-pyright-"));
    try {
      writeFileSync(join(repoRoot, "pyrightconfig.json"), "{}\n");
      writeToolShim(repoRoot, "mypy", "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'mypy 1.8.0'; exit 0; fi\necho 'mypy should not run'; exit 1\n");
      writeToolShim(
        repoRoot,
        "pyright",
        [
          "#!/bin/sh",
          "if [ \"$1\" = \"--version\" ]; then echo 'pyright 1.1.0'; exit 0; fi",
          "echo \"  $1:1:14 - error: Type \\\"Literal['wrong']\\\" is not assignable to declared type \\\"int\\\" (reportAssignmentType)\"",
          "exit 1",
          ""
        ].join("\n")
      );

      const result = await runner({
        files: {
          "pkg/app.py": "value: int = 'wrong'\n"
        },
        checks: createPythonValidationChecks({ env: { PATH: "" }, repoRoot })
      }).runValidation(
        request({
          repo: { repoRoot },
          checks: [PYTHON_TYPES_CHECK_ID]
        })
      );

      assert.equal(result.status, "policy_failure");
      assert.equal(result.diagnostics[0].code, "PYRIGHT_REPORT_ASSIGNMENT_TYPE");
      assert.equal(result.diagnostics[0].path, "pkg/app.py");
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("reports syntax diagnostics from overlay after-state content", async () => {
    const result = await runner({
      files: {
        "pkg/app.py": "value = 1\n"
      }
    }).runValidation(
      request({
        checks: [PYTHON_SYNTAX_CHECK_ID],
        overlays: [{ path: "pkg/app.py", action: "write", content: "if True\n    value = (1\n" }]
      })
    );

    assert.equal(result.status, "policy_failure");
    assert.deepEqual(
      result.diagnostics.map((diagnostic) => diagnostic.code),
      ["PY_SYNTAX_ERROR"]
    );
    assert.equal(result.diagnostics[0].path, "pkg/app.py");
  });

  it("fails python.syntax for invalid Python grammar the heuristics miss", async () => {
    const result = await runner({
      files: {
        "pkg/app.py": "x = 1 2\n"
      }
    }).runValidation(
      request({
        checks: [PYTHON_SYNTAX_CHECK_ID]
      })
    );

    assert.equal(result.status, "policy_failure");
    assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), ["PY_SYNTAX_ERROR"]);
    assert.equal(result.diagnostics[0].path, "pkg/app.py");
  });

  it("reports python.syntax as unsupported when no Python interpreter is available", async () => {
    const result = await runner({
      files: {
        "pkg/app.py": "x = 1 2\n"
      },
      checks: createPythonValidationChecks({ env: { PATH: "" } })
    }).runValidation(
      request({
        checks: [PYTHON_SYNTAX_CHECK_ID]
      })
    );

    assert.equal(result.status, "unsupported_request");
    assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), ["PY_SYNTAX_TOOL_UNAVAILABLE"]);
    assert.equal(result.manifest.runs[0].outcome, "tool_unavailable");
  });

  it("passes python.syntax for valid multi-line Python with no false positives", async () => {
    const result = await runner({
      files: Object.fromEntries(
        Object.entries(fixtureFiles("compiler-truth")).filter(([path]) => path.startsWith("pkg/"))
      )
    }).runValidation(
      request({
        checks: [PYTHON_SYNTAX_CHECK_ID],
        scope: { kind: "files", files: ["pkg/valid.py", "pkg/valid.pyi"] }
      })
    );

    assert.equal(result.status, "passed");
    assert.deepEqual(result.diagnostics, []);
  });

  it("uses compile truth for control-flow and future-import failures ast.parse accepts", async () => {
    const files = fixtureFiles("compiler-truth");
    const result = await runner({
      files: {
        "invalid/misplaced-future.py": files["invalid/misplaced-future.py"],
        "invalid/module-return.py": files["invalid/module-return.py"]
      }
    }).runValidation(
      request({
        checks: [PYTHON_SYNTAX_CHECK_ID],
        scope: { kind: "files", files: ["invalid/module-return.py", "invalid/misplaced-future.py"] }
      })
    );

    assert.equal(result.status, "policy_failure");
    assert.equal(result.manifest.runs[0].outcome, "findings");
    assert.deepEqual(result.diagnostics.map((entry) => entry.path), [
      "invalid/misplaced-future.py",
      "invalid/module-return.py"
    ]);
    assert.deepEqual(result.diagnostics.map((entry) => entry.code), ["PY_SYNTAX_ERROR", "PY_SYNTAX_ERROR"]);
    assert.ok(result.diagnostics.every((entry) => entry.line >= 1 && entry.column >= 1));
    assert.ok(result.diagnostics.every((entry) => entry.tool?.name === "python" && entry.tool.version));
  });

  it("normalizes indentation, null-byte, and unterminated compiler failures with ranges", async () => {
    const result = await runner({
      files: {
        "pkg/a-indent.py": "if True:\npass\n",
        "pkg/b-null.py": "value = 1\0\n",
        "pkg/c-string.pyi": "value: str = 'unterminated\n"
      }
    }).runValidation(
      request({
        checks: [PYTHON_SYNTAX_CHECK_ID],
        scope: { kind: "files", files: ["pkg/c-string.pyi", "pkg/b-null.py", "pkg/a-indent.py"] }
      })
    );

    assert.deepEqual(result.diagnostics.map((entry) => entry.code), [
      "PY_INDENTATION_ERROR",
      "PY_NULL_BYTE",
      "PY_SYNTAX_ERROR"
    ]);
    assert.equal(result.diagnostics[0].line, 2);
    assert.equal(result.diagnostics[0].column, 1);
    assert.equal(result.diagnostics[2].line, 1);
    assert.equal(result.diagnostics[2].endLine, 1);
  });

  it("preserves exact overlay after-state semantics for corrected, new, and deleted Python files", async () => {
    const corrected = await runner({ files: { "pkg/app.py": "return 1\n" } }).runValidation(
      request({
        overlays: [{ path: "pkg/app.py", action: "write", content: "value = 1\n" }]
      })
    );
    const introduced = await runner({ files: { "pkg/app.py": "value = 1\n" } }).runValidation(
      request({
        scope: { kind: "files", files: ["pkg/app.py"] },
        overlays: [
          { path: "pkg/new.py", action: "write", content: "break\n" },
          { path: "pkg/new.pyi", action: "write", content: "if True\n    ...\n" }
        ]
      })
    );
    const deleted = await runner({ files: { "pkg/app.py": "return 1\n", "pkg/valid.py": "value = 1\n" } }).runValidation(
      request({
        scope: { kind: "files", files: ["pkg/app.py", "pkg/valid.py"] },
        overlays: [{ path: "pkg/app.py", action: "delete" }]
      })
    );

    assert.equal(corrected.status, "passed");
    assert.equal(deleted.status, "passed");
    assert.equal(introduced.status, "policy_failure");
    assert.deepEqual(introduced.diagnostics.map((entry) => entry.path), ["pkg/new.py", "pkg/new.pyi"]);
  });

  it("executes the exact interpreter selected by the project resolver", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-exact-interpreter-"));
    try {
      const shimPath = writePythonProtocolShim(repoRoot, [
        `printf 'compiler' > '${join(repoRoot, "compiler-called")}'`,
        protocolResponse("SHIM_PATH", [{ path: "pkg/app.py", status: "passed" }])
      ]);
      replaceShimPlaceholder(shimPath);
      const result = await runner({
        files: { "pkg/app.py": "value = 1\n" },
        checks: createPythonValidationChecks({ repoRoot })
      }).runValidation(request({ repo: { repoRoot } }));

      assert.equal(result.status, "passed");
      assert.equal(readFileSync(join(repoRoot, "compiler-called"), "utf8"), "compiler");
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("fails closed for nonzero, malformed, timeout, signal, and incomplete compiler protocol states", async () => {
    const cases = [
      {
        name: "nonzero",
        branch: [protocolResponse("SHIM_PATH", [{ path: "pkg/app.py", status: "passed" }]), "exit 7"],
        outcome: "tool_failure"
      },
      { name: "malformed", branch: ["printf 'not-json\\n'"], outcome: "tool_failure" },
      { name: "timeout", branch: ["/bin/sleep 1"], outcome: "timeout", timeoutMs: 20 },
      { name: "signal", branch: ["kill -TERM $$"], outcome: "tool_failure" },
      { name: "incomplete", branch: [protocolResponse("SHIM_PATH", [])], outcome: "tool_failure" }
    ];
    for (const testCase of cases) {
      const repoRoot = mkdtempSync(join(tmpdir(), `opcore-python-protocol-${testCase.name}-`));
      try {
        const shimPath = writePythonProtocolShim(repoRoot, testCase.branch);
        replaceShimPlaceholder(shimPath);
        const result = await runner({
          files: { "pkg/app.py": "value = 1\n" },
          checks: createPythonValidationChecks({
            repoRoot,
            env: { PATH: "" },
            timeoutMs: testCase.timeoutMs
          })
        }).runValidation(request({ repo: { repoRoot } }));
        assert.equal(result.status, "infrastructure_failure", testCase.name);
        assert.equal(result.manifest.runs[0].outcome, testCase.outcome, testCase.name);
        assert.equal(result.diagnostics[0].category, "infrastructure", testCase.name);
      } finally {
        rmSync(repoRoot, { recursive: true, force: true });
      }
    }
  });

  it("normalizes compiler recursion and overflow protocol findings", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-compiler-limits-"));
    try {
      const shimPath = writePythonProtocolShim(repoRoot, [
        protocolResponse("SHIM_PATH", [
          { path: "pkg/a.py", status: "finding", error: { kind: "recursion_error", message: "recursion limit" } },
          { path: "pkg/b.pyi", status: "finding", error: { kind: "overflow_error", message: "compiler overflow" } }
        ])
      ]);
      replaceShimPlaceholder(shimPath);
      const result = await runner({
        files: { "pkg/a.py": "value = 1\n", "pkg/b.pyi": "value: int\n" },
        checks: createPythonValidationChecks({ repoRoot, env: { PATH: "" } })
      }).runValidation(
        request({ repo: { repoRoot }, scope: { kind: "files", files: ["pkg/b.pyi", "pkg/a.py"] } })
      );

      assert.deepEqual(result.diagnostics.map((entry) => entry.code), [
        "PY_COMPILER_RECURSION_ERROR",
        "PY_COMPILER_OVERFLOW_ERROR"
      ]);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("reports invalid and incompatible declared target versions explicitly", async () => {
    const resolved = resolvePythonInterpreter({ repoRoot: process.cwd() });
    assert.equal(resolved.outcome, "resolved");
    const [major, minor] = resolved.version.split(".").map(Number);
    const incompatibleTarget = `${major}.${minor + 1}`;
    const invalid = await runner({
      checks: createPythonValidationChecks({ targetPythonVersion: "3.x" })
    }).runValidation(request());
    const unsupported = await runner({
      checks: createPythonValidationChecks({ pythonCommand: resolved.command, targetPythonVersion: incompatibleTarget })
    }).runValidation(request());

    assert.equal(invalid.status, "unsupported_request");
    assert.equal(invalid.manifest.runs[0].outcome, "invalid_config");
    assert.equal(unsupported.status, "unsupported_request");
    assert.equal(unsupported.manifest.runs[0].outcome, "unsupported_target");
  });

  it("accepts syntax available only in the selected newer interpreter", async (t) => {
    const resolved = resolvePythonInterpreter({ repoRoot: process.cwd() });
    assert.equal(resolved.outcome, "resolved");
    const [major, minor] = resolved.version.split(".").map(Number);
    if (major < 3 || (major === 3 && minor < 14)) {
      t.skip(`selected Python ${resolved.version} does not support t-strings`);
      return;
    }
    const result = await runner({
      files: { "pkg/app.py": "value = t'hello'\n" },
      checks: createPythonValidationChecks({
        pythonCommand: resolved.command,
        targetPythonVersion: `${major}.${minor}`
      })
    }).runValidation(request());
    assert.equal(result.status, "passed");
  });

  it("fails python.types when a nonzero checker result contains no parseable diagnostics", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-types-malformed-"));
    try {
      writeToolShim(repoRoot, "mypy", "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'mypy 1.8.0'; exit 0; fi\necho 'unknown failure'\nexit 1\n");
      const result = await runner({
        files: { "pkg/app.py": "value: int = 1\n" },
        checks: createPythonValidationChecks({ repoRoot, env: { PATH: "" } })
      }).runValidation(request({ repo: { repoRoot }, checks: [PYTHON_TYPES_CHECK_ID] }));

      assert.equal(result.status, "infrastructure_failure");
      assert.equal(result.manifest.runs[0].outcome, "tool_failure");
      assert.deepEqual(result.diagnostics.map((entry) => entry.code), ["PYTHON_TYPES_TOOL_FAILED"]);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("reports source-hygiene diagnostics from overlay after-state content", async () => {
    const result = await runner({
      files: {
        "pkg/app.py": "value = 1\n"
      }
    }).runValidation(
      request({
        checks: [PYTHON_SOURCE_HYGIENE_CHECK_ID],
        overlays: [
          {
            path: "pkg/app.py",
            action: "write",
            content: ["# type: ignore", "# noqa", "# fmt: off", "value = 1", ""].join("\n")
          }
        ]
      })
    );

    assert.equal(result.status, "policy_failure");
    assert.deepEqual(
      result.diagnostics.map((diagnostic) => diagnostic.code),
      ["PY_SOURCE_FORMATTER_DISABLED", "PY_SOURCE_NOQA_BROAD", "PY_SOURCE_TYPE_IGNORE"]
    );
  });

  it("reports missing Python IMPORTS_FROM graph edges for resolved repo imports", async () => {
    const result = await runner({
      files: {
        "pkg/app.py": "from .dep import value\nresult = value\n",
        "pkg/dep.py": "value = 1\n"
      },
      graphProviderClient: graphClient({
        factQuery: (query) => availableFactResult(query, [], [])
      })
    }).runValidation(
      request({
        checks: [PYTHON_IMPORT_GRAPH_CHECK_ID],
        scope: { kind: "files", files: ["pkg/app.py"] }
      })
    );

    assert.equal(result.status, "passed");
    assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), ["PY_IMPORT_GRAPH_MISSING_EDGE"]);
    assert.match(result.diagnostics[0].message, /pkg\/app\.py -> pkg\/dep\.py/);
  });

  it("reports exported callable Python symbols without incoming CALLS as unused exports", async () => {
    const result = await runner({
      files: {
        "pkg/app.py": "def public_api():\n    return 1\n"
      },
      graphProviderClient: graphClient({
        factQuery: (query) =>
          availableFactResult(
            query,
            query.selector.kind === "symbols"
              ? [
                  {
                    id: "function:pkg/app.py#public_api",
                    kind: "Function",
                    path: "pkg/app.py",
                    name: "public_api",
                    attributes: { exported: true, exportPolicy: "leading-underscore" }
                  }
                ]
              : [],
            []
          )
      })
    }).runValidation(
      request({
        checks: [PYTHON_DEAD_CODE_CHECK_ID]
      })
    );

    assert.equal(result.status, "passed");
    assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), ["PY_DEAD_CODE_UNUSED_EXPORT"]);
  });

  it("reports unsupported Python dead-code coverage when export metadata is absent", async () => {
    const result = await runner({
      files: {
        "pkg/app.py": "def public_api():\n    return 1\n"
      },
      graphProviderClient: graphClient({
        factQuery: (query) =>
          availableFactResult(
            query,
            query.selector.kind === "symbols"
              ? [
                  {
                    id: "function:pkg/app.py#public_api",
                    kind: "Function",
                    path: "pkg/app.py",
                    name: "public_api",
                    attributes: {}
                  }
                ]
              : [],
            []
          )
      })
    }).runValidation(
      request({
        checks: [PYTHON_DEAD_CODE_CHECK_ID]
      })
    );

    assert.equal(result.status, "passed");
    assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), ["PY_DEAD_CODE_UNSUPPORTED"]);
  });

  it("finds relevant Python tests from TESTED_BY graph endpoints", async () => {
    const result = await runner({
      files: {
        "pkg/app.py": "def public_api():\n    return 1\n"
      },
      graphProviderClient: graphClient({
        factQuery: (query) =>
          availableFactResult(
            query,
            [],
            query.selector.kind === "edges" && query.selector.edgeKinds?.includes("TESTED_BY")
              ? [
                  {
                    kind: "TESTED_BY",
                    from: "function:pkg/app.py#public_api",
                    to: "test:tests/test_app.py#test_public_api"
                  }
                ]
              : []
          )
      })
    }).runValidation(
      request({
        checks: [PYTHON_RELEVANT_TESTS_CHECK_ID]
      })
    );

    assert.equal(result.status, "passed");
    assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), ["PY_RELEVANT_TESTS_FOUND"]);
  });

  it("passes clean Python validation fixture checks", async () => {
    const result = await runner({
      files: fixtureFiles("clean"),
      graphProviderClient: graphClient({
        factQuery: (query) =>
          availableFactResult(
            query,
            [],
            query.selector.kind === "edges" && query.selector.edgeKinds?.includes("IMPORTS_FROM")
              ? [
                  {
                    kind: "IMPORTS_FROM",
                    from: "file:pkg/app.py",
                    to: "file:pkg/dep.py"
                  }
                ]
              : []
          )
      })
    }).runValidation(
      request({
        checks: [PYTHON_SYNTAX_CHECK_ID, PYTHON_SOURCE_HYGIENE_CHECK_ID, PYTHON_IMPORT_GRAPH_CHECK_ID],
        scope: { kind: "files", files: ["pkg/app.py", "pkg/dep.py"] }
      })
    );

    assert.equal(result.status, "passed");
    assert.deepEqual(result.diagnostics, []);
  });

  it("reports syntax, hygiene, and import graph diagnostics from failing Python validation fixture", async () => {
    const result = await runner({
      files: fixtureFiles("failing"),
      graphProviderClient: graphClient({
        factQuery: (query) => availableFactResult(query, [], [])
      })
    }).runValidation(
      request({
        checks: [PYTHON_SYNTAX_CHECK_ID, PYTHON_SOURCE_HYGIENE_CHECK_ID, PYTHON_IMPORT_GRAPH_CHECK_ID],
        scope: { kind: "files", files: ["pkg/app.py", "pkg/dep.py"] }
      })
    );

    assert.equal(result.status, "policy_failure");
    assert.deepEqual(
      result.diagnostics.map((diagnostic) => diagnostic.code).sort(),
      ["PY_IMPORT_GRAPH_MISSING_EDGE", "PY_SOURCE_TYPE_IGNORE", "PY_SYNTAX_ERROR"]
    );
  });

  it("reports degraded Python type tooling from degraded-tools validation fixture", async () => {
    const result = await runner({
      files: fixtureFiles("degraded-tools"),
      checks: createPythonValidationChecks({ env: { PATH: "" } })
    }).runValidation(
      request({
        checks: [PYTHON_TYPES_CHECK_ID],
        scope: { kind: "files", files: ["pkg/app.py"] }
      })
    );

    assert.equal(result.status, "unsupported_request");
    assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), ["PYTHON_TYPES_UNSUPPORTED"]);
  });
});

describe("python toolchain resolver", () => {
  it("resolves an available tool from PATH when no repo-local venv exists", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-resolver-path-"));
    try {
      const resolution = resolvePythonTool("python", "node", ["--version"], {
        repoRoot,
        env: { PATH: process.env.PATH }
      });
      assert.equal(resolution.available, true);
      assert.equal(resolution.source, "path");
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("resolves a repo-local .venv/bin executable before falling back to PATH", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-resolver-venv-"));
    try {
      const venvBin = join(repoRoot, ".venv", "bin");
      mkdirSync(venvBin, { recursive: true });
      const shimPath = join(venvBin, "mypy");
      writeFileSync(shimPath, "#!/bin/sh\necho 'mypy 1.0.0 (compiled: yes)'\nexit 0\n");
      chmodSync(shimPath, 0o755);

      const resolution = resolvePythonTool("mypy", "mypy", ["--version"], {
        repoRoot,
        env: { PATH: "" }
      });
      assert.equal(resolution.available, true);
      assert.equal(resolution.source, "repo-venv");
      assert.ok(resolution.command.endsWith(join(".venv", "bin", "mypy")));
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("reports a missing tool as unavailable with a failure message", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-resolver-missing-"));
    try {
      const resolution = resolvePythonTool("mypy", "mypy", ["--version"], {
        repoRoot,
        env: { PATH: "" }
      });
      assert.equal(resolution.available, false);
      assert.equal(resolution.source, "path");
      assert.ok(resolution.failureMessage);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("prefers pyproject.toml when no tool-specific config exists", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-resolver-config-"));
    try {
      writeFileSync(join(repoRoot, "pyproject.toml"), "[tool.mypy]\n");
      const configFile = findPythonConfigFile(repoRoot, "mypy");
      assert.equal(configFile, join(repoRoot, "pyproject.toml"));
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("prefers a tool-specific config file over pyproject.toml", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-resolver-config-specific-"));
    try {
      writeFileSync(join(repoRoot, "pyproject.toml"), "[tool.mypy]\n");
      writeFileSync(join(repoRoot, "mypy.ini"), "[mypy]\n");
      const configFile = findPythonConfigFile(repoRoot, "mypy");
      assert.equal(configFile, join(repoRoot, "mypy.ini"));
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

function runner(options = {}) {
  return createValidationRunner({
    workspace: workspace(options),
    checks: options.checks ?? createPythonValidationChecks(),
    graphProviderClient: options.graphProviderClient
  });
}

function request(overrides = {}) {
  return {
    requestId: "validation-python-1",
    repo: {
      repoId: "opcore-python-test"
    },
    scope: {
      kind: "files",
      files: ["pkg/app.py"]
    },
    graph: {
      mode: "optional",
      provider: "opcore-graph"
    },
    overlays: [],
    checks: [PYTHON_SYNTAX_CHECK_ID],
    ...overrides
  };
}

function workspace(options = {}) {
  const files = new Map(Object.entries(options.files ?? { "pkg/app.py": "value = 1\n" }));
  return {
    readFile: (path) => (files.has(path) ? { status: "found", content: files.get(path) } : { status: "missing" }),
    listChangedFiles: () => ({ files: [...files.keys()] }),
    listStagedFiles: () => ({ files: [...files.keys()] }),
    listRepoFiles: () => ({ files: [...files.keys()] }),
    listPackageFiles: (_packageName, packageRoot) => ({
      files: [...files.keys()].filter((path) => path.startsWith(`${packageRoot}/`))
    })
  };
}

function fixtureFiles(name) {
  const root = join(validationFixtureRoot, name);
  const entries = {};
  for (const path of walkFiles(root)) {
    const fixturePath = relative(root, path).replaceAll("\\", "/");
    entries[fixturePath.endsWith(".fixture") ? fixturePath.slice(0, -".fixture".length) : fixturePath] = readFileSync(path, "utf8");
  }
  return entries;
}

function walkFiles(root) {
  const paths = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) paths.push(...walkFiles(path));
    else if (entry.isFile()) paths.push(path);
  }
  return paths.sort();
}

function writeToolShim(repoRoot, name, content) {
  const bin = join(repoRoot, ".venv", "bin");
  mkdirSync(bin, { recursive: true });
  const shimPath = join(bin, name);
  writeFileSync(shimPath, content);
  chmodSync(shimPath, 0o755);
}

function writePythonProtocolShim(repoRoot, compilerBranch) {
  const bin = join(repoRoot, ".venv", "bin");
  mkdirSync(bin, { recursive: true });
  const shimPath = join(bin, "python");
  writeFileSync(
    shimPath,
    [
      "#!/bin/sh",
      "case \"$4\" in",
      "  *opcore.python.interpreter.v1*)",
      protocolResponse("SHIM_PATH", undefined),
      "    ;;",
      "  *opcore.python.compile.v1*)",
      ...compilerBranch,
      "    ;;",
      "  *) exit 9 ;;",
      "esac",
      ""
    ].join("\n")
  );
  chmodSync(shimPath, 0o755);
  return shimPath;
}

function protocolResponse(executable, results) {
  const payload = results === undefined
    ? { protocol: "opcore.python.interpreter.v1", executable, version: "3.12.13" }
    : {
        protocol: "opcore.python.compile.v1",
        interpreter: { executable, version: "3.12.13" },
        results
      };
  return `printf '%s\\n' '${JSON.stringify(payload)}'`;
}

function replaceShimPlaceholder(shimPath) {
  writeFileSync(shimPath, readFileSync(shimPath, "utf8").replaceAll("SHIM_PATH", shimPath));
}

function graphClient(overrides = {}) {
  return {
    status: (validationRequest) => availableStatus(validationRequest.graph.mode, validationRequest.repo),
    factQuery: (query) => availableFactResult(query, [], []),
    namedQuery: () => {
      throw new Error("unexpected namedQuery");
    },
    impact: () => {
      throw new Error("unexpected impact");
    },
    reviewContext: () => {
      throw new Error("unexpected reviewContext");
    },
    detectChanges: () => {
      throw new Error("unexpected detectChanges");
    },
    ...overrides
  };
}

function availableStatus(mode = "optional", repo = { repoId: "opcore-python-test" }) {
  return {
    state: "available",
    mode,
    provider: "opcore-graph",
    schemaVersion: 1,
    repo,
    freshness: freshness(),
    nodes_by_kind: {},
    edges_by_kind: {}
  };
}

function availableFactResult(query, nodes, edges, metadataOverrides = {}) {
  return {
    requestId: query.requestId,
    status: availableStatus(query.mode, query.repo),
    metadata: {
      schemaVersion: 1,
      provider: "opcore-graph",
      repo: query.repo,
      generatedAt: "2026-06-05T00:00:00.000Z",
      freshness: freshness(),
      nodeKinds: ["File", "Module", "Class", "Function", "Variable"],
      edgeKinds: ["IMPORTS_FROM", "CALLS", "TESTED_BY"],
      ...metadataOverrides
    },
    nodes,
    edges
  };
}

function freshness(overrides = {}) {
  return {
    generatedAt: "2026-06-05T00:00:00.000Z",
    ageMs: 0,
    stale: false,
    ...overrides
  };
}
