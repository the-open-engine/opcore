#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { aspDogfoodForbiddenProviderMarkers, releaseReceiptPackageNames, validateAspDogfoodReceipt } from "../packages/contracts/dist/index.js";
import { runProviderProbe } from "./asp-dogfood-provider-probe.mjs";
import {
  aspEnv,
  assertNoForbiddenProviderMarkers,
  assuranceFromHost,
  binPath,
  collectInstalledPackages,
  collectParityBlockers,
  createAspHostFixtureRepo,
  locateAspManager,
  maybeRunCiVerify,
  packWorkspace,
  providerScanTexts,
  readJson,
  requireObject,
  releaseRuntimeInstallPackageNames,
  runAspCommand,
  runCurrentToolGuardrails,
  runRequired,
  sanitizeReceiptForProvenance,
  sha256File,
  writeAspServerManifest,
  writeReceiptDocs
} from "./asp-dogfood-receipt-support.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const receiptPath = "docs/release/asp-dogfood-receipt.json";
const summaryPath = "docs/release/asp-dogfood-receipt.summary.md";
const args = process.argv.slice(2);
const writeDocs = args.includes("--write");
const jsonOutput = args.includes("--json") || !writeDocs;
const includeCurrentToolsAll = args.includes("--include-current-tools-all");

await main();

