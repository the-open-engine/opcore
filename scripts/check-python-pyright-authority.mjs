import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  createNodePythonProjectWorkspace,
  createPythonValidationChecks,
  PYTHON_TYPES_CHECK_ID
} from "../packages/validation-python/dist/index.js";
import { validatePythonValidationCapabilityRun } from "../packages/contracts/dist/index.js";
import { createValidationRunner } from "../packages/validation/dist/index.js";
import { createStagedOpcorePackage } from "./stage-opcore-bundle.mjs";

const fixtureRoot = resolve("packages/fixtures/validation-python/pyright-authority");
const executable = process.env.OPCORE_REAL_PYRIGHT;
if (executable === undefined || executable.length === 0) {
  throw new Error("OPCORE_REAL_PYRIGHT must name the pinned Pyright 1.1.411 executable");
}
const versionProbe = run(executable, ["--version"]);
const version = /pyright\s+(\d+(?:\.\d+)+)/iu.exec(`${versionProbe.stdout}\n${versionProbe.stderr}`)?.[1];
assert.equal(version, "1.1.411", "authoritative proof must use Pyright 1.1.411");

const pythonProbe = run("python3", ["-c", "import json,sys; print(json.dumps({'version':f'{sys.version_info.major}.{sys.version_info.minor}','platform':sys.platform}))"]);
const python = JSON.parse(pythonProbe.stdout.trim());
const pyrightPlatform = python.platform === "win32" ? "Windows" : python.platform === "darwin" ? "Darwin" : "Linux";
const files = fixtureFiles(fixtureRoot);
files["pyrightconfig.json"] = files["pyrightconfig.json"]
  .replace("PYTHON_VERSION", python.version)
  .replace("PYTHON_PLATFORM", pyrightPlatform);
const sourcePaths = Object.keys(files).filter((path) => /\.pyi?$/u.test(path)).sort();
const originalApp = files["src/acme/app.py"];
const failingApp = originalApp.replace("def render_value(value: int) -> str:", "def render_value(value: int) -> int:");
const fixtureHashBefore = treeHash(fixtureRoot);
const tempBefore = pyrightTempWorkspaces();

const clean = await validate(files, []);
assertPortableResult(clean);
assert.equal(clean.status, "passed", JSON.stringify(clean, null, 2));
assert.equal(clean.pythonCapabilityRuns[0].status, "passed");
assert.equal(clean.pythonCapabilityRuns[0].tool.version, "1.1.411");
assert.equal(clean.pythonCapabilityRuns[0].tool.configFile, "pyrightconfig.json");
assert.deepEqual(clean.pythonCapabilityRuns[0].selectedConfigPaths, [
  "configs/base.json", "configs/strict.json", "pyrightconfig.json"
]);
assert.equal(clean.pythonCapabilityRuns[0].selectedSourcePaths.includes("stubs/external/__init__.pyi"), true);
for (const path of ["shared/helper.py", "src/namespace_pkg/tool.py", "src/excluded/broken.py", "src/ignored/broken.py"]) {
  assert.equal(clean.pythonCapabilityRuns[0].selectedSourcePaths.includes(path), true, `${path} must be in the exact after-state manifest`);
}
assert.equal(clean.diagnostics.some((entry) => entry.path === "src/excluded/broken.py"), false, "Pyright exclude configuration was not honored");
assert.equal(clean.diagnostics.some((entry) => entry.path === "src/ignored/broken.py"), false, "Pyright ignore configuration was not honored");

const overlay = await validate(files, [{ path: "src/acme/app.py", action: "write", content: failingApp }]);
assertPortableResult(overlay);
assert.equal(overlay.status, "policy_failure", JSON.stringify(overlay, null, 2));
assert.equal(overlay.pythonCapabilityRuns[0].status, "findings");
assert.equal(overlay.diagnostics.some((entry) => entry.code === "PYRIGHT_REPORT_RETURN_TYPE"), true);

