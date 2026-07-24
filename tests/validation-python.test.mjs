import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createValidationCheckRegistry, createValidationGraphQuerySession, createValidationRunner } from "../packages/validation/dist/index.js";
import { validationChecksForRepoPolicy } from "../packages/validation-policy/dist/index.js";
import {
  PYTHON_DEAD_CODE_CHECK_ID,
  PYTHON_IMPORT_GRAPH_CHECK_ID,
  PYTHON_RELEVANT_TESTS_CHECK_ID,
  PYTHON_RUFF_FORMAT_CHECK_ID,
  PYTHON_RUFF_LINT_CHECK_ID,
  PYTHON_SOURCE_HYGIENE_CHECK_ID,
  PYTHON_SYNTAX_CHECK_ID,
  PYTHON_TYPES_CHECK_ID,
  createPythonValidationAdapterStatus,
  createPythonValidationChecks as createCanonicalPythonValidationChecks,
  createNodePythonProjectWorkspace,
  createValidationFileViewPythonWorkspace,
  createSyntaxCheck,
  createTypeCheck,
  isPythonSourcePath,
  resolvePythonProjectContext,
  resolvePythonProjectContexts,
  validationPythonAdapterName
} from "../packages/validation-python/dist/index.js";
import { runTool } from "../packages/validation-python/dist/process.js";
import { ruffCommandArgs } from "../packages/validation-python/dist/ruff-execution.js";

