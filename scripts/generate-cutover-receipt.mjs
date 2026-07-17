#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  releaseCutoverCurrentToolGuardrailIds,
  releaseCutoverPythonCommandIds,
  releaseCutoverRustCommandIds,
  releaseCutoverRequiredCommandIds,
  releaseReceiptPackageNames,
  validateManagedToolDescriptor,
  validateReleaseCutoverReceipt
} from "../packages/contracts/dist/index.js";
import { releasePackageDirForName } from "./release-package-dirs.mjs";
import { createStagedOpcorePackage } from "./stage-opcore-bundle.mjs";
import {
  collectInstalledPackageTextEntries,
  collectPackageTarballTextEntries,
  formatLaunchScrubFindings,
  scrubLaunchTextEntries
} from "./lib/launch-claim-scrub.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const descriptorPath = "packages/opcore/dist/descriptors/opcore.managed-tool.json";
const graphReleaseReceiptPath = "docs/release/graph-release-receipt.json";
const releaseReceiptPath = "docs/release/release-receipt.json";
const preWriteEvidencePath = "docs/integration/pre-write-validation.md";
const cutoverReceiptPath = "docs/release/cutover-receipt.json";
const cutoverSummaryPath = "docs/release/cutover-receipt.summary.md";
const artifactAttestationPath = "docs/release/artifact-attestation.md";
const releasePackDestination = ".opcore/release/packages";
const fixtureRoot = "packages/fixtures/source-extraction/wave1";
const rustFixtureRoot = "packages/fixtures/source-extraction/rust-only";
const currentToolEnvVars = [
  "LATTICE_CURRENT_TOOLS_DIR",
  "ACE_CURRENT_TOOLS_DIR",
  "LATTICE_CURRENT_ROX_PATH",
  "LATTICE_CURRENT_CRG_PATH",
  "LATTICE_CURRENT_CIX_PATH"
];

const args = process.argv.slice(2);
const writeDocs = args.includes("--write");
const jsonOutput = args.includes("--json") || !writeDocs;
const reuseReleasePackages = process.env.OPCORE_CUTOVER_REUSE_RELEASE_PACKAGES === "1";
const reuseCurrentToolGuardrails = process.env.OPCORE_CUTOVER_REUSE_CURRENT_TOOL_GUARDRAILS === "1";

