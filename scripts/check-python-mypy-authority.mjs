import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  createNodePythonProjectWorkspace,
  createPythonValidationChecks,
  PYTHON_TYPES_CHECK_ID
} from "../packages/validation-python/dist/index.js";
import { validatePythonValidationCapabilityRun } from "../packages/contracts/dist/index.js";
import { createValidationRunner } from "../packages/validation/dist/index.js";

const fixtureRoot = resolve("packages/fixtures/validation-python/mypy-authority");
const executable = process.env.OPCORE_REAL_MYPY;
if (executable === undefined || executable.length === 0) {
  throw new Error("OPCORE_REAL_MYPY must name the pinned mypy 2.3.0 executable");
}
const versionProbe = spawnSync(executable, ["--version"], { encoding: "utf8" });
if (versionProbe.status !== 0) throw new Error(versionProbe.stderr || "mypy --version failed");
const version = /mypy\s+(?:version:\s*)?(\d+(?:\.\d+)+)/iu.exec(`${versionProbe.stdout}\n${versionProbe.stderr}`)?.[1];
assert.equal(version, "2.3.0", "authoritative proof must use mypy 2.3.0");

const files = fixtureFiles(fixtureRoot);
const sourcePaths = Object.keys(files)
  .filter((path) => /\.pyi?$/u.test(path) && !/(?:mypy_plugin|plugin_support)\.py$/u.test(path))
  .sort();
const originalApp = files["src/acme/app.py"];
const failingApp = originalApp.replace("-> str:\n    return render(value)", "-> int:\n    return render(value)");
const tempBefore = mypyTempWorkspaces();

const clean = await validate(files, []);
assertPortableResult(clean);
assert.equal(clean.status, "passed", JSON.stringify(clean, null, 2));
assert.equal(clean.pythonCapabilityRuns.length, 1);
assert.equal(clean.pythonCapabilityRuns[0].status, "passed");
assert.equal(clean.pythonCapabilityRuns[0].tool.version, "2.3.0");
assert.equal(clean.pythonCapabilityRuns[0].tool.configFile, "pyproject.toml");
assert.equal(clean.pythonCapabilityRuns[0].selectedSourcePaths.includes("src/acme/mypy_plugin.py"), true);
assert.equal(clean.pythonCapabilityRuns[0].selectedSourcePaths.includes("src/acme/plugin_support.py"), true);

const overlay = await validate(files, [{ path: "src/acme/app.py", action: "write", content: failingApp }]);
assertPortableResult(overlay);
assert.equal(overlay.status, "policy_failure", JSON.stringify(overlay, null, 2));
assert.equal(overlay.pythonCapabilityRuns[0].status, "findings");
assert.equal(overlay.diagnostics.some((entry) => entry.code === "MYPY_RETURN_VALUE"), true);

const materialized = await validate({ ...files, "src/acme/app.py": failingApp }, []);
assertPortableResult(materialized);
assert.equal(materialized.status, "policy_failure", JSON.stringify(materialized, null, 2));
assert.equal(
  overlay.pythonCapabilityRuns[0].afterStateManifestFingerprint,
  materialized.pythonCapabilityRuns[0].afterStateManifestFingerprint
);
assert.deepEqual(
  overlay.diagnostics.map(normalizedDiagnostic),
  materialized.diagnostics.map(normalizedDiagnostic)
);
const invalidConfig = await validate({
  ...files,
  "pyproject.toml": files["pyproject.toml"].replace("strict = true", "strict = \"garbage\"")
}, []);
assertPortableResult(invalidConfig);
assert.equal(invalidConfig.status, "unsupported_request", JSON.stringify(invalidConfig, null, 2));
assert.equal(invalidConfig.pythonCapabilityRuns[0].status, "invalid_config");
assert.equal(invalidConfig.pythonCapabilityRuns[0].execution.termination, "exited");
assert.equal(invalidConfig.pythonCapabilityRuns[0].execution.exitCode, 0);
assert.equal(invalidConfig.diagnostics[0].code, "PYTHON_TYPES_INVALID_CONFIG");

const attackRoot = mkdtempSync(resolve(tmpdir(), "opcore-mypy-authority-isolation-"));
let outputPathStatus;
let hostPluginStatus;
try {
  const outputVictim = resolve(attackRoot, "output-victim.py");
  const hostPlugin = resolve(attackRoot, "host-plugin.py");
  const pluginMarker = resolve(attackRoot, "host-plugin-executed");
  writeFileSync(outputVictim, "SOURCE_UNCHANGED\n", "utf8");
  writeFileSync(hostPlugin, [
    "from pathlib import Path",
    `Path(${JSON.stringify(pluginMarker)}).write_text('executed', encoding='utf8')`,
    ""
  ].join("\n"), "utf8");

  const outputPath = await validate({
    ...files,
    "pyproject.toml": `${files["pyproject.toml"]}\njunit_xml = ${JSON.stringify(outputVictim)}\n`
  }, []);
  assertPortableResult(outputPath);
  assert.equal(outputPath.status, "unsupported_request", JSON.stringify(outputPath, null, 2));
  assert.equal(outputPath.pythonCapabilityRuns[0].status, "invalid_config");
  assert.equal(outputPath.pythonCapabilityRuns[0].execution, undefined);
  assert.equal(readFileSync(outputVictim, "utf8"), "SOURCE_UNCHANGED\n");
  outputPathStatus = outputPath.pythonCapabilityRuns[0].status;

  const hostPluginConfig = files["pyproject.toml"].replace(
    'plugins = ["acme.mypy_plugin"]',
    `plugins = [${JSON.stringify(hostPlugin)}]`
  );
  const hostPluginResult = await validate({ ...files, "pyproject.toml": hostPluginConfig }, []);
  assertPortableResult(hostPluginResult);
  assert.equal(hostPluginResult.status, "unsupported_request", JSON.stringify(hostPluginResult, null, 2));
  assert.equal(hostPluginResult.pythonCapabilityRuns[0].status, "invalid_config");
  assert.equal(hostPluginResult.pythonCapabilityRuns[0].execution, undefined);
  assert.equal(existsSync(pluginMarker), false);
  hostPluginStatus = hostPluginResult.pythonCapabilityRuns[0].status;
} finally {
  rmSync(attackRoot, { recursive: true, force: true });
}
assert.equal(readFileSync(resolve(fixtureRoot, "src/acme/app.py"), "utf8"), originalApp);
assert.equal(existsSync(resolve(fixtureRoot, ".mypy_cache")), false);
assert.equal(existsSync(resolve(fixtureRoot, "__pycache__")), false);
assert.deepEqual(mypyTempWorkspaces(), tempBefore);