const materialized = await validate({ ...files, "src/acme/app.py": failingApp }, []);
assertPortableResult(materialized);
assert.equal(materialized.status, "policy_failure", JSON.stringify(materialized, null, 2));
assert.equal(
  overlay.pythonCapabilityRuns[0].afterStateManifestFingerprint,
  materialized.pythonCapabilityRuns[0].afterStateManifestFingerprint
);
assert.deepEqual(overlay.diagnostics.map(normalizedDiagnostic), materialized.diagnostics.map(normalizedDiagnostic));

const configExit3 = proveRealConfigExit3();
const packedInstall = provePackedInstall(files);
assert.equal(treeHash(fixtureRoot), fixtureHashBefore, "Pyright proof changed fixture inputs");
assert.equal(readFileSync(resolve(fixtureRoot, "src/acme/app.py"), "utf8"), originalApp);
assert.equal(existsSync(resolve(fixtureRoot, ".pyright")), false);
assert.equal(existsSync(resolve(fixtureRoot, "__pycache__")), false);
assert.deepEqual(pyrightTempWorkspaces(), tempBefore);

const proof = {
  schemaId: "opcore.python.pyright-authority-proof",
  schemaVersion: 1,
  pyrightVersion: version,
  executable: clean.pythonCapabilityRuns[0].tool.executable,
  clean: receiptSummary(clean),
  overlay: receiptSummary(overlay),
  materialized: receiptSummary(materialized),
  configExit3,
  packedInstall,
  sourceUnchanged: true,
  persistentCacheAbsent: true,
  temporaryWorkspacesCleaned: true
};
const serializedProof = JSON.stringify(proof);
assert.equal(serializedProof.includes(fixtureRoot), false, "proof receipt must not contain the checkout root");
assert.equal(serializedProof.includes("opcore-python-types-workspace-"), false, "proof receipt must not contain materialization roots");
process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`);

async function validate(fileMap, overlays) {
  const checks = createPythonValidationChecks({
    repoRoot: fixtureRoot,
    checker: "pyright",
    toolArgv: { pyright: [executable] },
    nodeWorkspace: createNodePythonProjectWorkspace(fixtureRoot),
    importAnalyzer: { analyze: async () => [] },
    env: process.env
  });
  return createValidationRunner({ workspace: validationWorkspace(fileMap), checks }).runValidation({
    requestId: "python-pyright-authority-proof",
    repo: { repoRoot: fixtureRoot },
    scope: { kind: "files", files: sourcePaths },
    graph: { mode: "optional", provider: "opcore-graph" },
    overlays,
    checks: [PYTHON_TYPES_CHECK_ID]
  });
}

function proveRealConfigExit3() {
  const root = mkdtempSync(join(tmpdir(), "opcore-pyright-config-exit-"));
  try {
    writeFileSync(join(root, "pyrightconfig.json"), "{ malformed\n", "utf8");
    const result = spawnSync(executable, ["--outputjson", "--project", "pyrightconfig.json"], {
      cwd: root, encoding: "utf8", env: isolatedProofEnvironment(root)
    });
    assert.equal(result.status, 3, `expected Pyright config exit 3: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.version, "1.1.411");
    assert.deepEqual(output.generalDiagnostics, []);
    return { status: "invalid_config", termination: "exited", exitCode: 3, version: output.version };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function provePackedInstall(fileMap) {
  const root = mkdtempSync(join(tmpdir(), "opcore-pyright-packed-proof-"));
  const staged = createStagedOpcorePackage(root);
  try {
    const packed = run("npm", ["pack", "--json", "--pack-destination", root], { cwd: staged.packageDir });
    const tarball = join(root, JSON.parse(packed.stdout)[0].filename);
    const project = join(root, "project");
    mkdirSync(project, { recursive: true });
    run("npm", ["init", "-y"], { cwd: project });
    run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], { cwd: project });
    writeFixture(project, fileMap);
    const sourceHash = treeHash(project, (path) => !path.startsWith("node_modules/") && !path.startsWith(".opcore/"));
    const cli = join(project, "node_modules/.bin/opcore");
    const result = spawnSync(cli, [
      "check", "files", "--files", "src/acme/app.py", "--checks", "python.types", "--json"
    ], {
      cwd: project,
      encoding: "utf8",
      env: { ...process.env, PATH: `${dirname(executable)}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}` },
      timeout: 60_000
    });
    assert.equal(result.status, 0, `packed Opcore Pyright execution failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const payload = JSON.parse(result.stdout);
    const runReceipt = payload.validationResult.pythonCapabilityRuns.find((entry) => entry.authority === "pyright");
    validatePythonValidationCapabilityRun(runReceipt);
    assert.equal(runReceipt.status, "passed");
    assert.equal(runReceipt.tool.version, "1.1.411");
    assert.equal(treeHash(project, (path) => !path.startsWith("node_modules/") && !path.startsWith(".opcore/")), sourceHash);
    return { status: runReceipt.status, authority: runReceipt.authority, toolVersion: runReceipt.tool.version };
  } finally {
    staged.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
}

function validationWorkspace(fileMap) {
  return {
    readFile: (path) => Object.hasOwn(fileMap, path) ? { status: "found", content: fileMap[path] } : { status: "missing" },
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
    const path = fixturePath.endsWith(".fixture") ? fixturePath.slice(0, -".fixture".length) : fixturePath;
    files[path] = readFileSync(absolute, "utf8");
  }
  return files;
}

function writeFixture(root, files) {
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, "utf8");
  }
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function treeHash(root, include = () => true) {
  const hash = createHash("sha256");
  for (const absolute of walk(root)) {
    const path = relative(root, absolute).replaceAll("\\", "/");
    if (!include(path)) continue;
    hash.update(path).update("\0").update(readFileSync(absolute)).update("\0");
  }
  return hash.digest("hex");
}

function pyrightTempWorkspaces() {
  return readdirSync(tmpdir()).filter((name) => name.startsWith("opcore-python-types-workspace-")).sort();
}

function normalizedDiagnostic(entry) {
  return {
    category: entry.category, severity: entry.severity, code: entry.code, message: entry.message,
    path: entry.path, line: entry.line, column: entry.column, endLine: entry.endLine, endColumn: entry.endColumn
  };
}

function receiptSummary(result) {
  const runReceipt = result.pythonCapabilityRuns[0];
  return {
    status: runReceipt.status,
    authority: runReceipt.authority,
    authoritySource: runReceipt.authoritySource,
    projectKey: runReceipt.projectKey,
    contextFingerprint: runReceipt.contextFingerprint,
    afterStateManifestFingerprint: runReceipt.afterStateManifestFingerprint,
    selectedSourcePaths: runReceipt.selectedSourcePaths,
    selectedConfigPaths: runReceipt.selectedConfigPaths,
    argv: runReceipt.tool.argv,
    cwd: runReceipt.tool.cwd,
    toolSource: runReceipt.tool.source,
    toolVersion: runReceipt.tool.version,
    configFile: runReceipt.tool.configFile,
    execution: runReceipt.execution,
    diagnosticCount: runReceipt.diagnosticCount
  };
}

function assertPortableResult(result) {
  assert.equal(result.pythonCapabilityRuns.length, 1, JSON.stringify(result, null, 2));
  const runReceipt = validatePythonValidationCapabilityRun(result.pythonCapabilityRuns[0]);
  const serialized = JSON.stringify(runReceipt);
  assert.equal(serialized.includes(fixtureRoot), false, "capability run must not contain checkout root");
  assert.equal(serialized.includes("opcore-python-types-workspace-"), false, "capability run must not contain materialization roots");
}

function isolatedProofEnvironment(root) {
  return {
    PATH: `${dirname(executable)}${process.platform === "win32" ? ";" : ":"}${dirname(process.execPath)}`,
    HOME: root,
    XDG_CONFIG_HOME: root,
    XDG_CACHE_HOME: root,
    TMPDIR: root,
    PYTHONPATH: "",
    PYTHONNOUSERSITE: "1",
    NODE_PATH: "",
    NODE_OPTIONS: "",
    LC_ALL: "C",
    LANG: "C"
  };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 120_000, ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed code=${result.status} signal=${result.signal}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result;
}