try {
  const validateReceiptFile = valueAfter("--validate-receipt-file");
  const inspectInstalledBinDir = valueAfter("--inspect-installed-bin-dir");
  if (validateReceiptFile) {
    const receipt = validateReleaseCutoverReceipt(readJson(resolve(repoRoot, validateReceiptFile)));
    outputPayload(receipt, "cutover receipt validation passed");
  } else if (inspectInstalledBinDir) {
    inspectInstalledBins(resolve(repoRoot, inspectInstalledBinDir));
    outputPayload({ schemaVersion: 1, installedBins: "passed" }, "installed bin inspection passed");
  } else if (args.includes("--inspect-descriptor-only")) {
    const descriptorText = readFileSync(join(repoRoot, descriptorPath), "utf8");
    validateManagedToolDescriptor(JSON.parse(descriptorText));
    assertNoForbiddenMarkers([{ label: descriptorPath, text: descriptorText }]);
    outputPayload({ schemaVersion: 1, descriptor: "passed" }, "cutover descriptor inspection passed");
  } else {
    const receipt = generateReceipt();
    const validated = validateReleaseCutoverReceipt(receipt);
    assertNoForbiddenMarkers(receiptScanTexts(validated));
    if (writeDocs) writeCutoverDocs(validated);
    outputPayload(validated, `cutover receipt written to ${cutoverReceiptPath}`);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}

function generateReceipt() {
  const tempRoot = mkdtempSync(join(tmpdir(), "opcore-cutover-"));
  try {
    const packDir = join(tempRoot, "packages");
    mkdirSync(packDir, { recursive: true });
    const tarballs = reuseReleasePackages
      ? releaseReceiptPackageNames.map(readReleasePackageTarball)
      : releaseReceiptPackageNames.map((packageName) => packWorkspace(packageName, packDir));
    const tarballsByPackage = new Map(tarballs.map((entry) => [entry.packageName, entry]));
    const project = join(tempRoot, "project");
    mkdirSync(project);
    run("npm", ["init", "-y"], { cwd: project });
    run("npm", [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      ...releaseRuntimeInstallPackageNames().map((packageName) => tarballsByPackage.get(packageName).path)
    ], { cwd: project });
    installFixture(project);
    writeFileSync(join(project, "src/cutover.ts"), "export const cutoverValue: number = 1;\n");
    const opcoreSmokeRepo = prepareOpcoreSmokeRepo(tempRoot);
    const rustSmokeRepo = prepareRustSmokeRepo(tempRoot);
    const pythonSmokeRepo = preparePythonSmokeRepo(tempRoot);

    const opcoreBin = binPath(project, "opcore");
    if (!existsSync(opcoreBin)) throw new Error("Installed opcore bin is missing");
    inspectInstalledBins(project);
    const commandEnv = sanitizedEnv();
    const commandTexts = [];
    const commandReceipts = [];
    const rustCommandReceipts = [];
    const pythonCommandReceipts = [];
    const runOpcoreInRepo = (id, args, expectedStatus, assertion, cwd, receipts, evidence = undefined) => {
      const result = run(opcoreBin, args, { cwd, env: commandEnv, expectedStatus });
      commandTexts.push({ label: `${id}:stdout`, text: result.stdout }, { label: `${id}:stderr`, text: result.stderr });
      const parsed = parseRouterJson(id, result.stdout);
      if (parsed.exitCode !== expectedStatus || result.status !== expectedStatus) {
        throw new Error(`Cutover command ${id} exit mismatch: router=${parsed.exitCode} process=${result.status}`);
      }
      assertCommandPayload(id, parsed);
      const receiptCommand = sanitizeReceiptCommand(parsed.canonicalCommand);
      receipts.push({
        id,
        command: receiptCommand,
        canonicalCommand: receiptCommand,
        ...(evidence === undefined ? {} : { evidence }),
        owner: parsed.owner,
        status: parsed.status,
        exitCode: parsed.exitCode,
        binPath: "node_modules/.bin/opcore",
        stdoutSha256: sha256(result.stdout),
        stderrSha256: sha256(result.stderr),
        assertion
      });
      return parsed;
    };
    const runOpcore = (id, args, expectedStatus, assertion) =>
      runOpcoreInRepo(id, args, expectedStatus, assertion, opcoreSmokeRepo, commandReceipts);
    const runAdvancedOpcore = (id, args, expectedStatus, assertion) => {
      const result = run(opcoreBin, args, { cwd: project, env: commandEnv, expectedStatus });
      commandTexts.push({ label: `${id}:stdout`, text: result.stdout }, { label: `${id}:stderr`, text: result.stderr });
      const parsed = parseRouterJson(id, result.stdout);
      if (parsed.status === "not_implemented") throw new Error(`Cutover command ${id} returned not_implemented`);
      if (parsed.exitCode !== expectedStatus || result.status !== expectedStatus) {
        throw new Error(`Cutover command ${id} exit mismatch: router=${parsed.exitCode} process=${result.status}`);
      }
      assertCommandPayload(id, parsed);
      const receiptCommand = sanitizeReceiptCommand(parsed.canonicalCommand);
      commandReceipts.push({
        id,
        command: receiptCommand,
        canonicalCommand: receiptCommand,
        owner: parsed.owner,
        status: parsed.status,
        exitCode: parsed.exitCode,
        binPath: "node_modules/.bin/opcore",
        stdoutSha256: sha256(result.stdout),
        stderrSha256: sha256(result.stderr),
        assertion
      });
      return parsed;
    };
    const runPythonOpcore = (id, args, assertion) => {
      const parsed = runOpcoreInRepo(id, args, 0, assertion, pythonSmokeRepo, pythonCommandReceipts, pythonCommandEvidence(id));
      assertPythonCommandPayload(id, parsed);
      return parsed;
    };
    const runRustOpcore = (id, args, assertion) => {
      const result = run(opcoreBin, args, { cwd: rustSmokeRepo, env: commandEnv, expectedStatus: 0 });
      commandTexts.push({ label: `${id}:stdout`, text: result.stdout }, { label: `${id}:stderr`, text: result.stderr });
      const parsed = parseRouterJson(id, result.stdout);
      if (parsed.exitCode !== 0 || result.status !== 0) {
        throw new Error(`Cutover Rust command ${id} exit mismatch: router=${parsed.exitCode} process=${result.status}`);
      }
      assertCommandPayload(id, parsed);
      assertRustCommandPayload(id, parsed);
      const receiptCommand = sanitizeReceiptCommand(parsed.canonicalCommand);
      rustCommandReceipts.push({
        id,
        command: receiptCommand,
        canonicalCommand: receiptCommand,
        owner: parsed.owner,
        status: parsed.status,
        exitCode: parsed.exitCode,
        binPath: "node_modules/.bin/opcore",
        stdoutSha256: sha256(result.stdout),
        stderrSha256: sha256(result.stderr),
        assertion
      });
      return parsed;
    };

    runOpcore("opcore-scan", ["--json"], 0, "opcore scan wrote read-only report artifacts");
    runOpcore("opcore-status", ["status", "--json"], 0, "opcore status returned repoState");
    runOpcore(
      "opcore-check-changed",
      ["check", "--changed", "--checks", "typescript.syntax", "--json"],
      0,
      "opcore check changed defaulted base to HEAD"
    );
    runOpcore("opcore-measure", ["measure", "--json"], 0, "opcore measure returned read-only report deltas");
    runOpcore("opcore-try", ["try", "--json"], 0, "opcore try generated local sample repos without publishing");

    runAdvancedOpcore("status", ["status", "--json"], 0, "runtime status reports validation readiness");
    runAdvancedOpcore("doctor", ["doctor", "--json"], 0, "runtime doctor reports validation readiness");
    runAdvancedOpcore("graph-build", ["graph", "build", "--json"], 0, "graph build completed with native artifact");
    runAdvancedOpcore("graph-status", ["graph", "status", "--json"], 0, "graph status available after build");
    runAdvancedOpcore("graph-query", ["graph", "query", "--json"], 0, "graph query returned facts");
    runAdvancedOpcore("graph-impact", ["graph", "impact", "--files", "src/components/GreetingCard.tsx", "--json"], 0, "graph impact returned file impact");
    runAdvancedOpcore(
      "graph-review-context",
      ["graph", "review-context", "--files", "src/components/GreetingCard.tsx", "--json"],
      0,
      "graph review-context returned related facts"
    );
    runAdvancedOpcore(
      "graph-detect-changes",
      ["graph", "detect-changes", "--files", "src/components/GreetingCard.tsx", "--json"],
      0,
      "graph detect-changes returned typed change data"
    );
    runAdvancedOpcore("graph-search", ["graph", "search", "Greeting", "--limit", "5", "--json"], 0, "graph search returned ranked results");
    runAdvancedOpcore("graph-serve", ["graph", "serve", "--json"], 0, "graph serve status route is ready");
    runRustOpcore("graph-rust-build", ["graph", "build", "--json"], "Rust graph build completed with installed native artifact");
    runRustOpcore("graph-rust-status", ["graph", "status", "--json"], "Rust graph status available after build");
    runRustOpcore("graph-rust-query", ["graph", "query", "--json"], "Rust graph query returned Rust facts");
    runRustOpcore("graph-rust-impact", ["graph", "impact", "--files", "src/helpers.rs", "--json"], "Rust graph impact returned related Rust facts");
    runRustOpcore(
      "graph-rust-review-context",
      ["graph", "review-context", "--files", "src/helpers.rs", "--json"],
      "Rust graph review-context returned related Rust facts"
    );
    runRustOpcore(
      "graph-rust-detect-changes",
      ["graph", "detect-changes", "--files", "src/helpers.rs", "--json"],
      "Rust graph detect-changes returned typed Rust change data"
    );
    runRustOpcore("graph-rust-search", ["graph", "search", "Widget", "--limit", "5", "--json"], "Rust graph search returned ranked Rust symbols");
    runPythonOpcore("opcore-python-scan", ["--json"], "opcore scan returned Python repoState and validation evidence from installed artifacts");
    runPythonOpcore("opcore-python-status", ["status", "--json"], "opcore status returned Python repoState from installed artifacts");
    runPythonOpcore(
      "opcore-python-check-changed",
      ["check", "--changed", "--checks", "python.syntax,python.source-hygiene", "--json"],
      "opcore check changed validated Python syntax and hygiene from installed artifacts"
    );
    runPythonOpcore("opcore-python-measure", ["measure", "--json"], "opcore measure returned Python metric deltas from installed artifacts");
    runPythonOpcore("graph-python-build", ["graph", "build", "--json"], "Python graph build completed with installed native artifact");
    runPythonOpcore("graph-python-status", ["graph", "status", "--json"], "Python graph status available after installed-artifact build");
    runPythonOpcore("graph-python-query", ["graph", "query", "--json"], "Python graph query returned installed-artifact Python facts");
    runPythonOpcore(
      "graph-python-search",
      ["graph", "search", "Greeter", "--limit", "5", "--json"],
      "Python graph search returned ranked installed-artifact Python symbols"
    );
    runAdvancedOpcore("inspect-symbols", ["inspect", "symbols", "Greeting", "--limit", "5", "--json"], 0, "inspect symbols returned graph symbols");
    runAdvancedOpcore("inspect-definition", ["inspect", "definition", "GreetingCard", "--json"], 0, "inspect definition returned a symbol");
    runAdvancedOpcore(
      "inspect-references",
      ["inspect", "references", "function:src/components/GreetingCard.tsx#GreetingCard", "--limit", "5", "--json"],
      0,
      "inspect references returned callers"
    );
    runAdvancedOpcore(
      "inspect-signature",
      ["inspect", "signature", "function:src/components/GreetingCard.tsx#GreetingCard", "--json"],
      0,
      "inspect signature returned read-only language-service signatures"
    );
    runAdvancedOpcore(
      "inspect-implementations",
      ["inspect", "implementations", "class:src/models.ts#GreetingModel", "--json"],
      0,
      "inspect implementations returned implementation evidence"
    );
    runAdvancedOpcore("inspect-search", ["inspect", "search", "Greeting", "--limit", "5", "--json"], 0, "inspect search returned graph search results");
    runAdvancedOpcore(
      "edit-preview",
      [
        "edit",
        "exact",
        "--path",
        "src/cutover.ts",
        "--expected",
        "export const cutoverValue: number = 1;",
        "--replacement",
        "export const cutoverValue: number = 2;",
        "--json"
      ],
      0,
      "safe edit preview produced a plan without writing"
    );
    runAdvancedOpcore(
      "edit-apply",
      [
        "edit",
        "exact",
        "--path",
        "src/cutover.ts",
        "--expected",
        "export const cutoverValue: number = 1;",
        "--replacement",
        "export const cutoverValue: number = 2;",
        "--apply",
        "--json"
      ],
      0,
      "safe edit apply wrote after validation"
    );
    assertFileContains(project, "src/cutover.ts", "cutoverValue: number = 2");
    const beforeRefused = readFileSync(join(project, "src/cutover.ts"), "utf8");
    runAdvancedOpcore(
      "edit-refused",
      [
        "edit",
        "exact",
        "--path",
        "src/cutover.ts",
        "--expected",
        "export const cutoverValue: number = 2;",
        "--replacement",
        "export const cutoverValue: number = missingCutoverSymbol;",
        "--apply",
        "--json"
      ],
      1,
      "validation-refused edit left file unchanged"
    );
    if (readFileSync(join(project, "src/cutover.ts"), "utf8") !== beforeRefused) {
      throw new Error("Validation-refused edit mutated src/cutover.ts");
    }
    runAdvancedOpcore(
      "check-files",
      ["check", "files", "src/cutover.ts", "--checks", "typescript.syntax,typescript.types", "--json"],
      0,
      "check files passed syntax and type checks"
    );
    const requestPath = writeValidationRequest(project, "validate-request.json", {
      checks: ["typescript.syntax", "typescript.types"]
    });
    runAdvancedOpcore("validate-request", ["validate", "request", "--request-file", requestPath, "--json"], 0, "validate request passed");
    const preWritePass = writeValidationRequest(project, "pre-write-pass.json", {
      checks: ["typescript.syntax", "typescript.types"],
      overlays: [{ path: "src/cutover.ts", action: "write", content: "export const cutoverValue: number = 3;\n" }]
    });
    runAdvancedOpcore(
      "validate-pre-write-pass",
      ["validate", "pre-write", "--request-file", preWritePass, "--timeout-ms", "30000", "--json"],
      0,
      "pre-write pass receipt was ok"
    );
    const preWriteFail = writeValidationRequest(project, "pre-write-fail.json", {
      checks: ["typescript.types"],
      overlays: [{ path: "src/cutover.ts", action: "write", content: "export const cutoverValue: number = 'bad';\n" }]
    });
    runAdvancedOpcore(
      "validate-pre-write-fail",
      ["validate", "pre-write", "--request-file", preWriteFail, "--timeout-ms", "30000", "--json"],
      1,
      "pre-write failure receipt failed closed"
    );

    const negativeChecks = [
      ...runMissingGraphNegativeChecks(tempRoot, opcoreBin, commandEnv, commandTexts),
      ...runPythonToolDegradationNegativeChecks(tempRoot, opcoreBin, commandEnv, commandTexts)
    ];
    const descriptor = collectInstalledDescriptor(project, tarballs);
    const installedPackages = collectInstalledPackages(project, tarballs);
    const currentToolGuardrails = currentToolGuardrailsForCutover();
    const markerScanEntries = receiptScanTextsWithoutReceipt(project, descriptor, commandTexts, tarballs);
    assertNoForbiddenMarkers(markerScanEntries);
    const receipt = {
      schemaVersion: 1,
      issue: "#30",
      origin: "covibes-authored-cutover-proof",
      generatedAt: new Date().toISOString(),
      commitSha: git(["rev-parse", "HEAD"]).trim(),
      privateRepo: true,
      packageNames: releaseReceiptPackageNames,
      installedPackages,
      descriptor,
      environmentIsolation: {
        currentToolEnvCleared: true,
        clearedEnvVarCount: currentToolEnvVars.length,
        pathSanitized: true,
        aceRuntimeBinExcluded: true,
        siblingCovibesExcluded: true,
        opcoreBinOnly: true,
        oldBinsAbsent: { lattice: true, crg: true, cix: true, rox: true }
      },
      commandReceipts: sortCommandReceipts(commandReceipts),
      rustCommandReceipts: sortRustCommandReceipts(rustCommandReceipts),
      pythonCommandReceipts: sortPythonCommandReceipts(pythonCommandReceipts),
      negativeChecks,
      currentToolGuardrails,
      oldToolReplacementClaimed: false,
      forbiddenMarkerScan: {
        scannedTextCount: markerScanEntries.length + 1,
        findingCount: 0,
        markersBlocked: ["private-runtime", "current-tool-env", "private-home", "old-tool-bins", "old-product-name", "doubled-token"]
      },
      inputEvidence: collectInputEvidence()
    };
    assertSameSet(receipt.commandReceipts.map((entry) => entry.id), releaseCutoverRequiredCommandIds, "cutover command receipts");
    assertNoForbiddenMarkers(receiptScanTexts(receipt));
    return receipt;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function runMissingGraphNegativeChecks(tempRoot, opcoreBin, env, commandTexts) {
  const missingProject = join(tempRoot, "missing-graph");
  mkdirSync(join(missingProject, "src"), { recursive: true });
  writeFileSync(join(missingProject, "src/index.ts"), "export const value = 1;\n");
  const requestPath = join(missingProject, "required-graph.json");
  writeFileSync(
    requestPath,
    `${JSON.stringify({
      repo: { repoRoot: missingProject },
      scope: { kind: "files", files: ["src/index.ts"] },
      graph: { mode: "required", provider: "opcore-graph" },
      overlays: [],
      checks: ["typescript.import-graph"]
    })}\n`
  );
  const checks = [
    {
      id: "missing-required-graph-check",
      args: [
        "check",
        "files",
        "src/index.ts",
        "--repo",
        missingProject,
        "--graph-mode",
        "required",
        "--checks",
        "typescript.import-graph",
        "--json"
      ]
    },
    {
      id: "missing-required-graph-validate",
      args: ["validate", "request", "--request-file", requestPath, "--json"]
    }
  ];
  return checks.map((check) => {
    const result = run(opcoreBin, check.args, { cwd: missingProject, env, expectedStatus: 1 });
    commandTexts.push({ label: `${check.id}:stdout`, text: result.stdout }, { label: `${check.id}:stderr`, text: result.stderr });
    const parsed = parseRouterJson(check.id, result.stdout);
    if (parsed.validationResult?.status !== "provider_failure") {
      throw new Error(`${check.id} did not fail closed with provider_failure`);
    }
    return {
      id: check.id,
      command:
        check.id === "missing-required-graph-check"
          ? ["opcore", "check", "files", "src/index.ts", "--repo", "<missing-graph-repo>", "--graph-mode", "required", "--checks", "typescript.import-graph"]
          : ["opcore", "validate", "request", "--request-file", "<required-graph-request>"],
      status: "passed",
      exitCode: 0,
      assertion: "required graph provider failure stayed typed"
    };
  });
}

function runPythonToolDegradationNegativeChecks(tempRoot, opcoreBin, env, commandTexts) {
  const degradedProject = preparePythonSmokeRepo(tempRoot, "python-no-tools-smoke");
  const noToolBin = join(tempRoot, "no-python-tools-bin");
  mkdirSync(noToolBin, { recursive: true });
  const degradedEnv = {
    ...env,
    PATH: [dirname(process.execPath), noToolBin].join(":")
  };
  const result = run(opcoreBin, ["check", "files", "src/acme/app.py", "--checks", "python.types", "--json"], {
    cwd: degradedProject,
    env: degradedEnv,
    expectedStatus: 1
  });
  commandTexts.push({ label: "python-types-degraded-no-tools:stdout", text: result.stdout }, { label: "python-types-degraded-no-tools:stderr", text: result.stderr });
  const parsed = parseRouterJson("python-types-degraded-no-tools", result.stdout);
  if (parsed.owner !== "validation" || parsed.validationResult?.status !== "unsupported_request") {
    throw new Error("python-types-degraded-no-tools did not return unsupported_request validation evidence");
  }
  const diagnosticCodes = parsed.validationResult.diagnostics?.map((diagnostic) => diagnostic.code) ?? [];
  if (!diagnosticCodes.includes("PYTHON_TYPES_UNSUPPORTED_TARGET")) {
    throw new Error(
      `python-types-degraded-no-tools did not report PYTHON_TYPES_UNSUPPORTED_TARGET: ${diagnosticCodes.join(", ")}`
    );
  }
  const sourceHygieneResult = run(opcoreBin, ["check", "files", "src/acme/app.py", "--checks", "python.source-hygiene", "--json"], {
    cwd: degradedProject,
    env: degradedEnv,
    expectedStatus: 0
  });
  commandTexts.push({ label: "python-source-hygiene-no-ruff:stdout", text: sourceHygieneResult.stdout }, { label: "python-source-hygiene-no-ruff:stderr", text: sourceHygieneResult.stderr });
  const sourceHygieneParsed = parseRouterJson("python-source-hygiene-no-ruff", sourceHygieneResult.stdout);
  if (sourceHygieneParsed.owner !== "validation" || sourceHygieneParsed.validationResult?.status !== "passed") {
    throw new Error("python-source-hygiene-no-ruff did not pass with built-in source-hygiene evidence");
  }
  run(opcoreBin, ["graph", "build", "--json"], { cwd: degradedProject, env: degradedEnv, expectedStatus: 0 });
  const relevantTestsResult = run(opcoreBin, ["check", "files", "src/acme/app.py", "--checks", "python.relevant-tests", "--json"], {
    cwd: degradedProject,
    env: degradedEnv,
    expectedStatus: 0
  });
  commandTexts.push({ label: "python-relevant-tests-no-pytest:stdout", text: relevantTestsResult.stdout }, { label: "python-relevant-tests-no-pytest:stderr", text: relevantTestsResult.stderr });
  const relevantTestsParsed = parseRouterJson("python-relevant-tests-no-pytest", relevantTestsResult.stdout);
  if (relevantTestsParsed.owner !== "validation" || relevantTestsParsed.validationResult?.status !== "passed") {
    throw new Error("python-relevant-tests-no-pytest did not pass with graph-backed relevant-test evidence");
  }
  const relevantTestCodes = relevantTestsParsed.validationResult.diagnostics?.map((diagnostic) => diagnostic.code) ?? [];
  if (!relevantTestCodes.some((code) => code === "PY_RELEVANT_TESTS_FOUND" || code === "PY_RELEVANT_TESTS_ABSENT")) {
    throw new Error("python-relevant-tests-no-pytest did not report Python relevant-test graph evidence");
  }
  const statusResult = run(opcoreBin, ["status", "--json"], {
    cwd: degradedProject,
    env: degradedEnv,
    expectedStatus: 0
  });
  commandTexts.push({ label: "python-toolchain-degraded-no-tools:stdout", text: statusResult.stdout }, { label: "python-toolchain-degraded-no-tools:stderr", text: statusResult.stderr });
  const statusParsed = parseRouterJson("python-toolchain-degraded-no-tools", statusResult.stdout);
  if (statusParsed.owner !== "runtime" || statusParsed.validationResult !== undefined || statusParsed.repoState === undefined) {
    throw new Error("python-toolchain-degraded-no-tools did not return read-only repoState status evidence");
  }
  assertPythonRepoState("python-toolchain-degraded-no-tools", statusParsed.repoState, ["mypy", "pyright", "ruff", "pytest"]);
  return [
    {
      id: "python-types-degraded-no-tools",
      command: ["opcore", "check", "files", "src/acme/app.py", "--checks", "python.types"],
      status: "passed",
      exitCode: 0,
      assertion: "missing Python type tools stayed degraded instead of passing silently"
    },
    {
      id: "python-source-hygiene-no-ruff",
      command: ["opcore", "check", "files", "src/acme/app.py", "--checks", "python.source-hygiene"],
      status: "passed",
      exitCode: 0,
      assertion: "source-hygiene check ran built-in policy while status reported ruff absent"
    },
    {
      id: "python-relevant-tests-no-pytest",
      command: ["opcore", "check", "files", "src/acme/app.py", "--checks", "python.relevant-tests"],
      status: "passed",
      exitCode: 0,
      assertion: "relevant-tests check used graph evidence while status reported pytest absent"
    },
    {
      id: "python-toolchain-degraded-no-tools",
      command: ["opcore", "status"],
      status: "passed",
      exitCode: 0,
      assertion: "read-only status reported absent mypy, pyright, ruff, and pytest as degraded"
    }
  ];
}

function currentToolGuardrailsForCutover() {
  if (reuseCurrentToolGuardrails) return recordedCurrentToolGuardrailsForCutover();
  return runCurrentToolGuardrailsForCutover();
}

function recordedCurrentToolGuardrailsForCutover() {
  const receipt = readJson(join(repoRoot, cutoverReceiptPath));
  const guardrails = receipt.currentToolGuardrails;
  if (!Array.isArray(guardrails)) {
    throw new Error(`${cutoverReceiptPath} must contain recorded current-tool guardrails`);
  }
  assertSameSet(
    guardrails.map((entry) => entry?.id),
    releaseCutoverCurrentToolGuardrailIds,
    "recorded current-tool guardrails"
  );
  return guardrails.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error(`${cutoverReceiptPath} current-tool guardrail entry is required`);
    if (entry.retained !== true || entry.oldToolReplacementClaimed !== false) {
      throw new Error(`${cutoverReceiptPath} current-tool guardrails must stay retained without old-tool replacement claims`);
    }
    return { ...entry };
  });
}

function runCurrentToolGuardrailsForCutover() {
  return [
    runCurrentToolGuardrail(
      "current-tools-validate-changed",
      ["run", "current-tools:validate-changed"],
      "retained external changed-file guardrail passed during installed-artifact cutover proof"
    ),
    runCurrentToolGuardrail(
      "current-tools-validate-rust-graph",
      ["run", "current-tools:validate-rust-graph"],
      "retained external Rust graph guardrail passed during installed-artifact cutover proof"
    )
  ];
}

function runCurrentToolGuardrail(id, npmArgs, assertion) {
  const result = run("npm", npmArgs, { cwd: repoRoot, env: process.env, expectedStatus: 0 });
  return {
    id,
    command: ["npm", ...npmArgs],
    status: "passed",
    exitCode: 0,
    stdoutSha256: sha256(result.stdout),
    stderrSha256: sha256(result.stderr),
    retained: true,
    assertion,
    oldToolReplacementClaimed: false
  };
}

function packWorkspace(packageName, destination) {
  const staged = packageName === "opcore" ? createStagedOpcorePackage(destination) : undefined;
  const packageDir = join(repoRoot, releasePackageDirForName(packageName));
  try {
    const result = run("npm", ["pack", "--json", "--pack-destination", destination], {
      cwd: staged?.packageDir ?? packageDir
    });
    const parsed = JSON.parse(result.stdout)[0];
    const path = join(destination, parsed.filename);
    return {
      packageName,
      packageDir,
      filename: parsed.filename,
      path,
      sha256: sha256File(path)
    };
  } finally {
    staged?.cleanup();
  }
}

function readReleasePackageTarball(packageName) {
  const packageDir = join(repoRoot, releasePackageDirForName(packageName));
  const manifest = readJson(join(packageDir, "package.json"));
  const filename = releasePackageTarballFilename(packageName, manifest.version);
  const path = join(repoRoot, releasePackDestination, filename);
  if (!existsSync(path)) {
    throw new Error(`Missing reusable release package tarball: ${releasePackDestination}/${filename}`);
  }
  return {
    packageName,
    packageDir,
    filename,
    path,
    sha256: sha256File(path)
  };
}

function releasePackageTarballFilename(packageName, version) {
  return `${packageName.replace(/^@/, "").replace(/\//g, "-")}-${version}.tgz`;
}

function releaseRuntimeInstallPackageNames() {
  return releaseReceiptPackageNames;
}

function installFixture(project) {
  cpSync(join(repoRoot, fixtureRoot, "src"), join(project, "src"), { recursive: true });
  cpSync(join(repoRoot, fixtureRoot, "tsconfig.json"), join(project, "tsconfig.json"));
}

function prepareOpcoreSmokeRepo(tempRoot) {
  const smokeRepo = join(tempRoot, "opcore-smoke");
  mkdirSync(join(smokeRepo, "src"), { recursive: true });
  writeFileSync(join(smokeRepo, "tsconfig.json"), `${JSON.stringify({ compilerOptions: { strict: true }, include: ["src/**/*.ts"] })}\n`);
  run("git", ["init"], { cwd: smokeRepo });
  const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Opcore Cutover",
    GIT_AUTHOR_EMAIL: "opcore@example.invalid",
    GIT_COMMITTER_NAME: "Opcore Cutover",
    GIT_COMMITTER_EMAIL: "opcore@example.invalid"
  };
  const commit = run("git", ["commit-tree", emptyTree, "-m", "fixture"], { cwd: smokeRepo, env }).stdout.trim();
  run("git", ["branch", "-f", "main", commit], { cwd: smokeRepo });
  run("git", ["checkout", "-q", "main"], { cwd: smokeRepo });
  writeFileSync(join(smokeRepo, "src/index.ts"), "export const opcoreValue: number = 1;\n");
  return smokeRepo;
}

