#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  releaseCutoverRequiredCommandIds,
  releaseReceiptPackageNames,
  validateManagedToolDescriptor,
  validateReleaseCutoverReceipt
} from "../packages/contracts/dist/index.js";
import {
  currentGraphCoreNativeTarget,
  graphCoreNativePackageForTarget
} from "./graph-native-targets.mjs";
import {
  isNativeReleasePackageName,
  releasePackageDirForName
} from "./release-package-dirs.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const descriptorPath = "packages/opcore/dist/descriptors/lattice.managed-tool.json";
const graphReleaseReceiptPath = "docs/release/graph-release-receipt.json";
const releaseReceiptPath = "docs/release/release-receipt.json";
const preWriteEvidencePath = "docs/integration/pre-write-validation.md";
const cutoverReceiptPath = "docs/release/cutover-receipt.json";
const cutoverSummaryPath = "docs/release/cutover-receipt.summary.md";
const artifactAttestationPath = "docs/release/artifact-attestation.md";
const fixtureRoot = "packages/fixtures/source-extraction/wave1";
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
  const tempRoot = mkdtempSync(join(tmpdir(), "lattice-cutover-"));
  try {
    const packDir = join(tempRoot, "packages");
    mkdirSync(packDir, { recursive: true });
    const tarballs = releaseReceiptPackageNames.map((packageName) => packWorkspace(packageName, packDir));
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

    const latticeBin = binPath(project, "lattice");
    const opcoreBin = binPath(project, "opcore");
    if (!existsSync(latticeBin)) throw new Error("Installed lattice bin is missing");
    if (!existsSync(opcoreBin)) throw new Error("Installed opcore bin is missing");
    inspectInstalledBins(project);
    const commandEnv = sanitizedEnv();
    const commandTexts = [];
    const commandReceipts = [];
    const runOpcore = (id, args, expectedStatus, assertion) => {
      const result = run(opcoreBin, args, { cwd: opcoreSmokeRepo, env: commandEnv, expectedStatus });
      commandTexts.push({ label: `${id}:stdout`, text: result.stdout }, { label: `${id}:stderr`, text: result.stderr });
      const parsed = parseRouterJson(id, result.stdout);
      if (parsed.exitCode !== expectedStatus || result.status !== expectedStatus) {
        throw new Error(`Cutover command ${id} exit mismatch: router=${parsed.exitCode} process=${result.status}`);
      }
      assertCommandPayload(id, parsed);
      commandReceipts.push({
        id,
        command: parsed.canonicalCommand,
        canonicalCommand: parsed.canonicalCommand,
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
    const runLattice = (id, args, expectedStatus, assertion) => {
      const result = run(latticeBin, args, { cwd: project, env: commandEnv, expectedStatus });
      commandTexts.push({ label: `${id}:stdout`, text: result.stdout }, { label: `${id}:stderr`, text: result.stderr });
      const parsed = parseRouterJson(id, result.stdout);
      if (parsed.status === "not_implemented") throw new Error(`Cutover command ${id} returned not_implemented`);
      if (parsed.exitCode !== expectedStatus || result.status !== expectedStatus) {
        throw new Error(`Cutover command ${id} exit mismatch: router=${parsed.exitCode} process=${result.status}`);
      }
      assertCommandPayload(id, parsed);
      commandReceipts.push({
        id,
        command: parsed.canonicalCommand,
        canonicalCommand: parsed.canonicalCommand,
        owner: parsed.owner,
        status: parsed.status,
        exitCode: parsed.exitCode,
        binPath: "node_modules/.bin/lattice",
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

    runLattice("status", ["status", "--json"], 0, "runtime status reports validation readiness");
    runLattice("doctor", ["doctor", "--json"], 0, "runtime doctor reports validation readiness");
    runLattice("graph-build", ["graph", "build", "--json"], 0, "graph build completed with native artifact");
    runLattice("graph-status", ["graph", "status", "--json"], 0, "graph status available after build");
    runLattice("graph-query", ["graph", "query", "--json"], 0, "graph query returned facts");
    runLattice("graph-impact", ["graph", "impact", "--files", "src/components/GreetingCard.tsx", "--json"], 0, "graph impact returned file impact");
    runLattice(
      "graph-review-context",
      ["graph", "review-context", "--files", "src/components/GreetingCard.tsx", "--json"],
      0,
      "graph review-context returned related facts"
    );
    runLattice(
      "graph-detect-changes",
      ["graph", "detect-changes", "--files", "src/components/GreetingCard.tsx", "--json"],
      0,
      "graph detect-changes returned typed change data"
    );
    runLattice("graph-search", ["graph", "search", "Greeting", "--limit", "5", "--json"], 0, "graph search returned ranked results");
    runLattice("graph-serve", ["graph", "serve", "--json"], 0, "graph serve status route is ready");
    runLattice("inspect-symbols", ["inspect", "symbols", "Greeting", "--limit", "5", "--json"], 0, "inspect symbols returned graph symbols");
    runLattice("inspect-definition", ["inspect", "definition", "GreetingCard", "--json"], 0, "inspect definition returned a symbol");
    runLattice(
      "inspect-references",
      ["inspect", "references", "function:src/components/GreetingCard.tsx#GreetingCard", "--limit", "5", "--json"],
      0,
      "inspect references returned callers"
    );
    runLattice(
      "inspect-signature",
      ["inspect", "signature", "function:src/components/GreetingCard.tsx#GreetingCard", "--json"],
      0,
      "inspect signature returned read-only language-service signatures"
    );
    runLattice(
      "inspect-implementations",
      ["inspect", "implementations", "class:src/models.ts#GreetingModel", "--json"],
      0,
      "inspect implementations returned implementation evidence"
    );
    runLattice("inspect-search", ["inspect", "search", "Greeting", "--limit", "5", "--json"], 0, "inspect search returned graph search results");
    runLattice(
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
    runLattice(
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
    runLattice(
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
    runLattice(
      "check-files",
      ["check", "files", "src/cutover.ts", "--checks", "typescript.syntax,typescript.types", "--json"],
      0,
      "check files passed syntax and type checks"
    );
    const requestPath = writeValidationRequest(project, "validate-request.json", {
      checks: ["typescript.syntax", "typescript.types"]
    });
    runLattice("validate-request", ["validate", "request", "--request-file", requestPath, "--json"], 0, "validate request passed");
    const preWritePass = writeValidationRequest(project, "pre-write-pass.json", {
      checks: ["typescript.syntax", "typescript.types"],
      overlays: [{ path: "src/cutover.ts", action: "write", content: "export const cutoverValue: number = 3;\n" }]
    });
    runLattice(
      "validate-pre-write-pass",
      ["validate", "pre-write", "--request-file", preWritePass, "--timeout-ms", "30000", "--json"],
      0,
      "pre-write pass receipt was ok"
    );
    const preWriteFail = writeValidationRequest(project, "pre-write-fail.json", {
      checks: ["typescript.types"],
      overlays: [{ path: "src/cutover.ts", action: "write", content: "export const cutoverValue: number = 'bad';\n" }]
    });
    runLattice(
      "validate-pre-write-fail",
      ["validate", "pre-write", "--request-file", preWriteFail, "--timeout-ms", "30000", "--json"],
      1,
      "pre-write failure receipt failed closed"
    );

    const negativeChecks = runMissingGraphNegativeChecks(tempRoot, latticeBin, commandEnv, commandTexts);
    const descriptor = collectInstalledDescriptor(project, tarballs);
    const installedPackages = collectInstalledPackages(project, tarballs);
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
        latticeBinOnly: true,
        oldBinsAbsent: { crg: true, cix: true, rox: true }
      },
      commandReceipts: sortCommandReceipts(commandReceipts),
      negativeChecks,
      forbiddenMarkerScan: {
        scannedTextCount: receiptScanTextsWithoutReceipt(project, descriptor, commandTexts, tarballs).length + 1,
        findingCount: 0,
        markersBlocked: ["private-runtime", "current-tool-env", "private-home", "old-tool-bins"]
      },
      inputEvidence: collectInputEvidence()
    };
    assertSameSet(receipt.commandReceipts.map((entry) => entry.id), releaseCutoverRequiredCommandIds, "cutover command receipts");
    assertNoForbiddenMarkers(receiptScanTextsWithoutReceipt(project, descriptor, commandTexts, tarballs));
    assertNoForbiddenMarkers(receiptScanTexts(receipt));
    return receipt;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function runMissingGraphNegativeChecks(tempRoot, latticeBin, env, commandTexts) {
  const missingProject = join(tempRoot, "missing-graph");
  mkdirSync(join(missingProject, "src"), { recursive: true });
  writeFileSync(join(missingProject, "src/index.ts"), "export const value = 1;\n");
  const requestPath = join(missingProject, "required-graph.json");
  writeFileSync(
    requestPath,
    `${JSON.stringify({
      repo: { repoRoot: missingProject },
      scope: { kind: "files", files: ["src/index.ts"] },
      graph: { mode: "required", provider: "lattice-graph" },
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
    const result = run(latticeBin, check.args, { cwd: missingProject, env, expectedStatus: 1 });
    commandTexts.push({ label: `${check.id}:stdout`, text: result.stdout }, { label: `${check.id}:stderr`, text: result.stderr });
    const parsed = parseRouterJson(check.id, result.stdout);
    if (parsed.validationResult?.status !== "provider_failure") {
      throw new Error(`${check.id} did not fail closed with provider_failure`);
    }
    return {
      id: check.id,
      command: ["lattice", ...check.args],
      status: "passed",
      exitCode: 0,
      assertion: "required graph provider failure stayed typed"
    };
  });
}

function packWorkspace(packageName, destination) {
  const packageDir = join(repoRoot, releasePackageDirForName(packageName));
  const result = run("npm", ["pack", "--json", "--pack-destination", destination], { cwd: packageDir });
  const parsed = JSON.parse(result.stdout)[0];
  const path = join(destination, parsed.filename);
  return {
    packageName,
    packageDir,
    filename: parsed.filename,
    path,
    sha256: sha256File(path)
  };
}

function releaseRuntimeInstallPackageNames() {
  const currentNativePackage = graphCoreNativePackageForTarget(currentGraphCoreNativeTarget()).packageName;
  return releaseReceiptPackageNames.filter((packageName) => !isNativeReleasePackageName(packageName) || packageName === currentNativePackage);
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

function inspectInstalledBins(project) {
  if (!existsSync(binPath(project, "lattice"))) throw new Error("installed project is missing lattice bin");
  if (!existsSync(binPath(project, "opcore"))) throw new Error("installed project is missing opcore bin");
  if (!existsSync(binPath(project, "opcore-asp-provider"))) throw new Error("installed project is missing opcore-asp-provider bin");
  for (const oldBin of ["crg", "cix", "rox"]) {
    if (existsSync(binPath(project, oldBin))) throw new Error(`installed project exposes old public bin ${oldBin}`);
  }
}

function collectInstalledPackages(project, tarballs) {
  return releaseReceiptPackageNames.flatMap((packageName) => {
    const manifestPath = join(project, "node_modules", ...packageName.split("/"), "package.json");
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
      }
    }];
  });
}

function collectInstalledDescriptor(project, tarballs) {
  const tarballsByPackage = new Map(tarballs.map((entry) => [entry.packageName, entry]));
  const descriptorAbsolutePath = join(
    project,
    "node_modules",
    "@the-open-engine",
    "opcore",
    "dist",
    "descriptors",
    "lattice.managed-tool.json"
  );
  const descriptor = validateManagedToolDescriptor(JSON.parse(readFileSync(descriptorAbsolutePath, "utf8")));
  return {
    path: "node_modules/@the-open-engine/opcore/dist/descriptors/lattice.managed-tool.json",
    packageName: "@the-open-engine/opcore",
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
    assertSameSet(scenarioIds, ["mixed-repo", "rust-crate", "typescript-app", "unsupported-files"], "opcore try scenario ids");
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
  if (id === "inspect-implementations" && parsed.inspectResult?.implementations?.length < 1) {
    throw new Error("inspect-implementations must return implementation evidence");
  }
  if (id === "edit-refused" && parsed.status !== "error") throw new Error("edit-refused must fail closed");
  if (id === "validate-pre-write-fail" && parsed.receipt?.ok !== false) throw new Error("pre-write failure receipt must not be ok");
}

function writeValidationRequest(project, filename, overrides = {}) {
  const path = join(project, filename);
  writeFileSync(
    path,
    `${JSON.stringify({
      repo: { repoRoot: project },
      scope: { kind: "files", files: ["src/cutover.ts"] },
      graph: { mode: "optional", provider: "lattice-graph" },
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
  return [...packageManifestTexts, { label: "descriptor", text: descriptorText }, ...commandTexts];
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
    for (const marker of forbidden) {
      if (marker.pattern.test(entry.text)) findings.push(`${entry.label}: ${marker.label}`);
    }
  }
  if (findings.length > 0) throw new Error(`Cutover forbidden marker scan failed:\n${findings.join("\n")}`);
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
    { issue: "#29", path: releaseReceiptPath, checksumSha256: sha256File(join(repoRoot, releaseReceiptPath)) },
    { issue: "#58", path: preWriteEvidencePath, checksumSha256: sha256File(join(repoRoot, preWriteEvidencePath)) }
  ];
}

function writeCutoverDocs(receipt) {
  mkdirSync(join(repoRoot, "docs/release"), { recursive: true });
  const receiptJson = `${JSON.stringify(receipt, null, 2)}\n`;
  writeFileSync(join(repoRoot, cutoverReceiptPath), receiptJson);
  writeFileSync(join(repoRoot, cutoverSummaryPath), cutoverSummaryMarkdown(receipt, sha256(receiptJson)));
  appendCutoverAttestation(receipt, sha256(receiptJson));
}

function cutoverSummaryMarkdown(receipt, receiptSha256) {
  const commandRows = receipt.commandReceipts
    .map((entry) => `| ${entry.id} | ${entry.owner} | ${entry.status} | ${entry.exitCode} | ${entry.assertion} |`)
    .join("\n");
  return `# Cutover Receipt Summary

Maintainer cutover gate proves installed Lattice artifacts handle canonical release commands without dev-tool fallback.

Machine receipt: ${cutoverReceiptPath}
Machine receipt SHA-256: ${receiptSha256}

Installed packages: ${receipt.installedPackages.length}
Command receipts: ${receipt.commandReceipts.length}
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
  const block = `\n## Cutover Gate\n\nIssue #30 receipt: ${cutoverReceiptPath}\nCutover receipt SHA-256: ${receiptSha256}\nInstalled command receipts: ${receipt.commandReceipts.length}\n`;
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
