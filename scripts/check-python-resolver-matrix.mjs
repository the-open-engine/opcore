#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  createNodePythonProjectWorkspace,
  createPythonValidationChecks,
  PYTHON_SYNTAX_CHECK_ID,
  PYTHON_TYPES_CHECK_ID,
  resolvePythonProjectContext
} from "../packages/validation-python/dist/index.js";
import {
  createNodeValidationWorkspace,
  createValidationRunner
} from "../packages/validation/dist/index.js";

const fixtureRoot = new URL("../packages/fixtures/validation-python/project-context/", import.meta.url);
const matrix = JSON.parse(await readFile(new URL("resolver-matrix.json", fixtureRoot), "utf8"));
const files = await loadFixtureFiles(fixtureRoot);
const tempRoot = await mkdtemp(join(tmpdir(), "opcore-python-resolver-matrix-"));

try {
  await materialize(tempRoot, files);
  const rows = [];
  for (const specification of matrix.rows) {
    const context = await resolveSpecification(specification);
    const repeated = await resolveSpecification(specification);
    const actual = summarize(context);
    const fingerprintStable = context.projectKey === repeated.projectKey &&
      context.contextFingerprint === repeated.contextFingerprint;
    const invariants = contextInvariants(context, fingerprintStable);
    rows.push({
      id: specification.id,
      execution: specification.execution,
      target: specification.target,
      expected: specification.expected,
      actual,
      matchesExpected: matchesExpected(specification.expected, actual),
      invariants,
      provenance: {
        hostPlatform: process.platform,
        hostArchitecture: process.arch,
        interpreter: context.interpreter ?? null,
        tools: context.tools,
        projectKey: context.projectKey,
        contextFingerprint: context.contextFingerprint
      }
    });
  }
  const validation = await verifyNestedValidationExecution();
  const output = {
    schemaVersion: 1,
    contract: "opcore.python.project-context.v1",
    fixture: "packages/fixtures/validation-python/project-context/resolver-matrix.json",
    rows,
    validation,
    allMatched: rows.every((row) => row.matchesExpected && Object.values(row.invariants).every(Boolean)) &&
      validation.matchesExpected
  };
  process.stdout.write(`${JSON.stringify(output, null, process.argv.includes("--json") ? 0 : 2)}\n`);
  if (!output.allMatched) process.exitCode = 1;
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

function resolveSpecification(specification) {
  return specification.execution === "real"
    ? resolveReal(specification)
    : resolveSimulated(specification);
}

async function resolveReal(specification) {
  const missingTools = Object.fromEntries(
    ["mypy", "pyright", "ruff", "pytest"].map((tool) => [tool, [`/opcore-missing-tools/${tool}`]])
  );
  return resolvePythonProjectContext({
    repoRoot: tempRoot,
    target: specification.target,
    workspace: createNodePythonProjectWorkspace(tempRoot),
    interpreterArgv: [process.env.OPCORE_PYTHON ?? "python3"],
    toolArgv: missingTools
  });
}

async function resolveSimulated(specification) {
  const windows = specification.platform === "win32";
  const repoRoot = windows ? "C:\\fixture" : "/fixture";
  const projectRoot = specification.expected.projectRoot;
  const projectPath = projectRoot === "." ? "" : `${projectRoot}/`;
  const environmentRoot = windows
    ? `C:\\fixture\\${projectPath.replaceAll("/", "\\")}\.venv`.replace("\\\\.venv", "\\.venv")
    : `/fixture/${projectPath}.venv`.replace("//", "/");
  const interpreter = windows
    ? specification.windowsInterpreterLayout === "environment-root"
      ? `${environmentRoot}\\python.exe`
      : `${environmentRoot}\\Scripts\\python.exe`
    : `${environmentRoot}/bin/python`;
  const workspace = inMemoryWorkspace(files, (path) => {
    if (path === interpreter) return true;
    if (windows) return path.startsWith(`${environmentRoot}\\Scripts\\`) && path.endsWith(".exe");
    return path.startsWith(`${environmentRoot}/bin/`);
  });
  return resolvePythonProjectContext({
    repoRoot,
    target: specification.target,
    workspace,
    platform: windows ? "win32" : "linux",
    architecture: windows ? "x64" : "x86_64",
    processProbe: simulatedProbe({
      interpreter,
      windows,
      version: specification.interpreterVersion ?? "3.12.4"
    })
  });
}

function simulatedProbe({ interpreter, windows, version }) {
  return {
    run(command, args, options) {
      const script = args[args.indexOf("-c") + 1] ?? "";
      const buildProbe = script.includes("opcore.python.project-context.build.v1");
      const interpreterProbe = args.includes("-c") && !buildProbe;
      const stdout = buildProbe
        ? JSON.stringify({ protocol: "opcore.python.project-context.build.v1", available: true, version: "1.0.0" })
        : interpreterProbe
        ? JSON.stringify({
            protocol: "opcore.python.project-context.interpreter.v1",
            executable: interpreter,
            version,
            implementation: "CPython",
            platform: windows ? "win32" : "linux",
            architecture: windows ? "AMD64" : "x86_64",
            abi: `cpython-${version.split(".").slice(0, 2).join("")}`,
            soabi: windows ? "cp312-win_amd64" : "cpython-312-x86_64-linux-gnu"
          })
        : `${command} 1.0.0`;
      return {
        command,
        args,
        cwd: options.cwd,
        allowedExitCodes: [0],
        exitCode: 0,
        signal: null,
        stdout,
        stderr: "",
        termination: "exited",
        ok: true
      };
    }
  };
}

function summarize(context) {
  return {
    target: context.target,
    repositoryRoot: context.repositoryRoot,
    projectRoot: context.projectRoot,
    projectBoundary: context.projectBoundary,
    sourceRoots: context.sourceRoots,
    layout: context.layout,
    evidence: context.evidence,
    targetRuntime: context.targetRuntime,
    managers: context.managers,
    ...(context.buildSystem === undefined ? {} : { buildSystem: context.buildSystem }),
    interpreter: context.interpreter ?? null,
    tools: context.tools,
    projectKey: context.projectKey,
    contextFingerprint: context.contextFingerprint,
    outcome: context.outcome,
    reasons: context.reasons.map((reason) => ({
      code: reason.code,
      ...(reason.path === undefined ? {} : { path: reason.path }),
      ...(reason.tool === undefined ? {} : { tool: reason.tool })
    }))
  };
}

function contextInvariants(context, fingerprintStable) {
  return {
    projectKeySha256: /^sha256:[a-f0-9]{64}$/u.test(context.projectKey),
    contextFingerprintSha256: /^sha256:[a-f0-9]{64}$/u.test(context.contextFingerprint),
    fingerprintStable,
    interpreterArgvExact: context.interpreter === undefined || context.interpreter.argv[0] === context.interpreter.executable,
    interpreterCwdExact: context.interpreter === undefined || context.interpreter.cwd === projectCwd(context),
    toolArgvExact: context.tools.every((tool) => tool.argv[0] === tool.executable),
    toolCwdExact: context.tools.every((tool) => tool.cwd === projectCwd(context))
  };
}

function projectCwd(context) {
  if (context.projectRoot === ".") return context.repositoryRoot;
  return context.repositoryRoot.includes("\\")
    ? `${context.repositoryRoot}\\${context.projectRoot.replaceAll("/", "\\")}`
    : `${context.repositoryRoot}/${context.projectRoot}`;
}

function matchesExpected(expected, actual) {
  if (typeof expected === "string" && expected.startsWith("<") && expected.endsWith(">")) {
    if (expected === "<sha256>") return typeof actual === "string" && /^sha256:[a-f0-9]{64}$/u.test(actual);
    if (expected === "<absolute>") return typeof actual === "string" && (/^\//u.test(actual) || /^[A-Za-z]:[\\/]/u.test(actual));
    if (expected === "<version>") return typeof actual === "string" && /^\d+(?:\.\d+)+/u.test(actual);
    if (expected === "<host-platform>") return actual === process.platform;
    if (expected === "<host-architecture>") return actual === process.arch;
  }
  if (typeof expected === "string" && expected.includes("<repo>")) {
    return actual === expected.replaceAll("<repo>", tempRoot);
  }
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.length === actual.length &&
      expected.every((entry, index) => matchesExpected(entry, actual[index]));
  }
  if (expected && typeof expected === "object") {
    return actual && typeof actual === "object" && !Array.isArray(actual) &&
      Object.entries(expected).every(([key, value]) => matchesExpected(value, actual[key]));
  }
  return isDeepStrictEqual(expected, actual);
}

async function verifyNestedValidationExecution() {
  if (process.platform === "win32") {
    return { execution: "skipped", reason: "POSIX wrapper row is not applicable on Windows", matchesExpected: true };
  }
  const environmentRoot = join(tempRoot, "services/api/.venv/bin");
  const interpreter = join(environmentRoot, "python");
  const mypy = join(environmentRoot, "mypy");
  const logPath = join(tempRoot, "python-execution.log");
  const hostPython = process.env.OPCORE_PYTHON ?? "python3";
  const hostPythonExecutable = execFileSync(hostPython, ["-I", "-B", "-c", "import sys; print(sys.executable)"], {
    encoding: "utf8"
  }).trim();
  const hostPythonVersion = execFileSync(hostPython, ["-I", "-B", "-c", "import platform; print(platform.python_version())"], {
    encoding: "utf8"
  }).trim();
  const targetPythonVersion = hostPythonVersion.split(".").slice(0, 2).join(".");
  const pyprojectPath = join(tempRoot, "services/api/pyproject.toml");
  const pyproject = await readFile(pyprojectPath, "utf8");
  await writeFile(
    pyprojectPath,
    pyproject.replace(/requires-python\s*=\s*"[^"]+"/u, `requires-python = ">=${targetPythonVersion}"`),
    "utf8"
  );
  await writeFile(
    join(tempRoot, "services/api/pyrightconfig.json"),
    `${JSON.stringify({ pythonVersion: targetPythonVersion })}\n`,
    "utf8"
  );
  await mkdir(environmentRoot, { recursive: true });
  await symlink(hostPythonExecutable, interpreter);
  await writeFile(mypy, toolWrapper({ logPath }), "utf8");
  await chmod(mypy, 0o755);

  const target = "services/api/src/acme/api.py";
  const result = await createValidationRunner({
    workspace: createNodeValidationWorkspace({ repoRoot: tempRoot }),
    checks: createPythonValidationChecks({
      env: { ...process.env },
      nodeWorkspace: createNodePythonProjectWorkspace(tempRoot)
    })
  }).runValidation({
    requestId: "python-resolver-matrix-nested-execution",
    repo: { repoRoot: tempRoot },
    scope: { kind: "files", files: [target] },
    graph: { mode: "optional", provider: "opcore-graph" },
    checks: [PYTHON_SYNTAX_CHECK_ID, PYTHON_TYPES_CHECK_ID],
    overlays: []
  });
  const log = await readFile(logPath, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
  const lines = log.split(/\r?\n/u).filter((line) => line.trim().length > 0).map((line) => JSON.parse(line));
  const types = lines.find((line) => line.kind === "types");
  const expectedProjectCwd = join(tempRoot, "services/api");
  const context = result.pythonProjectContexts?.find((candidate) => candidate.target === target);
  const syntaxRun = result.manifest?.runs?.find((run) => run.checkId === PYTHON_SYNTAX_CHECK_ID);
  const typeRun = result.manifest?.runs?.find((run) => run.checkId === PYTHON_TYPES_CHECK_ID);
  const matches = result.status === "passed" &&
    syntaxRun?.status === "passed" && typeRun?.status === "passed" &&
    context?.interpreter?.executable === hostPythonExecutable && context?.interpreter?.cwd === expectedProjectCwd &&
    types?.executable === mypy && types?.cwd.endsWith("/repo/services/api") &&
    types?.argv.includes("src/acme/api.py");
  return {
    execution: "real",
    hostPlatform: process.platform,
    hostArchitecture: process.arch,
    hostInterpreter: hostPython,
    hostInterpreterVersion: hostPythonVersion,
    target,
    projectRoot: "services/api",
    selectedInterpreter: context?.interpreter ?? null,
    selectedTypeTool: mypy,
    validationStatus: result.status,
    checkRuns: result.manifest?.runs ?? [],
    pythonProjectContexts: result.pythonProjectContexts ?? [],
    processExecutions: lines,
    matchesExpected: matches
  };
}

function toolWrapper({ logPath }) {
  return `#!/bin/sh\nif [ "$1" = "--version" ]; then printf '%s\\n' 'mypy 1.0.0'; exit 0; fi\n'${process.execPath}' -e 'const fs=require("fs"); fs.appendFileSync(process.argv[1], JSON.stringify({kind:"types",executable:process.argv[2],cwd:process.cwd(),argv:process.argv.slice(3)})+"\\n")' '${logPath}' "$0" "$@"\nexit 0\n`;
}

function inMemoryWorkspace(contents, executableExists) {
  const paths = [...contents.keys()].sort();
  return {
    read: async (path) => contents.get(path),
    list: async () => paths,
    exists: async (path) => contents.has(path),
    realpath: async (path) => ({ path, symlink: false }),
    executableExists: async (path) => executableExists(path)
  };
}

async function loadFixtureFiles(root) {
  const contents = new Map();
  for (const entry of await readdir(root, { recursive: true })) {
    const path = String(entry).replaceAll("\\", "/");
    if (!path.endsWith(".fixture")) continue;
    contents.set(path.slice(0, -".fixture".length), await readFile(new URL(path, root), "utf8"));
  }
  return contents;
}

async function materialize(root, contents) {
  for (const [path, content] of contents) {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
  }
}