function prepareRustSmokeRepo(tempRoot) {
  const smokeRepo = join(tempRoot, "rust-smoke");
  cpSync(join(repoRoot, rustFixtureRoot), smokeRepo, { recursive: true });
  return smokeRepo;
}

function preparePythonSmokeRepo(tempRoot, name = "python-smoke") {
  const smokeRepo = join(tempRoot, name);
  mkdirSync(join(smokeRepo, "src/acme"), { recursive: true });
  mkdirSync(join(smokeRepo, "tests"), { recursive: true });
  writeFileSync(
    join(smokeRepo, "pyproject.toml"),
    [
      "[project]",
      'name = "opcore-cutover-python-smoke"',
      'version = "0.0.0"',
      "",
      "[tool.pytest.ini_options]",
      'pythonpath = ["src"]',
      ""
    ].join("\n")
  );
  run("git", ["init"], { cwd: smokeRepo });
  const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Opcore Cutover",
    GIT_AUTHOR_EMAIL: "opcore@example.invalid",
    GIT_COMMITTER_NAME: "Opcore Cutover",
    GIT_COMMITTER_EMAIL: "opcore@example.invalid"
  };
  const commit = run("git", ["commit-tree", emptyTree, "-m", "fixture"], { cwd: smokeRepo, env }).stdout.trim();
  run("git", ["branch", "-f", "main", commit], { cwd: smokeRepo });
  run("git", ["checkout", "-q", "main"], { cwd: smokeRepo });
  writeFileSync(join(smokeRepo, "src/acme/__init__.py"), "from .app import Greeter\n\n__all__ = [\"Greeter\"]\n");
  writeFileSync(
    join(smokeRepo, "src/acme/helpers.py"),
    [
      "def build_name(value: str) -> str:",
      "    return f\"hello {value}\"",
      ""
    ].join("\n")
  );
  writeFileSync(
    join(smokeRepo, "src/acme/app.py"),
    [
      "from .helpers import build_name",
      "",
      "",
      "class Greeter:",
      "    def greet(self, value: str) -> str:",
      "        return build_name(value)",
      "",
      "",
      "async def load_name(value: str) -> str:",
      "    return build_name(value)",
      ""
    ].join("\n")
  );
  writeFileSync(
    join(smokeRepo, "tests/test_app.py"),
    [
      "from acme import Greeter",
      "",
      "",
      "def test_greeter() -> None:",
      "    assert Greeter().greet(\"cutover\") == \"hello cutover\"",
      ""
    ].join("\n")
  );
  return smokeRepo;
}