const proof = {
  schemaId: "opcore.python.mypy-authority-proof",
  schemaVersion: 1,
  mypyVersion: version,
  executable: clean.pythonCapabilityRuns[0].tool.executable,
  clean: receiptSummary(clean),
  overlay: receiptSummary(overlay),
  materialized: receiptSummary(materialized),
  invalidConfig: receiptSummary(invalidConfig),
  outputPathStatus,
  hostPluginStatus,
  sourceUnchanged: true,
  persistentCacheAbsent: true,
  temporaryWorkspacesCleaned: true
};
const serializedProof = JSON.stringify(proof);
assert.equal(serializedProof.includes(fixtureRoot), false, "proof receipt must not contain the checkout root");
assert.equal(serializedProof.includes("opcore-python-types-workspace-"), false, "proof receipt must not contain materialization roots");
process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`);

async function validate(fileMap, overlays) {
  const workspace = validationWorkspace(fileMap);
  const checks = createPythonValidationChecks({
    repoRoot: fixtureRoot,
    checker: "mypy",
    toolArgv: { mypy: [executable] },
    nodeWorkspace: createNodePythonProjectWorkspace(fixtureRoot),
    importAnalyzer: {
      analyze: async () => [{
        fromPath: "src/acme/mypy_plugin.py",
        toPath: "src/acme/plugin_support.py"
      }]
    },
    env: process.env
  });
  return createValidationRunner({ workspace, checks }).runValidation({
    requestId: "python-mypy-authority-proof",
    repo: { repoRoot: fixtureRoot },
    scope: { kind: "files", files: sourcePaths },
    graph: { mode: "optional", provider: "opcore-graph" },
    overlays,
    checks: [PYTHON_TYPES_CHECK_ID]
  });
}

function validationWorkspace(fileMap) {
  return {
    readFile: (path) => Object.hasOwn(fileMap, path)
      ? { status: "found", content: fileMap[path] }
      : { status: "missing" },
    listFiles: () => ({ files: Object.keys(fileMap).sort() }),
    listChangedFiles: () => ({ files: Object.keys(fileMap).sort() }),
    listStagedFiles: () => ({ files: Object.keys(fileMap).sort() }),
    listRepoFiles: () => ({ files: Object.keys(fileMap).sort() }),
    listPackageFiles: () => ({ files: Object.keys(fileMap).sort() })
  };
}

function fixtureFiles(root) {
  const files = {};
  for (const absolute of walk(root)) {
    const fixturePath = relative(root, absolute).replaceAll("\\", "/");
    const path = fixturePath.endsWith(".fixture")
      ? fixturePath.slice(0, -".fixture".length)
      : fixturePath;
    files[path] = readFileSync(absolute, "utf8");
  }
  return files;
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function mypyTempWorkspaces() {
  return readdirSync(tmpdir()).filter((name) => name.startsWith("opcore-python-types-workspace-")).sort();
}

function normalizedDiagnostic(entry) {
  return {
    category: entry.category,
    severity: entry.severity,
    code: entry.code,
    message: entry.message,
    path: entry.path,
    line: entry.line,
    column: entry.column
  };
}

function receiptSummary(result) {
  const run = result.pythonCapabilityRuns[0];
  return {
    status: run.status,
    authority: run.authority,
    authoritySource: run.authoritySource,
    projectKey: run.projectKey,
    contextFingerprint: run.contextFingerprint,
    afterStateManifestFingerprint: run.afterStateManifestFingerprint,
    argv: run.tool.argv,
    cwd: run.tool.cwd,
    toolSource: run.tool.source,
    toolVersion: run.tool.version,
    configFile: run.tool.configFile,
    execution: run.execution,
    diagnosticCount: run.diagnosticCount
  };
}

function assertPortableResult(result) {
  assert.equal(result.pythonCapabilityRuns.length, 1, JSON.stringify(result, null, 2));
  const run = validatePythonValidationCapabilityRun(result.pythonCapabilityRuns[0]);
  const serialized = JSON.stringify(run);
  assert.equal(serialized.includes(fixtureRoot), false, "capability run must not contain the checkout root");
  assert.equal(serialized.includes("opcore-python-types-workspace-"), false, "capability run must not contain materialization roots");
}