const repoRoot = dirname(fileURLToPath(import.meta.url));
const validationFixtureRoot = join(repoRoot, "../packages/fixtures/validation-python");
const sourceExtractionPythonFixtureRoot = join(repoRoot, "../packages/fixtures/source-extraction/python");
const sourceExtractionPythonExpected = JSON.parse(
  readFileSync(join(sourceExtractionPythonFixtureRoot, "python.expected.json"), "utf8")
);

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

  it("keeps mypy-authority fixture resources out of repository Python source discovery", () => {
    const fixturePaths = walkFiles(join(validationFixtureRoot, "mypy-authority"));
    assert.ok(fixturePaths.length > 0);
    assert.ok(fixturePaths.every((path) => !isPythonSourcePath(path)));
    assert.deepEqual(Object.keys(fixtureFiles("mypy-authority")).sort(), [
      "pyproject.toml",
      "src/acme/__init__.py",
      "src/acme/app.py",
      "src/acme/mypy_plugin.py",
      "src/acme/plugin_support.py",
      "src/acme/widget.py",
      "stubs/external/__init__.pyi"
    ]);
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
        PYTHON_RUFF_LINT_CHECK_ID,
        PYTHON_RUFF_FORMAT_CHECK_ID,
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

  it("places canonical explicit Ruff config overrides after the subcommand", () => {
    const baseTool = {
      tool: "ruff",
      available: true,
      executable: "/usr/bin/ruff",
      configFile: "pkg/ruff.toml",
      cwd: "/repo/pkg",
      source: "explicit_override"
    };
    assert.deepEqual(
      ruffCommandArgs(
        { ...baseTool, argv: ["/usr/bin/ruff", "--config", "pkg/ruff.toml"] },
        { projectRoot: "pkg", repositoryRoot: "/repo" },
        "check",
        ["app.py"]
      ),
      ["check", "--config", "ruff.toml", "app.py"]
    );
    assert.deepEqual(
      ruffCommandArgs(
        {
          ...baseTool,
          configFile: "ruff.toml",
          argv: ["/usr/bin/ruff", "--config=../../ruff.toml"]
        },
        { projectRoot: "services/api", repositoryRoot: "/repo" },
        "format",
        ["--check", "app.py"]
      ),
      ["format", "--config", "../../ruff.toml", "--check", "app.py"]
    );
  });

  it("fails syntax and type checks closed when no canonical context resolver is injected", async () => {
    for (const check of [createSyntaxCheck(), createTypeCheck()]) {
      const result = await runner({ files: { "app.py": "VALUE = 1\n" }, checks: [check] }).runValidation(request({
        checks: [check.id],
        scope: { kind: "files", files: ["app.py"] }
      }));
      assert.equal(result.status, "infrastructure_failure", check.id);
      assert.match(result.diagnostics[0].message, /canonical python project context/i, check.id);
    }
  });

  it("fails every target context closed before grouping targets by project", async () => {
    const files = {
      "pyproject.toml": "[project]\nname='fixture'\n",
      "a.py": "VALUE = 1\n",
      "z.py": "VALUE = 2\n"
    };
    for (const checkId of [PYTHON_SYNTAX_CHECK_ID, PYTHON_TYPES_CHECK_ID]) {
      const result = await runner({
        files,
        checks: createPythonValidationChecks({
          env: { PATH: "/fixture/bin" },
          nodeWorkspace: projectWorkspace(files, () => true, new Set(["z.py"])),
          processProbe: successfulProbe()
        })
      }).runValidation(request({
        repo: { repoRoot: "/fixture" },
        checks: [checkId],
        scope: { kind: "files", files: ["a.py", "z.py"] }
      }));

      assert.notEqual(result.status, "passed", checkId);
      assert.deepEqual(result.pythonProjectContexts.map((context) => [context.target, context.outcome]), [
        ["a.py", "resolved"],
        ["z.py", "ambiguous"]
      ]);
      assert.equal(result.diagnostics.some((diagnostic) => diagnostic.path === "z.py"), true, `${checkId}: ${JSON.stringify(result)}`);
    }
  });

  it("reports missing Python type tooling as degraded instead of a silent pass", async () => {
    const env = { PATH: "" };
    const isolatedRepoRoot = mkdtempSync(join(tmpdir(), "opcore-python-adapter-status-"));
    try {
      const status = createPythonValidationAdapterStatus({ env, repoRoot: isolatedRepoRoot });
      assert.equal(status.status, "degraded");
      assert.equal(status.degradedChecks?.[0]?.checkId, PYTHON_TYPES_CHECK_ID);
      assert.equal(status.degradedChecks?.[0]?.requiredTool, "configured Python type authority");
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
    assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), ["PYTHON_TYPES_UNSUPPORTED_TARGET"]);
    assert.equal(result.pythonCapabilityRuns[0].status, "unsupported_target");
  });

  it("executes repo-local mypy and maps type diagnostics", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-types-mypy-"));
    try {
      writePassingPythonProtocolShim(repoRoot);
      writeToolShim(
        repoRoot,
        "mypy",
        [
          "#!/bin/sh",
          "if [ \"$1\" = \"--version\" ]; then echo 'mypy 1.8.0'; exit 0; fi",
          "echo '{\"file\":\"pkg/app.py\",\"line\":1,\"column\":0,\"message\":\"Incompatible types in assignment\",\"hint\":null,\"code\":\"assignment\",\"severity\":\"error\"}'",
          "exit 1",
          ""
        ].join("\n")
      );

      const result = await runner({
        files: {
          "pkg/app.py": "value: int = 'wrong'\n"
        },
        checks: createPythonValidationChecks({ env: { PATH: "" }, repoRoot, checker: "mypy" })
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
      assert.equal(result.diagnostics[0].tool.command.startsWith("repo:.venv/bin/mypy"), true);
      assert.equal(result.pythonCapabilityRuns[0].tool.executable, "repo:.venv/bin/mypy");
      assert.equal(result.pythonCapabilityRuns[0].tool.argv[0], "repo:.venv/bin/mypy");
      assert.equal(result.pythonCapabilityRuns[0].tool.cwd, ".");
      assert.equal(result.pythonCapabilityRuns[0].tool.source, "project_local_environment");
      assert.equal(result.pythonCapabilityRuns[0].tool.version, "1.8.0");
      assert.match(result.pythonCapabilityRuns[0].projectKey, /^sha256:[a-f0-9]{64}$/u);
      assert.match(result.pythonCapabilityRuns[0].contextFingerprint, /^sha256:[a-f0-9]{64}$/u);
      assert.match(result.pythonCapabilityRuns[0].afterStateManifestFingerprint, /^sha256:[a-f0-9]{64}$/u);
      assert.equal(JSON.stringify(result.pythonCapabilityRuns).includes(repoRoot), false);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("materializes canonical transitive imports through the owning project's source roots", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-types-source-root-"));
    try {
      const projectRoot = join(repoRoot, "services/api");
      mkdirSync(projectRoot, { recursive: true });
      writePassingPythonProtocolShim(projectRoot);
      writeToolShim(
        projectRoot,
        "mypy",
        [
          "#!/bin/sh",
          "if [ \"$1\" = \"--version\" ]; then echo 'mypy 1.8.0'; exit 0; fi",
          "if [ -f ../__init__.py ] || [ -f ../leak.py ]; then echo 'initializer ascent escaped the source root' >&2; exit 9; fi",
          "if [ ! -f src/acme/__init__.py ]; then echo 'package initializer was not materialized' >&2; exit 9; fi",
          "if [ ! -f src/acme/models.py ]; then echo 'initializer dependency was not materialized' >&2; exit 9; fi",
          "if [ ! -f src/acme/mid.py ]; then echo 'direct dependency was not materialized' >&2; exit 9; fi",
          "if [ ! -f src/acme/dep.py ]; then echo 'transitive dependency was not materialized' >&2; exit 9; fi",
          "if [ ! -f ../../libs/shared/src/shared/__init__.py ]; then echo 'cross-project initializer was not materialized' >&2; exit 9; fi",
          "if [ ! -f ../../libs/shared/src/shared/bootstrap.py ]; then echo 'cross-project initializer dependency was not materialized' >&2; exit 9; fi",
          "exit 0",
          ""
        ].join("\n")
      );
      const files = {
        "services/__init__.py": "from . import leak\n",
        "services/leak.py": "VALUE = 'outside source root'\n",
        "libs/shared/pyproject.toml": "[project]\nname='shared'\n",
        "libs/shared/src/shared/__init__.py": "from . import bootstrap\n",
        "libs/shared/src/shared/bootstrap.py": "READY = True\n",
        "libs/shared/src/shared/models.py": "class SharedModel: pass\n",
        "services/api/pyproject.toml": "[project]\nname='api'\n[tool.mypy]\n",
        "services/api/src/acme/__init__.py": "from .models import Model\n",
        "services/api/src/acme/ns/app.py": "from acme import (\n    mid,\n)\nfrom shared import models as shared_models\nVALUE = mid.VALUE\n",
        "services/api/src/acme/mid.py": "from acme import dep\nVALUE = dep.VALUE\n",
        "services/api/src/acme/dep.py": "VALUE: int = 1\n",
        "services/api/src/acme/models.py": "class Model: pass\n"
      };
      const result = await runner({
        files,
        checks: createPythonValidationChecks({
          repoRoot,
          env: { PATH: "" },
          importAnalyzer: fixedImportAnalyzer([
            { fromPath: "services/__init__.py", toPath: "services/leak.py" },
            { fromPath: "services/api/src/acme/ns/app.py", toPath: "services/api/src/acme/mid.py" },
            { fromPath: "services/api/src/acme/ns/app.py", toPath: "libs/shared/src/shared/models.py" },
            { fromPath: "services/api/src/acme/mid.py", toPath: "services/api/src/acme/dep.py" },
            { fromPath: "services/api/src/acme/__init__.py", toPath: "services/api/src/acme/models.py" },
            { fromPath: "libs/shared/src/shared/__init__.py", toPath: "libs/shared/src/shared/bootstrap.py" },
          ]),
          nodeWorkspace: projectWorkspace(files, () => true)
        })
      }).runValidation(request({
        repo: { repoRoot },
        checks: [PYTHON_TYPES_CHECK_ID],
        scope: { kind: "files", files: ["services/api/src/acme/ns/app.py"] }
      }));

      if (result.status !== "passed") throw new Error(JSON.stringify(result, null, 2));
      assert.equal(result.pythonProjectContexts[0].projectRoot, "services/api");
      assert.deepEqual(result.pythonProjectContexts[0].sourceRoots, ["services/api/src"]);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("materializes multiline-configured plugins and their graph-owned transitive imports", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-types-plugin-closure-"));
    try {
      writePassingPythonProtocolShim(repoRoot);
      writeToolShim(repoRoot, "mypy", [
        "#!/bin/sh",
        "if [ \"$1\" = \"--version\" ]; then echo 'mypy 2.3.0'; exit 0; fi",
        "if [ ! -f src/acme/plugin.py ]; then echo 'plugin missing' >&2; exit 91; fi",
        "if [ ! -f src/acme/plugin_helper.py ]; then echo 'plugin helper missing' >&2; exit 92; fi",
        "case \"$PYTHONPATH\" in *\"$PWD/src\"*) ;; *) echo 'source root absent from isolated PYTHONPATH' >&2; exit 93;; esac",
        "exit 0",
        ""
      ].join("\n"));
      const files = {
        "mypy.ini": "[mypy]\nplugins =\n    acme.plugin\nmypy_path =\n    src\n",
        "src/acme/__init__.py": "",
        "src/acme/app.py": "VALUE: int = 1\n",
        "src/acme/plugin.py": "from acme import plugin_helper\n",
        "src/acme/plugin_helper.py": "READY = True\n"
      };
      const result = await runner({
        files,
        checks: createPythonValidationChecks({
          repoRoot,
          env: { PATH: "" },
          importAnalyzer: fixedImportAnalyzer([
            { fromPath: "src/acme/plugin.py", toPath: "src/acme/plugin_helper.py" }
          ]),
          nodeWorkspace: projectWorkspace(files, () => true)
        })
      }).runValidation(request({
        repo: { repoRoot },
        checks: [PYTHON_TYPES_CHECK_ID],
        scope: { kind: "files", files: ["src/acme/app.py"] }
      }));

      assert.equal(result.status, "passed", JSON.stringify(result, null, 2));
      assert.deepEqual(result.pythonCapabilityRuns[0].selectedSourcePaths, [
        "src/acme/__init__.py",
        "src/acme/app.py",
        "src/acme/plugin.py",
        "src/acme/plugin_helper.py"
      ]);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("maps nested-project type diagnostics to repository-relative paths", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-types-nested-path-"));
    try {
      const projectRoot = join(repoRoot, "services/api");
      mkdirSync(projectRoot, { recursive: true });
      writePassingPythonProtocolShim(projectRoot);
      writeToolShim(
        projectRoot,
        "mypy",
        [
          "#!/bin/sh",
          "if [ \"$1\" = \"--version\" ]; then echo 'mypy 1.8.0'; exit 0; fi",
          "echo '{\"file\":\"src/acme/app.py\",\"line\":1,\"column\":0,\"message\":\"nested project type failure\",\"hint\":null,\"code\":\"assignment\",\"severity\":\"error\"}'",
          "exit 1",
          ""
        ].join("\n")
      );
      const files = {
        "services/api/pyproject.toml": "[project]\nname='api'\n[tool.mypy]\n",
        "services/api/src/acme/app.py": "value: int = 'wrong'\n"
      };
      const result = await runner({
        files,
        checks: createPythonValidationChecks({
          repoRoot,
          env: { PATH: "" },
          nodeWorkspace: projectWorkspace(files, () => true)
        })
      }).runValidation(request({
        repo: { repoRoot },
        checks: [PYTHON_TYPES_CHECK_ID],
        scope: { kind: "files", files: ["services/api/src/acme/app.py"] }
      }));

      assert.equal(result.status, "policy_failure");
      assert.equal(result.pythonProjectContexts[0].projectRoot, "services/api");
      assert.equal(result.diagnostics[0].path, "services/api/src/acme/app.py");
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("materializes root imports for flat targets in mixed flat/src projects", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-types-mixed-layout-"));
    try {
      writePassingPythonProtocolShim(repoRoot);
      writeToolShim(
        repoRoot,
        "mypy",
        [
          "#!/bin/sh",
          "if [ \"$1\" = \"--version\" ]; then echo 'mypy 1.8.0'; exit 0; fi",
          "if [ ! -f helper.py ]; then echo 'root dependency was not materialized' >&2; exit 9; fi",
          "exit 0",
          ""
        ].join("\n")
      );
      const files = {
        "pyproject.toml": "[project]\nname='mixed'\n[tool.mypy]\n",
        "script.py": "import helper\nVALUE = helper.VALUE\n",
        "helper.py": "VALUE: int = 1\n",
        "src/pkg/__init__.py": "VALUE = 2\n"
      };
      const result = await runner({
        files,
        checks: createPythonValidationChecks({
          env: { PATH: "" },
          repoRoot,
          importAnalyzer: fixedImportAnalyzer([{ fromPath: "script.py", toPath: "helper.py" }])
        })
      }).runValidation(request({
        repo: { repoRoot },
        checks: [PYTHON_TYPES_CHECK_ID],
        scope: { kind: "files", files: ["script.py"] }
      }));

      assert.equal(result.status, "passed", JSON.stringify(result, null, 2));
      assert.deepEqual(result.pythonProjectContexts[0].sourceRoots, ["."]);
      assert.deepEqual(result.pythonProjectContexts[0].layout, { kinds: ["flat"], paths: ["."] });
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("checks overlay after-state content instead of the original Python file", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-types-overlay-"));
    try {
      writePassingPythonProtocolShim(repoRoot);
      writeToolShim(
        repoRoot,
        "mypy",
        [
          "#!/bin/sh",
          "if [ \"$1\" = \"--version\" ]; then echo 'mypy 1.8.0'; exit 0; fi",
          "for arg in \"$@\"; do target=\"$arg\"; done",
          "if /usr/bin/grep -q \"'wrong'\" \"$target\"; then",
          "  echo '{\"file\":\"pkg/app.py\",\"line\":1,\"column\":0,\"message\":\"overlay type failure\",\"hint\":null,\"code\":\"assignment\",\"severity\":\"error\"}'",
          "  exit 1",
          "fi",
          "exit 0",
          ""
        ].join("\n")
      );

      const result = await runner({
        files: {
          "pkg/app.py": "value: int = 1\n"
        },
        checks: createPythonValidationChecks({ env: { PATH: "" }, repoRoot, checker: "mypy" })
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

  it("executes configured pyright and normalizes machine JSON diagnostics", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-types-pyright-"));
    try {
      writePassingPythonProtocolShim(repoRoot);
      writeFileSync(join(repoRoot, "pyrightconfig.json"), "{}\n");
      writeToolShim(repoRoot, "mypy", "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'mypy 1.8.0'; exit 0; fi\necho 'mypy should not run'; exit 1\n");
      writeToolShim(
        repoRoot,
        "pyright",
        pyrightShim("1.1.0", [{
          file: "pkg/app.py",
          severity: "error",
          message: "Type mismatch\n  Literal is not assignable to int",
          rule: "reportAssignmentType",
          range: { start: { line: 0, character: 13 }, end: { line: 0, character: 20 } }
        }], 1)
      );

      const result = await runner({
        files: {
          "pkg/app.py": "value: int = 'wrong'\n",
          "pyrightconfig.json": "{}\n"
        },
        checks: createPythonValidationChecks({
          env: { PATH: "" },
          repoRoot,
          nodeWorkspace: createNodePythonProjectWorkspace(repoRoot),
          toolArgv: {
            mypy: [join(repoRoot, ".venv", "bin", "mypy")],
            pyright: [join(repoRoot, ".venv", "bin", "pyright")]
          },
        })
      }).runValidation(
        request({
          repo: { repoRoot },
          checks: [PYTHON_TYPES_CHECK_ID]
        })
      );

      assert.equal(result.status, "policy_failure", JSON.stringify(result, null, 2));
      assert.equal(result.diagnostics[0].code, "PYRIGHT_REPORT_ASSIGNMENT_TYPE");
      assert.equal(result.diagnostics[0].path, "pkg/app.py");
      assert.equal(result.diagnostics[0].line, 1);
      assert.equal(result.diagnostics[0].column, 14);
      assert.equal(result.diagnostics[0].message.includes("\n"), true);
      assert.equal(result.pythonCapabilityRuns[0].status, "findings");
      assert.deepEqual(result.pythonCapabilityRuns[0].tool.argv.slice(-5), [
        "--outputjson", "--project", "pyrightconfig.json", "--pythonpath", "repo:.venv/bin/python"
      ]);
      assert.equal(result.pythonProjectContexts[0].tools.find((tool) => tool.tool === "pyright")?.source, "explicit_override");
      assert.equal(result.pythonProjectContexts[0].tools.find((tool) => tool.tool === "pyright")?.configFile, "pyrightconfig.json");
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("executes [tool.pyright] and preserves pyrightconfig.json precedence", async () => {
    for (const testCase of [
      {
        name: "toml",
        files: {
          "pyproject.toml": "[project]\nname='fixture'\n[tool.pyright]\ninclude=['pkg']\n",
          "pkg/app.py": "value: int = 1\n"
        },
        configFile: "pyproject.toml"
      },
      {
        name: "json-precedence",
        files: {
          "pyrightconfig.json": "{}\n",
          "pyproject.toml": "[project]\nname='fixture'\n[tool.pyright]\nstubPath='/tmp/host-stubs'\n",
          "pkg/app.py": "value: int = 1\n"
        },
        configFile: "pyrightconfig.json"
      }
    ]) {
      const repoRoot = mkdtempSync(join(tmpdir(), `opcore-python-pyright-${testCase.name}-`));
      try {
        writePassingPythonProtocolShim(repoRoot);
        writeToolShim(repoRoot, "pyright", pyrightShim("1.1.411", [], 0));
        const result = await runner({
          files: testCase.files,
          checks: createPythonValidationChecks({ repoRoot, env: { PATH: "" }, nodeWorkspace: createNodePythonProjectWorkspace(repoRoot) })
        }).runValidation(request({ repo: { repoRoot }, checks: [PYTHON_TYPES_CHECK_ID] }));

        assert.equal(result.status, "passed", `${testCase.name}: ${JSON.stringify(result, null, 2)}`);
        assert.deepEqual(result.pythonCapabilityRuns[0].selectedConfigPaths, [testCase.configFile]);
        assert.equal(result.pythonCapabilityRuns[0].tool.configFile, testCase.configFile);
        assert.deepEqual(result.pythonCapabilityRuns[0].tool.argv.slice(1, 4), ["--outputjson", "--project", testCase.configFile]);
      } finally {
        rmSync(repoRoot, { recursive: true, force: true });
      }
    }
  });

  it("accepts the canonical repository root in every Pyright path field", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-pyright-root-paths-"));
    try {
      writePassingPythonProtocolShim(repoRoot);
      writeToolShim(repoRoot, "pyright", pyrightShim("1.1.411", [], 0));
      const config = {
        include: ["."],
        exclude: ["."],
        ignore: ["."],
        extraPaths: ["."],
        stubPath: ".",
        typeshedPath: ".",
        venvPath: ".",
        venv: "fixture-env",
        executionEnvironments: [{ root: ".", extraPaths: ["."] }]
      };
      const result = await runner({
        files: {
          "pyrightconfig.json": `${JSON.stringify(config)}\n`,
          "pkg/app.py": "value: int = 1\n"
        },
        checks: createPythonValidationChecks({
          repoRoot,
          env: { PATH: "" },
          nodeWorkspace: createNodePythonProjectWorkspace(repoRoot)
        })
      }).runValidation(request({ repo: { repoRoot }, checks: [PYTHON_TYPES_CHECK_ID] }));

      assert.equal(result.status, "passed", JSON.stringify(result, null, 2));
      assert.equal(result.pythonCapabilityRuns[0].status, "passed");
      assert.deepEqual(result.pythonCapabilityRuns[0].selectedSourcePaths, ["pkg/app.py"]);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("accepts Pyright glob patterns and the repository root without non-file realpath evidence", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-pyright-host-paths-"));
    try {
      writePassingPythonProtocolShim(repoRoot);
      writeToolShim(repoRoot, "pyright", pyrightShim("1.1.411", [], 0));
      const config = {
        include: ["src/**/*.py"],
        exclude: ["**/__pycache__"],
        ignore: ["generated/**"],
        extraPaths: [".", "src"],
        stubPath: "stubs",
        executionEnvironments: [{ root: "src", extraPaths: [".", "stubs"] }]
      };
      const files = {
        "pyrightconfig.json": `${JSON.stringify(config)}\n`,
        "src/app.py": "value: int = 1\n",
        "stubs/external/__init__.pyi": "VALUE: int\n"
      };
      const baseWorkspace = projectWorkspace(files, (path) => existsSync(path));
      const result = await runner({
        files,
        checks: createPythonValidationChecks({
          repoRoot,
          env: { PATH: "" },
          nodeWorkspace: {
            ...baseWorkspace,
            realpath: async (path) => files[path] === undefined
              ? { path, symlink: false, unavailable: true }
              : { path, symlink: false }
          }
        })
      }).runValidation(request({
        repo: { repoRoot },
        checks: [PYTHON_TYPES_CHECK_ID],
        scope: { kind: "files", files: ["src/app.py"] }
      }));

      assert.equal(result.status, "passed", JSON.stringify(result, null, 2));
      assert.equal(result.pythonCapabilityRuns[0].status, "passed");
      assert.equal(result.diagnostics.some((entry) => entry.code === "PYTHON_TYPES_INVALID_CONFIG"), false);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("selects the type checker from overlay after-state config", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-types-overlay-config-"));
    try {
      writePassingPythonProtocolShim(repoRoot);
      writeToolShim(repoRoot, "mypy", "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'mypy 1.8.0'; exit 0; fi\necho 'mypy should not run'; exit 1\n");
      writeToolShim(
        repoRoot,
        "pyright",
        pyrightShim("1.1.0", [{
          file: "pkg/app.py",
          severity: "error",
          message: "overlay config selected Pyright",
          rule: "reportAssignmentType",
          range: { start: { line: 0, character: 13 }, end: { line: 0, character: 20 } }
        }], 1)
      );
      const files = {
        "mypy.ini": "[mypy]\nstrict = true\n",
        "pkg/app.py": "value: int = 'wrong'\n"
      };
      const result = await runner({
        files,
        checks: createPythonValidationChecks({
          env: { PATH: "" },
          repoRoot,
          nodeWorkspace: projectWorkspace(files, () => true)
        })
      }).runValidation(request({
        repo: { repoRoot },
        checks: [PYTHON_TYPES_CHECK_ID],
        overlays: [
          { path: "mypy.ini", action: "delete" },
          { path: "pyrightconfig.json", action: "write", content: "{}\n" }
        ]
      }));

      assert.equal(result.status, "policy_failure", JSON.stringify(result, null, 2));
      assert.equal(result.diagnostics[0].code, "PYRIGHT_REPORT_ASSIGNMENT_TYPE");
      assert.equal(result.pythonCapabilityRuns[0].authority, "pyright", JSON.stringify(result, null, 2));
      assert.equal(result.pythonProjectContexts[0].tools.find((tool) => tool.tool === "pyright")?.configFile, "pyrightconfig.json");
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("switches pyright to mypy from the same exact authority overlay", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-types-overlay-pyright-to-mypy-"));
    try {
      writePassingPythonProtocolShim(repoRoot);
      writeToolShim(repoRoot, "pyright", pyrightShim("1.1.411", [], 0));
      writeToolShim(repoRoot, "mypy", "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'mypy 2.3.0'; exit 0; fi\nexit 0\n");
      const files = { "pyrightconfig.json": "{}\n", "pkg/app.py": "value: int = 1\n" };
      const result = await runner({
        files,
        checks: createPythonValidationChecks({ repoRoot, env: { PATH: "" }, nodeWorkspace: createNodePythonProjectWorkspace(repoRoot) })
      }).runValidation(request({
        repo: { repoRoot },
        checks: [PYTHON_TYPES_CHECK_ID],
        overlays: [
          { path: "pyrightconfig.json", action: "delete" },
          { path: "mypy.ini", action: "write", content: "[mypy]\nstrict = true\n" }
        ]
      }));

      assert.equal(result.status, "passed", JSON.stringify(result, null, 2));
      assert.equal(result.pythonCapabilityRuns[0].authority, "mypy");
      assert.deepEqual(result.pythonCapabilityRuns[0].selectedConfigPaths, ["mypy.ini"]);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("fails pyright machine protocol contradictions and fatal exits closed", async () => {
    const validFinding = pyrightPayload("1.1.411", [{
      file: "pkg/app.py",
      severity: "error",
      message: "assignment failure",
      rule: "reportAssignmentType",
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }
    }]);
    const clean = pyrightPayload("1.1.411", []);
    const deeplyNested = '{"version":"1.1.411","generalDiagnostics":' + "[".repeat(10000) + "0" + "]".repeat(10000) +
      ',"summary":{"filesAnalyzed":1,"errorCount":0,"warningCount":0,"informationCount":0,"timeInSec":0}}';
    const contradictory = pyrightPayload("1.1.411", [
      validFinding.generalDiagnostics[0],
      { ...validFinding.generalDiagnostics[0], severity: "warning" }
    ]);
    const cases = [
      { name: "malformed", body: "printf '{not-json\\n'; exit 1" },
      { name: "truncated", body: `printf '%s' '${JSON.stringify(clean).slice(0, -2)}'; exit 0` },
      { name: "excessively-nested", body: `cat <<'JSON'\n${deeplyNested}\nJSON\nexit 1` },
      { name: "duplicate-key", body: `cat <<'JSON'\n${JSON.stringify(clean).replace('\"version\":\"1.1.411\"', '\"version\":\"1.1.411\",\"version\":\"1.1.411\"')}\nJSON\nexit 0` },
      { name: "version-mismatch", body: `cat <<'JSON'\n${JSON.stringify({ ...clean, version: "1.1.410" })}\nJSON\nexit 0` },
      { name: "summary-mismatch", body: `cat <<'JSON'\n${JSON.stringify({ ...validFinding, summary: { ...validFinding.summary, errorCount: 0 } })}\nJSON\nexit 1` },
      { name: "zero-files", body: `cat <<'JSON'\n${JSON.stringify({ ...clean, summary: { ...clean.summary, filesAnalyzed: 0 } })}\nJSON\nexit 0` },
      { name: "contradictory-diagnostic", body: `cat <<'JSON'\n${JSON.stringify(contradictory)}\nJSON\nexit 1` },
      { name: "out-of-repo", body: `cat <<'JSON'\n${JSON.stringify(pyrightPayload("1.1.411", [{ ...validFinding.generalDiagnostics[0], file: "/tmp/outside.py" }]))}\nJSON\nexit 1` },
      { name: "outside-source-closure", body: `cat <<'JSON'\n${JSON.stringify(pyrightPayload("1.1.411", [{ ...validFinding.generalDiagnostics[0], file: "pkg/missing.py" }]))}\nJSON\nexit 1` },
      { name: "reversed-range", body: `cat <<'JSON'\n${JSON.stringify(pyrightPayload("1.1.411", [{ ...validFinding.generalDiagnostics[0], range: { start: { line: 2, character: 1 }, end: { line: 1, character: 1 } } }]))}\nJSON\nexit 1` },
      { name: "out-of-bounds-range", body: `cat <<'JSON'\n${JSON.stringify(pyrightPayload("1.1.411", [{ ...validFinding.generalDiagnostics[0], range: { start: { line: 99, character: 0 }, end: { line: 99, character: 1 } } }]))}\nJSON\nexit 1` },
      { name: "stderr", body: `cat <<'JSON'\n${JSON.stringify(clean)}\nJSON\necho fatal >&2\nexit 0` },
      { name: "exit-zero-errors", body: `cat <<'JSON'\n${JSON.stringify(validFinding)}\nJSON\nexit 0` },
      { name: "exit-one-empty", body: `cat <<'JSON'\n${JSON.stringify(clean)}\nJSON\nexit 1` },
      { name: "fatal-two", body: `cat <<'JSON'\n${JSON.stringify(clean)}\nJSON\nexit 2` },
      { name: "illegal-four", body: `cat <<'JSON'\n${JSON.stringify(clean)}\nJSON\nexit 4` }
    ];
    for (const testCase of cases) {
      const repoRoot = mkdtempSync(join(tmpdir(), `opcore-python-pyright-${testCase.name}-`));
      try {
        writePassingPythonProtocolShim(repoRoot);
        writeToolShim(repoRoot, "pyright", rawPyrightShim("1.1.411", testCase.body));
        const files = { "pyrightconfig.json": "{}\n", "pkg/app.py": "value: int = 1\n" };
        const before = materializedMypyWorkspaces();
        const result = await runner({
          files,
          checks: createPythonValidationChecks({
            repoRoot,
            env: { PATH: "" },
            nodeWorkspace: createNodePythonProjectWorkspace(repoRoot)
          })
        }).runValidation(request({ repo: { repoRoot }, checks: [PYTHON_TYPES_CHECK_ID] }));
        assert.equal(result.status, "infrastructure_failure", `${testCase.name}: ${JSON.stringify(result, null, 2)}`);
        assert.equal(result.pythonCapabilityRuns.length, 1, testCase.name);
        assert.equal(result.pythonCapabilityRuns[0].status, "tool_failure", testCase.name);
        assert.equal(result.diagnostics.some((entry) => entry.code === "PYTHON_TYPES_TOOL_FAILED"), true, testCase.name);
        assert.deepEqual(materializedMypyWorkspaces(), before, testCase.name);
      } finally {
        rmSync(repoRoot, { recursive: true, force: true });
      }
    }
  });

  it("maps pyright exit 3 to executed invalid_config evidence", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-pyright-config-exit-"));
    try {
      writePassingPythonProtocolShim(repoRoot);
      const payload = pyrightPayload("1.1.411", [{
        file: "pyrightconfig.json",
        severity: "error",
        message: "Invalid configuration",
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }
      }]);
      writeToolShim(repoRoot, "pyright", rawPyrightShim("1.1.411", `cat <<'JSON'\n${JSON.stringify(payload)}\nJSON\necho rejected >&2\nexit 3`));
      const files = { "pyrightconfig.json": "{}\n", "pkg/app.py": "value: int = 1\n" };
      const result = await runner({
        files,
        checks: createPythonValidationChecks({ repoRoot, env: { PATH: "" }, nodeWorkspace: createNodePythonProjectWorkspace(repoRoot) })
      }).runValidation(request({ repo: { repoRoot }, checks: [PYTHON_TYPES_CHECK_ID] }));

      assert.equal(result.status, "unsupported_request", JSON.stringify(result, null, 2));
      assert.equal(result.pythonCapabilityRuns[0].status, "invalid_config");
      assert.deepEqual(result.pythonCapabilityRuns[0].execution, {
        termination: "exited",
        exitCode: 3,
        failureSummary: "pyright rejected selected configuration: pyrightconfig.json"
      });
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("maps pyright timeout, signal, and spawn failures and cleans exact workspaces", async () => {
    const cases = [
      { name: "timeout", body: "/bin/sleep 2", status: "timeout", termination: "timeout", timeoutMs: 500 },
      { name: "signal", body: "kill -TERM $$", status: "tool_failure", termination: "signal" },
      { name: "spawn", body: "exit 0", status: "tool_failure", termination: "spawn_error", removeAfterProbe: true }
    ];
    for (const testCase of cases) {
      const repoRoot = mkdtempSync(join(tmpdir(), `opcore-python-pyright-${testCase.name}-`));
      try {
        writePassingPythonProtocolShim(repoRoot);
        const executable = join(repoRoot, ".venv/bin/pyright");
        writeToolShim(repoRoot, "pyright", testCase.removeAfterProbe
          ? `#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then /bin/rm -- \"$0\"; echo 'pyright 1.1.411'; exit 0; fi\nexit 0\n`
          : rawPyrightShim("1.1.411", testCase.body));
        const files = { "pyrightconfig.json": "{}\n", "pkg/app.py": "value: int = 1\n" };
        const before = materializedMypyWorkspaces();
        const baseProbe = successfulProbe();
        const processProbe = testCase.removeAfterProbe
          ? {
              ...baseProbe,
              async run(command, args, options) {
                const result = await baseProbe.run(command, args, options);
                if (command === executable && args.includes("--version")) rmSync(executable, { force: true });
                return result;
              }
            }
          : baseProbe;
        const result = await runner({
          files,
          checks: createPythonValidationChecks({
            repoRoot,
            env: { PATH: "" },
            timeoutMs: testCase.timeoutMs,
            processProbe,
            nodeWorkspace: createNodePythonProjectWorkspace(repoRoot),
            toolArgv: { pyright: [executable] }
          })
        }).runValidation(request({ repo: { repoRoot }, checks: [PYTHON_TYPES_CHECK_ID] }));
        assert.ok(result.pythonCapabilityRuns?.[0], JSON.stringify(result, null, 2));
        assert.equal(result.pythonCapabilityRuns[0].status, testCase.status, JSON.stringify(result, null, 2));
        assert.equal(result.pythonCapabilityRuns[0].execution.termination, testCase.termination);
        assert.deepEqual(materializedMypyWorkspaces(), before);
      } finally {
        rmSync(repoRoot, { recursive: true, force: true });
      }
    }
  });

  it("accepts passed pyright warning and information evidence", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-pyright-warning-"));
    try {
      writePassingPythonProtocolShim(repoRoot);
      writeToolShim(repoRoot, "pyright", pyrightShim("1.1.411", [
        { file: "pkg/app.py", severity: "warning", message: "warning", rule: "reportUnusedImport", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
        { file: "pkg/app.py", severity: "information", message: "information", range: { start: { line: 0, character: 1 }, end: { line: 0, character: 2 } } }
      ], 0));
      const files = { "pyrightconfig.json": "{}\n", "pkg/app.py": "value: int = 1\n" };
      const result = await runner({
        files,
        checks: createPythonValidationChecks({ repoRoot, env: { PATH: "" }, nodeWorkspace: createNodePythonProjectWorkspace(repoRoot) })
      }).runValidation(request({ repo: { repoRoot }, checks: [PYTHON_TYPES_CHECK_ID] }));

      assert.equal(result.pythonCapabilityRuns[0].status, "passed", JSON.stringify(result, null, 2));
      assert.deepEqual({
        errors: result.pythonCapabilityRuns[0].errorCount,
        warnings: result.pythonCapabilityRuns[0].warningCount,
        notes: result.pythonCapabilityRuns[0].noteCount
      }, { errors: 0, warnings: 1, notes: 1 });
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("materializes recursive pyright extends and rejects unsafe closures before execution", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-pyright-extends-"));
    try {
      writePassingPythonProtocolShim(repoRoot);
      writeToolShim(repoRoot, "pyright", rawPyrightShim("1.1.411", [
        "test -f configs/base.json || exit 91",
        "test -f configs/stubs/external/__init__.pyi || exit 92",
        `cat <<'JSON'\n${JSON.stringify(pyrightPayload("1.1.411", []))}\nJSON`,
        "exit 0"
      ].join("\n")));
      const files = {
        "pyrightconfig.json": "{ // JSONC\n  \"extends\": \"configs/base.json\",\n  \"include\": [\"src\"],\n}\n",
        "configs/base.json": "{\"stubPath\":\"stubs\",\"extraPaths\":[\"src\"]}\n",
        "configs/src/helper.py": "VALUE: int = 1\n",
        "src/app.py": "value: int = 1\n",
        "configs/stubs/external/__init__.pyi": "VALUE: int\n"
      };
      const result = await runner({
        files,
        checks: createPythonValidationChecks({ repoRoot, env: { PATH: "" }, nodeWorkspace: projectWorkspace(files, () => true) })
      }).runValidation(request({ repo: { repoRoot }, checks: [PYTHON_TYPES_CHECK_ID], scope: { kind: "files", files: ["src/app.py"] } }));
      assert.equal(result.status, "passed", JSON.stringify(result, null, 2));
      assert.deepEqual(result.pythonCapabilityRuns[0].selectedConfigPaths, ["configs/base.json", "pyrightconfig.json"]);

      for (const [name, configFiles] of Object.entries({
        missing: { "pyrightconfig.json": "{\"extends\":\"configs/missing.json\"}\n" },
        rootDirectory: { "pyrightconfig.json": "{\"extends\":\".\"}\n" },
        cycle: {
          "pyrightconfig.json": "{\"extends\":\"configs/a.json\"}\n",
          "configs/a.json": "{\"extends\":\"b.json\"}\n",
          "configs/b.json": "{\"extends\":\"a.json\"}\n"
        },
        traversal: { "pyrightconfig.json": "{\"extraPaths\":[\"../outside\"]}\n" },
        absolute: { "pyrightconfig.json": "{\"stubPath\":\"/tmp/stubs\"}\n" }
      })) {
        const attempted = join(repoRoot, `attempted-${name}`);
        writeToolShim(repoRoot, "pyright", rawPyrightShim("1.1.411", `touch ${JSON.stringify(attempted)}\nexit 0`));
        const caseFiles = { ...configFiles, "src/app.py": "value: int = 1\n" };
        const failed = await runner({
          files: caseFiles,
          checks: createPythonValidationChecks({ repoRoot, env: { PATH: "" }, nodeWorkspace: projectWorkspace(caseFiles, () => true) })
        }).runValidation(request({ repo: { repoRoot }, checks: [PYTHON_TYPES_CHECK_ID], scope: { kind: "files", files: ["src/app.py"] } }));
        assert.equal(failed.pythonCapabilityRuns[0].status, "invalid_config", `${name}: ${JSON.stringify(failed, null, 2)}`);
        assert.equal(existsSync(attempted), false, name);
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("materializes pyright stub write/delete overlays without stale inputs", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-pyright-stub-overlay-"));
    try {
      writePassingPythonProtocolShim(repoRoot);
      writeToolShim(repoRoot, "pyright", rawPyrightShim("1.1.411", [
        "test ! -e stubs/old.pyi || exit 91",
        "test -f stubs/new.pyi || exit 92",
        `cat <<'JSON'\n${JSON.stringify(pyrightPayload("1.1.411", []))}\nJSON`,
        "exit 0"
      ].join("\n")));
      const files = {
        "pyrightconfig.json": "{\"stubPath\":\"stubs\"}\n",
        "pkg/app.py": "value: int = 1\n",
        "stubs/old.pyi": "OLD: int\n"
      };
      const result = await runner({
        files,
        checks: createPythonValidationChecks({ repoRoot, env: { PATH: "" }, nodeWorkspace: createNodePythonProjectWorkspace(repoRoot) })
      }).runValidation(request({
        repo: { repoRoot },
        checks: [PYTHON_TYPES_CHECK_ID],
        overlays: [
          { path: "stubs/old.pyi", action: "delete" },
          { path: "stubs/new.pyi", action: "write", content: "NEW: int\n" }
        ]
      }));

      assert.equal(result.status, "passed", JSON.stringify(result, null, 2));
      assert.equal(result.pythonCapabilityRuns[0].selectedSourcePaths.includes("stubs/old.pyi"), false);
      assert.equal(result.pythonCapabilityRuns[0].selectedSourcePaths.includes("stubs/new.pyi"), true);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("refuses symlinked pyright configs, configured roots, and stub inputs before execution", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-pyright-symlink-"));
    try {
      writePassingPythonProtocolShim(repoRoot);
      const marker = join(repoRoot, "pyright-ran");
      writeToolShim(repoRoot, "pyright", rawPyrightShim("1.1.411", `touch ${JSON.stringify(marker)}\nexit 0`));
      const cases = [
        {
          files: {
            "pyrightconfig.json": "{\"extends\":\"configs/base.json\"}\n",
            "configs/base.json": "{}\n",
            "src/app.py": "VALUE = 1\n"
          },
          symlinks: new Set(["configs/base.json"])
        },
        {
          files: {
            "pyrightconfig.json": "{\"stubPath\":\"stubs\"}\n",
            "src/app.py": "VALUE = 1\n",
            "stubs/external/__init__.pyi": "VALUE: int\n"
          },
          symlinks: new Set(["stubs/external/__init__.pyi"])
        },
        {
          files: {
            "pyrightconfig.json": "{\"stubPath\":\"stubs\"}\n",
            "src/app.py": "VALUE = 1\n"
          },
          symlinks: new Set(["stubs"])
        }
      ];
      for (const testCase of cases) {
        const result = await runner({
          files: testCase.files,
          checks: createPythonValidationChecks({
            repoRoot,
            env: { PATH: "" },
            nodeWorkspace: projectWorkspace(testCase.files, () => true, testCase.symlinks)
          })
        }).runValidation(request({
          repo: { repoRoot }, checks: [PYTHON_TYPES_CHECK_ID], scope: { kind: "files", files: ["src/app.py"] }
        }));
        assert.equal(result.pythonCapabilityRuns[0].status, "invalid_config", JSON.stringify(result, null, 2));
        assert.equal(existsSync(marker), false);
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("does not fall back to mypy when configured pyright is unavailable", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-pyright-unavailable-"));
    try {
      writePassingPythonProtocolShim(repoRoot);
      const mypyMarker = join(repoRoot, "mypy-ran");
      writeToolShim(repoRoot, "mypy", `#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'mypy 2.3.0'; exit 0; fi\ntouch ${JSON.stringify(mypyMarker)}\nexit 0\n`);
      const files = { "pyrightconfig.json": "{}\n", "pkg/app.py": "value: int = 1\n" };
      const result = await runner({
        files,
        checks: createPythonValidationChecks({
          repoRoot,
          env: { PATH: "" },
          nodeWorkspace: createNodePythonProjectWorkspace(repoRoot)
        })
      }).runValidation(request({ repo: { repoRoot }, checks: [PYTHON_TYPES_CHECK_ID] }));
      assert.equal(result.pythonCapabilityRuns[0].authority, "pyright", JSON.stringify(result, null, 2));
      assert.equal(result.pythonCapabilityRuns[0].status, "tool_unavailable", JSON.stringify(result, null, 2));
      assert.equal(existsSync(mypyMarker), false);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("retains a Pyright receipt when canonical interpreter probing is malformed", async () => {
    const files = {
      "pyrightconfig.json": "{}\n",
      "pkg/app.py": "value: int = 1\n"
    };
    const result = await runner({
      files,
      checks: createPythonValidationChecks({
        env: { PATH: "/fixture/bin" },
        nodeWorkspace: projectWorkspace(files, () => true),
        processProbe: successfulProbe("malformed-version")
      })
    }).runValidation(request({ repo: { repoRoot: "/fixture" }, checks: [PYTHON_TYPES_CHECK_ID] }));

    assert.equal(result.pythonProjectContexts[0].interpreter, undefined);
    assert.equal(result.pythonProjectContexts[0].reasons.some((reason) =>
      reason.code === "malformed_probe_output" && reason.tool === "python"
    ), true);
    assert.equal(result.pythonCapabilityRuns.length, 1, JSON.stringify(result, null, 2));
    assert.equal(result.pythonCapabilityRuns[0].authority, "pyright");
    assert.equal(result.pythonCapabilityRuns[0].status, "invalid_config");
    assert.equal(result.pythonCapabilityRuns[0].execution, undefined);
    assert.equal(result.diagnostics.some((entry) => entry.code === "PYTHON_TYPES_INVALID_CONFIG"), true);
  });

  it("retains independent mixed mypy and pyright project receipts", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-mixed-authorities-"));
    try {
      const mypyRoot = join(repoRoot, "services/mypy-app");
      const pyrightRoot = join(repoRoot, "services/pyright-app");
      mkdirSync(mypyRoot, { recursive: true });
      mkdirSync(pyrightRoot, { recursive: true });
      writePassingPythonProtocolShim(mypyRoot);
      writePassingPythonProtocolShim(pyrightRoot);
      writeToolShim(mypyRoot, "mypy", "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'mypy 2.3.0'; exit 0; fi\nexit 0\n");
      writeToolShim(pyrightRoot, "pyright", pyrightShim("1.1.411", [], 0));
      const files = {
        "services/mypy-app/pyproject.toml": "[project]\nname='mypy-app'\n[tool.mypy]\nstrict=true\n",
        "services/mypy-app/app.py": "VALUE: int = 1\n",
        "services/pyright-app/pyproject.toml": "[project]\nname='pyright-app'\n",
        "services/pyright-app/pyrightconfig.json": "{\"include\":[\".\"]}\n",
        "services/pyright-app/app.py": "VALUE: int = 1\n"
      };
      const result = await runner({
        files,
        checks: createPythonValidationChecks({
          repoRoot,
          env: { PATH: "" },
          nodeWorkspace: projectWorkspace(files, (path) => existsSync(path))
        })
      }).runValidation(request({
        repo: { repoRoot },
        checks: [PYTHON_TYPES_CHECK_ID],
        scope: { kind: "files", files: ["services/mypy-app/app.py", "services/pyright-app/app.py"] }
      }));

      assert.equal(result.status, "passed", JSON.stringify(result, null, 2));
      assert.deepEqual(result.pythonCapabilityRuns.map((run) => [run.projectRoot, run.authority, run.status]), [
        ["services/mypy-app", "mypy", "passed"],
        ["services/pyright-app", "pyright", "passed"]
      ]);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("keeps root Pyright sources outside a nested mypy authority boundary", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-nested-authority-boundary-"));
    try {
      const nestedRoot = join(repoRoot, "nested");
      mkdirSync(nestedRoot, { recursive: true });
      writePassingPythonProtocolShim(repoRoot);
      writePassingPythonProtocolShim(nestedRoot);
      const nestedDiagnostic = {
        file: "nested/app.py",
        severity: "error",
        message: "root Pyright crossed the nested mypy authority boundary",
        rule: "reportAssignmentType",
        range: { start: { line: 0, character: 13 }, end: { line: 0, character: 20 } }
      };
      writeToolShim(repoRoot, "pyright", rawPyrightShim("1.1.411", [
        "if [ -f nested/app.py ]; then",
        "cat <<'OPCORE_PYRIGHT_NESTED_JSON'",
        JSON.stringify(pyrightPayload("1.1.411", [nestedDiagnostic])),
        "OPCORE_PYRIGHT_NESTED_JSON",
        "exit 1",
        "fi",
        "cat <<'OPCORE_PYRIGHT_ROOT_JSON'",
        JSON.stringify(pyrightPayload("1.1.411", [])),
        "OPCORE_PYRIGHT_ROOT_JSON",
        "exit 0"
      ].join("\n")));
      writeToolShim(nestedRoot, "mypy", "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'mypy 2.3.0'; exit 0; fi\nexit 0\n");
      const files = {
        "pyrightconfig.json": "{\"include\":[\"**/*.py\"]}\n",
        "root.py": "VALUE: int = 1\n",
        "nested/pyproject.toml": "[project]\nname='nested'\n[tool.mypy]\nstrict=true\n",
        "nested/app.py": "value: int = 'wrong'\n"
      };
      const result = await runner({
        files,
        checks: createPythonValidationChecks({
          repoRoot,
          env: { PATH: "" },
          nodeWorkspace: projectWorkspace(files, (path) => existsSync(path))
        })
      }).runValidation(request({
        repo: { repoRoot },
        checks: [PYTHON_TYPES_CHECK_ID],
        scope: { kind: "files", files: ["root.py", "nested/app.py"] }
      }));

      assert.equal(result.status, "passed", JSON.stringify(result, null, 2));
      assert.deepEqual(result.pythonCapabilityRuns.map((run) => [run.projectRoot, run.authority, run.selectedSourcePaths]), [
        ["nested", "mypy", ["nested/app.py"]],
        [".", "pyright", ["root.py"]]
      ]);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("keeps root-only Pyright scope outside nested canonical project sources", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-root-only-authority-boundary-"));
    try {
      writePassingPythonProtocolShim(repoRoot);
      const nestedRoot = join(repoRoot, "nested");
      mkdirSync(nestedRoot, { recursive: true });
      const nestedDiagnostic = {
        file: "nested/app.py",
        severity: "error",
        message: "root-only Pyright materialized a nested canonical project",
        rule: "reportAssignmentType",
        range: { start: { line: 0, character: 13 }, end: { line: 0, character: 20 } }
      };
      writeToolShim(repoRoot, "pyright", rawPyrightShim("1.1.411", [
        "if [ -f nested/app.py ]; then",
        "cat <<'OPCORE_PYRIGHT_ROOT_ONLY_JSON'",
        JSON.stringify(pyrightPayload("1.1.411", [nestedDiagnostic])),
        "OPCORE_PYRIGHT_ROOT_ONLY_JSON",
        "exit 1",
        "fi",
        "cat <<'OPCORE_PYRIGHT_ROOT_ONLY_CLEAN_JSON'",
        JSON.stringify(pyrightPayload("1.1.411", [])),
        "OPCORE_PYRIGHT_ROOT_ONLY_CLEAN_JSON",
        "exit 0"
      ].join("\n")));
      const files = {
        "pyrightconfig.json": "{\"include\":[\"**/*.py\"]}\n",
        "root.py": "VALUE: int = 1\n",
        "nested/pyproject.toml": "[project]\nname='nested'\n[tool.mypy]\nstrict=true\n",
        "nested/app.py": "value: int = 'wrong'\n"
      };
      const result = await runner({
        files,
        checks: createPythonValidationChecks({
          repoRoot,
          env: { PATH: "" },
          nodeWorkspace: projectWorkspace(files, (path) => existsSync(path))
        })
      }).runValidation(request({
        repo: { repoRoot },
        checks: [PYTHON_TYPES_CHECK_ID],
        scope: { kind: "files", files: ["root.py"] }
      }));

      assert.equal(result.status, "passed", JSON.stringify(result, null, 2));
      assert.deepEqual(result.pythonCapabilityRuns.map((run) => [run.projectRoot, run.authority, run.selectedSourcePaths]), [
        [".", "pyright", ["root.py"]]
      ]);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("does not select type authority from installed-tool availability", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-types-no-authority-"));
    try {
      writePassingPythonProtocolShim(repoRoot);
      writeToolShim(repoRoot, "mypy", "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'mypy 2.3.0'; exit 0; fi\nexit 99\n");
      const result = await runner({
        files: { "pkg/app.py": "value: int = 1\n" },
        checks: createPythonValidationChecks({ repoRoot, env: { PATH: "" } })
      }).runValidation(request({ repo: { repoRoot }, checks: [PYTHON_TYPES_CHECK_ID] }));

      assert.equal(result.status, "unsupported_request");
      assert.equal(result.pythonCapabilityRuns[0].status, "unsupported_target");
      assert.equal(result.diagnostics[0].code, "PYTHON_TYPES_UNSUPPORTED_TARGET");
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("does not treat packaging-only setup.cfg or tox.ini as mypy authority", async () => {
    const files = {
      "setup.cfg": "[metadata]\nname = fixture\n[options]\npackages = find:\n",
      "tox.ini": "[tox]\nenvlist = py312\n[testenv]\ncommands = pytest\n",
      "pkg/app.py": "value: int = 1\n"
    };
    const result = await runner({
      files,
      checks: createPythonValidationChecks({
        env: { PATH: "/fixture/bin" },
        nodeWorkspace: projectWorkspace(files, () => true),
        processProbe: successfulProbe()
      })
    }).runValidation(request({
      repo: { repoRoot: "/fixture" },
      checks: [PYTHON_TYPES_CHECK_ID]
    }));

    assert.equal(result.status, "unsupported_request", JSON.stringify(result, null, 2));
    assert.equal(result.pythonCapabilityRuns[0].status, "unsupported_target");
    assert.equal(result.pythonProjectContexts[0].tools.find((tool) => tool.tool === "mypy")?.configFile, undefined);
    const status = createPythonValidationAdapterStatus({ contexts: result.pythonProjectContexts });
    assert.equal(status.status, "degraded");
    assert.equal(status.degradedChecks.find((check) => check.checkId === PYTHON_TYPES_CHECK_ID)?.requiredTool, "configured Python type authority");
  });

  it("uses documented mypy config precedence without reading lower-priority output or plugin settings", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-types-config-precedence-"));
    const hostRoot = mkdtempSync(join(tmpdir(), "opcore-python-types-config-precedence-host-"));
    try {
      writePassingPythonProtocolShim(repoRoot);
      const executed = join(repoRoot, "mypy-executed");
      const outputVictim = join(hostRoot, "output-victim.xml");
      const pluginMarker = join(hostRoot, "plugin-executed");
      const hostPlugin = join(hostRoot, "host-plugin.py");
      writeFileSync(outputVictim, "UNCHANGED\n");
      writeFileSync(hostPlugin, `from pathlib import Path\nPath(${JSON.stringify(pluginMarker)}).write_text('executed')\n`);
      writeToolShim(repoRoot, "mypy", [
        "#!/bin/sh",
        "if [ \"$1\" = \"--version\" ]; then echo 'mypy 2.3.0'; exit 0; fi",
        "config=",
        "while [ \"$#\" -gt 0 ]; do",
        "  if [ \"$1\" = \"--config-file\" ]; then shift; config=$1; fi",
        "  shift",
        "done",
        "if [ \"$config\" != \"mypy.ini\" ]; then exit 97; fi",
        `/usr/bin/touch ${JSON.stringify(executed)}`,
        "exit 0",
        ""
      ].join("\n"));
      const files = {
        "mypy.ini": "[mypy]\nstrict = true\n",
        ".mypy.ini": "[mypy\nmalformed = ignored\n",
        "pyproject.toml": [
          "[project]",
          "name = 'fixture'",
          "[tool.mypy]",
          `junit_xml = ${JSON.stringify(outputVictim)}`,
          `plugins = [${JSON.stringify(hostPlugin)}]`,
          ""
        ].join("\n"),
        "setup.cfg": `[mypy]\npython_executable = ${hostPlugin}\n`,
        "tox.ini": `[mypy]\ncache_dir = ${hostRoot}\n`,
        "pkg/app.py": "value: int = 1\n"
      };
      const result = await runner({
        files,
        checks: createPythonValidationChecks({
          repoRoot,
          env: { PATH: "" },
          nodeWorkspace: createNodePythonProjectWorkspace(repoRoot)
        })
      }).runValidation(request({ repo: { repoRoot }, checks: [PYTHON_TYPES_CHECK_ID] }));

      assert.equal(result.status, "passed", JSON.stringify(result, null, 2));
      assert.deepEqual(result.pythonCapabilityRuns[0].selectedConfigPaths, ["mypy.ini"]);
      assert.equal(result.pythonCapabilityRuns[0].tool.configFile, "mypy.ini");
      assert.equal(result.pythonProjectContexts[0].tools.find((tool) => tool.tool === "mypy")?.configFile, "mypy.ini");
      assert.equal(result.pythonProjectContexts[0].reasons.some((reason) => reason.code === "invalid_config"), false);
      assert.equal(existsSync(executed), true);
      assert.equal(readFileSync(outputVictim, "utf8"), "UNCHANGED\n");
      assert.equal(existsSync(pluginMarker), false);
      assert.equal(JSON.stringify(result.pythonCapabilityRuns).includes(hostRoot), false);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(hostRoot, { recursive: true, force: true });
    }
  });

  it("fails a dedicated mypy config without a mypy section closed", async () => {
    const files = {
      "mypy.ini": "[metadata]\nname = not-mypy\n",
      "pkg/app.py": "value: int = 1\n"
    };
    const result = await runner({
      files,
      checks: createPythonValidationChecks({
        env: { PATH: "/fixture/bin" },
        nodeWorkspace: projectWorkspace(files, () => true),
        processProbe: successfulProbe()
      })
    }).runValidation(request({ repo: { repoRoot: "/fixture" }, checks: [PYTHON_TYPES_CHECK_ID] }));

    assert.equal(result.status, "unsupported_request", JSON.stringify(result, null, 2));
    assert.equal(result.pythonCapabilityRuns[0].status, "invalid_config");
    assert.deepEqual(result.pythonCapabilityRuns[0].selectedConfigPaths, ["mypy.ini"]);
  });

  it("classifies mypy semantic config rejection as invalid_config", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-types-invalid-mypy-config-"));
    try {
      writePassingPythonProtocolShim(repoRoot);
      writeToolShim(repoRoot, "mypy", [
        "#!/bin/sh",
        "if [ \"$1\" = \"--version\" ]; then echo 'mypy 2.3.0'; exit 0; fi",
        "echo \"mypy.ini: [mypy]: strict: Not a boolean: garbage\" >&2",
        "exit 0",
        ""
      ].join("\n"));
      const files = {
        "mypy.ini": "[mypy]\nstrict = garbage\n",
        "pkg/app.py": "value: int = 1\n"
      };
      const result = await runner({
        files,
        checks: createPythonValidationChecks({
          repoRoot,
          env: { PATH: "" },
          nodeWorkspace: createNodePythonProjectWorkspace(repoRoot)
        })
      }).runValidation(request({ repo: { repoRoot }, checks: [PYTHON_TYPES_CHECK_ID] }));

      assert.equal(result.status, "unsupported_request", JSON.stringify(result, null, 2));
      assert.equal(result.pythonCapabilityRuns[0].status, "invalid_config", JSON.stringify(result, null, 2));
      assert.equal(result.pythonCapabilityRuns[0].execution.termination, "exited");
      assert.equal(result.pythonCapabilityRuns[0].execution.exitCode, 0);
      assert.equal(result.diagnostics[0].code, "PYTHON_TYPES_INVALID_CONFIG");
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("classifies complete JSON mypy config diagnostics as invalid_config", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-types-json-mypy-config-"));
    try {
      writePassingPythonProtocolShim(repoRoot);
      writeToolShim(repoRoot, "mypy", [
        "#!/bin/sh",
        "if [ \"$1\" = \"--version\" ]; then echo 'mypy 2.3.0'; exit 0; fi",
        "printf '%s\\n' '{\"file\":\"mypy.ini\",\"line\":2,\"column\":0,\"end_line\":2,\"end_column\":1,\"message\":\"strict is not a boolean\",\"hint\":null,\"code\":\"misc\",\"severity\":\"error\"}' >&2",
        "exit 2",
        ""
      ].join("\n"));
      const files = {
        "mypy.ini": "[mypy]\nstrict = garbage\n",
        "pkg/app.py": "value: int = 1\n"
      };
      const result = await runner({
        files,
        checks: createPythonValidationChecks({
          repoRoot,
          env: { PATH: "" },
          nodeWorkspace: createNodePythonProjectWorkspace(repoRoot)
        })
      }).runValidation(request({ repo: { repoRoot }, checks: [PYTHON_TYPES_CHECK_ID] }));

      assert.equal(result.status, "unsupported_request", JSON.stringify(result, null, 2));
      assert.equal(result.pythonCapabilityRuns[0].status, "invalid_config");
      assert.equal(result.pythonCapabilityRuns[0].execution.exitCode, 2);
      assert.equal(result.diagnostics[0].code, "PYTHON_TYPES_INVALID_CONFIG");
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("classifies an invalid mypy python_version before unsupported target policy", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-types-invalid-mypy-version-"));
    try {
      writePassingPythonProtocolShim(repoRoot);
      const executed = join(repoRoot, "mypy-executed");
      writeToolShim(repoRoot, "mypy", [
        "#!/bin/sh",
        "if [ \"$1\" = \"--version\" ]; then echo 'mypy 2.3.0'; exit 0; fi",
        `/usr/bin/touch ${JSON.stringify(executed)}`,
        "exit 99",
        ""
      ].join("\n"));
      const files = {
        "mypy.ini": "[mypy]\npython_version = garbage\n",
        "pkg/app.py": "value: int = 1\n"
      };
      const result = await runner({
        files,
        checks: createPythonValidationChecks({
          repoRoot,
          env: { PATH: "" },
          nodeWorkspace: createNodePythonProjectWorkspace(repoRoot)
        })
      }).runValidation(request({ repo: { repoRoot }, checks: [PYTHON_TYPES_CHECK_ID] }));

      assert.equal(result.status, "unsupported_request", JSON.stringify(result, null, 2));
      assert.equal(result.pythonCapabilityRuns[0].status, "invalid_config");
      assert.equal(result.pythonCapabilityRuns[0].execution, undefined);
      assert.equal(result.diagnostics[0].code, "PYTHON_TYPES_INVALID_CONFIG");
      assert.equal(existsSync(executed), false);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("runs configured mypy without falling back to an installed pyright", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-types-configured-mypy-"));
    try {
      writePassingPythonProtocolShim(repoRoot);
      const mypyExecuted = join(repoRoot, "mypy-executed");
      const pyrightExecuted = join(repoRoot, "pyright-executed");
      writeToolShim(repoRoot, "mypy", [
        "#!/bin/sh",
        "if [ \"$1\" = \"--version\" ]; then echo 'mypy 2.3.0'; exit 0; fi",
        `/usr/bin/touch ${JSON.stringify(mypyExecuted)}`,
        "exit 0",
        ""
      ].join("\n"));
      writeToolShim(repoRoot, "pyright", [
        "#!/bin/sh",
        "if [ \"$1\" = \"--version\" ]; then echo 'pyright 1.1.0'; exit 0; fi",
        `/usr/bin/touch ${JSON.stringify(pyrightExecuted)}`,
        "exit 99",
        ""
      ].join("\n"));
      const files = {
        "mypy.ini": "[mypy]\nstrict = true\n",
        "pkg/app.py": "value: int = 1\n"
      };
      const result = await runner({
        files,
        checks: createPythonValidationChecks({
          checker: "mypy",
          repoRoot,
          env: { PATH: "" },
          nodeWorkspace: createNodePythonProjectWorkspace(repoRoot)
        })
      }).runValidation(request({ repo: { repoRoot }, checks: [PYTHON_TYPES_CHECK_ID] }));

      assert.equal(result.status, "passed", JSON.stringify(result, null, 2));
      assert.equal(result.pythonCapabilityRuns[0].authority, "mypy");
      assert.equal(result.pythonCapabilityRuns[0].authoritySource, "explicit");
      assert.equal(existsSync(mypyExecuted), true);
      assert.equal(existsSync(pyrightExecuted), false);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("reports configured mypy unavailable without falling back to installed pyright", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-types-mypy-unavailable-"));
    try {
      writePassingPythonProtocolShim(repoRoot);
      const pyrightExecuted = join(repoRoot, "pyright-executed");
      writeToolShim(repoRoot, "pyright", [
        "#!/bin/sh",
        "if [ \"$1\" = \"--version\" ]; then echo 'pyright 1.1.0'; exit 0; fi",
        `/usr/bin/touch ${JSON.stringify(pyrightExecuted)}`,
        "exit 99",
        ""
      ].join("\n"));
      const files = {
        "mypy.ini": "[mypy]\nstrict = true\n",
        "pkg/app.py": "value: int = 1\n"
      };
      const result = await runner({
        files,
        checks: createPythonValidationChecks({
          repoRoot,
          env: { PATH: "" },
          nodeWorkspace: createNodePythonProjectWorkspace(repoRoot)
        })
      }).runValidation(request({ repo: { repoRoot }, checks: [PYTHON_TYPES_CHECK_ID] }));

      assert.equal(result.status, "unsupported_request");
      assert.equal(result.pythonCapabilityRuns[0].status, "tool_unavailable");
      assert.equal(result.pythonCapabilityRuns[0].authority, "mypy");
      assert.equal(existsSync(pyrightExecuted), false);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("fails explicit and configured authority conflicts without checker execution", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-types-explicit-conflict-"));
    try {
      writePassingPythonProtocolShim(repoRoot);
      const mypyExecuted = join(repoRoot, "mypy-executed");
      writeToolShim(repoRoot, "mypy", [
        "#!/bin/sh",
        "if [ \"$1\" = \"--version\" ]; then echo 'mypy 2.3.0'; exit 0; fi",
        `/usr/bin/touch ${JSON.stringify(mypyExecuted)}`,
        "exit 99",
        ""
      ].join("\n"));
      const files = {
        "mypy.ini": "[mypy]\nstrict = true\n",
        "pkg/app.py": "value: int = 1\n"
      };
      const result = await runner({
        files,
        checks: createPythonValidationChecks({
          checker: "pyright",
          repoRoot,
          env: { PATH: "" },
          nodeWorkspace: createNodePythonProjectWorkspace(repoRoot)
        })
      }).runValidation(request({ repo: { repoRoot }, checks: [PYTHON_TYPES_CHECK_ID] }));

      assert.equal(result.status, "unsupported_request");
      assert.equal(result.pythonCapabilityRuns[0].status, "invalid_config");
      assert.equal(result.pythonCapabilityRuns[0].authority, undefined);
      assert.equal(result.pythonCapabilityRuns[0].authoritySource, undefined);
      assert.equal(result.pythonCapabilityRuns[0].tool, undefined);
      assert.equal(existsSync(mypyExecuted), false);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("fails conflicting checker authority closed without executing either checker", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-types-conflict-"));
    try {
      writePassingPythonProtocolShim(repoRoot);
      for (const tool of ["mypy", "pyright"]) {
        writeToolShim(repoRoot, tool, [
          "#!/bin/sh",
          `if [ \"$1\" = \"--version\" ]; then echo '${tool} 2.3.0'; exit 0; fi`,
          `/usr/bin/touch ${JSON.stringify(join(repoRoot, `${tool}-executed`))}`,
          "exit 99",
          ""
        ].join("\n"));
      }
      const files = {
        "mypy.ini": "[mypy]\nstrict = true\n",
        "pyrightconfig.json": "{}\n",
        "pkg/app.py": "value: int = 1\n"
      };
      const result = await runner({
        files,
        checks: createPythonValidationChecks({
          repoRoot,
          env: { PATH: "" },
          nodeWorkspace: createNodePythonProjectWorkspace(repoRoot)
        })
      }).runValidation(request({ repo: { repoRoot }, checks: [PYTHON_TYPES_CHECK_ID] }));

      assert.equal(result.status, "unsupported_request");
      assert.equal(result.pythonCapabilityRuns[0].status, "invalid_config");
      assert.deepEqual(result.pythonCapabilityRuns[0].selectedConfigPaths, ["mypy.ini", "pyrightconfig.json"]);
      assert.equal(result.pythonCapabilityRuns[0].authority, undefined);
      assert.equal(result.pythonCapabilityRuns[0].authoritySource, undefined);
      assert.equal(result.pythonCapabilityRuns[0].tool, undefined);
      assert.match(result.pythonCapabilityRuns[0].projectKey, /^sha256:[a-f0-9]{64}$/u);
      assert.match(result.pythonCapabilityRuns[0].contextFingerprint, /^sha256:[a-f0-9]{64}$/u);
      assert.match(result.pythonCapabilityRuns[0].afterStateManifestFingerprint, /^sha256:[a-f0-9]{64}$/u);
      assert.equal(result.pythonCapabilityRuns[0].projectRoot, ".");
      assert.equal(existsSync(join(repoRoot, "mypy-executed")), false);
      assert.equal(existsSync(join(repoRoot, "pyright-executed")), false);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("retains separate mypy capability evidence and diagnostics for two projects", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-types-projects-"));
    try {
      const files = {};
      for (const project of ["a", "b"]) {
        const projectRoot = join(repoRoot, project);
        mkdirSync(projectRoot, { recursive: true });
        writePassingPythonProtocolShim(projectRoot);
        writeToolShim(projectRoot, "mypy", [
          "#!/bin/sh",
          "if [ \"$1\" = \"--version\" ]; then echo 'mypy 2.3.0'; exit 0; fi",
          `echo '{\"file\":\"app.py\",\"line\":1,\"column\":0,\"end_line\":1,\"end_column\":5,\"message\":\"${project} failure\",\"hint\":null,\"code\":\"assignment\",\"severity\":\"error\"}'`,
          "exit 1",
          ""
        ].join("\n"));
        files[`${project}/pyproject.toml`] = `[project]\nname='${project}'\n[tool.mypy]\nstrict=true\n`;
        files[`${project}/app.py`] = "value: int = 'wrong'\n";
      }
      const result = await runner({
        files,
        checks: createPythonValidationChecks({
          repoRoot,
          env: { PATH: "" },
          nodeWorkspace: projectWorkspace(files, () => true)
        })
      }).runValidation(request({
        repo: { repoRoot },
        checks: [PYTHON_TYPES_CHECK_ID],
        scope: { kind: "files", files: ["b/app.py", "a/app.py"] }
      }));

      assert.equal(result.status, "policy_failure", JSON.stringify(result, null, 2));
      assert.deepEqual(result.pythonCapabilityRuns.map((run) => run.projectRoot).sort(), ["a", "b"]);
      assert.deepEqual(result.diagnostics.map((entry) => entry.path), ["a/app.py", "b/app.py"]);
      assert.deepEqual(
        result.pythonCapabilityRuns.map((run) => [run.projectRoot, run.selectedSourcePaths]).sort(),
        [["a", ["a/app.py"]], ["b", ["b/app.py"]]]
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("rewrites explicit checker config paths into the materialized after-state workspace", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-types-config-path-"));
    try {
      writePassingPythonProtocolShim(repoRoot);
      writeFileSync(join(repoRoot, "mypy.ini"), "[mypy]\nmarker = before\n");
      writeToolShim(
        repoRoot,
        "mypy",
        [
          "#!/bin/sh",
          "if [ \"$3\" = \"--version\" ]; then echo 'mypy 1.8.0'; exit 0; fi",
          "if [ \"$1\" != \"--config-file\" ] || [ \"$2\" != \"mypy.ini\" ]; then echo \"unexpected config path: $*\" >&2; exit 9; fi",
          "/usr/bin/grep -q 'marker = after' \"$2\" || { echo 'overlay config was not materialized' >&2; exit 9; }",
          "exit 0",
          ""
        ].join("\n")
      );
      const mypy = join(repoRoot, ".venv", "bin", "mypy");
      const files = {
        "mypy.ini": "[mypy]\nmarker = before\n",
        "pkg/app.py": "value: int = 1\n"
      };
      const result = await runner({
        files,
        checks: createPythonValidationChecks({
          env: { PATH: "" },
          repoRoot,
          nodeWorkspace: createNodePythonProjectWorkspace(repoRoot),
          toolArgv: { mypy: [mypy, "--config-file", join(repoRoot, "mypy.ini")] }
        })
      }).runValidation(request({
        repo: { repoRoot },
        checks: [PYTHON_TYPES_CHECK_ID],
        overlays: [{ path: "mypy.ini", action: "write", content: "[mypy]\nmarker = after\n" }]
      }));

      assert.equal(result.status, "passed", JSON.stringify(result, null, 2));
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("isolates explicit mypy from poisoned host environment and global config discovery", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-types-host-isolation-"));
    const poisonHome = mkdtempSync(join(tmpdir(), "opcore-python-types-poison-home-"));
    try {
      mkdirSync(join(poisonHome, ".config", "mypy"), { recursive: true });
      const poisonConfig = join(poisonHome, ".config", "mypy", "config");
      writeFileSync(poisonConfig, "[mypy]\nplugins = outside.plugin\n");
      writePassingPythonProtocolShim(repoRoot);
      const mypy = join(repoRoot, ".venv", "bin", "mypy");
      writeToolShim(repoRoot, "mypy", [
        "#!/bin/sh",
        `if [ \"$HOME\" = ${JSON.stringify(poisonHome)} ] || [ \"$XDG_CONFIG_HOME\" = ${JSON.stringify(poisonHome)} ]; then exit 9; fi`,
        "if [ \"$MYPYPATH\" = poison ] || [ \"$PYTHONPATH\" = poison ] || [ \"$MYPY_CACHE_DIR\" = poison ]; then exit 9; fi",
        "config=",
        "while [ \"$#\" -gt 0 ]; do",
        "  case \"$1\" in",
        "    --config-file) shift; config=$1 ;;",
        "    --config-file=*) config=${1#--config-file=} ;;",
        "  esac",
        "  shift",
        "done",
        "if [ -z \"$config\" ] || [ ! -f \"$config\" ]; then exit 9; fi",
        "/usr/bin/grep -q '^\\[mypy\\]' \"$config\" || exit 9",
        "exit 0",
        ""
      ].join("\n"));
      const files = { "pkg/app.py": "value: int = 1\n" };
      const result = await runner({
        files,
        checks: createPythonValidationChecks({
          checker: "mypy",
          repoRoot,
          env: {
            PATH: "",
            HOME: poisonHome,
            XDG_CONFIG_HOME: poisonHome,
            MYPYPATH: "poison",
            PYTHONPATH: "poison",
            MYPY_CACHE_DIR: "poison"
          },
          nodeWorkspace: projectWorkspace(files, () => true),
          processProbe: successfulProbe(),
          toolArgv: { mypy: [mypy] }
        })
      }).runValidation(request({ repo: { repoRoot }, checks: [PYTHON_TYPES_CHECK_ID] }));

      assert.equal(result.status, "passed", JSON.stringify(result, null, 2));
      assert.deepEqual(result.pythonCapabilityRuns[0].selectedConfigPaths, []);
      assert.equal(result.pythonCapabilityRuns[0].tool.configFile, undefined);
      assert.equal(result.pythonCapabilityRuns[0].tool.argv.some((argument) => argument.startsWith("--config-file")), true);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(poisonHome, { recursive: true, force: true });
    }
  });

  it("rejects absolute mypy_path before execution and cannot read an overlay-deleted poisoned worktree source", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-types-mypy-path-escape-"));
    try {
      writePassingPythonProtocolShim(repoRoot);
      const executed = join(repoRoot, "mypy-executed");
      writeToolShim(repoRoot, "mypy", [
        "#!/bin/sh",
        "if [ \"$1\" = \"--version\" ]; then echo 'mypy 2.3.0'; exit 0; fi",
        `/usr/bin/touch ${JSON.stringify(executed)}`,
        "exit 0",
        ""
      ].join("\n"));
      mkdirSync(join(repoRoot, "poison"), { recursive: true });
      writeFileSync(join(repoRoot, "poison", "dependency.py"), "VALUE: str = 'host-only'\n");
      const files = {
        "mypy.ini": `[mypy]\nmypy_path = ${join(repoRoot, "poison")}\n`,
        "pkg/app.py": "from dependency import VALUE\nvalue: str = VALUE\n",
        "poison/dependency.py": "VALUE: str = 'after-state'\n"
      };
      const result = await runner({
        files,
        checks: createPythonValidationChecks({
          repoRoot,
          env: { PATH: "" },
          nodeWorkspace: createNodePythonProjectWorkspace(repoRoot)
        })
      }).runValidation(request({
        repo: { repoRoot },
        checks: [PYTHON_TYPES_CHECK_ID],
        overlays: [{ path: "poison/dependency.py", action: "delete" }]
      }));

      assert.equal(result.status, "unsupported_request", JSON.stringify(result, null, 2));
      assert.equal(result.pythonCapabilityRuns[0].status, "invalid_config");
      assert.equal(result.pythonCapabilityRuns[0].execution, undefined);
      assert.match(result.diagnostics[0].message, /mypy_path.*absolute/i);
      assert.equal(existsSync(executed), false);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("rejects every configured mypy output path before execution and preserves source files", async () => {
    for (const [option, value] of [
      ["junit_xml", "source"],
      ["html_report", "source"],
      ["timing_stats", "source"],
      ["line_checking_stats", "source"],
      ["cache_dir", "source"],
      ["cache_map", "source"],
      ["mypyc_annotation_file", "source"]
    ]) {
      const isolatedRepoRoot = mkdtempSync(join(tmpdir(), `opcore-python-types-${option}-`));
      try {
        writePassingPythonProtocolShim(isolatedRepoRoot);
        const sourcePath = join(isolatedRepoRoot, "pkg", "app.py");
        const executed = join(isolatedRepoRoot, "mypy-executed");
        mkdirSync(dirname(sourcePath), { recursive: true });
        writeFileSync(sourcePath, "value: int = 1\n");
        writeToolShim(isolatedRepoRoot, "mypy", [
          "#!/bin/sh",
          "if [ \"$1\" = \"--version\" ]; then echo 'mypy 2.3.0'; exit 0; fi",
          `/usr/bin/touch ${JSON.stringify(executed)}`,
          `/usr/bin/printf 'MUTATED\\n' > ${JSON.stringify(sourcePath)}`,
          "exit 0",
          ""
        ].join("\n"));
        const configuredValue = value === "source" ? sourcePath : value;
        const files = {
          "mypy.ini": `[mypy]\n${option} = ${configuredValue}\n`,
          "pkg/app.py": "value: int = 1\n"
        };
        const result = await runner({
          files,
          checks: createPythonValidationChecks({
            repoRoot: isolatedRepoRoot,
            env: { PATH: "" },
            nodeWorkspace: createNodePythonProjectWorkspace(isolatedRepoRoot)
          })
        }).runValidation(request({ repo: { repoRoot: isolatedRepoRoot }, checks: [PYTHON_TYPES_CHECK_ID] }));

        assert.equal(result.status, "unsupported_request", `${option}: ${JSON.stringify(result, null, 2)}`);
        assert.equal(result.pythonCapabilityRuns[0].status, "invalid_config", option);
        assert.equal(result.pythonCapabilityRuns[0].execution, undefined, option);
        assert.match(result.diagnostics[0].message, new RegExp(option, "i"), option);
        assert.equal(existsSync(executed), false, option);
        assert.equal(readFileSync(sourcePath, "utf8"), "value: int = 1\n", option);
        assert.equal(JSON.stringify(result.diagnostics).includes(sourcePath), false, option);
        assert.equal(JSON.stringify(result.pythonCapabilityRuns).includes(sourcePath), false, option);
      } finally {
        rmSync(isolatedRepoRoot, { recursive: true, force: true });
      }
    }
  });

  it("rejects mypy config paths that can read or execute outside the exact after-state", async () => {
    for (const option of [
      "plugins",
      "custom_typeshed_dir",
      "python_executable",
      "quickstart_file",
      "custom_typing_module",
      "shadow_file"
    ]) {
      const isolatedRepoRoot = mkdtempSync(join(tmpdir(), `opcore-python-types-${option}-escape-`));
      const hostRoot = mkdtempSync(join(tmpdir(), `opcore-python-types-${option}-host-`));
      try {
        writePassingPythonProtocolShim(isolatedRepoRoot);
        const executed = join(isolatedRepoRoot, "mypy-executed");
        const hostPath = join(hostRoot, option === "plugins" ? "host_plugin.py" : "host-input");
        writeFileSync(hostPath, option === "plugins" ? "raise RuntimeError('host plugin executed')\n" : "host-only\n");
        writeToolShim(isolatedRepoRoot, "mypy", [
          "#!/bin/sh",
          "if [ \"$1\" = \"--version\" ]; then echo 'mypy 2.3.0'; exit 0; fi",
          `/usr/bin/touch ${JSON.stringify(executed)}`,
          "exit 0",
          ""
        ].join("\n"));
        const configuredValue = option === "custom_typing_module" ? "host_typing" : hostPath;
        const files = {
          "mypy.ini": `[mypy]\n${option} = ${configuredValue}\n`,
          "pkg/app.py": "value: int = 1\n"
        };
        const result = await runner({
          files,
          checks: createPythonValidationChecks({
            repoRoot: isolatedRepoRoot,
            env: { PATH: "" },
            nodeWorkspace: createNodePythonProjectWorkspace(isolatedRepoRoot)
          })
        }).runValidation(request({ repo: { repoRoot: isolatedRepoRoot }, checks: [PYTHON_TYPES_CHECK_ID] }));

        assert.equal(result.status, "unsupported_request", `${option}: ${JSON.stringify(result, null, 2)}`);
        assert.equal(result.pythonCapabilityRuns[0].status, "invalid_config", option);
        assert.equal(result.pythonCapabilityRuns[0].execution, undefined, option);
        assert.match(result.diagnostics[0].message, new RegExp(option, "i"), option);
        assert.equal(existsSync(executed), false, option);
        assert.equal(JSON.stringify(result.diagnostics).includes(hostRoot), false, option);
        assert.equal(JSON.stringify(result.pythonCapabilityRuns).includes(hostRoot), false, option);
      } finally {
        rmSync(isolatedRepoRoot, { recursive: true, force: true });
        rmSync(hostRoot, { recursive: true, force: true });
      }
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

    assert.equal(result.status, "passed", JSON.stringify(result, null, 2));
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

      assert.equal(result.status, "passed", JSON.stringify(result, null, 2));
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
        assert.equal(result.status, "infrastructure_failure", `${testCase.name}: ${JSON.stringify(result, null, 2)}`);
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
        checks: createPythonValidationChecks({ repoRoot, env: { PATH: "" }, checker: "mypy" })
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

  it("fails python.types when a nonzero checker result contains no parseable diagnostics", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-types-malformed-"));
    try {
      writePassingPythonProtocolShim(repoRoot);
      writeToolShim(repoRoot, "mypy", "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'mypy 1.8.0'; exit 0; fi\necho 'unknown failure'\nexit 1\n");
      const result = await runner({
        files: { "pkg/app.py": "value: int = 1\n" },
        checks: createPythonValidationChecks({ repoRoot, env: { PATH: "" }, checker: "mypy" })
      }).runValidation(request({ repo: { repoRoot }, checks: [PYTHON_TYPES_CHECK_ID] }));

      assert.equal(result.status, "infrastructure_failure");
      assert.equal(result.manifest.runs[0].outcome, "tool_failure");
      assert.deepEqual(result.diagnostics.map((entry) => entry.code), ["PYTHON_TYPES_TOOL_FAILED"]);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("runs opt-in Ruff lint and records a portable receipt", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-ruff-lint-"));
    try {
      writePassingPythonProtocolShim(repoRoot);
      writeToolShim(
        repoRoot,
        "ruff",
        [
          "#!/bin/sh",
          "if [ \"$1\" = \"--version\" ]; then echo 'ruff 0.6.9'; exit 0; fi",
          "if [ \"$1\" = \"check\" ]; then",
          "  printf '%s\\n' '[{\"code\":\"F401\",\"filename\":\"pkg/app.py\",\"location\":{\"row\":1,\"column\":8},\"end_location\":{\"row\":1,\"column\":10},\"message\":\"unused import\"}]'",
          "  exit 1",
          "fi",
          "exit 2",
          ""
        ].join("\n")
      );

      const result = await runner({
        files: {
          "pkg/app.py": "value = 1\n",
          "ruff.toml": "[lint]\nselect = [\"F401\"]\n"
        },
        checks: createPythonValidationChecks({ repoRoot, env: { PATH: "" } })
      }).runValidation(
        request({
          repo: { repoRoot },
          checks: [PYTHON_RUFF_LINT_CHECK_ID],
          overlays: [{ path: "pkg/app.py", action: "write", content: "import os\n" }]
        })
      );

      assert.equal(result.status, "policy_failure");
      assert.deepEqual(result.diagnostics.map((entry) => entry.code), ["PY_RUFF_LINT_F401"]);
      const receipt = result.manifest.runs[0].pythonCapabilityRuns?.[0];
      assert.equal(receipt?.checkId, PYTHON_RUFF_LINT_CHECK_ID);
      assert.equal(receipt?.capability, "ruff_lint");
      assert.equal(receipt?.state, "findings");
      assert.equal(receipt?.cwd, ".");
      assert.deepEqual(receipt?.sourcePaths, ["pkg/app.py"]);
      assert.deepEqual(receipt?.configPaths, ["ruff.toml"]);
      assert.equal(receipt?.argv.includes("check"), true);
      assert.equal(receipt?.argv.includes("pkg/app.py"), true);
      assert.equal(receipt?.configPath, "ruff.toml");
      assert.equal(receipt?.termination, "exited");
      assert.equal(receipt?.exitCode, 1);
      assert.equal(receipt?.diagnosticCount, 1);
      assert.match(receipt?.afterStateManifestFingerprint ?? "", /^sha256:[a-f0-9]{64}$/);
      assert.equal(receipt?.executable, "repo:.venv/bin/ruff");
      assert.equal(receipt?.argv?.[0], "repo:.venv/bin/ruff");
      assert.equal(receipt?.invocations?.every((invocation) => invocation.argv[0] === "repo:.venv/bin/ruff"), true);
      assert.equal(JSON.stringify(receipt).includes(repoRoot), false);
      assert.equal((receipt?.command ?? "").includes("opcore-python-check"), false);
      assert.equal(receipt?.argv.includes("--no-fix"), true);
      assert.equal(receipt?.argv.includes("--no-cache"), true);
      assert.equal(result.diagnostics[0].tool?.command, receipt?.command);
      assert.equal(result.diagnostics[0].tool?.cwd, receipt?.cwd);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("maps Ruff syntax diagnostics with null codes to deterministic findings", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-ruff-null-code-"));
    try {
      writePassingPythonProtocolShim(repoRoot);
      writeToolShim(
        repoRoot,
        "ruff",
        [
          "#!/bin/sh",
          "if [ \"$1\" = \"--version\" ]; then echo 'ruff 0.6.9'; exit 0; fi",
          "if [ \"$1\" = \"check\" ]; then",
          "  printf '%s\\n' '[{\"cell\":null,\"code\":null,\"end_location\":{\"column\":1,\"row\":2},\"filename\":\"pkg/app.py\",\"fix\":null,\"location\":{\"column\":12,\"row\":1},\"message\":\"SyntaxError: Expected \\\")\\\", found newline\",\"noqa_row\":null,\"url\":null}]'",
          "  exit 1",
          "fi",
          "exit 2",
          ""
        ].join("\n")
      );

      const result = await runner({
        files: {
          "pkg/app.py": "print(\"oops\"\\n",
          "ruff.toml": "target-version = \"py38\"\n"
        },
        checks: createPythonValidationChecks({ repoRoot, env: { PATH: "" } })
      }).runValidation(
        request({
          repo: { repoRoot },
          checks: [PYTHON_RUFF_LINT_CHECK_ID]
        })
      );

      assert.equal(result.status, "policy_failure", JSON.stringify(result, null, 2));
      assert.deepEqual(result.diagnostics.map((entry) => entry.code), ["PY_RUFF_LINT_SYNTAX_ERROR"]);
      assert.equal(result.diagnostics[0].line, 1);
      assert.equal(result.diagnostics[0].column, 12);
      assert.equal(result.manifest.runs[0].outcome, "findings");
      const receipt = result.manifest.runs[0].pythonCapabilityRuns?.[0];
      assert.equal(receipt?.state, "findings");
      assert.equal(receipt?.diagnosticCount, 1);
      assert.equal(receipt?.exitCode, 1);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("runs Ruff without Python and keeps standalone Ruff status available", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-ruff-no-interpreter-"));
    try {
      writeToolShim(
        repoRoot,
        "ruff",
        [
          "#!/bin/sh",
          "if [ \"$1\" = \"--version\" ]; then echo 'ruff 0.6.9'; exit 0; fi",
          "if [ \"$1\" = \"check\" ]; then printf '%s\\n' '[]'; exit 0; fi",
          "exit 2",
          ""
        ].join("\n")
      );

      const result = await runner({
        files: {
          "pyproject.toml": "[project]\nname='fixture'\n[tool.mypy]\n",
          "pkg/app.py": "value = 1\n"
        },
        checks: createPythonValidationChecks({ repoRoot, env: { PATH: "" } })
      }).runValidation(
        request({
          repo: { repoRoot },
          checks: [PYTHON_RUFF_LINT_CHECK_ID]
        })
      );

      assert.equal(result.status, "passed");
      assert.equal(result.pythonProjectContexts[0].outcome, "unsupported");
      assert.equal(
        result.pythonProjectContexts[0].reasons.some((reason) => reason.code === "interpreter_unavailable"),
        true
      );
      assert.equal(
        result.pythonProjectContexts[0].tools.some((tool) => tool.tool === "ruff" && tool.available),
        true
      );
      assert.equal(result.manifest.runs[0].pythonCapabilityRuns?.[0]?.state, "passed");

      const status = createPythonValidationAdapterStatus({
        contexts: result.pythonProjectContexts,
        activeCheckIds: [PYTHON_RUFF_LINT_CHECK_ID]
      });
      assert.equal(status.status, "available");
      assert.deepEqual(status.degradedChecks, []);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("does not attribute malformed mypy, Pyright, or pytest config to a Ruff-only run", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-ruff-unrelated-config-"));
    try {
      writeToolShim(
        repoRoot,
        "ruff",
        [
          "#!/bin/sh",
          "if [ \"$1\" = \"--version\" ]; then echo 'ruff 0.6.9'; exit 0; fi",
          "if [ \"$1\" = \"check\" ]; then printf '%s\\n' '[]'; exit 0; fi",
          "exit 2",
          ""
        ].join("\n")
      );

      const result = await runner({
        files: {
          "pkg/app.py": "value = 1\n",
          "pyproject.toml": "[tool.mypy]\npython_version = [\n",
          "mypy.ini": "option-before-section = true\n",
          "pyrightconfig.json": "{not-json\n",
          "pytest.ini": "option-before-section = true\n"
        },
        checks: createPythonValidationChecks({ repoRoot, env: { PATH: "" } })
      }).runValidation(request({
        repo: { repoRoot },
        checks: [PYTHON_RUFF_LINT_CHECK_ID],
        scope: { kind: "files", files: ["pkg/app.py"] }
      }));

      assert.equal(result.status, "passed", JSON.stringify(result, null, 2));
      assert.equal(result.manifest.runs[0].pythonCapabilityRuns?.[0]?.state, "passed");
      assert.deepEqual(
        [...new Set(result.pythonProjectContexts[0].reasons
          .filter((reason) => reason.code === "invalid_config")
          .map((reason) => reason.tool)
          .filter((tool) => tool !== undefined))].sort(),
        []
      );
      assert.equal(
        result.pythonProjectContexts[0].reasons.some((reason) =>
          reason.code === "invalid_config" && reason.tool === "ruff"
        ),
        false
      );
      assert.equal(
        result.pythonProjectContexts[0].tools.find((tool) => tool.tool === "ruff")?.configFile,
        undefined
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("ignores top-level pyproject extend while honoring the selected tool.ruff table", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-ruff-pyproject-extend-"));
    try {
      writeToolShim(
        repoRoot,
        "ruff",
        [
          "#!/bin/sh",
          "if [ \"$1\" = \"--version\" ]; then echo 'ruff 0.6.9'; exit 0; fi",
          "if [ \"$1\" = \"check\" ]; then printf '%s\\n' '[]'; exit 0; fi",
          "exit 2",
          ""
        ].join("\n")
      );
      const result = await runner({
        files: {
          "pyproject.toml": [
            "extend = \"../unrelated.toml\"",
            "[project]",
            "name = \"fixture\"",
            "[tool.ruff]",
            "line-length = 99",
            ""
          ].join("\n"),
          "pkg/app.py": "value = 1\n"
        },
        checks: createPythonValidationChecks({ repoRoot, env: { PATH: "" } })
      }).runValidation(request({
        repo: { repoRoot },
        checks: [PYTHON_RUFF_LINT_CHECK_ID],
        scope: { kind: "files", files: ["pkg/app.py"] }
      }));

      assert.equal(result.status, "passed", JSON.stringify(result, null, 2));
      assert.deepEqual(result.manifest.runs[0].pythonCapabilityRuns?.[0]?.configPaths, ["pyproject.toml"]);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("materializes overlay-aware Ruff extend config outside a nested project boundary", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-ruff-extend-"));
    try {
      writePassingPythonProtocolShim(join(repoRoot, "apps/api"));
      writeToolShim(
        join(repoRoot, "apps/api"),
        "ruff",
        [
          "#!/bin/sh",
          "if [ \"$1\" = \"--version\" ]; then echo 'ruff 0.6.9'; exit 0; fi",
          "if [ \"$1\" = \"--config\" ]; then shift 2; fi",
          "IFS= read -r extended_line < ../../config/base-style.toml",
          "if [ \"$1\" = \"check\" ] && [ \"$extended_line\" = 'line-length = 99' ]; then",
          "  printf '%s\\n' '[]'",
          "  exit 0",
          "fi",
          "exit 2",
          ""
        ].join("\n")
      );

      const result = await runner({
        files: {
          "apps/api/pyproject.toml": "[project]\nname = 'api'\n",
          "apps/api/ruff.toml": "extend = \"../../config/base-style.toml\"\n",
          "apps/api/src/app.py": "VALUE = 1\n",
          "config/base-style.toml": "line-length = 88\n"
        },
        checks: createPythonValidationChecks({ repoRoot, env: { PATH: "" } })
      }).runValidation(request({
        repo: { repoRoot },
        checks: [PYTHON_RUFF_LINT_CHECK_ID],
        scope: { kind: "files", files: ["apps/api/src/app.py"] },
        overlays: [{ path: "config/base-style.toml", action: "write", content: "line-length = 99\n" }]
      }));

      assert.equal(result.status, "passed", JSON.stringify(result, null, 2));
      const receipt = result.manifest.runs[0].pythonCapabilityRuns?.[0];
      assert.deepEqual(receipt?.configPaths, [
        "apps/api/ruff.toml",
        "config/base-style.toml"
      ]);
      assert.equal(receipt?.state, "passed");
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("materializes only the selected Ruff extend chain and ignores unrelated sibling config", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-ruff-absolute-extend-"));
    try {
      writePassingPythonProtocolShim(repoRoot);
      writeToolShim(
        repoRoot,
        "ruff",
        [
          "#!/bin/sh",
          "if [ \"$1\" = \"--version\" ]; then echo 'ruff 0.6.9'; exit 0; fi",
          "IFS= read -r root_extend < ruff.toml",
          "IFS= read -r base_extend < config/base-style.toml",
          "IFS= read -r final_style < config/final-style.toml",
          "if [ \"$1\" = \"check\" ] &&",
          "   [ \"$root_extend\" = 'extend = \"config/base-style.toml\"' ] &&",
          "   [ \"$base_extend\" = 'extend = \"final-style.toml\"' ] &&",
          "   [ \"$final_style\" = 'line-length = 99' ]; then",
          "  printf '%s\\n' '[]'",
          "  exit 0",
          "fi",
          "exit 2",
          ""
        ].join("\n")
      );
      const absoluteBase = join(repoRoot, "config/base-style.toml");
      const absoluteFinal = join(repoRoot, "config/final-style.toml");
      const result = await runner({
        files: {
          "pyproject.toml": "[project]\nname = 'absolute-extend'\n",
          "ruff.toml": `extend = ${JSON.stringify(absoluteBase)}\n`,
          "config/base-style.toml": `extend = ${JSON.stringify(absoluteFinal)}\n`,
          "config/final-style.toml": "line-length = 88\n",
          "other/ruff.toml": "extend = \"/outside/does-not-exist.toml\"\n",
          "pkg/app.py": "VALUE = 1\n"
        },
        checks: createPythonValidationChecks({ repoRoot, env: { PATH: "" } })
      }).runValidation(request({
        repo: { repoRoot },
        checks: [PYTHON_RUFF_LINT_CHECK_ID],
        scope: { kind: "files", files: ["pkg/app.py"] },
        overlays: [{ path: "config/final-style.toml", action: "write", content: "line-length = 99\n" }]
      }));

      assert.equal(result.status, "passed", JSON.stringify(result, null, 2));
      const receipt = result.manifest.runs[0].pythonCapabilityRuns?.[0];
      assert.deepEqual(receipt?.configPaths, [
        "config/base-style.toml",
        "config/final-style.toml",
        "ruff.toml"
      ]);
      assert.equal(receipt?.state, "passed");
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("partitions Ruff execution by each target's closest configuration", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-ruff-target-config-"));
    try {
      writeToolShim(
        repoRoot,
        "ruff",
        [
          "#!/bin/sh",
          "if [ \"$1\" = \"--version\" ]; then echo 'ruff 0.6.9'; exit 0; fi",
          "case \" $* \" in",
          "  *' pkg/app.py '*)",
          "    /usr/bin/grep -q '^line-length = 99$' pkg/ruff.toml || exit 9",
          "    [ ! -e ruff.toml ] || exit 9",
          "    printf '%s\\n' '[{\"code\":\"F401\",\"filename\":\"pkg/app.py\",\"location\":{\"row\":1,\"column\":1},\"message\":\"nested config\"}]'",
          "    exit 1",
          "    ;;",
          "  *' root.py '*)",
          "    /usr/bin/grep -q '^line-length = 88$' ruff.toml || exit 9",
          "    [ ! -e pkg/ruff.toml ] || exit 9",
          "    printf '%s\\n' '[]'",
          "    exit 0",
          "    ;;",
          "esac",
          "exit 9",
          ""
        ].join("\n")
      );
      const result = await runner({
        files: {
          "ruff.toml": "line-length = 88\n",
          "root.py": "ROOT = 1\n",
          "pkg/ruff.toml": "line-length = 99\n",
          "pkg/app.py": "APP = 1\n"
        },
        checks: createPythonValidationChecks({ repoRoot, env: { PATH: "" } })
      }).runValidation(request({
        repo: { repoRoot },
        checks: [PYTHON_RUFF_LINT_CHECK_ID],
        scope: { kind: "files", files: ["root.py", "pkg/app.py"] }
      }));

      assert.equal(result.status, "policy_failure", JSON.stringify(result, null, 2));
      assert.deepEqual(result.diagnostics.map((entry) => entry.path), ["pkg/app.py"]);
      assert.deepEqual(
        result.manifest.runs[0].pythonCapabilityRuns?.map((receipt) => receipt.configPaths),
        [["pkg/ruff.toml"], ["ruff.toml"]]
      );
      assert.deepEqual(
        result.pythonProjectContexts.map((context) => [
          context.target,
          context.tools.find((tool) => tool.tool === "ruff")?.configFile
        ]),
        [["pkg/app.py", "pkg/ruff.toml"], ["root.py", "ruff.toml"]]
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("uses the closest ancestor Ruff config across a nested project boundary", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-ruff-ancestor-config-"));
    try {
      writeToolShim(
        join(repoRoot, "services/api"),
        "ruff",
        [
          "#!/bin/sh",
          "if [ \"$1\" = \"--version\" ]; then echo 'ruff 0.6.9'; exit 0; fi",
          "if [ \"$1\" = \"check\" ] && /usr/bin/grep -q 'E501' ../../ruff.toml; then",
          "  printf '%s\\n' '[{\"code\":\"E501\",\"filename\":\"app.py\",\"location\":{\"row\":1,\"column\":89},\"message\":\"line too long\"}]'",
          "  exit 1",
          "fi",
          "printf '%s\\n' '[]'",
          "exit 0",
          ""
        ].join("\n")
      );
      const result = await runner({
        files: {
          "ruff.toml": "[lint]\nselect = [\"E501\"]\n",
          "services/api/pyproject.toml": "[project]\nname = \"api\"\n",
          "services/api/app.py": `${"x".repeat(100)}\n`
        },
        checks: createPythonValidationChecks({
          repoRoot,
          env: { PATH: "" },
          nodeWorkspace: createNodePythonProjectWorkspace(repoRoot)
        })
      }).runValidation(request({
        repo: { repoRoot },
        checks: [PYTHON_RUFF_LINT_CHECK_ID],
        scope: { kind: "files", files: ["services/api/app.py"] }
      }));

      assert.equal(result.status, "policy_failure", JSON.stringify(result, null, 2));
      assert.deepEqual(result.diagnostics.map((entry) => entry.code), ["PY_RUFF_LINT_E501"]);
      assert.equal(
        result.pythonProjectContexts[0].tools.find((tool) => tool.tool === "ruff")?.configFile,
        "ruff.toml"
      );
      assert.deepEqual(result.manifest.runs[0].pythonCapabilityRuns?.[0]?.configPaths, ["ruff.toml"]);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("executes nested explicit Ruff config overrides after the subcommand with the materialized ancestor path", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-ruff-explicit-config-"));
    const projectRoot = join(repoRoot, "services/api");
    try {
      writeToolShim(
        projectRoot,
        "ruff",
        [
          "#!/bin/sh",
          "if [ \"$1\" = \"--version\" ]; then echo 'ruff 0.6.9'; exit 0; fi",
          "if [ \"$1\" = \"check\" ] && [ \"$2\" = \"--config\" ] && [ \"$3\" = \"../../ruff.toml\" ]; then",
          "  printf '%s\\n' '[]'",
          "  exit 0",
          "fi",
          "if [ \"$1\" = \"format\" ] && [ \"$2\" = \"--config\" ] && [ \"$3\" = \"../../ruff.toml\" ]; then",
          "  exit 0",
          "fi",
          "exit 9",
          ""
        ].join("\n")
      );
      const ruff = join(projectRoot, ".venv/bin/ruff");
      const result = await runner({
        files: {
          "ruff.toml": "line-length = 88\n",
          "services/api/pyproject.toml": "[project]\nname = \"api\"\n",
          "services/api/app.py": "VALUE = 1\n"
        },
        checks: createPythonValidationChecks({
          repoRoot,
          env: { PATH: "" },
          nodeWorkspace: createNodePythonProjectWorkspace(repoRoot),
          toolArgv: { ruff: [ruff, "--config", "../../ruff.toml"] }
        })
      }).runValidation(request({
        repo: { repoRoot },
        checks: [PYTHON_RUFF_LINT_CHECK_ID, PYTHON_RUFF_FORMAT_CHECK_ID],
        scope: { kind: "files", files: ["services/api/app.py"] }
      }));

      assert.equal(result.status, "passed", JSON.stringify(result, null, 2));
      const runs = new Map(result.manifest.runs.map((run) => [run.checkId, run]));
      assert.deepEqual(
        runs.get(PYTHON_RUFF_LINT_CHECK_ID)?.pythonCapabilityRuns?.[0]?.argv?.slice(1, 4),
        ["check", "--config", "../../ruff.toml"]
      );
      assert.deepEqual(
        runs.get(PYTHON_RUFF_FORMAT_CHECK_ID)?.pythonCapabilityRuns?.[0]?.argv?.slice(1, 4),
        ["format", "--config", "../../ruff.toml"]
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("rejects Ruff lint diagnostics outside the selected after-state source set", async () => {
    for (const [id, filename] of [
      ["outside", "/etc/passwd"],
      ["unselected", "pkg/unselected.py"]
    ]) {
      const repoRoot = mkdtempSync(join(tmpdir(), `opcore-python-ruff-output-${id}-`));
      try {
        writeToolShim(
          repoRoot,
          "ruff",
          [
            "#!/bin/sh",
            "if [ \"$1\" = \"--version\" ]; then echo 'ruff 0.6.9'; exit 0; fi",
            `printf '%s\\n' ${JSON.stringify(JSON.stringify([{
              code: "F401",
              filename,
              location: { row: 1, column: 1 },
              message: "unauthorized path"
            }]))}`,
            "exit 1",
            ""
          ].join("\n")
        );
        const result = await runner({
          files: {
            "pkg/app.py": "APP = 1\n",
            "pkg/unselected.py": "UNSELECTED = 1\n"
          },
          checks: createPythonValidationChecks({ repoRoot, env: { PATH: "" } })
        }).runValidation(request({
          repo: { repoRoot },
          checks: [PYTHON_RUFF_LINT_CHECK_ID],
          scope: { kind: "files", files: ["pkg/app.py"] }
        }));

        assert.equal(result.status, "infrastructure_failure", `${id}: ${JSON.stringify(result, null, 2)}`);
        assert.equal(result.manifest.runs[0].outcome, "tool_failure");
        assert.deepEqual(result.diagnostics.map((entry) => entry.code), ["PY_RUFF_LINT_TOOL_FAILED"]);
        assert.equal(JSON.stringify(result).includes(filename), false);
      } finally {
        rmSync(repoRoot, { recursive: true, force: true });
      }
    }
  });

  it("keeps unrelated refused tool configuration from disabling a Ruff-only run", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-ruff-refusal-scope-"));
    try {
      writeToolShim(
        repoRoot,
        "ruff",
        [
          "#!/bin/sh",
          "if [ \"$1\" = \"--version\" ]; then echo 'ruff 0.6.9'; exit 0; fi",
          "printf '%s\\n' '[]'",
          "exit 0",
          ""
        ].join("\n")
      );
      const files = {
        "mypy.ini": "[mypy]\nstrict = true\n",
        "ruff.toml": "line-length = 88\n",
        "pkg/app.py": "APP = 1\n"
      };
      const result = await runner({
        files,
        checks: createPythonValidationChecks({
          repoRoot,
          env: { PATH: "" },
          nodeWorkspace: projectWorkspace(files, () => true, new Set(["mypy.ini"]))
        })
      }).runValidation(request({
        repo: { repoRoot },
        checks: [PYTHON_RUFF_LINT_CHECK_ID],
        scope: { kind: "files", files: ["pkg/app.py"] }
      }));

      assert.equal(result.status, "passed", JSON.stringify(result, null, 2));
      assert.equal(result.manifest.runs[0].pythonCapabilityRuns?.[0]?.state, "passed");
      assert.equal(
        result.pythonProjectContexts[0].reasons.some((reason) => reason.tool === "mypy"),
        false
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("isolates Ruff execution from poisoned host paths and Python state", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-ruff-host-isolation-"));
    const poisonRoot = mkdtempSync(join(tmpdir(), "opcore-python-ruff-poison-"));
    try {
      writeToolShim(
        repoRoot,
        "ruff",
        [
          "#!/bin/sh",
          "if [ \"$1\" = \"--version\" ]; then echo 'ruff 0.6.9'; exit 0; fi",
          `case \"$HOME:$XDG_CONFIG_HOME:$XDG_CACHE_HOME:$TMPDIR:$PATH:$PYTHONPATH\" in *${poisonRoot}*) exit 9 ;; esac`,
          "[ \"$PYTHONNOUSERSITE\" = 1 ] || exit 9",
          "[ \"$PYTHONDONTWRITEBYTECODE\" = 1 ] || exit 9",
          "[ \"$PWD\" = \"$(pwd)\" ] || exit 9",
          "[ \"$RUFF_CACHE_DIR\" = \"${TMPDIR%/tmp}/ruff-cache\" ] || exit 9",
          "printf '%s\\n' '[]'",
          "exit 0",
          ""
        ].join("\n")
      );
      const result = await runner({
        files: { "pkg/app.py": "APP = 1\n" },
        checks: createPythonValidationChecks({
          repoRoot,
          env: {
            PATH: poisonRoot,
            HOME: poisonRoot,
            XDG_CONFIG_HOME: poisonRoot,
            XDG_CACHE_HOME: poisonRoot,
            TMPDIR: poisonRoot,
            PYTHONPATH: poisonRoot
          }
        })
      }).runValidation(request({
        repo: { repoRoot },
        checks: [PYTHON_RUFF_LINT_CHECK_ID],
        scope: { kind: "files", files: ["pkg/app.py"] }
      }));

      assert.equal(result.status, "passed", JSON.stringify(result, null, 2));
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(poisonRoot, { recursive: true, force: true });
    }
  });

  it("attributes malformed pyproject Ruff dotted, quoted, and inline declarations", async () => {
    const declarations = [
      "tool.ruff = { line-length = 88 }",
      "\"tool\".\"ruff\" = { line-length = 88 }",
      "tool = { ruff = { line-length = 88 } }"
    ];
    for (const [index, declaration] of declarations.entries()) {
      const repoRoot = mkdtempSync(join(tmpdir(), `opcore-python-ruff-declaration-${index}-`));
      const markerPath = join(repoRoot, "ruff-check-executed");
      try {
        writeToolShim(
          repoRoot,
          "ruff",
          [
            "#!/bin/sh",
            "if [ \"$1\" = \"--version\" ]; then echo 'ruff 0.6.9'; exit 0; fi",
            `printf executed > ${JSON.stringify(markerPath)}`,
            "printf '%s\\n' '[]'",
            "exit 0",
            ""
          ].join("\n")
        );
        const result = await runner({
          files: {
            "pyproject.toml": `${declaration}\nBROKEN = [\n`,
            "pkg/app.py": "APP = 1\n"
          },
          checks: createPythonValidationChecks({ repoRoot, env: { PATH: "" } })
        }).runValidation(request({
          repo: { repoRoot },
          checks: [PYTHON_RUFF_LINT_CHECK_ID],
          scope: { kind: "files", files: ["pkg/app.py"] }
        }));

        assert.equal(result.status, "unsupported_request", `${declaration}: ${JSON.stringify(result, null, 2)}`);
        assert.equal(result.manifest.runs[0].outcome, "invalid_config");
        assert.equal(result.manifest.runs[0].pythonCapabilityRuns?.[0]?.configPath, "pyproject.toml");
        assert.equal(existsSync(markerPath), false);
      } finally {
        rmSync(repoRoot, { recursive: true, force: true });
      }
    }
  });

  it("fails closed before execution when an absolute Ruff extend escapes the after-state repository", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-ruff-external-extend-"));
    const markerPath = join(repoRoot, "ruff-check-executed");
    try {
      writePassingPythonProtocolShim(repoRoot);
      writeToolShim(
        repoRoot,
        "ruff",
        [
          "#!/bin/sh",
          "if [ \"$1\" = \"--version\" ]; then echo 'ruff 0.6.9'; exit 0; fi",
          `printf executed > '${markerPath}'`,
          "exit 0",
          ""
        ].join("\n")
      );
      const result = await runner({
        files: {
          "ruff.toml": "extend = \"/outside/opcore-style.toml\"\n",
          "pkg/app.py": "VALUE = 1\n"
        },
        checks: createPythonValidationChecks({ repoRoot, env: { PATH: "" } })
      }).runValidation(request({
        repo: { repoRoot },
        checks: [PYTHON_RUFF_LINT_CHECK_ID],
        scope: { kind: "files", files: ["pkg/app.py"] }
      }));

      assert.equal(result.status, "unsupported_request", JSON.stringify(result, null, 2));
      assert.equal(result.manifest.runs[0].outcome, "invalid_config");
      assert.equal(result.manifest.runs[0].pythonCapabilityRuns?.[0]?.state, "invalid_config");
      assert.deepEqual(result.diagnostics.map((entry) => entry.code), ["PY_RUFF_LINT_INVALID_CONFIG"]);
      assert.equal(existsSync(markerPath), false);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("fails closed before reading a Ruff extend symlink that resolves outside the repository", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-ruff-symlink-extend-"));
    const externalRoot = mkdtempSync(join(tmpdir(), "opcore-python-ruff-symlink-external-"));
    const markerPath = join(repoRoot, "ruff-check-executed");
    try {
      mkdirSync(join(repoRoot, "config"), { recursive: true });
      writeFileSync(join(externalRoot, "base.toml"), "line-length = 200\n");
      symlinkSync(join(externalRoot, "base.toml"), join(repoRoot, "config/base.toml"));
      writeToolShim(
        repoRoot,
        "ruff",
        [
          "#!/bin/sh",
          "if [ \"$1\" = \"--version\" ]; then echo 'ruff 0.6.9'; exit 0; fi",
          `printf executed > '${markerPath}'`,
          "exit 0",
          ""
        ].join("\n")
      );
      const result = await runner({
        files: {
          "ruff.toml": "extend = \"config/base.toml\"\n",
          "config/base.toml": "line-length = 200\n",
          "pkg/app.py": "VALUE = 1\n"
        },
        checks: createPythonValidationChecks({
          repoRoot,
          env: { PATH: "" },
          nodeWorkspace: createNodePythonProjectWorkspace(repoRoot)
        })
      }).runValidation(request({
        repo: { repoRoot },
        checks: [PYTHON_RUFF_LINT_CHECK_ID],
        scope: { kind: "files", files: ["pkg/app.py"] }
      }));

      assert.equal(result.status, "unsupported_request", JSON.stringify(result, null, 2));
      assert.equal(result.manifest.runs[0].outcome, "invalid_config");
      assert.deepEqual(result.diagnostics.map((entry) => entry.code), ["PY_RUFF_LINT_INVALID_CONFIG"]);
      assert.match(result.diagnostics[0].message, /symlinked Ruff configuration path/i);
      assert.equal(existsSync(markerPath), false);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(externalRoot, { recursive: true, force: true });
    }
  });

  it("Ruff activation: records not_applicable receipts with zero Ruff processes when unrequested", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-ruff-inactive-"));
    const markerPath = join(repoRoot, "ruff-called");
    try {
      writePassingPythonProtocolShim(repoRoot);
      writeToolShim(
        repoRoot,
        "ruff",
        [
          "#!/bin/sh",
          `printf 'called' > '${markerPath}'`,
          "exit 1",
          ""
        ].join("\n")
      );
      const result = await runner({
        files: { "pkg/app.py": "value = 1\n" },
        checks: createPythonValidationChecks({ repoRoot, env: { PATH: "" } })
      }).runValidation(
        request({
          repo: { repoRoot },
          checks: [PYTHON_SOURCE_HYGIENE_CHECK_ID]
        })
      );

      assert.equal(result.status, "passed");
      const lintRun = result.manifest.runs.find((run) => run.checkId === PYTHON_RUFF_LINT_CHECK_ID);
      const formatRun = result.manifest.runs.find((run) => run.checkId === PYTHON_RUFF_FORMAT_CHECK_ID);
      assert.equal(lintRun?.status, "skipped");
      assert.equal(lintRun?.pythonCapabilityRuns?.[0]?.state, "not_applicable");
      assert.equal(lintRun?.pythonCapabilityRuns?.[0]?.diagnosticCount, 0);
      assert.equal(formatRun?.status, "skipped");
      assert.equal(formatRun?.pythonCapabilityRuns?.[0]?.state, "not_applicable");
      assert.equal(formatRun?.pythonCapabilityRuns?.[0]?.diagnosticCount, 0);
      assert.equal(existsSync(markerPath), false);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("records deleted-only Ruff scope as not applicable without probing or executing Ruff", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-ruff-deleted-only-"));
    const markerPath = join(repoRoot, "ruff-called");
    try {
      writeToolShim(
        repoRoot,
        "ruff",
        [
          "#!/bin/sh",
          `printf called > '${markerPath}'`,
          "exit 1",
          ""
        ].join("\n")
      );
      const result = await runner({
        files: { "pkg/app.py": "VALUE = 1\n" },
        checks: createPythonValidationChecks({ repoRoot, env: { PATH: "" } })
      }).runValidation(request({
        repo: { repoRoot },
        checks: [PYTHON_RUFF_LINT_CHECK_ID],
        scope: { kind: "files", files: ["pkg/app.py"] },
        overlays: [{ path: "pkg/app.py", action: "delete" }]
      }));

      const run = result.manifest.runs.find((entry) => entry.checkId === PYTHON_RUFF_LINT_CHECK_ID);
      assert.equal(run?.status, "skipped", JSON.stringify(result, null, 2));
      assert.equal(run?.pythonCapabilityRuns?.[0]?.state, "not_applicable");
      assert.equal(run?.pythonCapabilityRuns?.[0]?.durationMs, 0);
      assert.equal(existsSync(markerPath), false);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("refines Ruff format drift to the exact file set and records a findings receipt", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-ruff-format-"));
    try {
      writePassingPythonProtocolShim(repoRoot);
      writeToolShim(
        repoRoot,
        "ruff",
        [
          "#!/bin/sh",
          "if [ \"$1\" = \"--version\" ]; then echo 'ruff 0.6.9'; exit 0; fi",
          "if [ \"$1\" = \"format\" ]; then",
          "  shift",
          "  for arg in \"$@\"; do",
          "    case \"$arg\" in",
          "      *pkg/bad.py) exit 1 ;;",
          "    esac",
          "  done",
          "  exit 0",
          "fi",
          "exit 2",
          ""
        ].join("\n")
      );

      const result = await runner({
        files: {
          "pkg/good.py": "value = 1\n",
          "pkg/bad.py": "value=1\n"
        },
        checks: createPythonValidationChecks({ repoRoot, env: { PATH: "" } })
      }).runValidation(
        request({
          repo: { repoRoot },
          checks: [PYTHON_RUFF_FORMAT_CHECK_ID],
          scope: { kind: "files", files: ["pkg/good.py", "pkg/bad.py"] }
        })
      );

      assert.equal(result.status, "policy_failure");
      assert.deepEqual(result.diagnostics.map((entry) => entry.code), ["PY_RUFF_FORMAT_DRIFT"]);
      assert.deepEqual(result.diagnostics.map((entry) => entry.path), ["pkg/bad.py"]);
      const receipt = result.manifest.runs[0].pythonCapabilityRuns?.[0];
      assert.equal(receipt?.capability, "ruff_format");
      assert.equal(receipt?.state, "findings");
      assert.equal(receipt?.termination, "exited");
      assert.equal(receipt?.exitCode, 1);
      assert.equal(receipt?.diagnosticCount, 1);
      assert.deepEqual(receipt?.sourcePaths, ["pkg/bad.py", "pkg/good.py"]);
      assert.equal(receipt?.argv.includes("format"), true);
      assert.equal(receipt?.argv.includes("pkg/bad.py"), true);
      assert.equal(receipt?.argv.includes("pkg/good.py"), true);
      assert.equal(receipt?.argv.includes("--no-cache"), true);
      assert.equal(receipt?.invocations?.length, 3);
      assert.equal(receipt?.invocations?.every((invocation) => invocation.termination === "exited"), true);
      assert.equal(result.diagnostics[0].tool?.command, receipt?.command);
      assert.equal(result.diagnostics[0].tool?.cwd, receipt?.cwd);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("bounds Ruff format argv batches before refinement", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-ruff-format-batches-"));
    const markerPath = join(repoRoot, "format-invocations");
    try {
      writePassingPythonProtocolShim(repoRoot);
      writeToolShim(
        repoRoot,
        "ruff",
        [
          "#!/bin/sh",
          "if [ \"$1\" = \"--version\" ]; then echo 'ruff 0.6.9'; exit 0; fi",
          `if [ \"$1\" = \"format\" ]; then printf x >> '${markerPath}'; exit 0; fi`,
          "exit 2",
          ""
        ].join("\n")
      );
      const files = Object.fromEntries(
        Array.from({ length: 65 }, (_, index) => [`pkg/file_${String(index).padStart(2, "0")}.py`, "VALUE = 1\n"])
      );
      const targets = Object.keys(files);
      const result = await runner({
        files,
        checks: createPythonValidationChecks({ repoRoot, env: { PATH: "" } })
      }).runValidation(request({
        repo: { repoRoot },
        checks: [PYTHON_RUFF_FORMAT_CHECK_ID],
        scope: { kind: "files", files: targets }
      }));

      assert.equal(result.status, "passed", JSON.stringify(result, null, 2));
      assert.equal(readFileSync(markerPath, "utf8"), "xx");
      const receipt = result.manifest.runs[0].pythonCapabilityRuns?.[0];
      assert.equal(receipt?.state, "passed");
      assert.equal(receipt?.sourcePaths?.length, 65);
      assert.equal((receipt?.argv?.filter((argument) => argument.endsWith(".py")).length ?? 0) <= 64, true);
      assert.equal(receipt?.invocations?.length, 2);
      assert.equal(
        receipt?.invocations?.every(
          (invocation) => invocation.argv.filter((argument) => argument.endsWith(".py")).length <= 64
        ),
        true
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("fails closed with bounded invocation evidence when Ruff format refinement exceeds its invocation bound", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-ruff-format-invocation-bound-"));
    try {
      writePassingPythonProtocolShim(repoRoot);
      writeToolShim(
        repoRoot,
        "ruff",
        [
          "#!/bin/sh",
          "if [ \"$1\" = \"--version\" ]; then echo 'ruff 0.6.9'; exit 0; fi",
          "if [ \"$1\" = \"format\" ]; then exit 1; fi",
          "exit 2",
          ""
        ].join("\n")
      );
      const files = Object.fromEntries(
        Array.from({ length: 320 }, (_, index) => [`pkg/file_${String(index).padStart(3, "0")}.py`, "value=1\n"])
      );
      const targets = Object.keys(files);
      const result = await runner({
        files,
        checks: createPythonValidationChecks({ repoRoot, env: { PATH: "" } })
      }).runValidation(request({
        repo: { repoRoot },
        checks: [PYTHON_RUFF_FORMAT_CHECK_ID],
        scope: { kind: "files", files: targets }
      }));

      assert.equal(result.status, "infrastructure_failure", JSON.stringify(result.failure, null, 2));
      const run = result.manifest.runs.find((entry) => entry.checkId === PYTHON_RUFF_FORMAT_CHECK_ID);
      assert.equal(run?.outcome, "tool_failure");
      assert.deepEqual(result.diagnostics.map((entry) => entry.code), ["PY_RUFF_FORMAT_TOOL_FAILED"]);
      const receipt = run?.pythonCapabilityRuns?.[0];
      assert.equal(receipt?.state, "tool_failure");
      assert.equal(receipt?.termination, "overflow");
      assert.equal(receipt?.exitCode, undefined);
      assert.match(receipt?.failureMessage ?? "", /bounded invocations/u);
      const bounded = receipt?.invocations?.filter((invocation) => invocation.termination === "overflow") ?? [];
      assert.equal(bounded.length, 1);
      assert.deepEqual(bounded[0].argv, receipt?.argv);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("Ruff outcome matrix: fails closed for malformed, contradictory, exit, timeout, signal, spawn, and overflow states", async () => {
    const cases = [
      {
        id: "malformed",
        body: "printf '%s\\n' 'not-json'\nexit 1",
        outcome: "tool_failure",
        code: "PY_RUFF_LINT_TOOL_FAILED"
      },
      {
        id: "contradictory-clean",
        body: "printf '%s\\n' '[]'\nexit 1",
        outcome: "tool_failure",
        code: "PY_RUFF_LINT_TOOL_FAILED"
      },
      {
        id: "contradictory-findings",
        body: "printf '%s\\n' '[{\"code\":\"F401\",\"filename\":\"pkg/app.py\",\"location\":{\"row\":1,\"column\":1},\"message\":\"unused\"}]'\nexit 0",
        outcome: "tool_failure",
        code: "PY_RUFF_LINT_TOOL_FAILED"
      },
      {
        id: "unknown-exit",
        body: "printf '%s\\n' '[]'\nexit 2",
        outcome: "tool_failure",
        code: "PY_RUFF_LINT_TOOL_FAILED"
      },
      {
        id: "timeout",
        body: "while :; do :; done",
        outcome: "timeout",
        code: "PY_RUFF_LINT_TIMEOUT",
        timeoutMs: 20
      },
      {
        id: "signal",
        body: "kill -TERM $",
        outcome: "tool_failure",
        code: "PY_RUFF_LINT_TOOL_FAILED"
      },
      {
        id: "spawn",
        version: `echo 'ruff 0.6.9'; /bin/rm \"$0\"; exit 0`,
        body: "exit 0",
        outcome: "tool_failure",
        code: "PY_RUFF_LINT_TOOL_FAILED"
      },
      {
        id: "overflow",
        body: `'${process.execPath}' -e 'process.stdout.write(\"x\".repeat(1100000))'\nexit 0`,
        outcome: "tool_failure",
        code: "PY_RUFF_LINT_TOOL_FAILED"
      }
    ];
    for (const fixture of cases) {
      const repoRoot = mkdtempSync(join(tmpdir(), `opcore-python-ruff-${fixture.id}-`));
      try {
        writePassingPythonProtocolShim(repoRoot);
        writeToolShim(
          repoRoot,
          "ruff",
          [
            "#!/bin/sh",
            `if [ \"$1\" = \"--version\" ]; then ${fixture.version ?? "echo 'ruff 0.6.9'; exit 0"}; fi`,
            fixture.body,
            ""
          ].join("\n")
        );
        const baseProbe = successfulProbe();
        const processProbe = fixture.id === "spawn"
          ? {
              ...baseProbe,
              run(command, args, options) {
                const result = baseProbe.run(command, args, options);
                if (command.endsWith("/ruff")) rmSync(command, { force: true });
                return result;
              }
            }
          : baseProbe;
        const result = await runner({
          files: { "pkg/app.py": "VALUE = 1\n" },
          checks: createPythonValidationChecks({
            repoRoot,
            env: { PATH: "" },
            processProbe,
            timeoutMs: fixture.timeoutMs ?? 30000
          })
        }).runValidation(request({
          repo: { repoRoot },
          checks: [PYTHON_RUFF_LINT_CHECK_ID],
          scope: { kind: "files", files: ["pkg/app.py"] }
        }));

        assert.equal(result.status, "infrastructure_failure", `${fixture.id}: ${JSON.stringify(result, null, 2)}`);
        const run = result.manifest.runs[0];
        assert.equal(run.outcome, fixture.outcome, `${fixture.id}: ${JSON.stringify(result, null, 2)}`);
        assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), [fixture.code], fixture.id);
        const receipt = run.pythonCapabilityRuns?.[0];
        assert.equal(receipt?.state, fixture.outcome, fixture.id);
        assert.notEqual(receipt?.state, "passed", fixture.id);
        if (fixture.id === "overflow") assert.equal(receipt?.termination, "overflow");
      } finally {
        rmSync(repoRoot, { recursive: true, force: true });
      }
    }
  });

  it("Ruff outcome matrix: proves malformed dedicated and pyproject config as invalid_config without executing a check", async () => {
    for (const [configPath, configContent] of [
      ["ruff.toml", "line-length = [\n"],
      ["pyproject.toml", "[project]\nname = 'fixture'\n[tool.ruff]\nline-length = [\n"]
    ]) {
      for (const checkId of [PYTHON_RUFF_LINT_CHECK_ID, PYTHON_RUFF_FORMAT_CHECK_ID]) {
        const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-ruff-invalid-config-"));
        const markerPath = join(repoRoot, "ruff-check-executed");
        try {
          writePassingPythonProtocolShim(repoRoot);
          writeToolShim(
            repoRoot,
            "ruff",
            [
              "#!/bin/sh",
              "if [ \"$1\" = \"--version\" ]; then echo 'ruff 0.6.9'; exit 0; fi",
              `printf executed > '${markerPath}'`,
              "exit 0",
              ""
            ].join("\n")
          );
          const result = await runner({
            files: {
              "pkg/app.py": "VALUE = 1\n",
              [configPath]: configContent
            },
            checks: createPythonValidationChecks({ repoRoot, env: { PATH: "" } })
          }).runValidation(request({
            repo: { repoRoot },
            checks: [checkId],
            scope: { kind: "files", files: ["pkg/app.py"] }
          }));

          assert.equal(result.status, "unsupported_request", `${checkId} ${configPath}: ${JSON.stringify(result, null, 2)}`);
          assert.equal(result.manifest.runs[0].outcome, "invalid_config");
          const receipt = result.manifest.runs[0].pythonCapabilityRuns?.[0];
          assert.equal(receipt?.state, "invalid_config");
          assert.equal(receipt?.configPath, configPath);
          assert.equal(
            result.pythonProjectContexts[0].reasons.some((reason) =>
              reason.code === "invalid_config" &&
              reason.tool === "ruff" &&
              reason.path === configPath
            ),
            true
          );
          assert.equal(existsSync(markerPath), false);
        } finally {
          rmSync(repoRoot, { recursive: true, force: true });
        }
      }
    }
  });

  it("classifies malformed extended Ruff configs as invalid_config before lint or format execution", async () => {
    for (const checkId of [PYTHON_RUFF_LINT_CHECK_ID, PYTHON_RUFF_FORMAT_CHECK_ID]) {
      const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-ruff-malformed-extend-"));
      const markerPath = join(repoRoot, "ruff-check-executed");
      try {
        writeToolShim(
          repoRoot,
          "ruff",
          [
            "#!/bin/sh",
            "if [ \"$1\" = \"--version\" ]; then echo 'ruff 0.6.9'; exit 0; fi",
            `printf executed > '${markerPath}'`,
            "printf '%s\\n' 'Failed to parse config/base.toml: expected a value' >&2",
            "exit 2",
            ""
          ].join("\n")
        );
        const result = await runner({
          files: {
            "pkg/app.py": "VALUE = 1\n",
            "ruff.toml": "extend = \"config/base.toml\"\n",
            "config/base.toml": "line-length = [\n"
          },
          checks: createPythonValidationChecks({ repoRoot, env: { PATH: "" } })
        }).runValidation(request({
          repo: { repoRoot },
          checks: [checkId],
          scope: { kind: "files", files: ["pkg/app.py"] }
        }));

        assert.equal(result.status, "unsupported_request", `${checkId}: ${JSON.stringify(result, null, 2)}`);
        assert.equal(result.manifest.runs[0].outcome, "invalid_config");
        const receipt = result.manifest.runs[0].pythonCapabilityRuns?.[0];
        assert.equal(receipt?.state, "invalid_config");
        assert.equal(receipt?.configPath, "config/base.toml");
        assert.match(receipt?.afterStateManifestFingerprint ?? "", /^sha256:[a-f0-9]{64}$/u);
        assert.deepEqual(receipt?.sourcePaths, ["pkg/app.py"]);
        assert.deepEqual(receipt?.configPaths, ["config/base.toml", "ruff.toml"]);
        assert.equal(receipt?.cwd, ".");
        assert.deepEqual(result.diagnostics.map((entry) => entry.path), ["config/base.toml"]);
        assert.equal(existsSync(markerPath), false);
      } finally {
        rmSync(repoRoot, { recursive: true, force: true });
      }
    }
  });

  it("classifies deleted extended Ruff configs as invalid_config without executing Ruff", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-ruff-deleted-extend-"));
    const markerPath = join(repoRoot, "ruff-check-executed");
    try {
      writeToolShim(
        repoRoot,
        "ruff",
        [
          "#!/bin/sh",
          "if [ \"$1\" = \"--version\" ]; then echo 'ruff 0.6.9'; exit 0; fi",
          `printf executed > '${markerPath}'`,
          "exit 2",
          ""
        ].join("\n")
      );
      const result = await runner({
        files: {
          "pkg/app.py": "VALUE = 1\n",
          "ruff.toml": "extend = \"config/base.toml\"\n",
          "config/base.toml": "line-length = 88\n"
        },
        checks: createPythonValidationChecks({ repoRoot, env: { PATH: "" } })
      }).runValidation(request({
        repo: { repoRoot },
        checks: [PYTHON_RUFF_LINT_CHECK_ID],
        scope: { kind: "files", files: ["pkg/app.py"] },
        overlays: [{ path: "config/base.toml", action: "delete" }]
      }));

      assert.equal(result.status, "unsupported_request", JSON.stringify(result, null, 2));
      assert.equal(result.manifest.runs[0].outcome, "invalid_config");
      const receipt = result.manifest.runs[0].pythonCapabilityRuns?.[0];
      assert.equal(receipt?.state, "invalid_config");
      assert.equal(receipt?.configPath, "config/base.toml");
      assert.match(receipt?.afterStateManifestFingerprint ?? "", /^sha256:[a-f0-9]{64}$/u);
      assert.deepEqual(receipt?.sourcePaths, ["pkg/app.py"]);
      assert.deepEqual(receipt?.configPaths, ["config/base.toml", "ruff.toml"]);
      assert.equal(receipt?.cwd, ".");
      assert.deepEqual(result.diagnostics.map((entry) => entry.path), ["config/base.toml"]);
      assert.equal(existsSync(markerPath), false);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("classifies Ruff extend cycles as exact-state invalid_config without executing Ruff", async () => {
    for (const checkId of [PYTHON_RUFF_LINT_CHECK_ID, PYTHON_RUFF_FORMAT_CHECK_ID]) {
      const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-ruff-cycle-extend-"));
      const markerPath = join(repoRoot, "ruff-check-executed");
      try {
        writeToolShim(
          repoRoot,
          "ruff",
          [
            "#!/bin/sh",
            "if [ \"$1\" = \"--version\" ]; then echo 'ruff 0.6.9'; exit 0; fi",
            `printf executed > '${markerPath}'`,
            "printf '%s\\n' 'Circular dependency detected in ruff.toml' >&2",
            "exit 2",
            ""
          ].join("\n")
        );
        const result = await runner({
          files: {
            "pkg/app.py": "VALUE = 1\n",
            "ruff.toml": "extend = \"config/base.toml\"\n",
            "config/base.toml": "extend = \"../ruff.toml\"\n"
          },
          checks: createPythonValidationChecks({ repoRoot, env: { PATH: "" } })
        }).runValidation(request({
          repo: { repoRoot },
          checks: [checkId],
          scope: { kind: "files", files: ["pkg/app.py"] }
        }));

        assert.equal(result.status, "unsupported_request", `${checkId}: ${JSON.stringify(result, null, 2)}`);
        assert.equal(result.manifest.runs[0].outcome, "invalid_config");
        const receipt = result.manifest.runs[0].pythonCapabilityRuns?.[0];
        assert.equal(receipt?.state, "invalid_config");
        assert.equal(receipt?.configPath, "config/base.toml");
        assert.match(receipt?.afterStateManifestFingerprint ?? "", /^sha256:[a-f0-9]{64}$/u);
        assert.deepEqual(receipt?.sourcePaths, ["pkg/app.py"]);
        assert.deepEqual(receipt?.configPaths, ["config/base.toml", "ruff.toml"]);
        assert.equal(receipt?.cwd, ".");
        assert.deepEqual(result.diagnostics.map((entry) => entry.path), ["config/base.toml"]);
        assert.equal(existsSync(markerPath), false);
      } finally {
        rmSync(repoRoot, { recursive: true, force: true });
      }
    }
  });

  it("uses the selected Ruff config closure to prove semantic extended-config rejection", async () => {
    for (const checkId of [PYTHON_RUFF_LINT_CHECK_ID, PYTHON_RUFF_FORMAT_CHECK_ID]) {
      const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-ruff-semantic-extend-"));
      try {
        writeToolShim(
          repoRoot,
          "ruff",
          [
            "#!/bin/sh",
            "if [ \"$1\" = \"--version\" ]; then echo 'ruff 0.6.9'; exit 0; fi",
            "printf '%s\\n' 'Failed to parse config/base.toml: invalid value' >&2",
            "exit 2",
            ""
          ].join("\n")
        );
        const result = await runner({
          files: {
            "pkg/app.py": "VALUE = 1\n",
            "ruff.toml": "extend = \"config/base.toml\"\n",
            "config/base.toml": "line-length = \"wide\"\n"
          },
          checks: createPythonValidationChecks({ repoRoot, env: { PATH: "" } })
        }).runValidation(request({
          repo: { repoRoot },
          checks: [checkId],
          scope: { kind: "files", files: ["pkg/app.py"] }
        }));

        assert.equal(result.status, "unsupported_request", `${checkId}: ${JSON.stringify(result, null, 2)}`);
        assert.equal(result.manifest.runs[0].outcome, "invalid_config");
        assert.equal(result.manifest.runs[0].pythonCapabilityRuns?.[0]?.state, "invalid_config");
        assert.deepEqual(result.diagnostics.map((entry) => entry.path), ["config/base.toml"]);
        assert.equal(result.manifest.runs[0].pythonCapabilityRuns?.[0]?.invocations?.length, 2);
      } finally {
        rmSync(repoRoot, { recursive: true, force: true });
      }
    }
  });

  it("Ruff outcome matrix: uses a settings probe to prove semantic config rejection separately from internal exit", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-ruff-semantic-config-"));
    const invocationMarker = join(repoRoot, "ruff-invocations");
    try {
      writePassingPythonProtocolShim(repoRoot);
      writeToolShim(
        repoRoot,
        "ruff",
        [
          "#!/bin/sh",
          "if [ \"$1\" = \"--version\" ]; then echo 'ruff 0.6.9'; exit 0; fi",
          `printf x >> '${invocationMarker}'`,
          "case \" $* \" in",
          "  *' --show-settings '*)",
          "    printf '%s\\n' 'selected configuration ruff.toml rejected' >&2",
          "    exit 2",
          "    ;;",
          "esac",
          "if [ \"$1\" = \"check\" ]; then",
          "  printf '%s\\n' 'check failed to load selected configuration' >&2",
          "  exit 2",
          "fi",
          "exit 9",
          ""
        ].join("\n")
      );
      const result = await runner({
        files: {
          "pkg/app.py": "VALUE = 1\n",
          "ruff.toml": "line-length = \"wide\"\n"
        },
        checks: createPythonValidationChecks({ repoRoot, env: { PATH: "" } })
      }).runValidation(request({
        repo: { repoRoot },
        checks: [PYTHON_RUFF_LINT_CHECK_ID],
        scope: { kind: "files", files: ["pkg/app.py"] }
      }));

      assert.equal(result.status, "unsupported_request", JSON.stringify(result, null, 2));
      assert.equal(result.manifest.runs[0].outcome, "invalid_config");
      assert.deepEqual(result.diagnostics.map((entry) => entry.code), ["PY_RUFF_LINT_INVALID_CONFIG"]);
      assert.equal(readFileSync(invocationMarker, "utf8"), "xx");
      const receipt = result.manifest.runs[0].pythonCapabilityRuns?.[0];
      assert.equal(receipt?.state, "invalid_config");
      assert.equal(receipt?.exitCode, 2);
      assert.equal(receipt?.argv.includes("--show-settings"), true);
      assert.equal(receipt?.configPath, "ruff.toml");
      assert.equal(receipt?.invocations?.length, 2);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("does not relabel an unrelated configuration cache failure as invalid_config", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-ruff-config-cache-failure-"));
    try {
      writeToolShim(
        repoRoot,
        "ruff",
        [
          "#!/bin/sh",
          "if [ \"$1\" = \"--version\" ]; then echo 'ruff 0.6.9'; exit 0; fi",
          "printf '%s\\n' 'error: configuration cache initialization failed for ruff.toml' >&2",
          "exit 2",
          ""
        ].join("\n")
      );
      const result = await runner({
        files: {
          "pkg/app.py": "VALUE = 1\n",
          "ruff.toml": "line-length = 88\n"
        },
        checks: createPythonValidationChecks({ repoRoot, env: { PATH: "" } })
      }).runValidation(request({
        repo: { repoRoot },
        checks: [PYTHON_RUFF_LINT_CHECK_ID],
        scope: { kind: "files", files: ["pkg/app.py"] }
      }));

      assert.equal(result.status, "infrastructure_failure", JSON.stringify(result, null, 2));
      assert.equal(result.manifest.runs[0].outcome, "tool_failure");
      assert.equal(result.manifest.runs[0].pythonCapabilityRuns?.[0]?.state, "tool_failure");
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("keeps unsupported settings probes as tool failures with complete invocation evidence", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-ruff-unsupported-settings-"));
    try {
      writePassingPythonProtocolShim(repoRoot);
      writeToolShim(
        repoRoot,
        "ruff",
        [
          "#!/bin/sh",
          "if [ \"$1\" = \"--version\" ]; then echo 'ruff 0.6.9'; exit 0; fi",
          "if [ \"$1\" = \"check\" ] && [ \"$2\" = \"--show-settings\" ]; then",
          "  printf '%s\\n' \"unexpected argument '--show-settings'\" >&2",
          "  exit 2",
          "fi",
          "if [ \"$1\" = \"check\" ]; then",
          "  printf '%s\\n' 'internal execution failure' >&2",
          "  exit 2",
          "fi",
          "exit 9",
          ""
        ].join("\n")
      );
      const result = await runner({
        files: {
          "pkg/app.py": "VALUE = 1\n",
          "ruff.toml": "line-length = 88\n"
        },
        checks: createPythonValidationChecks({ repoRoot, env: { PATH: "" } })
      }).runValidation(request({
        repo: { repoRoot },
        checks: [PYTHON_RUFF_LINT_CHECK_ID],
        scope: { kind: "files", files: ["pkg/app.py"] }
      }));

      assert.equal(result.status, "infrastructure_failure", JSON.stringify(result, null, 2));
      assert.equal(result.manifest.runs[0].outcome, "tool_failure");
      const receipt = result.manifest.runs[0].pythonCapabilityRuns?.[0];
      assert.equal(receipt?.state, "tool_failure");
      assert.equal(receipt?.invocations?.length, 2);
      assert.equal(receipt?.invocations?.[1]?.argv.includes("--show-settings"), true);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("Ruff outcome matrix: reports an activated missing tool without a false pass", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-ruff-missing-"));
    try {
      writePassingPythonProtocolShim(repoRoot);
      const result = await runner({
        files: { "pkg/app.py": "VALUE = 1\n" },
        checks: createPythonValidationChecks({ repoRoot, env: { PATH: "" } })
      }).runValidation(request({
        repo: { repoRoot },
        checks: [PYTHON_RUFF_LINT_CHECK_ID],
        scope: { kind: "files", files: ["pkg/app.py"] }
      }));

      assert.equal(result.status, "unsupported_request", JSON.stringify(result, null, 2));
      assert.equal(result.manifest.runs[0].outcome, "tool_unavailable");
      const receipt = result.manifest.runs[0].pythonCapabilityRuns?.[0];
      assert.equal(receipt?.state, "tool_unavailable");
      assert.equal(receipt?.termination, undefined);
      assert.equal(receipt?.diagnosticCount, 1);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("Ruff activation: disabled policy wins with zero Ruff processes", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-ruff-disabled-"));
    const markerPath = join(repoRoot, "ruff-called");
    try {
      writePassingPythonProtocolShim(repoRoot);
      mkdirSync(join(repoRoot, ".opcore"), { recursive: true });
      writeFileSync(
        join(repoRoot, ".opcore", "config"),
        JSON.stringify({
          validation: {
            checks: {
              disabled: [PYTHON_RUFF_LINT_CHECK_ID]
            }
          }
        })
      );
      writeToolShim(
        repoRoot,
        "ruff",
        [
          "#!/bin/sh",
          `printf 'called' > '${markerPath}'`,
          "exit 1",
          ""
        ].join("\n")
      );
      const result = await createValidationRunner({
        workspace: workspace({
          repoRoot,
          files: { "pkg/app.py": "value = 1\n" }
        }),
        checks: validationChecksForRepoPolicy(repoRoot, {
          pythonWorkspace: canonicalTestPythonWorkspace(),
          pythonImportAnalyzer: fixedImportAnalyzer([])
        })
      }).runValidation(
        request({
          repo: { repoRoot },
          checks: [PYTHON_RUFF_LINT_CHECK_ID]
        })
      );

      assert.equal(result.status, "skipped");
      const run = result.manifest.runs.find((entry) => entry.checkId === PYTHON_RUFF_LINT_CHECK_ID);
      assert.equal(run?.status, "skipped");
      assert.equal(run?.pythonCapabilityRuns?.[0]?.state, "disabled");
      assert.equal(run?.pythonCapabilityRuns?.[0]?.diagnosticCount, 0);
      assert.equal(existsSync(markerPath), false);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("finalizes inactive Ruff receipts after an earlier check infrastructure failure", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-ruff-early-failure-"));
    try {
      mkdirSync(join(repoRoot, ".opcore"), { recursive: true });
      writeFileSync(
        join(repoRoot, ".opcore", "config"),
        JSON.stringify({
          validation: {
            checks: {
              disabled: [PYTHON_RUFF_LINT_CHECK_ID]
            }
          }
        })
      );
      const failingCheck = {
        id: "fixture.infrastructure",
        owner: "fixture",
        adapter: "fixture",
        defaultSeverity: "error",
        supportedScopes: ["files"],
        run: () => ({
          outcome: "tool_failure",
          failureMessage: "fixture failed before Ruff",
          diagnostics: []
        })
      };
      const result = await createValidationRunner({
        workspace: workspace({ files: { "pkg/app.py": "VALUE = 1\n" } }),
        checks: [
          failingCheck,
          ...validationChecksForRepoPolicy(repoRoot, {
            pythonWorkspace: canonicalTestPythonWorkspace()
          })
        ]
      }).runValidation(request({
        repo: { repoRoot },
        checks: ["fixture.infrastructure"],
        scope: { kind: "files", files: ["pkg/app.py"] }
      }));

      assert.equal(result.status, "infrastructure_failure");
      const lintRun = result.manifest.runs.find((run) => run.checkId === PYTHON_RUFF_LINT_CHECK_ID);
      const formatRun = result.manifest.runs.find((run) => run.checkId === PYTHON_RUFF_FORMAT_CHECK_ID);
      assert.equal(lintRun?.pythonCapabilityRuns?.[0]?.state, "disabled");
      assert.equal(formatRun?.pythonCapabilityRuns?.[0]?.state, "not_applicable");
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("Ruff activation: repo defaults execute the selected Ruff check", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-ruff-default-"));
    const markerPath = join(repoRoot, "ruff-executed");
    try {
      mkdirSync(join(repoRoot, ".opcore"), { recursive: true });
      writeFileSync(
        join(repoRoot, ".opcore", "config"),
        JSON.stringify({ validation: { checks: { defaults: [PYTHON_RUFF_LINT_CHECK_ID] } } })
      );
      writePassingPythonProtocolShim(repoRoot);
      writeToolShim(
        repoRoot,
        "ruff",
        [
          "#!/bin/sh",
          "if [ \"$1\" = \"--version\" ]; then echo 'ruff 0.6.9'; exit 0; fi",
          `printf executed > '${markerPath}'`,
          "printf '%s\\n' '[]'",
          "exit 0",
          ""
        ].join("\n")
      );
      const result = createValidationRunner({
        workspace: workspace({ repoRoot, files: { "pkg/app.py": "VALUE = 1\n" } }),
        checks: validationChecksForRepoPolicy(repoRoot, {
          pythonWorkspace: canonicalTestPythonWorkspace(),
          pythonImportAnalyzer: fixedImportAnalyzer([])
        })
      }).runValidation(request({
        repo: { repoRoot },
        checks: undefined,
        scope: { kind: "files", files: ["pkg/app.py"] }
      }));

      const resolved = await result;
      assert.equal(resolved.status, "unsupported_request", JSON.stringify(resolved, null, 2));
      assert.equal(readFileSync(markerPath, "utf8"), "executed");
      const run = resolved.manifest.runs.find((entry) => entry.checkId === PYTHON_RUFF_LINT_CHECK_ID);
      assert.equal(run?.pythonCapabilityRuns?.[0]?.state, "passed");
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("records exact per-project Ruff receipt source paths and executed command", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-ruff-multi-project-"));
    try {
      for (const projectRoot of [join(repoRoot, "apps/one"), join(repoRoot, "apps/two")]) {
        writePassingPythonProtocolShim(projectRoot);
        writeToolShim(
          projectRoot,
          "ruff",
          [
            "#!/bin/sh",
            "if [ \"$1\" = \"--version\" ]; then echo 'ruff 0.6.9'; exit 0; fi",
            "if [ \"$1\" = \"check\" ]; then",
            "  printf '%s\\n' '[]'",
            "  exit 0",
            "fi",
            "exit 2",
            ""
          ].join("\n")
        );
      }

      const result = await runner({
        files: {
          "apps/one/pyproject.toml": "[project]\nname='one'\n[tool.ruff]\n",
          "apps/one/pkg/app.py": "value = 1\n",
          "apps/two/pyproject.toml": "[project]\nname='two'\n[tool.ruff]\n",
          "apps/two/pkg/app.py": "value = 2\n"
        },
        checks: createPythonValidationChecks({ repoRoot, env: { PATH: "" } })
      }).runValidation(
        request({
          repo: { repoRoot },
          checks: [PYTHON_RUFF_LINT_CHECK_ID],
          scope: {
            kind: "files",
            files: ["apps/one/pkg/app.py", "apps/two/pkg/app.py"]
          }
        })
      );

      assert.equal(result.status, "passed");
      const receipts = result.manifest.runs[0].pythonCapabilityRuns ?? [];
      assert.equal(receipts.length, 2);
      assert.deepEqual(
        receipts.map((receipt) => ({
          cwd: receipt.cwd,
          sourcePaths: receipt.sourcePaths,
          command: receipt.command
        })),
        [
          {
            cwd: "apps/one",
            sourcePaths: ["apps/one/pkg/app.py"],
            command: `${receipts[0].argv.join(" ")}`
          },
          {
            cwd: "apps/two",
            sourcePaths: ["apps/two/pkg/app.py"],
            command: `${receipts[1].argv.join(" ")}`
          }
        ]
      );
      assert.equal(receipts[0].command.includes("check"), true);
      assert.equal(receipts[1].command.includes("check"), true);
      assert.equal(receipts[0].command.includes("apps/two/pkg/app.py"), false);
      assert.equal(receipts[1].command.includes("apps/one/pkg/app.py"), false);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("preserves Ruff tool provenance on mixed Ruff and type runs", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-ruff-types-context-"));
    try {
      writePassingPythonProtocolShim(repoRoot);
      writeToolShim(
        repoRoot,
        "ruff",
        [
          "#!/bin/sh",
          "if [ \"$1\" = \"--version\" ]; then echo 'ruff 0.6.9'; exit 0; fi",
          "if [ \"$1\" = \"check\" ]; then printf '%s\\n' '[]'; exit 0; fi",
          "exit 2",
          ""
        ].join("\n")
      );
      writeToolShim(
        repoRoot,
        "mypy",
        [
          "#!/bin/sh",
          "if [ \"$1\" = \"--version\" ]; then echo 'mypy 1.8.0'; exit 0; fi",
          "exit 0",
          ""
        ].join("\n")
      );

      const result = await runner({
        files: {
          "app.py": "value: int = 1\n",
          "pyproject.toml": "[project]\nname='fixture'\n[tool.mypy]\n",
          "ruff.toml": "[lint]\nselect = ['F401']\n"
        },
        checks: createPythonValidationChecks({ repoRoot, env: { PATH: "" } })
      }).runValidation(
        request({
          repo: { repoRoot },
          checks: [PYTHON_RUFF_LINT_CHECK_ID, PYTHON_TYPES_CHECK_ID],
          scope: { kind: "files", files: ["app.py"] }
        })
      );

      assert.equal(result.status, "passed");
      assert.equal(result.pythonProjectContexts.length, 1);
      const tools = result.pythonProjectContexts[0].tools;
      assert.equal(
        tools.some((tool) => tool.tool === "ruff" && tool.available === true && tool.configFile === "ruff.toml"),
        true,
        JSON.stringify(tools, null, 2)
      );
      assert.equal(tools.some((tool) => tool.tool === "mypy" && tool.available === true), true);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("preserves Ruff tool provenance when policy defaults enable mixed Ruff and type runs", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-ruff-types-default-context-"));
    try {
      writePassingPythonProtocolShim(repoRoot);
      writeToolShim(
        repoRoot,
        "ruff",
        [
          "#!/bin/sh",
          "if [ \"$1\" = \"--version\" ]; then echo 'ruff 0.6.9'; exit 0; fi",
          "if [ \"$1\" = \"check\" ]; then printf '%s\\n' '[]'; exit 0; fi",
          "exit 2",
          ""
        ].join("\n")
      );
      writeToolShim(
        repoRoot,
        "mypy",
        [
          "#!/bin/sh",
          "if [ \"$1\" = \"--version\" ]; then echo 'mypy 1.8.0'; exit 0; fi",
          "exit 0",
          ""
        ].join("\n")
      );
      const checks = createPythonValidationChecks({ repoRoot, env: { PATH: "" } }).map((check) =>
        check.id === PYTHON_RUFF_LINT_CHECK_ID || check.id === PYTHON_TYPES_CHECK_ID
          ? { ...check, defaultScopes: check.supportedScopes }
          : { ...check, defaultScopes: [] }
      );

      const result = await createValidationRunner({
        workspace: workspace({
          repoRoot,
          files: {
            "app.py": "value: int = 1\n",
            "pyproject.toml": "[project]\nname='fixture'\n[tool.mypy]\n",
            "ruff.toml": "[lint]\nselect = ['F401']\n"
          }
        }),
        checks
      }).runValidation(
        request({
          repo: { repoRoot },
          checks: undefined,
          scope: { kind: "files", files: ["app.py"] }
        })
      );

      assert.equal(result.status, "passed");
      assert.equal(result.pythonProjectContexts.length, 1);
      const tools = result.pythonProjectContexts[0].tools;
      assert.equal(
        tools.some((tool) => tool.tool === "ruff" && tool.available === true && tool.configFile === "ruff.toml"),
        true,
        JSON.stringify(tools, null, 2)
      );
      assert.equal(tools.some((tool) => tool.tool === "mypy" && tool.available === true), true);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("retains earlier Ruff lint receipts when a later project fails", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-ruff-lint-multi-failure-"));
    try {
      writePassingPythonProtocolShim(join(repoRoot, "apps/one"));
      writePassingPythonProtocolShim(join(repoRoot, "apps/two"));
      writeToolShim(
        join(repoRoot, "apps/one"),
        "ruff",
        [
          "#!/bin/sh",
          "if [ \"$1\" = \"--version\" ]; then echo 'ruff 0.6.9'; exit 0; fi",
          "if [ \"$1\" = \"check\" ]; then printf '%s\\n' '[]'; exit 0; fi",
          "exit 2",
          ""
        ].join("\n")
      );
      writeToolShim(
        join(repoRoot, "apps/two"),
        "ruff",
        [
          "#!/bin/sh",
          "if [ \"$1\" = \"--version\" ]; then echo 'ruff 0.6.9'; exit 0; fi",
          "if [ \"$1\" = \"check\" ]; then printf '%s\\n' 'not-json'; exit 1; fi",
          "exit 2",
          ""
        ].join("\n")
      );

      const result = await runner({
        files: {
          "apps/one/pyproject.toml": "[project]\nname='one'\n[tool.ruff]\n",
          "apps/one/pkg/app.py": "value = 1\n",
          "apps/two/pyproject.toml": "[project]\nname='two'\n[tool.ruff]\n",
          "apps/two/pkg/app.py": "value = 2\n"
        },
        checks: createPythonValidationChecks({ repoRoot, env: { PATH: "" } })
      }).runValidation(
        request({
          repo: { repoRoot },
          checks: [PYTHON_RUFF_LINT_CHECK_ID],
          scope: {
            kind: "files",
            files: ["apps/one/pkg/app.py", "apps/two/pkg/app.py"]
          }
        })
      );

      assert.equal(result.status, "infrastructure_failure");
      const receipts = result.manifest.runs[0].pythonCapabilityRuns ?? [];
      assert.equal(receipts.length, 2);
      assert.deepEqual(
        receipts.map((receipt) => ({ cwd: receipt.cwd, state: receipt.state, exitCode: receipt.exitCode })),
        [
          { cwd: "apps/one", state: "passed", exitCode: 0 },
          { cwd: "apps/two", state: "tool_failure", exitCode: 1 }
        ]
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("retains earlier Ruff diagnostics and attempts remaining projects after a mixed-project failure", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-ruff-lint-complete-aggregation-"));
    const finalMarker = join(repoRoot, "apps/c/ruff-executed");
    try {
      for (const project of ["a", "b", "c"]) writePassingPythonProtocolShim(join(repoRoot, `apps/${project}`));
      writeToolShim(
        join(repoRoot, "apps/a"),
        "ruff",
        [
          "#!/bin/sh",
          "if [ \"$1\" = \"--version\" ]; then echo 'ruff 0.6.9'; exit 0; fi",
          "printf '%s\\n' '[{\"code\":\"F401\",\"filename\":\"pkg/app.py\",\"location\":{\"row\":1,\"column\":1},\"message\":\"unused import\"}]'",
          "exit 1",
          ""
        ].join("\n")
      );
      writeToolShim(
        join(repoRoot, "apps/b"),
        "ruff",
        [
          "#!/bin/sh",
          "if [ \"$1\" = \"--version\" ]; then echo 'ruff 0.6.9'; exit 0; fi",
          "printf '%s\\n' 'not-json'",
          "exit 1",
          ""
        ].join("\n")
      );
      writeToolShim(
        join(repoRoot, "apps/c"),
        "ruff",
        [
          "#!/bin/sh",
          "if [ \"$1\" = \"--version\" ]; then echo 'ruff 0.6.9'; exit 0; fi",
          `printf executed > '${finalMarker}'`,
          "printf '%s\\n' '[]'",
          "exit 0",
          ""
        ].join("\n")
      );
      const files = {};
      for (const project of ["a", "b", "c"]) {
        files[`apps/${project}/pyproject.toml`] = `[project]\nname='${project}'\n[tool.ruff]\n`;
        files[`apps/${project}/pkg/app.py`] = "import os\n";
      }

      const result = await runner({
        files,
        checks: createPythonValidationChecks({ repoRoot, env: { PATH: "" } })
      }).runValidation(request({
        repo: { repoRoot },
        checks: [PYTHON_RUFF_LINT_CHECK_ID],
        scope: {
          kind: "files",
          files: ["apps/a/pkg/app.py", "apps/b/pkg/app.py", "apps/c/pkg/app.py"]
        }
      }));

      assert.equal(result.status, "infrastructure_failure", JSON.stringify(result, null, 2));
      assert.deepEqual(
        result.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.path]),
        [
          ["PY_RUFF_LINT_TOOL_FAILED", undefined],
          ["PY_RUFF_LINT_F401", "apps/a/pkg/app.py"]
        ]
      );
      assert.deepEqual(
        result.manifest.runs[0].pythonCapabilityRuns?.map((receipt) => [receipt.cwd, receipt.state]),
        [["apps/a", "findings"], ["apps/b", "tool_failure"], ["apps/c", "passed"]]
      );
      assert.equal(existsSync(finalMarker), true);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("continues healthy Ruff projects and binds unavailable receipts to each exact after-state", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-ruff-lint-unavailable-project-"));
    const healthyMarker = join(repoRoot, "apps/b/ruff-executed");
    try {
      for (const project of ["a", "b"]) writePassingPythonProtocolShim(join(repoRoot, `apps/${project}`));
      writeToolShim(
        join(repoRoot, "apps/b"),
        "ruff",
        [
          "#!/bin/sh",
          "if [ \"$1\" = \"--version\" ]; then echo 'ruff 0.6.9'; exit 0; fi",
          `printf executed > '${healthyMarker}'`,
          "printf '%s\\n' '[]'",
          "exit 0",
          ""
        ].join("\n")
      );
      const result = await runner({
        files: {
          "apps/a/pyproject.toml": "[project]\nname='a'\n[tool.ruff]\n",
          "apps/a/pkg/app.py": "value = 1\n",
          "apps/b/pyproject.toml": "[project]\nname='b'\n[tool.ruff]\n",
          "apps/b/pkg/app.py": "value = 2\n"
        },
        checks: createPythonValidationChecks({ repoRoot, env: { PATH: "" } })
      }).runValidation(request({
        repo: { repoRoot },
        checks: [PYTHON_RUFF_LINT_CHECK_ID],
        scope: {
          kind: "files",
          files: ["apps/a/pkg/app.py", "apps/b/pkg/app.py"]
        }
      }));

      assert.equal(result.status, "unsupported_request", JSON.stringify(result, null, 2));
      const receipts = result.manifest.runs[0].pythonCapabilityRuns ?? [];
      assert.deepEqual(
        receipts.map((receipt) => [receipt.cwd, receipt.state]),
        [["apps/a", "tool_unavailable"], ["apps/b", "passed"]]
      );
      const unavailable = receipts[0];
      assert.match(unavailable.projectKey, /^sha256:[a-f0-9]{64}$/u);
      assert.match(unavailable.contextFingerprint, /^sha256:[a-f0-9]{64}$/u);
      assert.match(unavailable.afterStateManifestFingerprint, /^sha256:[a-f0-9]{64}$/u);
      assert.deepEqual(unavailable.sourcePaths, ["apps/a/pkg/app.py"]);
      assert.deepEqual(unavailable.configPaths, ["apps/a/pyproject.toml"]);
      assert.equal(existsSync(healthyMarker), true);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("retains earlier Ruff format receipts when a later project fails", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-ruff-format-multi-failure-"));
    try {
      writePassingPythonProtocolShim(join(repoRoot, "apps/one"));
      writePassingPythonProtocolShim(join(repoRoot, "apps/two"));
      writeToolShim(
        join(repoRoot, "apps/one"),
        "ruff",
        [
          "#!/bin/sh",
          "if [ \"$1\" = \"--version\" ]; then echo 'ruff 0.6.9'; exit 0; fi",
          "if [ \"$1\" = \"format\" ]; then exit 0; fi",
          "exit 2",
          ""
        ].join("\n")
      );
      writeToolShim(
        join(repoRoot, "apps/two"),
        "ruff",
        [
          "#!/bin/sh",
          "if [ \"$1\" = \"--version\" ]; then echo 'ruff 0.6.9'; exit 0; fi",
          "if [ \"$1\" = \"format\" ]; then echo 'internal error' >&2; exit 2; fi",
          "exit 2",
          ""
        ].join("\n")
      );

      const result = await runner({
        files: {
          "apps/one/pyproject.toml": "[project]\nname='one'\n[tool.ruff]\n",
          "apps/one/pkg/app.py": "value = 1\n",
          "apps/two/pyproject.toml": "[project]\nname='two'\n[tool.ruff]\n",
          "apps/two/pkg/app.py": "value = 2\n"
        },
        checks: createPythonValidationChecks({ repoRoot, env: { PATH: "" } })
      }).runValidation(
        request({
          repo: { repoRoot },
          checks: [PYTHON_RUFF_FORMAT_CHECK_ID],
          scope: {
            kind: "files",
            files: ["apps/one/pkg/app.py", "apps/two/pkg/app.py"]
          }
        })
      );

      assert.equal(result.status, "infrastructure_failure");
      const receipts = result.manifest.runs[0].pythonCapabilityRuns ?? [];
      assert.equal(receipts.length, 2);
      assert.deepEqual(
        receipts.map((receipt) => ({ cwd: receipt.cwd, state: receipt.state, exitCode: receipt.exitCode })),
        [
          { cwd: "apps/one", state: "passed", exitCode: 0 },
          { cwd: "apps/two", state: "tool_failure", exitCode: 2 }
        ]
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("fails mypy machine-protocol, timeout, signal, spawn, and exit errors closed and cleans workspaces", async () => {
    const cases = [
      { name: "malformed", body: "printf '{not-json\\n'; exit 1", status: "tool_failure", termination: "exited" },
      {
        name: "partial",
        body: "printf '%s\\n' '{\"file\":\"pkg/app.py\",\"line\":1,\"column\":0,\"message\":\"finding\",\"code\":\"assignment\",\"severity\":\"error\"}' '{not-json'; exit 1",
        status: "tool_failure",
        termination: "exited"
      },
      {
        name: "unknown-severity",
        body: "printf '%s\\n' '{\"file\":\"pkg/app.py\",\"line\":1,\"column\":0,\"message\":\"finding\",\"code\":\"assignment\",\"severity\":\"fatal\"}'; exit 1",
        status: "tool_failure",
        termination: "exited"
      },
      {
        name: "reversed-same-line-range",
        body: "printf '%s\\n' '{\"file\":\"pkg/app.py\",\"line\":1,\"column\":5,\"end_line\":1,\"end_column\":1,\"message\":\"bad range\",\"code\":\"assignment\",\"severity\":\"error\"}'; exit 1",
        status: "tool_failure",
        termination: "exited"
      },
      {
        name: "partial-config-stderr",
        body: "printf '%s\\n' '{\"file\":\"mypy.ini\"}' >&2; exit 2",
        status: "tool_failure",
        termination: "exited"
      },
      {
        name: "unrelated-config-stderr",
        body: "printf '%s\\n' 'mypy.ini: unrelated process failure' >&2; exit 2",
        status: "tool_failure",
        termination: "exited"
      },
      { name: "empty-findings", body: "exit 1", status: "tool_failure", termination: "exited" },
      { name: "unexpected-exit", body: "exit 2", status: "tool_failure", termination: "exited" },
      { name: "timeout", body: "/bin/sleep 1", status: "timeout", termination: "timeout", timeoutMs: 20 },
      { name: "signal", body: "kill -TERM $$", status: "tool_failure", termination: "signal" }
    ];
    for (const testCase of cases) {
      const repoRoot = mkdtempSync(join(tmpdir(), `opcore-python-mypy-${testCase.name}-`));
      try {
        writePassingPythonProtocolShim(repoRoot);
        writeToolShim(repoRoot, "mypy", [
          "#!/bin/sh",
          "if [ \"$1\" = \"--version\" ]; then echo 'mypy 2.3.0'; exit 0; fi",
          testCase.body,
          ""
        ].join("\n"));
        const files = {
          "mypy.ini": "[mypy]\nstrict = true\n",
          "pkg/app.py": "value: int = 1\n"
        };
        const before = materializedMypyWorkspaces();
        const result = await runner({
          files,
          checks: createPythonValidationChecks({
            repoRoot,
            env: { PATH: "" },
            timeoutMs: testCase.timeoutMs,
            processProbe: successfulProbe(),
            nodeWorkspace: createNodePythonProjectWorkspace(repoRoot)
          })
        }).runValidation(request({ repo: { repoRoot }, checks: [PYTHON_TYPES_CHECK_ID] }));

        assert.equal(result.status, "infrastructure_failure", `${testCase.name}: ${JSON.stringify(result, null, 2)}`);
        const capabilityRun = result.pythonCapabilityRuns[0];
        assert.equal(capabilityRun.status, testCase.status, testCase.name);
        assert.equal(capabilityRun.execution.termination, testCase.termination, testCase.name);
        assert.match(capabilityRun.projectKey, /^sha256:[a-f0-9]{64}$/u, testCase.name);
        assert.match(capabilityRun.contextFingerprint, /^sha256:[a-f0-9]{64}$/u, testCase.name);
        assert.match(capabilityRun.afterStateManifestFingerprint, /^sha256:[a-f0-9]{64}$/u, testCase.name);
        assert.equal(capabilityRun.projectRoot, ".", testCase.name);
        assert.deepEqual(capabilityRun.targets, ["pkg/app.py"], testCase.name);
        assert.deepEqual(capabilityRun.selectedConfigPaths, ["mypy.ini"], testCase.name);
        assert.equal(JSON.stringify(result.pythonCapabilityRuns).includes(repoRoot), false, testCase.name);
        assert.deepEqual(materializedMypyWorkspaces(), before, testCase.name);
      } finally {
        rmSync(repoRoot, { recursive: true, force: true });
      }
    }

    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-mypy-spawn-"));
    try {
      writePassingPythonProtocolShim(repoRoot);
      writeToolShim(repoRoot, "mypy", [
        "#!/bin/sh",
        "if [ \"$1\" = \"--version\" ]; then /bin/rm -- \"$0\"; echo 'mypy 2.3.0'; exit 0; fi",
        "exit 0",
        ""
      ].join("\n"));
      const files = {
        "mypy.ini": "[mypy]\nstrict = true\n",
        "pkg/app.py": "value: int = 1\n"
      };
      const before = materializedMypyWorkspaces();
      const result = await runner({
        files,
        checks: createPythonValidationChecks({
          repoRoot,
          env: { PATH: "" },
          nodeWorkspace: createNodePythonProjectWorkspace(repoRoot)
        })
      }).runValidation(request({ repo: { repoRoot }, checks: [PYTHON_TYPES_CHECK_ID] }));

      assert.equal(result.status, "infrastructure_failure");
      assert.equal(result.pythonCapabilityRuns[0].status, "tool_failure");
      assert.equal(result.pythonCapabilityRuns[0].execution.termination, "spawn_error");
      assert.equal(JSON.stringify(result.pythonCapabilityRuns).includes(repoRoot), false);
      assert.deepEqual(materializedMypyWorkspaces(), before);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("fails closed and terminates the tool when requested stdin cannot be written", async () => {
    const startedAt = Date.now();
    const result = await runTool("/bin/sh", ["-c", "exec 0<&-; /bin/sleep 5"], {
      input: "x".repeat(8 * 1024 * 1024),
      timeoutMs: 10_000
    });

    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.termination, "spawn_error");
    assert.match(result.failureMessage, /stdin write failed/i);
    assert.ok(Date.now() - startedAt < 2_000, "stdin failure did not terminate the process tree promptly");
  });

  it("kills mypy descendants when the authority process times out", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-mypy-descendant-timeout-"));
    try {
      writePassingPythonProtocolShim(repoRoot);
      const pidFile = join(repoRoot, "descendant.pid");
      writeToolShim(repoRoot, "mypy", [
        "#!/bin/sh",
        "if [ \"$1\" = \"--version\" ]; then echo 'mypy 2.3.0'; exit 0; fi",
        "/bin/sleep 30 &",
        `echo $! > ${JSON.stringify(pidFile)}`,
        "/bin/sleep 30",
        ""
      ].join("\n"));
      const files = {
        "mypy.ini": "[mypy]\nstrict = true\n",
        "pkg/app.py": "value: int = 1\n"
      };
      const result = await runner({
        files,
        checks: createPythonValidationChecks({
          repoRoot,
          env: { PATH: "" },
          // The process-heavy CI suite can delay shim startup; keep headroom below the 30s child sleep.
          timeoutMs: 2_000,
          nodeWorkspace: createNodePythonProjectWorkspace(repoRoot),
          processProbe: successfulProbe(),
          toolArgv: { mypy: [join(repoRoot, ".venv", "bin", "mypy")] }
        })
      }).runValidation(request({ repo: { repoRoot }, checks: [PYTHON_TYPES_CHECK_ID] }));

      assert.equal(result.pythonCapabilityRuns[0].status, "timeout");
      const descendantPid = Number(readFileSync(pidFile, "utf8").trim());
      assert.equal(await processExited(descendantPid), true, `descendant ${descendantPid} survived timeout`);
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
      checks: createPythonValidationChecks({
        importAnalyzer: fixedImportAnalyzer([{ fromPath: "pkg/app.py", toPath: "pkg/dep.py" }])
      }),
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

  it("reuses the exact after-state graph session instead of a second analyzer pass", async () => {
    const analysisCalls = [];
    const importAnalyzer = {
      async analyze(files) {
        analysisCalls.push(files);
        return [{ fromPath: "pkg/app.py", toPath: "pkg/new.py" }];
      }
    };
    const graphEdges = [
      { kind: "IMPORTS_FROM", from: "file:pkg/app.py", to: "file:pkg/new.py" }
    ];
    const client = graphClient({
      factQuery: (query) => availableFactResult(query, [], graphEdges)
    });
    const result = await runner({
      files: {
        "pkg/__init__.py": "",
        "pkg/app.py": "from pkg import old\n",
        "pkg/old.py": "OLD = True\n"
      },
      checks: createPythonValidationChecks({ importAnalyzer }),
      graphProviderClient: client,
      graphSessionFactory: exactGraphSessionFactory(client)
    }).runValidation(request({
      checks: [PYTHON_IMPORT_GRAPH_CHECK_ID],
      scope: { kind: "files", files: ["pkg/app.py"] },
      overlays: [{
        path: "pkg/app.py",
        action: "write",
        content: "from pkg import (\n    new,\n)\n"
      }, {
        path: "pkg/new.py",
        action: "write",
        content: "NEW = True\n"
      }]
    }));

    assert.equal(result.status, "passed", JSON.stringify(result, null, 2));
    assert.deepEqual(result.diagnostics, []);
    assert.equal(analysisCalls.length, 0);
  });

  it("fails import graph validation closed when the canonical analyzer is missing", async () => {
    const checks = createCanonicalPythonValidationChecks({
      nodeWorkspace: canonicalTestPythonWorkspace()
    });
    const client = graphClient();
    const result = await runner({
      files: { "pkg/app.py": "VALUE = 1\n" },
      checks,
      graphProviderClient: client,
      graphSessionFactory: exactGraphSessionFactory(client)
    }).runValidation(request({
      checks: [PYTHON_IMPORT_GRAPH_CHECK_ID],
      scope: { kind: "files", files: ["pkg/app.py"] }
    }));

    assert.equal(result.status, "infrastructure_failure");
    assert.match(JSON.stringify(result), /python import analyzer/i);
  });

  it("runs graph-only dead-code and relevant-test checks without an import analyzer", async () => {
    const checks = createCanonicalPythonValidationChecks({
      nodeWorkspace: canonicalTestPythonWorkspace()
    });
    const result = await runner({
      files: { "pkg/app.py": "VALUE = 1\n" },
      checks,
      graphProviderClient: graphClient()
    }).runValidation(request({
      checks: [PYTHON_DEAD_CODE_CHECK_ID, PYTHON_RELEVANT_TESTS_CHECK_ID],
      scope: { kind: "files", files: ["pkg/app.py"] }
    }));

    assert.equal(result.status, "passed", JSON.stringify(result, null, 2));
    assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code).sort(), [
      "PY_DEAD_CODE_UNSUPPORTED",
      "PY_RELEVANT_TESTS_ABSENT"
    ]);
  });

  it("fails import-dependent validation closed for throwing and malformed analyzers", async (testContext) => {
    const cases = [
      {
        name: "throwing",
        analyzer: { analyze: async () => { throw new Error("native analysis failed"); } },
        message: /native analysis failed/i
      },
      {
        name: "non-array",
        analyzer: { analyze: async () => ({ edges: [] }) },
        message: /expected an array/i
      },
      {
        name: "outside after-state",
        analyzer: fixedImportAnalyzer([{ fromPath: "pkg/app.py", toPath: "pkg/missing.py" }]),
        message: /outside the supplied after-state/i
      }
    ];

    for (const testCase of cases) {
      await testContext.test(testCase.name, async () => {
        const result = await runner({
          files: { "pkg/app.py": "VALUE = 1\n" },
          checks: createPythonValidationChecks({ importAnalyzer: testCase.analyzer }),
          graphProviderClient: graphClient()
        }).runValidation(request({
          checks: [PYTHON_IMPORT_GRAPH_CHECK_ID],
          scope: { kind: "files", files: ["pkg/app.py"] }
        }));

        assert.equal(result.status, "infrastructure_failure");
        assert.match(result.failure.cause, testCase.message);
      });
    }
  });

  it("excludes deleted Python files from canonical after-state analysis", async () => {
    const calls = [];
    const client = graphClient();
    const result = await runner({
      files: {
        "pkg/app.py": "from .dep import VALUE\n",
        "pkg/dep.py": "VALUE = 1\n"
      },
      checks: createPythonValidationChecks({
        importAnalyzer: {
          async analyze(files) {
            calls.push(files);
            return [];
          }
        }
      }),
      graphProviderClient: client,
      graphSessionFactory: exactGraphSessionFactory(client)
    }).runValidation(request({
      checks: [PYTHON_IMPORT_GRAPH_CHECK_ID],
      scope: { kind: "files", files: ["pkg/app.py"] },
      overlays: [{ path: "pkg/dep.py", action: "delete" }]
    }));

    assert.equal(result.status, "passed");
    assert.equal(calls.length, 0);
    assert.deepEqual(result.diagnostics, []);
  });

  it("skips deleted scoped Python targets before project or type-tool resolution", async () => {
    const result = await runner({
      files: { "pkg/app.py": "VALUE = 1\n" },
      checks: createPythonValidationChecks({ importAnalyzer: fixedImportAnalyzer([]) })
    }).runValidation(request({
      checks: [PYTHON_SYNTAX_CHECK_ID, PYTHON_TYPES_CHECK_ID],
      scope: { kind: "files", files: ["pkg/app.py"] },
      overlays: [{ path: "pkg/app.py", action: "delete" }]
    }));

    assert.equal(result.status, "passed", JSON.stringify(result, null, 2));
    assert.deepEqual(result.pythonProjectContexts, []);
  });

  it("shares one canonical source resolver across graph-dependent Python checks", async () => {
    let analysisCalls = 0;
    const checks = createPythonValidationChecks({
      importAnalyzer: {
        async analyze() {
          analysisCalls += 1;
          return [];
        }
      }
    });
    const result = await runner({
      files: { "pkg/app.py": "VALUE = 1\n" },
      checks,
      graphProviderClient: graphClient()
    }).runValidation(request({
      checks: [PYTHON_IMPORT_GRAPH_CHECK_ID, PYTHON_DEAD_CODE_CHECK_ID, PYTHON_RELEVANT_TESTS_CHECK_ID],
      scope: { kind: "files", files: ["pkg/app.py"] }
    }));

    assert.equal(result.status, "passed");
    assert.equal(analysisCalls, 1);
  });

  it("consumes the shared canonical Python import edge matrix and reports only a genuinely omitted edge", async () => {
    const files = fixtureFilesAt(sourceExtractionPythonFixtureRoot);
    const expectedEdges = sourceExtractionPythonExpected.pythonImportEdges;
    const graphEdges = expectedEdges.map(({ fromPath, toPath }) => ({
      kind: "IMPORTS_FROM",
      from: `file:${fromPath}`,
      to: `file:${toPath}`
    }));
    const scopeFiles = [...new Set(expectedEdges.map((edge) => edge.fromPath))].sort();
    const checks = createPythonValidationChecks({ importAnalyzer: fixedImportAnalyzer(expectedEdges) });
    const complete = await runner({
      files,
      checks,
      graphProviderClient: graphClient({
        factQuery: (query) => availableFactResult(query, [], graphEdges)
      })
    }).runValidation(request({ checks: [PYTHON_IMPORT_GRAPH_CHECK_ID], scope: { kind: "files", files: scopeFiles } }));

    assert.equal(complete.status, "passed");
    assert.deepEqual(complete.diagnostics, []);

    const omitted = expectedEdges.find((edge) => edge.fromPath === "src/cases/alias_case.py");
    assert.ok(omitted);
    const incomplete = await runner({
      files,
      checks,
      graphProviderClient: graphClient({
        factQuery: (query) => availableFactResult(
          query,
          [],
          graphEdges.filter((edge) => edge.from !== `file:${omitted.fromPath}` || edge.to !== `file:${omitted.toPath}`)
        )
      })
    }).runValidation(request({ checks: [PYTHON_IMPORT_GRAPH_CHECK_ID], scope: { kind: "files", files: scopeFiles } }));

    assert.deepEqual(incomplete.diagnostics.map((diagnostic) => diagnostic.code), ["PY_IMPORT_GRAPH_MISSING_EDGE"]);
    assert.equal(incomplete.diagnostics[0].path, omitted.fromPath);
    assert.match(incomplete.diagnostics[0].message, new RegExp(`${omitted.fromPath} -> ${omitted.toPath}`));
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
      checks: createPythonValidationChecks({
        importAnalyzer: fixedImportAnalyzer([{ fromPath: "pkg/app.py", toPath: "pkg/dep.py" }])
      }),
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
    assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), ["PYTHON_TYPES_UNSUPPORTED_TARGET"]);
    assert.equal(result.pythonCapabilityRuns[0].status, "unsupported_target");
  });
});

describe("Python project-context resolver", () => {
  it("filters non-Python paths without reading file contents from matching after-state indexes", async () => {
    const indexedPaths = ["large-native-binary", "pkg/app.py", "pyproject.toml"];
    const workspace = createValidationFileViewPythonWorkspace({
      overlays: [],
      scopeFiles: ["pkg/app.py"],
      defaultReadState: "after",
      listVisibleFiles: async () => indexedPaths,
      readFile: async () => { throw new Error("unexpected file content read"); },
      readBefore: async () => { throw new Error("unexpected file content read"); },
      readAfter: async () => { throw new Error("unexpected file content read"); },
      exists: async () => { throw new Error("unexpected file content read"); },
      hasOverlay: () => false,
      overlayFor: () => undefined
    }, undefined, {
      read: async () => undefined,
      list: async () => indexedPaths,
      exists: async () => true,
      realpath: async (path) => ({ path, symlink: false }),
      executableExists: async () => true
    });

    assert.deepEqual(await workspace.list(), ["pkg/app.py", "pyproject.toml"]);
  });

  it("keeps before-state project boundaries independent of current files and overlays", async () => {
    const before = new Map([
      ["pyproject.toml", "[project]\nname='root'\n"],
      ["services/api/app.py", "VALUE = 1\n"]
    ]);
    const current = {
      "services/api/pyproject.toml": "[project]\nname='api'\n",
      "services/api/app.py": "VALUE = 2\n",
      "large-native-binary": "not Python project evidence",
    };
    const overlays = [
      { path: "pyproject.toml", action: "delete" },
      { path: "services/api/pyproject.toml", action: "write", content: current["services/api/pyproject.toml"] }
    ];
    const readBefore = async (path) =>
      before.has(path) ? { status: "found", content: before.get(path) } : { status: "missing" };
    const workspace = createValidationFileViewPythonWorkspace({
      overlays,
      scopeFiles: ["services/api/app.py"],
      defaultReadState: "before",
      listVisibleFiles: async () => [...new Set([...before.keys(), ...Object.keys(current)])].sort(),
      readFile: readBefore,
      readBefore,
      readAfter: readBefore,
      exists: async (path) => {
        if (path === "large-native-binary") throw new Error("irrelevant binary existence was probed");
        return before.has(path);
      },
      hasOverlay: (path) => overlays.some((overlay) => overlay.path === path),
      overlayFor: (path) => overlays.find((overlay) => overlay.path === path)
    }, undefined, projectWorkspace(current, () => true));

    assert.deepEqual(await workspace.list(), [...before.keys()].sort());
    const context = await resolvePythonProjectContext({
      repoRoot: "/fixture",
      target: "services/api/app.py",
      workspace,
      processProbe: successfulProbe()
    });
    assert.equal(context.projectRoot, ".");
  });

  it("resolves nearest nested projects, layouts, managers, and stable fingerprints", async () => {
    const files = {
      "pyproject.toml": "[project]\nname='root'\nrequires-python='>=3.11'\n",
      "src/root/__init__.py": "VALUE = 1\n",
      "services/api/pyproject.toml": "[project]\nname='api'\nrequires-python='>=3.12'\n[tool.uv]\npackage=true\n",
      "services/api/uv.lock": "version = 1\n",
      "services/api/src/acme/app.py": "VALUE = 2\n"
    };
    const contexts = await resolvePythonProjectContexts({
      repoRoot: "/fixture",
      targets: ["src/root/__init__.py", "services/api/src/acme/app.py"],
      workspace: projectWorkspace(files, (command) => !command.includes("/")),
      processProbe: successfulProbe()
    });

    assert.deepEqual(contexts.map((context) => context.projectRoot), ["services/api", "."]);
    const nested = contexts[0];
    assert.deepEqual(nested.sourceRoots, ["services/api/src"]);
    assert.deepEqual(nested.layout.kinds, ["namespace", "src"]);
    assert.deepEqual(nested.managers.map((manager) => manager.kind), ["uv"]);
    assert.equal(nested.outcome, "resolved");
    assert.match(nested.projectKey, /^sha256:[a-f0-9]{64}$/);
    assert.match(nested.contextFingerprint, /^sha256:[a-f0-9]{64}$/);
  });

  it("keeps fingerprints stable across equivalent checkout roots", async () => {
    const files = {
      "pyproject.toml": "[project]\nname='fixture'\n",
      "app.py": "VALUE = 1\n"
    };
    const resolveAt = (repoRoot, mode) => resolvePythonProjectContext({
      repoRoot,
      target: "app.py",
      workspace: projectWorkspace(files, () => true),
      processProbe: successfulProbe(),
      ...(mode === "active"
        ? { env: { VIRTUAL_ENV: `${repoRoot}/.active`, PATH: "/usr/bin" } }
        : {
            env: { PATH: "/usr/bin" },
            interpreterArgv: [`${repoRoot}/bin/python`, "-X", "dev"],
            toolArgv: { mypy: [`${repoRoot}/bin/mypy`, `--config=${repoRoot}/mypy.ini`] }
          })
    });

    for (const mode of ["active", "explicit"]) {
      const [left, right] = await Promise.all([
        resolveAt("/checkout-a", mode),
        resolveAt("/checkout-b", mode)
      ]);
      assert.notEqual(left.interpreter?.executable, right.interpreter?.executable, mode);
      assert.notEqual(left.interpreter?.cwd, right.interpreter?.cwd, mode);
      assert.equal(left.projectKey, right.projectKey, mode);
      assert.equal(left.contextFingerprint, right.contextFingerprint, mode);
    }
  });

  it("resolves layout and source roots from the target in mixed flat/src projects", async () => {
    const files = {
      "pyproject.toml": "[project]\nname='mixed'\n",
      "script.py": "VALUE = 1\n",
      "helper.py": "VALUE = 2\n",
      "src/pkg/__init__.py": "VALUE = 3\n"
    };
    const [flat, src] = await Promise.all([
      resolvePythonProjectContext({
        repoRoot: "/fixture",
        target: "script.py",
        workspace: projectWorkspace(files, () => true),
        processProbe: successfulProbe()
      }),
      resolvePythonProjectContext({
        repoRoot: "/fixture",
        target: "src/pkg/__init__.py",
        workspace: projectWorkspace(files, () => true),
        processProbe: successfulProbe()
      })
    ]);

    assert.deepEqual(flat.sourceRoots, ["."]);
    assert.deepEqual(flat.layout, { kinds: ["flat"], paths: ["."] });
    assert.deepEqual(src.sourceRoots, ["src"]);
    assert.deepEqual(src.layout, { kinds: ["package", "src"], paths: ["src"] });
  });

  it("applies explicit, active, project-local, then PATH interpreter precedence", async () => {
    const files = { "pyproject.toml": "[project]\nname='fixture'\n", "app.py": "VALUE = 1\n" };
    const cases = [
      {
        source: "explicit_override",
        options: { interpreterArgv: ["/explicit/python"] },
        available: (command) => command === "/explicit/python" || !command.includes("/")
      },
      {
        source: "active_environment",
        options: { env: { VIRTUAL_ENV: "/fixture/.active", PATH: "/redacted" } },
        available: (command) => command.startsWith("/fixture/.active/") || !command.includes("/")
      },
      {
        source: "project_local_environment",
        options: {},
        available: (command) => command.startsWith("/fixture/.venv/") || !command.includes("/")
      },
      {
        source: "path",
        options: { env: { PATH: "/must-not-serialize" } },
        available: (command) => !command.includes("/")
      }
    ];
    for (const testCase of cases) {
      const context = await resolvePythonProjectContext({
        repoRoot: "/fixture",
        target: "app.py",
        workspace: projectWorkspace(files, testCase.available),
        processProbe: successfulProbe(),
        ...testCase.options
      });
      assert.equal(context.interpreter?.source, testCase.source);
      assert.equal(JSON.stringify(context).includes("must-not-serialize"), false);
      assert.equal(JSON.stringify(context).includes("/redacted"), false);
    }

    const launcher = await resolvePythonProjectContext({
      repoRoot: "/fixture",
      target: "app.py",
      interpreterArgv: ["uv", "run", "python"],
      workspace: projectWorkspace(files, () => true),
      processProbe: successfulProbe()
    });
    assert.equal(launcher.interpreter, undefined);
    assert.equal(launcher.reasons.some((reason) => reason.code === "invalid_config" && reason.tool === "python"), true);
  });

  it("refuses shell and sync-capable manager overrides before executing a probe", async () => {
    const isolatedRepoRoot = mkdtempSync(join(tmpdir(), "opcore-python-unsafe-override-"));
    const marker = join(isolatedRepoRoot, "probe-side-effect");
    try {
      writeFileSync(join(isolatedRepoRoot, "pyproject.toml"), "[project]\nname='fixture'\n");
      writeFileSync(join(isolatedRepoRoot, "app.py"), "VALUE = 1\n");
      const context = await resolvePythonProjectContext({
        repoRoot: isolatedRepoRoot,
        target: "app.py",
        env: { PATH: "" },
        interpreterArgv: ["/bin/sh", "-c", `printf side-effect > ${marker}`],
        toolArgv: { mypy: ["uv", "run", "mypy"] },
        workspace: createNodePythonProjectWorkspace(isolatedRepoRoot)
      });

      assert.equal(existsSync(marker), false);
      assert.equal(context.interpreter, undefined);
      assert.equal(context.tools.find((tool) => tool.tool === "mypy")?.available, false);
      assert.equal(context.reasons.some((reason) => reason.code === "invalid_config" && reason.tool === "python"), true);
      assert.equal(context.reasons.some((reason) => reason.code === "invalid_config" && reason.tool === "mypy"), true);
      assert.notEqual(context.outcome, "resolved");
    } finally {
      rmSync(isolatedRepoRoot, { recursive: true, force: true });
    }
  });

  it("accepts active environments only at the nearest project boundary", async () => {
    const files = {
      "pyproject.toml": "[project]\nname='root'\n",
      "app.py": "ROOT = 1\n",
      "services/api/pyproject.toml": "[project]\nname='api'\n[tool.uv]\npackage=true\n",
      "services/api/uv.lock": "version = 1\n",
      "services/api/app.py": "NESTED = 1\n"
    };
    for (const [variable, nestedSource] of [
      ["VIRTUAL_ENV", "active_environment"],
      ["UV_PROJECT_ENVIRONMENT", "manager_environment"]
    ]) {
      const environment = variable === "VIRTUAL_ENV" ? "/fixture/services/api/.venv" : "/fixture/services/api/.uv-active";
      const contexts = await resolvePythonProjectContexts({
        repoRoot: "/fixture",
        targets: ["app.py", "services/api/app.py"],
        env: { PATH: "/usr/bin", [variable]: environment },
        workspace: projectWorkspace(files, (command) => command.startsWith(`${environment}/`) || !command.includes("/")),
        processProbe: successfulProbe()
      });
      const root = contexts.find((context) => context.target === "app.py");
      const nested = contexts.find((context) => context.target === "services/api/app.py");
      assert.equal(root?.interpreter?.source, "path", variable);
      assert.equal(nested?.interpreter?.source, nestedSource, variable);
    }
  });

  it("uses inherited active environments when no environment projection is injected", async () => {
    const previous = process.env.VIRTUAL_ENV;
    process.env.VIRTUAL_ENV = "/fixture/custom-env";
    try {
      const context = await resolvePythonProjectContext({
        repoRoot: "/fixture",
        target: "app.py",
        workspace: projectWorkspace(
          { "pyproject.toml": "[project]\nname='fixture'\n", "app.py": "VALUE = 1\n" },
          (command) => command.startsWith("/fixture/custom-env/") || !command.includes("/")
        ),
        processProbe: successfulProbe()
      });
      assert.equal(context.interpreter?.source, "active_environment");
      assert.equal(context.interpreter?.executable, "/fixture/custom-env/bin/python");
    } finally {
      if (previous === undefined) delete process.env.VIRTUAL_ENV;
      else process.env.VIRTUAL_ENV = previous;
    }
  });

  it("discards failed PATH candidates after a later interpreter succeeds", async () => {
    const baseProbe = successfulProbe();
    const context = await resolvePythonProjectContext({
      repoRoot: "/fixture",
      target: "app.py",
      env: { PATH: "/usr/bin" },
      workspace: projectWorkspace(
        { "pyproject.toml": "[project]\nname='fixture'\n", "app.py": "VALUE = 1\n" },
        (command) => !command.includes("/")
      ),
      processProbe: {
        ...baseProbe,
        run(command, args, options) {
          if (command === "python3") {
            return probeResult(command, args, options, {
              ok: false,
              termination: "spawn_error",
              exitCode: null,
              failureMessage: "spawn python3 ENOENT"
            });
          }
          return baseProbe.run(command, args, options);
        }
      }
    });

    assert.equal(context.interpreter?.executable, "/usr/bin/python");
    assert.equal(context.outcome, "resolved");
    assert.equal(context.reasons.some((reason) => reason.tool === "python"), false);
  });

  it("rejects symlinked PDM interpreter evidence before reading its content", async () => {
    const files = {
      "pyproject.toml": "[project]\nname='fixture'\n[tool.pdm]\ndistribution=true\n",
      "pdm.lock": "version = '4.5'\n",
      ".pdm-python": "/external/python\n",
      "app.py": "VALUE = 1\n"
    };
    const context = await resolvePythonProjectContext({
      repoRoot: "/fixture",
      target: "app.py",
      env: { PATH: "/usr/bin" },
      workspace: projectWorkspace(files, (command) => !command.includes("/"), new Set([".pdm-python"])),
      processProbe: successfulProbe()
    });

    assert.equal(context.outcome, "ambiguous");
    assert.equal(context.interpreter?.source, "path");
    assert.equal(
      context.reasons.some((reason) => reason.code === "symlink_refused" && reason.path === ".pdm-python"),
      true
    );
  });

  it("honors an explicitly declared zero patch version", async () => {
    const context = await resolvePythonProjectContext({
      repoRoot: "/fixture",
      target: "app.py",
      env: { PATH: "/usr/bin" },
      workspace: projectWorkspace({
        "pyproject.toml": "[project]\nname='fixture'\nrequires-python='==3.12.0'\n",
        "app.py": "VALUE = 1\n"
      }, (command) => !command.includes("/")),
      processProbe: successfulProbe("3.12.1")
    });

    assert.equal(context.outcome, "unsupported");
    assert.equal(context.reasons.some((reason) => reason.code === "incompatible_interpreter"), true);
  });

  it("distinguishes exact release equality from explicit prefix wildcards", async () => {
    const resolveConstraint = (requiresPython) => resolvePythonProjectContext({
      repoRoot: "/fixture",
      target: "app.py",
      env: { PATH: "/usr/bin" },
      workspace: projectWorkspace({
        "pyproject.toml": `[project]\nname='fixture'\nrequires-python='${requiresPython}'\n`,
        "app.py": "VALUE = 1\n"
      }, (command) => !command.includes("/")),
      processProbe: successfulProbe("3.11.9")
    });

    const [exactEqual, wildcardEqual, exactNotEqual, wildcardNotEqual] = await Promise.all([
      resolveConstraint("==3.11"),
      resolveConstraint("==3.11.*"),
      resolveConstraint("!=3.11"),
      resolveConstraint("!=3.11.*")
    ]);
    assert.equal(exactEqual.outcome, "unsupported");
    assert.equal(wildcardEqual.outcome, "resolved");
    assert.equal(exactNotEqual.outcome, "resolved");
    assert.equal(wildcardNotEqual.outcome, "unsupported");
  });

  it("accepts standard multiline TOML and reports malformed TOML as invalid_config", async () => {
    const valid = await resolvePythonProjectContext({
      repoRoot: "/fixture",
      target: "app.py",
      workspace: projectWorkspace({
        "pyproject.toml": [
          "[project]",
          "name = 'fixture'",
          "requires-python = '>=3.12'",
          "",
          "[build-system]",
          "requires = [",
          "  'hatchling>=1',",
          "  'hatch-vcs>=0.4',",
          "]",
          "build-backend = 'hatchling.build'",
          ""
        ].join("\n"),
        "app.py": "VALUE = 1\n"
      }, () => true),
      processProbe: successfulProbe()
    });
    assert.equal(valid.reasons.some((reason) => reason.code === "invalid_config"), false);
    assert.deepEqual(valid.buildSystem, {
      configFile: "pyproject.toml",
      backend: "hatchling.build",
      requires: ["hatch-vcs>=0.4", "hatchling>=1"]
    });
    assert.deepEqual(valid.tools.find((tool) => tool.tool === "build")?.argv.slice(-2), ["-m", "build"]);

    const malformed = await resolvePythonProjectContext({
      repoRoot: "/fixture",
      target: "app.py",
      workspace: projectWorkspace({
        "pyproject.toml": "[project\nname = 'fixture'\n",
        "app.py": "VALUE = 1\n"
      }, () => true),
      processProbe: successfulProbe()
    });
    assert.equal(malformed.outcome, "degraded");
    assert.deepEqual(
      malformed.reasons.filter((reason) => reason.code === "invalid_config").map((reason) => reason.path),
      ["pyproject.toml"]
    );
  });

  it("reports malformed INI tool configuration as invalid_config", async () => {
    const context = await resolvePythonProjectContext({
      repoRoot: "/fixture",
      target: "app.py",
      env: { PATH: "/usr/bin" },
      workspace: projectWorkspace({
        "pyproject.toml": "[project]\nname='fixture'\n",
        "mypy.ini": "[mypy\nstrict = true\n",
        "app.py": "VALUE = 1\n"
      }, (command) => !command.includes("/")),
      processProbe: successfulProbe()
    });

    assert.equal(context.outcome, "degraded");
    assert.equal(
      context.reasons.some((reason) => reason.code === "invalid_config" && reason.path === "mypy.ini"),
      true
    );
  });

  it("reads Poetry target metadata from TOML AST and reports unavailable build tooling honestly", async () => {
    const context = await resolvePythonProjectContext({
      repoRoot: "/fixture",
      target: "app.py",
      workspace: projectWorkspace({
        "pyproject.toml": [
          "[tool.poetry]",
          "name = 'fixture'",
          "[tool.poetry.dependencies]",
          "python = '>=3.13'",
          "[build-system]",
          "requires = ['poetry-core>=1']",
          "build-backend = 'poetry.core.masonry.api'",
          ""
        ].join("\n"),
        "app.py": "VALUE = 1\n"
      }, () => true),
      processProbe: buildUnavailableProbe()
    });

    assert.equal(context.targetRuntime.requiresPython, ">=3.13");
    assert.deepEqual(context.buildSystem, {
      configFile: "pyproject.toml",
      backend: "poetry.core.masonry.api",
      requires: ["poetry-core>=1"]
    });
    assert.equal(context.tools.find((tool) => tool.tool === "build")?.available, false);
    assert.equal(context.reasons.some((reason) => reason.code === "tool_unavailable" && reason.tool === "build"), true);
  });

  it("resolves Windows environment-root python.exe after Scripts/python.exe", async () => {
    const environmentRootPython = "C:\\fixture\\.venv\\python.exe";
    const context = await resolvePythonProjectContext({
      repoRoot: "C:\\fixture",
      target: "app.py",
      platform: "win32",
      architecture: "x64",
      workspace: projectWorkspace(
        { "pyproject.toml": "[project]\nname='fixture'\nrequires-python='>=3.12'\n", "app.py": "VALUE = 1\n" },
        (command) => command === environmentRootPython || /\\Scripts\\(?:mypy|pyright|ruff|pytest)\.exe$/u.test(command)
      ),
      processProbe: windowsProbe(environmentRootPython)
    });

    assert.equal(context.interpreter?.source, "project_local_environment");
    assert.equal(context.interpreter?.executable, environmentRootPython);
    assert.deepEqual(context.interpreter?.argv, [environmentRootPython]);
    assert.equal(context.interpreter?.cwd, "C:\\fixture");
    assert.equal(context.outcome, "resolved");
  });

  it("resolves Python tools from the selected UV manager environment before PATH", async () => {
    const managerEnvironment = "/fixture/.uv-python";
    const managerBin = `${managerEnvironment}/bin`;
    const context = await resolvePythonProjectContext({
      repoRoot: "/fixture",
      target: "app.py",
      env: { PATH: "/usr/bin", UV_PROJECT_ENVIRONMENT: managerEnvironment },
      workspace: projectWorkspace(
        {
          "pyproject.toml": "[project]\nname='fixture'\nrequires-python='>=3.12'\n[tool.uv]\npackage=true\n",
          "uv.lock": "version=1\n",
          "app.py": "VALUE = 1\n"
        },
        (command) => command.startsWith(`${managerBin}/`) || !command.includes("/")
      ),
      processProbe: successfulProbe()
    });

    assert.equal(context.interpreter?.source, "manager_environment");
    assert.deepEqual(
      context.tools.filter((tool) => tool.tool !== "build").map((tool) => ({
        tool: tool.tool,
        source: tool.source,
        executable: tool.executable
      })),
      ["mypy", "pyright", "pytest", "ruff"].map((tool) => ({
        tool,
        source: "manager_environment",
        executable: `${managerBin}/${tool}`
      }))
    );
    assert.equal(context.outcome, "resolved");
  });

  it("reports deterministic path, symlink, manager, platform, target, and probe failures", async () => {
    const baseFiles = { "pyproject.toml": "[project]\nname='fixture'\nrequires-python='>=3.12'\n", "app.py": "VALUE = 1\n" };
    for (const [mode, expected] of [
      ["timeout", "probe_timeout"],
      ["signal", "probe_signal"],
      ["spawn", "probe_spawn_failure"],
      ["exit", "probe_exit_failure"],
      ["malformed", "malformed_probe_output"]
    ]) {
      const context = await resolvePythonProjectContext({
        repoRoot: "/fixture",
        target: "app.py",
        interpreterArgv: ["/fixture/python"],
        workspace: projectWorkspace(baseFiles, () => true),
        processProbe: failingProbe(mode)
      });
      assert.equal(context.reasons.some((reason) => reason.code === expected), true, mode);
      assert.notEqual(context.outcome, "resolved", mode);
    }

    const unsupportedPlatform = await resolvePythonProjectContext({
      repoRoot: "/fixture",
      target: "app.py",
      platform: "aix",
      workspace: projectWorkspace(baseFiles, () => true)
    });
    assert.equal(unsupportedPlatform.reasons[0].code, "unsupported_platform");

    const unsupportedTarget = await resolvePythonProjectContext({
      repoRoot: "/fixture",
      target: "app.py",
      workspace: projectWorkspace(
        { ...baseFiles, "pyproject.toml": "[project]\nname='fixture'\nrequires-python='^3.12'\n" },
        () => true
      ),
      processProbe: successfulProbe()
    });
    assert.equal(unsupportedTarget.reasons.some((reason) => reason.code === "unsupported_target"), true);

    const ambiguous = await resolvePythonProjectContext({
      repoRoot: "/fixture",
      target: "app.py",
      workspace: projectWorkspace({
        ...baseFiles,
        "uv.lock": "version=1\n",
        "poetry.lock": "package=[]\n"
      }, () => true, new Set(["app.py"])),
      processProbe: successfulProbe()
    });
    assert.equal(ambiguous.outcome, "ambiguous");
    assert.equal(ambiguous.reasons.some((reason) => reason.code === "conflicting_managers"), true);
    assert.equal(ambiguous.reasons.some((reason) => reason.code === "symlink_refused"), true);

    await assert.rejects(
      resolvePythonProjectContext({
        repoRoot: "/fixture",
        target: "../escape.py",
        workspace: projectWorkspace(baseFiles, () => true)
      }),
      (error) => error?.code === "path_refused"
    );
  });

  it("fails closed when successful interpreter or tool probes return malformed versions", async () => {
    const files = {
      "pyproject.toml": "[project]\nname='fixture'\nrequires-python='>=3.12'\n",
      "app.py": "VALUE = 1\n"
    };
    const malformedInterpreter = await resolvePythonProjectContext({
      repoRoot: "/fixture",
      target: "app.py",
      workspace: projectWorkspace(files, () => true),
      processProbe: successfulProbe("garbage")
    });
    assert.equal(malformedInterpreter.interpreter, undefined);
    assert.equal(
      malformedInterpreter.reasons.some((reason) => reason.code === "malformed_probe_output" && reason.tool === "python"),
      true
    );
    assert.notEqual(malformedInterpreter.outcome, "resolved");

    const probeWithoutAbi = successfulProbe();
    const incompleteInterpreter = await resolvePythonProjectContext({
      repoRoot: "/fixture",
      target: "app.py",
      workspace: projectWorkspace(files, () => true),
      processProbe: {
        ...probeWithoutAbi,
        run(command, args, options) {
          const script = args[args.indexOf("-c") + 1] ?? "";
          if (!args.includes("-c") || script.includes("opcore.python.project-context.build.v1")) {
            return probeWithoutAbi.run(command, args, options);
          }
          return probeResult(command, args, options, {
            stdout: JSON.stringify({
              protocol: "opcore.python.project-context.interpreter.v1",
              executable: command.includes("/") ? command : `/usr/bin/${command}`,
              version: "3.12.4",
              implementation: "CPython",
              platform: "linux",
              architecture: "x86_64"
            })
          });
        }
      }
    });
    assert.equal(incompleteInterpreter.interpreter, undefined);
    assert.equal(
      incompleteInterpreter.reasons.some((reason) => reason.code === "malformed_probe_output" && reason.tool === "python"),
      true
    );
    assert.notEqual(incompleteInterpreter.outcome, "resolved");

    const validProbe = successfulProbe();
    const malformedTools = await resolvePythonProjectContext({
      repoRoot: "/fixture",
      target: "app.py",
      workspace: projectWorkspace(files, () => true),
      processProbe: {
        ...validProbe,
        run(command, args, options) {
          return args.includes("-c")
            ? validProbe.run(command, args, options)
            : probeResult(command, args, options, { stdout: "not-a-version" });
        }
      }
    });
    assert.equal(malformedTools.tools.every((tool) => !tool.available), true);
    assert.deepEqual(
      malformedTools.reasons.filter((reason) => reason.code === "malformed_probe_output").map((reason) => reason.tool).sort(),
      ["mypy", "pyright", "pytest", "ruff"]
    );
    assert.notEqual(malformedTools.outcome, "resolved");

    const malformedBuild = await resolvePythonProjectContext({
      repoRoot: "/fixture",
      target: "app.py",
      workspace: projectWorkspace({
        ...files,
        "pyproject.toml": `${files["pyproject.toml"]}[build-system]\nrequires=['build']\nbuild-backend='example.backend'\n`
      }, () => true),
      processProbe: {
        ...validProbe,
        run(command, args, options) {
          const script = args[args.indexOf("-c") + 1] ?? "";
          return script.includes("opcore.python.project-context.build.v1")
            ? probeResult(command, args, options, {
                stdout: JSON.stringify({
                  protocol: "opcore.python.project-context.build.v1",
                  available: true,
                  version: "not-a-version"
                })
              })
            : validProbe.run(command, args, options);
        }
      }
    });
    assert.equal(malformedBuild.tools.find((tool) => tool.tool === "build")?.available, false);
    assert.equal(
      malformedBuild.reasons.some((reason) => reason.code === "malformed_probe_output" && reason.tool === "build"),
      true
    );
    assert.notEqual(malformedBuild.outcome, "resolved");

    const missingBuildVersion = await resolvePythonProjectContext({
      repoRoot: "/fixture",
      target: "app.py",
      workspace: projectWorkspace({
        ...files,
        "pyproject.toml": `${files["pyproject.toml"]}[build-system]\nrequires=['build']\nbuild-backend='example.backend'\n`
      }, () => true),
      processProbe: {
        ...validProbe,
        run(command, args, options) {
          const script = args[args.indexOf("-c") + 1] ?? "";
          return script.includes("opcore.python.project-context.build.v1")
            ? probeResult(command, args, options, {
                stdout: JSON.stringify({
                  protocol: "opcore.python.project-context.build.v1",
                  available: true,
                  version: null
                })
              })
            : validProbe.run(command, args, options);
        }
      }
    });
    assert.equal(missingBuildVersion.tools.find((tool) => tool.tool === "build")?.available, false);
    assert.equal(
      missingBuildVersion.reasons.some((reason) => reason.code === "malformed_probe_output" && reason.tool === "build"),
      true
    );
    assert.notEqual(missingBuildVersion.outcome, "resolved");
  });

  it("does not use provider-local executable paths when the injected workspace refuses them", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-host-workspace-"));
    try {
      const localPython = join(repoRoot, ".venv", "bin", "python");
      mkdirSync(dirname(localPython), { recursive: true });
      writeFileSync(localPython, "#!/bin/sh\nexit 0\n");
      chmodSync(localPython, 0o755);
      const files = {
        "pyproject.toml": "[project]\nname='fixture'\n",
        "app.py": "VALUE = 1\n"
      };
      const result = await runner({
        files,
        checks: createPythonValidationChecks({
          nodeWorkspace: projectWorkspace(files, () => false),
          processProbe: {
            run() {
              throw new Error("provider-local executable must not be probed");
            }
          }
        })
      }).runValidation(request({
        repo: { repoRoot },
        checks: [PYTHON_SOURCE_HYGIENE_CHECK_ID],
        scope: { kind: "files", files: ["app.py"] }
      }));

      assert.equal(result.pythonProjectContexts[0].interpreter, undefined);
      assert.equal(result.pythonProjectContexts[0].outcome, "unsupported");
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("refuses explicit interpreter paths outside the injected workspace trust boundary", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-explicit-host-path-"));
    try {
      const localPython = join(repoRoot, ".venv", "bin", "python");
      mkdirSync(dirname(localPython), { recursive: true });
      writeFileSync(localPython, "#!/bin/sh\nexit 0\n");
      chmodSync(localPython, 0o755);
      const result = await resolvePythonProjectContext({
        repoRoot,
        target: "app.py",
        interpreterArgv: [localPython],
        workspace: projectWorkspace({
          "pyproject.toml": "[project]\nname='fixture'\n",
          "app.py": "VALUE = 1\n"
        }, () => false),
        processProbe: {
          run() {
            throw new Error("refused explicit interpreter must not be probed");
          }
        }
      });

      assert.equal(result.interpreter, undefined);
      assert.equal(result.reasons.some((reason) => reason.code === "interpreter_unavailable"), true);
      assert.equal(result.outcome, "unsupported");
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("resolves each validation file view once per required Python tool selection", async () => {
    const files = {
      "pyproject.toml": "[project]\nname='fixture'\n",
      "app.py": "VALUE = 1\n"
    };
    const baseWorkspace = projectWorkspace(files, () => false);
    let listCalls = 0;
    const result = await runner({
      files,
      checks: createPythonValidationChecks({
        nodeWorkspace: {
          ...baseWorkspace,
          list: async () => {
            listCalls += 1;
            return baseWorkspace.list();
          }
        }
      })
    }).runValidation(request({
      repo: { repoRoot: "/fixture" },
      checks: [PYTHON_SOURCE_HYGIENE_CHECK_ID, PYTHON_TYPES_CHECK_ID],
      scope: { kind: "files", files: ["app.py"] }
    }));

    assert.equal(result.pythonProjectContexts.length, 1);
    assert.equal(listCalls, 2);
  });

  it("resolves each current file view independently of earlier context evidence", async () => {
    const originalFiles = {
      "pyproject.toml": "[project]\nname='fixture'\nrequires-python='>=3.11'\n",
      "app.py": "VALUE = 1\n"
    };
    const stale = await resolvePythonProjectContext({
      repoRoot: "/fixture",
      target: "app.py",
      workspace: projectWorkspace(originalFiles, () => true),
      processProbe: successfulProbe("3.12.4")
    });
    const currentFiles = {
      ...originalFiles,
      "pyproject.toml": "[project]\nname='fixture'\nrequires-python='>=3.13'\n"
    };
    const result = await runner({
      files: currentFiles,
      checks: createPythonValidationChecks({
        nodeWorkspace: projectWorkspace(currentFiles, () => true),
        processProbe: successfulProbe("3.12.4")
      })
    }).runValidation(request({
      repo: { repoRoot: "/fixture" },
      checks: [PYTHON_SOURCE_HYGIENE_CHECK_ID],
      scope: { kind: "files", files: ["app.py"] }
    }));

    assert.equal(result.pythonProjectContexts[0].targetRuntime.requiresPython, ">=3.13");
    assert.equal(result.pythonProjectContexts[0].outcome, "unsupported");
    assert.notEqual(result.pythonProjectContexts[0].contextFingerprint, stale.contextFingerprint);
  });

  it("parses setup.cfg python_requires and major-only PEP 440 range bounds", async () => {
    const files = {
      "setup.cfg": "[metadata]\nname = fixture\npython_requires = >=99\n[options]\npython_requires = >=3.11,<4\n",
      "app.py": "VALUE = 1\n"
    };
    const compatible = await resolvePythonProjectContext({
      repoRoot: "/fixture",
      target: "app.py",
      workspace: projectWorkspace(files, () => true),
      processProbe: successfulProbe("3.12.4")
    });
    const incompatible = await resolvePythonProjectContext({
      repoRoot: "/fixture",
      target: "app.py",
      workspace: projectWorkspace(files, () => true),
      processProbe: successfulProbe("4.0.0")
    });
    const belowFloor = await resolvePythonProjectContext({
      repoRoot: "/fixture",
      target: "app.py",
      workspace: projectWorkspace(files, () => true),
      processProbe: successfulProbe("3.10.14")
    });

    assert.equal(compatible.targetRuntime.requiresPython, ">=3.11,<4");
    assert.equal(compatible.outcome, "resolved");
    assert.equal(incompatible.outcome, "unsupported");
    assert.equal(incompatible.reasons.some((reason) => reason.code === "incompatible_interpreter"), true);
    assert.equal(belowFloor.outcome, "unsupported");
    assert.equal(belowFloor.reasons.some((reason) => reason.code === "incompatible_interpreter"), true);
  });

  it("applies PEP 440 compatible-release precision consistently", async () => {
    const compatible = await resolvePythonProjectContext({
      repoRoot: "/fixture",
      target: "app.py",
      workspace: projectWorkspace({
        "pyproject.toml": "[project]\nname='fixture'\nrequires-python='~=3.11'\n",
        "pyrightconfig.json": JSON.stringify({ pythonVersion: "3.12" }),
        "app.py": "VALUE = 1\n"
      }, () => true),
      processProbe: successfulProbe("3.12.4")
    });
    assert.equal(compatible.targetRuntime.conflicts.length, 0);
    assert.equal(compatible.reasons.some((reason) => reason.code === "incompatible_interpreter"), false);
    assert.equal(compatible.outcome, "resolved");

    const incompatible = await resolvePythonProjectContext({
      repoRoot: "/fixture",
      target: "app.py",
      workspace: projectWorkspace({
        "pyproject.toml": "[project]\nname='fixture'\nrequires-python='~=3.11.0'\n",
        "app.py": "VALUE = 1\n"
      }, () => true),
      processProbe: successfulProbe("3.12.4")
    });
    assert.equal(incompatible.reasons.some((reason) => reason.code === "incompatible_interpreter"), true);
    assert.equal(incompatible.outcome, "unsupported");

    const underspecified = await resolvePythonProjectContext({
      repoRoot: "/fixture",
      target: "app.py",
      workspace: projectWorkspace({
        "pyproject.toml": "[project]\nname='fixture'\nrequires-python='~=3'\n",
        "app.py": "VALUE = 1\n"
      }, () => true),
      processProbe: successfulProbe("3.12.4")
    });
    assert.equal(underspecified.reasons.some((reason) => reason.code === "unsupported_target"), true);
    assert.equal(underspecified.outcome, "unsupported");
  });

  it("does not treat prerelease interpreters as final PEP 440 releases", async () => {
    const resolveWithConstraint = (requiresPython) => resolvePythonProjectContext({
      repoRoot: "/fixture",
      target: "app.py",
      workspace: projectWorkspace({
        "pyproject.toml": `[project]\nname='fixture'\nrequires-python='${requiresPython}'\n`,
        "app.py": "VALUE = 1\n"
      }, () => true),
      processProbe: successfulProbe("3.13.0rc1")
    });

    const finalOnly = await resolveWithConstraint(">=3.13");
    assert.equal(finalOnly.reasons.some((reason) => reason.code === "incompatible_interpreter"), true);
    assert.equal(finalOnly.outcome, "unsupported");

    const explicitPrerelease = await resolveWithConstraint(">=3.13rc1");
    assert.equal(explicitPrerelease.reasons.some((reason) => reason.code === "incompatible_interpreter"), false);
    assert.equal(explicitPrerelease.outcome, "resolved");

    const laterPrerelease = await resolveWithConstraint(">=3.13rc2");
    assert.equal(laterPrerelease.reasons.some((reason) => reason.code === "incompatible_interpreter"), true);
    assert.equal(laterPrerelease.outcome, "unsupported");

    const betaFloor = await resolveWithConstraint(">=3.13b1");
    assert.equal(betaFloor.reasons.some((reason) => reason.code === "incompatible_interpreter"), false);
    assert.equal(betaFloor.outcome, "resolved");
  });

  it("checks requires-python and configured target version independently", async () => {
    const context = await resolvePythonProjectContext({
      repoRoot: "/fixture",
      target: "app.py",
      workspace: projectWorkspace({
        "pyproject.toml": "[project]\nname='fixture'\nrequires-python='>=3.10'\n",
        "pyrightconfig.json": JSON.stringify({ pythonVersion: "3.12" }),
        "app.py": "VALUE = 1\n"
      }, () => true),
      processProbe: successfulProbe("3.11.9")
    });

    assert.equal(context.targetRuntime.requiresPython, ">=3.10");
    assert.equal(context.targetRuntime.version, "3.12");
    assert.equal(context.reasons.some((reason) => reason.code === "incompatible_interpreter"), true);
    assert.equal(context.outcome, "unsupported");
  });

  it("uses JSONC target fields only from the precedence-selected Pyright config", async () => {
    const preferred = await resolvePythonProjectContext({
      repoRoot: "/fixture",
      target: "app.py",
      workspace: projectWorkspace({
        "pyrightconfig.json": "{ // selected target\n  \"pythonVersion\": \"3.14\",\n  \"pythonPlatform\": \"linux\",\n}\n",
        "pyproject.toml": "[project]\nname='fixture'\n[tool.pyright]\npythonVersion='3.11'\npythonPlatform='win32'\n",
        "app.py": "VALUE = 1\n"
      }, () => true),
      processProbe: successfulProbe("3.14.1")
    });

    assert.deepEqual(preferred.targetRuntime, {
      version: "3.14",
      platform: "linux",
      conflicts: []
    });
    assert.equal(preferred.outcome, "resolved");

    const incompatible = await resolvePythonProjectContext({
      repoRoot: "/fixture",
      target: "app.py",
      workspace: projectWorkspace({
        "pyrightconfig.json": "{ // preserve JSONC fields\n  \"pythonVersion\": \"3.13\",\n  \"pythonPlatform\": \"linux\",\n  \"pythonImplementation\": \"CPython\",\n}\n",
        "app.py": "VALUE = 1\n"
      }, () => true),
      processProbe: successfulProbe("3.13.9", "darwin")
    });

    assert.equal(incompatible.targetRuntime.version, "3.13");
    assert.equal(incompatible.targetRuntime.platform, "linux");
    assert.equal(incompatible.targetRuntime.implementation, "CPython");
    assert.equal(incompatible.reasons.some((reason) => reason.code === "incompatible_interpreter"), true);
    assert.equal(incompatible.outcome, "unsupported");
  });

  it("inherits recursive Pyright target fields into compatibility and fingerprints with child overrides", async () => {
    const inheritedFiles = {
      "pyrightconfig.json": "{ // child override\n  \"extends\": \"configs/base.json\",\n  \"pythonVersion\": \"3.13\",\n}\n",
      "configs/base.json": "{\n  \"extends\": \"more/leaf.json\",\n  \"pythonPlatform\": \"linux\",\n}\n",
      "configs/more/leaf.json": "{\n  \"pythonVersion\": \"3.11\",\n  \"pythonImplementation\": \"CPython\",\n}\n",
      "app.py": "VALUE = 1\n"
    };
    const inherited = await resolvePythonProjectContext({
      repoRoot: "/fixture",
      target: "app.py",
      workspace: projectWorkspace(inheritedFiles, () => true),
      processProbe: successfulProbe("3.13.9", "darwin")
    });

    assert.deepEqual(inherited.targetRuntime, {
      version: "3.13",
      platform: "linux",
      implementation: "CPython",
      conflicts: []
    });
    assert.equal(inherited.reasons.some((reason) => reason.code === "incompatible_interpreter"), true);
    assert.equal(inherited.outcome, "unsupported");

    const changed = await resolvePythonProjectContext({
      repoRoot: "/fixture",
      target: "app.py",
      workspace: projectWorkspace({
        ...inheritedFiles,
        "configs/more/leaf.json": "{\n  \"pythonVersion\": \"3.11\",\n  \"pythonImplementation\": \"PyPy\",\n}\n"
      }, () => true),
      processProbe: successfulProbe("3.13.9", "darwin")
    });

    assert.equal(changed.targetRuntime.implementation, "PyPy");
    assert.notEqual(changed.contextFingerprint, inherited.contextFingerprint);
  });

  it("returns a typed ambiguous context for a target symlink escaping the repository", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "opcore-python-symlink-repo-"));
    const externalRoot = mkdtempSync(join(tmpdir(), "opcore-python-symlink-external-"));
    try {
      writeFileSync(join(repoRoot, "pyproject.toml"), "[project]\nname='fixture'\n");
      writeFileSync(join(externalRoot, "outside.py"), "VALUE = 1\n");
      symlinkSync(join(externalRoot, "outside.py"), join(repoRoot, "app.py"));
      const context = await resolvePythonProjectContext({
        repoRoot,
        target: "app.py",
        workspace: createNodePythonProjectWorkspace(repoRoot),
        processProbe: successfulProbe()
      });
      assert.equal(context.outcome, "ambiguous");
      assert.equal(context.reasons.some((reason) => reason.code === "symlink_refused" && reason.path === "app.py"), true);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(externalRoot, { recursive: true, force: true });
    }
  });

  it("preserves baseline symlink refusal when the target has an after-state overlay", async () => {
    const files = {
      "pyproject.toml": "[project]\nname='fixture'\n",
      "app.py": "VALUE = 1\n"
    };
    const result = await runner({
      files,
      checks: createPythonValidationChecks({
        processProbe: successfulProbe(),
        nodeWorkspace: projectWorkspace(files, () => true, new Set(["app.py"]))
      })
    }).runValidation(request({
      repo: { repoRoot: "/fixture" },
      checks: [PYTHON_SOURCE_HYGIENE_CHECK_ID],
      scope: { kind: "files", files: ["app.py"] },
      overlays: [{ path: "app.py", action: "write", content: "VALUE = 2\n" }]
    }));

    assert.equal(result.pythonProjectContexts[0].outcome, "ambiguous");
    assert.equal(
      result.pythonProjectContexts[0].reasons.some((reason) => reason.code === "symlink_refused" && reason.path === "app.py"),
      true
    );
  });

  it("bounds package ancestry at the owning project and source root", async () => {
    const context = await resolvePythonProjectContext({
      repoRoot: "/fixture",
      target: "services/api/app.py",
      workspace: projectWorkspace({
        "pyproject.toml": "[project]\nname='root'\n",
        "services/api/pyproject.toml": "[project]\nname='api'\n",
        "services/api/app.py": "VALUE = 1\n"
      }, () => true),
      processProbe: successfulProbe()
    });
    assert.equal(context.projectRoot, "services/api");
    assert.deepEqual(context.layout.kinds, ["flat"]);
  });

  it("preserves overlay after-state project identity without probing inactive Ruff tools", async () => {
    const before = {
      "pyproject.toml": "[project]\nname='fixture'\nrequires-python='>=3.11'\n",
      "app.py": "VALUE = 1\n"
    };
    const after = {
      "pyproject.toml": "[project]\nname='fixture'\nrequires-python='>=3.12'\n[tool.uv]\npackage=true\n",
      "app.py": "VALUE = 2\n"
    };
    const validationResult = await runner({
      files: before,
      checks: createPythonValidationChecks({ processProbe: successfulProbe() })
    }).runValidation(request({
      repo: { repoRoot: "/fixture" },
      checks: [PYTHON_SOURCE_HYGIENE_CHECK_ID],
      scope: { kind: "files", files: ["app.py"] },
      overlays: [
        { path: "pyproject.toml", action: "write", content: after["pyproject.toml"] },
        { path: "app.py", action: "write", content: after["app.py"] }
      ]
    }));
    const materialized = await resolvePythonProjectContext({
      repoRoot: "/fixture",
      target: "app.py",
      workspace: projectWorkspace(after, (command) => !command.includes("/")),
      processProbe: successfulProbe()
    });

    assert.equal(validationResult.pythonProjectContexts.length, 1);
    assert.equal(validationResult.pythonProjectContexts[0].projectKey, materialized.projectKey);
    assert.equal(validationResult.pythonProjectContexts[0].projectRoot, materialized.projectRoot);
    assert.equal(validationResult.pythonProjectContexts[0].outcome, materialized.outcome);
    assert.deepEqual(validationResult.pythonProjectContexts[0].tools, []);
  });

  it("removes deleted project markers from overlay discovery without probing inactive Ruff tools", async () => {
    const before = {
      "pyproject.toml": "[project]\nname='root'\n",
      "services/api/pyproject.toml": "[project]\nname='api'\n",
      "services/api/app.py": "VALUE = 1\n"
    };
    const result = await runner({
      files: before,
      checks: createPythonValidationChecks({
        processProbe: successfulProbe(),
        nodeWorkspace: projectWorkspace(before, (command) => !command.includes("/"))
      })
    }).runValidation(request({
      repo: { repoRoot: "/fixture" },
      checks: [PYTHON_SOURCE_HYGIENE_CHECK_ID],
      scope: { kind: "files", files: ["services/api/app.py"] },
      overlays: [{ path: "services/api/pyproject.toml", action: "delete" }]
    }));
    const materialized = await resolvePythonProjectContext({
      repoRoot: "/fixture",
      target: "services/api/app.py",
      workspace: projectWorkspace({
        "pyproject.toml": before["pyproject.toml"],
        "services/api/app.py": before["services/api/app.py"]
      }, (command) => !command.includes("/")),
      processProbe: successfulProbe()
    });
    const overlay = result.pythonProjectContexts[0];
    assert.equal(overlay.projectRoot, ".");
    assert.equal(overlay.projectKey, materialized.projectKey, JSON.stringify({ overlay, materialized }, null, 2));
    assert.equal(overlay.outcome, materialized.outcome);
    assert.deepEqual(overlay.tools, []);
  });
});

function runner(options = {}) {
  return createValidationRunner({
    workspace: workspace(options),
    checks: options.checks ?? createPythonValidationChecks(),
    graphProviderClient: options.graphProviderClient,
    graphSessionFactory: options.graphSessionFactory
  });
}

function exactGraphSessionFactory(client) {
  return (args) => createValidationGraphQuerySession({
    ...args,
    client,
    status: availableStatus(args.request.graph.mode, args.request.repo)
  });
}

function createPythonValidationChecks(options = {}) {
  return createCanonicalPythonValidationChecks({
    ...options,
    importAnalyzer: options.importAnalyzer ?? { analyze: async () => [] },
    nodeWorkspace: options.nodeWorkspace ?? canonicalTestPythonWorkspace()
  });
}

function canonicalTestPythonWorkspace() {
  return {
    read: async () => undefined,
    list: async () => [],
    exists: async () => false,
    realpath: async (path) => ({ path, symlink: false }),
    executableExists: async (path) => !path.includes("/") && !path.includes("\\") || existsSync(path)
  };
}

function projectWorkspace(files, executableExists, symlinks = new Set()) {
  const contents = new Map(Object.entries(files));
  return {
    read: async (path) => contents.get(path),
    list: async () => [...contents.keys()].sort(),
    exists: async (path) => contents.has(path),
    realpath: async (path) => ({ path, symlink: symlinks.has(path) }),
    executableExists: async (path) => executableExists(path)
  };
}

function fixedImportAnalyzer(edges) {
  return { analyze: async () => edges };
}

function successfulProbe(version = "3.12.4", platform = "linux") {
  return {
    resolveExecutable(command) {
      return command.includes("/") ? command : `/usr/bin/${command}`;
    },
    run(command, args, options) {
      const script = args[args.indexOf("-c") + 1] ?? "";
      const build = script.includes("opcore.python.project-context.build.v1");
      const interpreter = args.includes("-c") && !build;
      return probeResult(command, args, options, {
        stdout: build
          ? JSON.stringify({ protocol: "opcore.python.project-context.build.v1", available: true, version: "1.2.2" })
          : interpreter
          ? JSON.stringify({
              protocol: "opcore.python.project-context.interpreter.v1",
              executable: command.includes("/") ? command : `/usr/bin/${command}`,
              version,
              implementation: "CPython",
              platform,
              architecture: "x86_64",
              abi: "cpython-312",
              soabi: "cpython-312-x86_64-linux-gnu"
            })
          : `${command} 1.0.0`
      });
    }
  };
}

function buildUnavailableProbe() {
  const base = successfulProbe();
  return {
    ...base,
    run(command, args, options) {
      const script = args[args.indexOf("-c") + 1] ?? "";
      if (script.includes("opcore.python.project-context.build.v1")) {
        return probeResult(command, args, options, {
          stdout: JSON.stringify({ protocol: "opcore.python.project-context.build.v1", available: false, version: null })
        });
      }
      return base.run(command, args, options);
    }
  };
}

function windowsProbe(interpreter) {
  return {
    run(command, args, options) {
      return probeResult(command, args, options, {
        stdout: args.includes("-c")
          ? JSON.stringify({
              protocol: "opcore.python.project-context.interpreter.v1",
              executable: interpreter,
              version: "3.12.4",
              implementation: "CPython",
              platform: "win32",
              architecture: "AMD64",
              abi: "cpython-312",
              soabi: "cp312-win_amd64"
            })
          : `${command} 1.0.0`
      });
    }
  };
}

function failingProbe(mode) {
  return {
    run(command, args, options) {
      if (mode === "malformed") return probeResult(command, args, options, { stdout: "not-json" });
      const base = probeResult(command, args, options, { ok: false });
      if (mode === "timeout") return { ...base, termination: "timeout", exitCode: null, failureMessage: "timeout" };
      if (mode === "signal") return { ...base, termination: "signal", exitCode: null, signal: "SIGTERM", failureMessage: "signal" };
      if (mode === "spawn") return { ...base, termination: "spawn_error", exitCode: null, failureMessage: "permission denied" };
      return { ...base, termination: "exited", exitCode: 9, failureMessage: "exit 9" };
    }
  };
}

function probeResult(command, args, options, overrides = {}) {
  return {
    command,
    args,
    cwd: options.cwd,
    allowedExitCodes: [0],
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    termination: "exited",
    ok: true,
    ...overrides
  };
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
    listFiles: () => ({ files: [...files.keys()] }),
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
  return fixtureFilesAt(root);
}

function fixtureFilesAt(root) {
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

async function processExited(pid) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return true;
      throw error;
    }
    await delay(10);
  }
  return false;
}

function materializedMypyWorkspaces() {
  return readdirSync(tmpdir())
    .filter((entry) => entry.startsWith(`opcore-python-types-workspace-${process.pid}-`))
    .sort();
}

function writeToolShim(repoRoot, name, content) {
  const bin = join(repoRoot, ".venv", "bin");
  mkdirSync(bin, { recursive: true });
  const shimPath = join(bin, name);
  writeFileSync(shimPath, content);
  chmodSync(shimPath, 0o755);
}

function pyrightShim(version, diagnostics, exitCode = diagnostics.some((entry) => entry.severity === "error") ? 1 : 0) {
  const payload = pyrightPayload(version, diagnostics);
  return rawPyrightShim(version, [
    "cat <<'OPCORE_PYRIGHT_JSON'",
    JSON.stringify(payload),
    "OPCORE_PYRIGHT_JSON",
    `exit ${exitCode}`
  ].join("\n"));
}

function pyrightPayload(version, diagnostics) {
  const summary = {
    filesAnalyzed: 1,
    errorCount: diagnostics.filter((entry) => entry.severity === "error").length,
    warningCount: diagnostics.filter((entry) => entry.severity === "warning").length,
    informationCount: diagnostics.filter((entry) => entry.severity === "information").length,
    timeInSec: 0.01
  };
  return { version, time: "0", generalDiagnostics: diagnostics, summary };
}

function rawPyrightShim(version, body) {
  return [
    "#!/bin/sh",
    `for arg in \"$@\"; do if [ \"$arg\" = \"--version\" ]; then echo 'pyright ${version}'; exit 0; fi; done`,
    body,
    ""
  ].join("\n");
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
      "  *opcore.python.project-context.interpreter.v1*)",
      projectContextInterpreterResponse("SHIM_PATH"),
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

function writePassingPythonProtocolShim(repoRoot) {
  const shimPath = writePythonProtocolShim(repoRoot, [protocolResponse("SHIM_PATH", [{ path: "pkg/app.py", status: "passed" }])]);
  replaceShimPlaceholder(shimPath);
  return shimPath;
}

function projectContextInterpreterResponse(executable) {
  return `printf '%s\\n' '${JSON.stringify({
    protocol: "opcore.python.project-context.interpreter.v1",
    executable,
    version: "3.12.13",
    implementation: "CPython",
    platform: "darwin",
    architecture: "arm64",
    abi: "cpython-312",
    soabi: "cpython-312-darwin"
  })}'`;
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