function inspectInstalledBins(project) {
  if (!existsSync(binPath(project, "opcore"))) throw new Error("installed project is missing opcore bin");
  if (!existsSync(binPath(project, "opcore-asp-provider"))) throw new Error("installed project is missing opcore-asp-provider bin");
  for (const oldBin of ["lattice", "crg", "cix", "rox"]) {
    if (existsSync(binPath(project, oldBin))) throw new Error(`installed project exposes old public bin ${oldBin}`);
  }
}

function collectInstalledPackages(project, tarballs) {
  return releaseReceiptPackageNames.flatMap((packageName) => {
    const packageRoot = join(project, "node_modules", ...packageName.split("/"));
    const manifestPath = join(packageRoot, "package.json");
    if (!existsSync(manifestPath)) return [];
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const tarball = tarballs.find((entry) => entry.packageName === packageName);
    if (!tarball) throw new Error(`Missing tarball evidence for ${packageName}`);
    return [{
      packageName,
      version: manifest.version,
      tarball: {
        filename: tarball.filename,
        sha256: tarball.sha256
      },
      installedManifest: {
        path: `node_modules/${packageName}/package.json`,
        sha256: sha256File(manifestPath),
        bins: manifest.bin ?? {}
      },
      installedFiles: collectInstalledFiles(packageRoot, packageName)
    }];
  });
}