async function main() {
  try {
    const validateReceiptFile = valueAfter("--validate-receipt-file");
    if (validateReceiptFile) return validateReceipt(validateReceiptFile);
    const receipt = validateAspDogfoodReceipt(await generateReceipt());
    assertNoForbiddenProviderMarkers(receipt);
    if (writeDocs) writeReceiptDocs(repoRoot, receiptPath, summaryPath, receipt);
    outputPayload(receipt, writeDocs ? `ASP dogfood receipt written to ${receiptPath}` : "ASP dogfood receipt passed");
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

function validateReceipt(path) {
  const receipt = validateAspDogfoodReceipt(readJson(path));
  assertNoForbiddenProviderMarkers(receipt);
  outputPayload(receipt, "ASP dogfood receipt validation passed");
}

async function generateReceipt() {
  const tempRoot = mkdtempSync(join(tmpdir(), "opcore-asp-dogfood-"));
  try {
    const install = installPackedProject(tempRoot);
    const provider = providerEvidence(tempRoot, install.project);
    const manager = locateAspManager();
    const aspHome = mkdtempSync(join(tempRoot, "asp-home-"));
    const env = aspEnv(install.project, aspHome);
    const fixture = createAspHostFixtureRepo(tempRoot);
    const flow = runAspFlow(manager, env, provider.manifest.manifestPath, fixture);
    const probe = await runProviderProbe(binPath(install.project, "opcore-asp-provider"));
    return sanitizeReceiptForProvenance(buildReceipt({ install, provider, manager, aspHome, fixture, flow, probe }));
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function installPackedProject(tempRoot) {
  const packDir = join(tempRoot, "packages");
  mkdirSync(packDir, { recursive: true });
  const tarballs = releaseReceiptPackageNames.map((packageName) => packWorkspace(repoRoot, packageName, packDir));
  const tarballsByPackage = new Map(tarballs.map((entry) => [entry.packageName, entry]));
  const project = join(tempRoot, "project");
  mkdirSync(project);
  runRequired("npm", ["init", "-y"], { cwd: project });
  runRequired(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      ...releaseRuntimeInstallPackageNames().map((packageName) => tarballsByPackage.get(packageName).path)
    ],
    { cwd: project }
  );
  if (!existsSync(binPath(project, "opcore-asp-provider"))) throw new Error("Installed opcore-asp-provider bin is missing");
  return { project, tarballs, installedPackages: collectInstalledPackages(project, tarballs) };
}

function providerEvidence(tempRoot, project) {
  const providerIndex = join(project, "node_modules", "opcore", "node_modules", "@the-open-engine", "opcore-asp-provider", "dist", "index.js");
  const manifest = writeAspServerManifest(tempRoot, project, providerIndex);
  return {
    providerId: "opcore",
    packageName: "opcore",
    binPath: "node_modules/.bin/opcore-asp-provider",
    indexPath: "node_modules/opcore/node_modules/@the-open-engine/opcore-asp-provider/dist/index.js",
    indexSha256: sha256File(providerIndex),
    command: ["opcore-asp-provider", "--stdio"],
    entrypoint: manifest.manifest.entrypoint,
    manifest: {
      manifestPath: manifest.path,
      manifestSha256: sha256File(manifest.path),
      manifest: manifest.manifest
    }
  };
}

function runAspFlow(manager, env, manifestPath, fixture) {
  const asp = (id, canonicalArgs, cwd = repoRoot) => runAspCommand({ repoRoot: cwd, asp: manager, id, canonicalArgs, env });
  const managerState = {
    status: asp("asp-status", ["status", "--json"]),
    serverAdd: asp("asp-server-add", ["server", "add", "--manifest", manifestPath, "--json"]),
    serverStatus: asp("asp-server-status", ["server", "status", "opcore", "--json"])
  };
  const repoEnrollment = {
    repoAdd: asp("asp-repo-add", ["repo", "add", fixture.repo, "--json"], fixture.repo),
    repoEnable: asp("asp-repo-enable", ["repo", "enable", "opcore", "--repo", fixture.repo, "--mode", "advisory", "--json"], fixture.repo),
    repoStatus: asp("asp-repo-status", ["repo", "status", fixture.repo, "--json"], fixture.repo)
  };
  const check = asp("asp-check-changed", ["check", "--repo", fixture.repo, "--changed", "--call-site", "interactive", "--json"], fixture.repo);
  const checkOutput = requireObject(check.output, "asp check output");
  const hostDecision = requireObject(checkOutput.hostDecision, "asp check hostDecision");
  const receipt = requireObject(checkOutput.receipt, "asp check receipt");
  assertHostEvaluationRecorded(hostDecision, receipt, checkOutput);
  return {
    managerState,
    repoEnrollment,
    hostEvaluation: {
      check: { ...check, hostDecision, receipt, assurance: assuranceFromHost(hostDecision, receipt) },
      ciVerify: maybeRunCiVerify(fixture.repo, manager, env)
    }
  };
}

function assertHostEvaluationRecorded(hostDecision, receipt, checkOutput) {
  if (Array.isArray(hostDecision.authorityEvidence) && hostDecision.authorityEvidence.length > 0) return;
  throw new Error(
    `ASP dogfood host check did not record provider authority evidence: ${JSON.stringify(
      {
        decision: hostDecision.decision,
        authorityEvidenceLength: hostDecision.authorityEvidence?.length ?? 0,
        receiptAuthorityEvidenceLength: receipt.authorityEvidence?.length ?? 0,
        receiptProviderProvenanceLength: receipt.providerProvenance?.length ?? 0,
        coverage: checkOutput.coverage ?? hostDecision.coverage ?? receipt.coverage,
        providerIds: receipt.providerIds
      },
      null,
      2
    )}`
  );
}

function buildReceipt({ install, provider, manager, aspHome, fixture, flow, probe }) {
  return {
    schemaVersion: 1,
    issue: "#120",
    origin: "covibes-authored-asp-dogfood-proof",
    generatedAt: new Date().toISOString(),
    commitSha: runRequired("git", ["rev-parse", "HEAD"], { cwd: repoRoot }).stdout.trim(),
    privateRepo: true,
    bootstrapSource: "local-sibling",
    packageNames: releaseReceiptPackageNames,
    installedPackages: install.installedPackages,
    manager,
    aspHome: aspHomeEvidence(aspHome),
    hostFixture: fixture,
    provider,
    managerState: flow.managerState,
    repoEnrollment: { repo: fixture.repo, mode: "advisory", ...flow.repoEnrollment },
    hostEvaluation: flow.hostEvaluation.ciVerify
      ? flow.hostEvaluation
      : { check: flow.hostEvaluation.check },
    providerProbe: probe,
    currentToolGuardrails: runCurrentToolGuardrails(repoRoot, includeCurrentToolsAll),
    unsupportedSurfaces: unsupportedSurfaces(),
    parityBlockers: collectParityBlockers(repoRoot),
    authority: authorityEvidence(),
    publicReleaseActions: [],
    oldToolReplacementClaimed: false,
    forbiddenMarkerScan: {
      scannedTextCount: providerScanTexts(provider.manifest.manifest).length,
      findingCount: 0,
      markersBlocked: aspDogfoodForbiddenProviderMarkers
    }
  };
}

function aspHomeEvidence(aspHome) {
  return {
    path: aspHome,
    temp: true,
    isolated: true,
    sharedStateMutated: false,
    pathSanitized: true,
    aceRuntimeBinExcluded: true
  };
}

function unsupportedSurfaces() {
  return [
    {
      surface: "inspect",
      status: "parity-blocker",
      cleanCoverage: false,
      blocker: "ASP dogfood covers Core check/evaluate only; inspect request/response mapping remains outside #120."
    },
    {
      surface: "edit",
      status: "retained-old-tool-gate",
      cleanCoverage: false,
      blocker: "ASP dogfood does not authorize edits or apply behavior; edit parity remains covered by current old-tool and cutover gates."
    }
  ];
}

function authorityEvidence() {
  return {
    hostOwnsDecisions: true,
    providerOutputIsHostDecision: false,
    localAuthorityOverride: { present: false, sharedAuthorityWeakened: false }
  };
}

function outputPayload(payload, text) {
  if (jsonOutput) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write(`${text}\n`);
}

function valueAfter(flag) {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const raw = args[index + 1];
  if (!raw) throw new Error(`Missing value for ${flag}`);
  return raw.startsWith("/") ? raw : join(repoRoot, raw);
}