function collectInstalledFiles(packageRoot, packageName) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
      } else if (entry.isFile()) {
        const packagePath = relative(packageRoot, absolutePath).split("\\").join("/");
        files.push({
          path: `node_modules/${packageName}/${packagePath}`,
          sha256: sha256File(absolutePath)
        });
      }
    }
  };
  visit(packageRoot);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function collectInstalledDescriptor(project, tarballs) {
  const tarballsByPackage = new Map(tarballs.map((entry) => [entry.packageName, entry]));
  const descriptorAbsolutePath = join(
    project,
    "node_modules",
    "opcore",
    "dist",
    "descriptors",
    "opcore.managed-tool.json"
  );
  const descriptor = validateManagedToolDescriptor(JSON.parse(readFileSync(descriptorAbsolutePath, "utf8")));
  return {
    path: "node_modules/opcore/dist/descriptors/opcore.managed-tool.json",
    packageName: "opcore",
    checksumSha256: sha256File(descriptorAbsolutePath),
    descriptor,
    resolvedArtifacts: descriptor.artifacts.map((artifact) => {
      packageFilePath(project, tarballsByPackage, artifact.packageName, artifact.path, `Descriptor artifact ${artifact.id}`);
      return {
        id: artifact.id,
        packageName: artifact.packageName,
        path: artifact.path,
        type: artifact.type,
        required: artifact.required,
        packageFile: true,
        ...(artifact.checksumRef ? { checksumRef: artifact.checksumRef } : {})
      };
    }),
    resolvedChecksums: descriptor.checksums.map((checksum) => {
      const artifact = descriptor.artifacts.find((entry) => entry.id === checksum.artifactRef);
      if (!artifact) throw new Error(`Descriptor checksum ${checksum.id} references missing artifact ${checksum.artifactRef}`);
      packageFilePath(project, tarballsByPackage, checksum.packageName, checksum.path, `Descriptor checksum ${checksum.id}`);
      const artifactPath = packageFilePath(project, tarballsByPackage, checksum.packageName, artifact.path, `Descriptor checksum artifact ${checksum.artifactRef}`);
      return {
        id: checksum.id,
        packageName: checksum.packageName,
        path: checksum.path,
        algorithm: "sha256",
        artifactRef: checksum.artifactRef,
        required: checksum.required,
        packageFile: true,
        value: checksum.value ?? sha256File(artifactPath)
      };
    })
  };
}

function packageFilePath(project, tarballsByPackage, packageName, packagePath, label) {
  const installedPath = join(project, "node_modules", ...packageName.split("/"), packagePath);
  if (existsSync(installedPath)) return installedPath;
  const tarball = tarballsByPackage.get(packageName);
  if (!tarball) throw new Error(`${label} missing tarball evidence for ${packageName}`);
  const packedPath = join(tarball.packageDir, packagePath);
  if (!existsSync(packedPath)) throw new Error(`${label} missing in packed package source: ${packageName}:${packagePath}`);
  return packedPath;
}

function assertCommandPayload(id, parsed) {
  if (id === "opcore-scan") {
    if (parsed.owner !== "runtime" || parsed.repoState === undefined || parsed.validationResult === undefined) {
      throw new Error("opcore-scan must return repoState and validationResult");
    }
  }
  if (id === "opcore-status") {
    if (parsed.owner !== "runtime" || parsed.repoState === undefined || parsed.validationResult !== undefined) {
      throw new Error("opcore-status must return repoState only");
    }
  }
  if (id === "opcore-check-changed") {
    if (parsed.owner !== "validation" || parsed.validationResult?.status !== "passed") {
      throw new Error("opcore-check-changed must pass validation");
    }
  }
  if (id === "opcore-measure") {
    if (parsed.owner !== "runtime" || parsed.opcoreMeasure?.kind !== "opcore_measure_delta" || parsed.validationResult !== undefined || parsed.repoState !== undefined) {
      throw new Error("opcore-measure must return read-only opcoreMeasure deltas only");
    }
  }
  if (id === "opcore-try") {
    if (parsed.owner !== "runtime" || parsed.opcoreTry?.published !== false || parsed.validationResult !== undefined || parsed.repoState !== undefined) {
      throw new Error("opcore-try must return a local unpublished try payload only");
    }
    const scenarioIds = parsed.opcoreTry.scenarios.map((scenario) => scenario.id).sort();
    assertSameSet(
      scenarioIds,
      ["mixed-repo", "python-package", "rust-crate", "typescript-app", "unsupported-files"],
      "opcore try scenario ids"
    );
    const signalText = JSON.stringify(parsed.opcoreTry.scenarios.flatMap((scenario) => scenario.signals.map((signal) => signal.id)));
    for (const required of ["typescript.type_errors", "rust.source_hygiene", "coverage.unsupported_stacks"]) {
      if (!signalText.includes(required)) throw new Error(`opcore-try missing signal ${required}`);
    }
    assertNoForbiddenMarkers([{ label: "opcore-try", text: collectStringValues(parsed.opcoreTry).join("\n") }]);
    rmSync(parsed.opcoreTry.sampleRoot, { recursive: true, force: true });
  }
  if (id.startsWith("graph-") && parsed.owner !== "graph") throw new Error(`${id} owner must be graph`);
  if (id.startsWith("inspect-") && parsed.owner !== "inspect") throw new Error(`${id} owner must be inspect`);
  if (id.startsWith("edit-") && parsed.owner !== "edit") throw new Error(`${id} owner must be edit`);
  if ((id.startsWith("check-") || id.startsWith("validate-")) && parsed.owner !== "validation") {
    throw new Error(`${id} owner must be validation`);
  }
  if (id === "graph-query" && parsed.graphQuery?.status?.state !== "available") throw new Error("graph-query did not return graph data");
  if (id === "graph-search" && parsed.graphSearch?.status?.state !== "available") throw new Error("graph-search did not return search data");
  if (id.startsWith("inspect-") && parsed.providerStatus?.state !== "available") throw new Error(`${id} did not use graph data`);
  if (id === "inspect-signature" && (!Array.isArray(parsed.inspectResult?.signatures) || parsed.inspectResult.signatures.length === 0)) {
    throw new Error("inspect-signature must return read-only signature entries");
  }
  if (id === "inspect-references" && (!Array.isArray(parsed.inspectResult?.references) || parsed.inspectResult.references.length === 0)) {
    throw new Error("inspect-references must return read-only reference entries");
  }
  if (id === "inspect-implementations" && parsed.inspectResult?.implementations?.length < 1) {
    throw new Error("inspect-implementations must return implementation evidence");
  }
  if (id === "edit-refused" && parsed.status !== "error") throw new Error("edit-refused must fail closed");
  if (id === "validate-pre-write-fail" && parsed.receipt?.ok !== false) throw new Error("pre-write failure receipt must not be ok");
}

function assertRustCommandPayload(id, parsed) {
  const text = JSON.stringify(parsed);
  if (id === "graph-rust-query" || id === "graph-rust-search") {
    for (const expected of ["src/lib.rs", "Widget"]) {
      if (!text.includes(expected)) throw new Error(`${id} did not return Rust graph evidence for ${expected}`);
    }
  }
  if (id === "graph-rust-impact" || id === "graph-rust-review-context" || id === "graph-rust-detect-changes") {
    if (!text.includes("src/helpers.rs")) throw new Error(`${id} did not return Rust graph evidence for src/helpers.rs`);
  }
}

function assertPythonCommandPayload(id, parsed) {
  const text = JSON.stringify(parsed);
  if (id === "opcore-python-scan") {
    if (parsed.owner !== "runtime" || parsed.repoState === undefined || parsed.validationResult === undefined) {
      throw new Error("opcore-python-scan must return repoState and validationResult");
    }
    assertPythonRepoState(id, parsed.repoState);
    if (!text.includes("PYTHON_TYPES_UNSUPPORTED_TARGET")) {
      throw new Error("opcore-python-scan must record missing Python type-authority evidence");
    }
  }
  if (id === "opcore-python-status") {
    if (parsed.owner !== "runtime" || parsed.repoState === undefined || parsed.validationResult !== undefined) {
      throw new Error("opcore-python-status must return repoState only");
    }
    assertPythonRepoState(id, parsed.repoState);
  }
  if (id === "opcore-python-check-changed") {
    if (parsed.owner !== "validation" || parsed.validationResult?.status !== "passed") {
      throw new Error("opcore-python-check-changed must pass Python syntax/hygiene validation");
    }
  }
  if (id === "opcore-python-measure") {
    if (parsed.owner !== "runtime" || parsed.opcoreMeasure?.kind !== "opcore_measure_delta" || parsed.validationResult !== undefined || parsed.repoState !== undefined) {
      throw new Error("opcore-python-measure must return read-only opcoreMeasure deltas only");
    }
    const measureText = JSON.stringify(parsed.opcoreMeasure);
    if (!measureText.includes("Python") && !measureText.includes("python.")) {
      throw new Error("opcore-python-measure did not include Python metric or coverage evidence");
    }
  }
  if (id === "graph-python-query" || id === "graph-python-search") {
    for (const expected of ["src/acme/app.py", "Greeter"]) {
      if (!text.includes(expected)) throw new Error(`${id} did not return Python graph evidence for ${expected}`);
    }
  }
  if (id === "graph-python-query" && !text.includes("build_name")) {
    throw new Error("graph-python-query did not return Python call/import facts for build_name");
  }
  if (id === "graph-python-status" && parsed.providerStatus?.state !== "available") {
    throw new Error("graph-python-status did not report available provider status");
  }
}

function assertPythonRepoState(id, repoState, requiredTools = ["mypy", "pyright"]) {
  const python = repoState?.coverage?.languages?.find((entry) => entry.language === "Python");
  if (!python || python.files < 1 || python.graphSupported !== true || python.validationSupported !== true) {
    throw new Error(`${id} did not report Python graph and validation coverage`);
  }
  const degradedTools = repoState.validation?.degradedToolchains?.filter((tool) => tool.adapter === "python").map((tool) => tool.tool).sort() ?? [];
  for (const required of requiredTools) {
    if (!degradedTools.includes(required)) throw new Error(`${id} did not report degraded Python tool ${required}`);
  }
}

function pythonCommandEvidence(id) {
  const evidence = {
    "opcore-python-scan": ["python-coverage", "python-validation", "python-types-degraded"],
    "opcore-python-status": ["python-coverage", "python-validation"],
    "opcore-python-check-changed": ["python-syntax", "python-source-hygiene"],
    "opcore-python-measure": ["python-measure-delta"],
    "graph-python-build": ["python-graph-provider"],
    "graph-python-status": ["python-graph-provider"],
    "graph-python-query": ["src/acme/app.py", "Greeter", "build_name"],
    "graph-python-search": ["src/acme/app.py", "Greeter"]
  }[id];
  if (!evidence) throw new Error(`Unknown Python command receipt id: ${id}`);
  return evidence;
}

function sanitizeReceiptCommand(command) {
  return command.map((part, index) => (command[index - 1] === "--request-file" ? basename(part) : part));
}

function writeValidationRequest(project, filename, overrides = {}) {
  const path = join(project, filename);
  writeFileSync(
    path,
    `${JSON.stringify({
      repo: { repoRoot: project },
      scope: { kind: "files", files: ["src/cutover.ts"] },
      graph: { mode: "optional", provider: "opcore-graph" },
      overlays: [],
      ...overrides
    })}\n`
  );
  return path;
}

function sanitizedEnv() {
  const env = { ...process.env };
  for (const key of currentToolEnvVars) delete env[key];
  env.PATH = [dirname(process.execPath), "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
  env.npm_lifecycle_event = undefined;
  if (env.PATH.includes(".ace/runtime/bin") || env.PATH.includes("/covibes/")) {
    throw new Error("sanitized PATH still includes current-tool or sibling Covibes paths");
  }
  return env;
}

function receiptScanTextsWithoutReceipt(project, descriptor, commandTexts, tarballs) {
  const tarballsByPackage = new Map(tarballs.map((entry) => [entry.packageName, entry]));
  const packageManifestTexts = releaseReceiptPackageNames.map((packageName) => {
    const path = join(project, "node_modules", ...packageName.split("/"), "package.json");
    const manifestPath = existsSync(path) ? path : packageFilePath(project, tarballsByPackage, packageName, "package.json", `Manifest ${packageName}`);
    return { label: `manifest:${packageName}`, text: readFileSync(manifestPath, "utf8") };
  });
  const descriptorText = JSON.stringify(descriptor.descriptor);
  const installedPackageTexts = collectInstalledPackageTextEntries(project, releaseReceiptPackageNames);
  const tarballPackageTexts = tarballs.flatMap((tarball) =>
    collectPackageTarballTextEntries(tarball.path, `npm-pack:${tarball.packageName}`)
  );
  return [...packageManifestTexts, ...installedPackageTexts, ...tarballPackageTexts, { label: "descriptor", text: descriptorText }, ...commandTexts];
}

function receiptScanTexts(receipt) {
  return [{ label: "receipt", text: collectStringValues(receipt).join("\n") }];
}

function assertNoForbiddenMarkers(entries) {
  const forbidden = [
    { label: "private runtime", pattern: /(^|[\\/"'\s])\.ace(?:[\\/"'\s]|$)/i },
    { label: "current-tool env", pattern: /LATTICE_CURRENT_TOOLS_DIR|ACE_CURRENT_TOOLS_DIR|LATTICE_CURRENT_(?:ROX|CRG|CIX)_PATH/i },
    { label: "private home", pattern: /\/Users\/tom\b/ },
    { label: "old tool bins", pattern: /(^|[\\/"'\s])(?:crg|cix|rox)(?:$|[\\/"'\s])/i }
  ];
  const findings = [];
  for (const entry of entries) {
    if (!isPackageTextScanEntry(entry.label)) {
      for (const marker of forbidden) {
        const lines = entry.text.split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index];
          if (!marker.pattern.test(line)) continue;
          if (isAllowlistedCutoverMarkerLine(line, marker.label)) continue;
          findings.push(`${entry.label}:${index + 1}: ${marker.label}: ${line.trim()}`);
        }
      }
    }
  }
  findings.push(...formatLaunchScrubFindings(scrubLaunchTextEntries(entries)));
  if (findings.length > 0) throw new Error(`Cutover forbidden marker scan failed:\n${findings.join("\n")}`);
}

function isPackageTextScanEntry(label) {
  return label.startsWith("installed-package:") || label.startsWith("npm-pack:");
}

function isAllowlistedCutoverMarkerLine(line, label) {
  if (label !== "old tool bins") return false;
  return /oldBins(?:Absent)?|old public bin|old tool bins|forbiddenPublicBins|forbiddenBin|oldBin|Release receipt package exposes old public bin|\["lattice",\s*"crg",\s*"cix",\s*"rox"\]|\["crg",\s*"cix",\s*"rox"\]/i.test(line);
}

function collectStringValues(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((entry) => collectStringValues(entry));
  if (value && typeof value === "object") return Object.values(value).flatMap((entry) => collectStringValues(entry));
  return [];
}

function collectInputEvidence() {
  return [
    { issue: "#17", path: graphReleaseReceiptPath, checksumSha256: sha256File(join(repoRoot, graphReleaseReceiptPath)) },
    { issue: "#29", path: releaseReceiptPath, checksumSha256: releaseReceiptChecksum() },
    { issue: "#58", path: preWriteEvidencePath, checksumSha256: sha256File(join(repoRoot, preWriteEvidencePath)) }
  ];
}

function releaseReceiptChecksum() {
  const releaseReceiptAbsolutePath = join(repoRoot, releaseReceiptPath);
  if (existsSync(releaseReceiptAbsolutePath)) return sha256File(releaseReceiptAbsolutePath);
  const generatedReceipt = runJson(process.execPath, ["scripts/generate-release-receipt.mjs", "--json"]);
  return sha256(`${JSON.stringify(generatedReceipt, null, 2)}\n`);
}

function writeCutoverDocs(receipt) {
  mkdirSync(join(repoRoot, "docs/release"), { recursive: true });
  const receiptJson = `${JSON.stringify(receipt, null, 2)}\n`;
  writeFileSync(join(repoRoot, cutoverReceiptPath), receiptJson);
  writeFileSync(join(repoRoot, cutoverSummaryPath), cutoverSummaryMarkdown(receipt, sha256(receiptJson)));
  appendCutoverAttestation(receipt, sha256(receiptJson));
}

function cutoverSummaryMarkdown(receipt, receiptSha256) {
  const commandRows = [...receipt.commandReceipts, ...receipt.rustCommandReceipts, ...receipt.pythonCommandReceipts]
    .map((entry) => `| ${entry.id} | ${entry.owner} | ${entry.status} | ${entry.exitCode} | ${entry.assertion} |`)
    .join("\n");
  return `# Cutover Receipt Summary

Maintainer cutover gate proves installed Opcore artifacts handle canonical release commands without dev-tool fallback.

Machine receipt: ${cutoverReceiptPath}
Machine receipt SHA-256: ${receiptSha256}

Installed packages: ${receipt.installedPackages.length}
Command receipts: ${receipt.commandReceipts.length}
Rust command receipts: ${receipt.rustCommandReceipts.length}
Python command receipts: ${receipt.pythonCommandReceipts.length}
Current-tool guardrails retained: ${receipt.currentToolGuardrails.length}
Old-tool replacement claimed: ${receipt.oldToolReplacementClaimed}
Forbidden marker findings: ${receipt.forbiddenMarkerScan.findingCount}
Input evidence: ${receipt.inputEvidence.map((entry) => entry.issue).join(", ")}

| Command | Owner | Status | Exit | Assertion |
|---------|-------|--------|------|-----------|
${commandRows}
`;
}

function appendCutoverAttestation(receipt, receiptSha256) {
  const existing = existsSync(join(repoRoot, artifactAttestationPath))
    ? readFileSync(join(repoRoot, artifactAttestationPath), "utf8")
    : "# Artifact Attestation\n";
  const block = `\n## Cutover Gate\n\nIssue #30 receipt: ${cutoverReceiptPath}\nCutover receipt SHA-256: ${receiptSha256}\nInstalled command receipts: ${receipt.commandReceipts.length}\nRust command receipts: ${receipt.rustCommandReceipts.length}\nPython command receipts: ${receipt.pythonCommandReceipts.length}\nCurrent-tool guardrails retained: ${receipt.currentToolGuardrails.length}\nOld-tool replacement claimed: ${receipt.oldToolReplacementClaimed}\n`;
  const withoutOld = existing.replace(/\n## Cutover Gate\n[\s\S]*$/, "");
  writeFileSync(join(repoRoot, artifactAttestationPath), `${withoutOld.trimEnd()}\n${block}`);
}

function sortCommandReceipts(receipts) {
  return releaseCutoverRequiredCommandIds.map((id) => {
    const receipt = receipts.find((entry) => entry.id === id);
    if (!receipt) throw new Error(`Missing cutover command receipt: ${id}`);
    return receipt;
  });
}

function sortRustCommandReceipts(receipts) {
  return releaseCutoverRustCommandIds.map((id) => {
    const receipt = receipts.find((entry) => entry.id === id);
    if (!receipt) throw new Error(`Missing cutover Rust command receipt: ${id}`);
    return receipt;
  });
}

function sortPythonCommandReceipts(receipts) {
  return releaseCutoverPythonCommandIds.map((id) => {
    const receipt = receipts.find((entry) => entry.id === id);
    if (!receipt) throw new Error(`Missing cutover Python command receipt: ${id}`);
    return receipt;
  });
}

function parseRouterJson(id, stdout) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`Cutover command ${id} did not emit JSON: ${errorMessage(error)}\n${stdout}`);
  }
}

function assertFileContains(project, path, expected) {
  const content = readFileSync(join(project, path), "utf8");
  if (!content.includes(expected)) throw new Error(`${path} does not contain ${expected}`);
}

function binPath(project, bin) {
  return join(project, "node_modules", ".bin", process.platform === "win32" ? `${bin}.cmd` : bin);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  const expectedStatus = options.expectedStatus ?? 0;
  if (result.status !== expectedStatus) {
    throw new Error(
      [
        `Command failed: ${command} ${args.join(" ")}`,
        `cwd: ${options.cwd ?? process.cwd()}`,
        `status: ${result.status}`,
        `stdout:\n${result.stdout}`,
        `stderr:\n${result.stderr}`
      ].join("\n")
    );
  }
  return result;
}

function runJson(command, args, options = {}) {
  return JSON.parse(run(command, args, options).stdout);
}

function valueAfter(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function git(args) {
  return run("git", args, { cwd: repoRoot }).stdout;
}

function assertSameSet(actual, expected, label) {
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  if (JSON.stringify(actualSorted) !== JSON.stringify(expectedSorted)) {
    throw new Error(`${label} mismatch\nexpected:\n${expectedSorted.join("\n")}\nactual:\n${actualSorted.join("\n")}`);
  }
}

function outputPayload(payload, text) {
  if (jsonOutput) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write(`${text}\n`);
}

function sha256File(path) {
  if (!existsSync(path)) throw new Error(`Missing file for checksum: ${path}`);
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error(`Checksum target is not a file: ${path}`);
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
