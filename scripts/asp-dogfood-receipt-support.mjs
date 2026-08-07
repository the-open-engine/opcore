import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { aspDogfoodForbiddenProviderMarkers, releaseReceiptPackageNames } from "../packages/contracts/dist/index.js";
import { releasePackageDirForName } from "./release-package-dirs.mjs";
import { createStagedOpcorePackage } from "./stage-opcore-bundle.mjs";

export function packWorkspace(repoRoot, packageName, destination) {
  const staged = packageName === "opcore" ? createStagedOpcorePackage(destination) : undefined;
  try {
    const packageDir = join(repoRoot, releasePackageDirForName(packageName));
    const result = runRequired("npm", ["pack", "--json", "--pack-destination", destination], {
      cwd: staged?.packageDir ?? packageDir
    });
    const parsed = JSON.parse(result.stdout)[0];
    const path = join(destination, parsed.filename);
    return { packageName, packageDir, filename: parsed.filename, path, sha256: sha256File(path) };
  } finally {
    staged?.cleanup();
  }
}

export function releaseRuntimeInstallPackageNames() {
  return releaseReceiptPackageNames;
}

export function locateAspManager(repoRoot) {
  const configuredPath = process.env.ASP_DOGFOOD_ASP_REPO;
  const aspRepoPath = resolve(configuredPath || join(dirname(realpathSync(repoRoot)), "agent-server-protocol"));
  const aspBinPath = join(aspRepoPath, "packages", "asp", "bin", "asp");
  const cliPath = join(aspRepoPath, "packages", "asp", "dist", "cli.js");
  if (!existsSync(aspBinPath)) {
    const source = configuredPath ? "ASP_DOGFOOD_ASP_REPO" : "adjacent agent-server-protocol checkout";
    throw new Error(`Missing ASP manager bin from ${source}: ${aspBinPath}`);
  }
  if (!existsSync(cliPath)) {
    throw new Error(`Missing ASP manager build: ${cliPath}. Run npm run build in ${aspRepoPath}.`);
  }
  const commitSha = runRequired("git", ["rev-parse", "HEAD"], { cwd: aspRepoPath }).stdout.trim();
  return { bootstrapSource: "local-sibling", aspRepoPath, aspBinPath, cliPath, commitSha };
}

export function writeAspServerManifest(tempRoot, project, providerIndex) {
  const packageManifest = readJson(join(project, "node_modules", "opcore", "package.json"));
  const indexSha256 = sha256File(providerIndex);
  const manifest = aspServerManifest(packageManifest.version, indexSha256, binPath(project, "opcore-asp-provider"));
  const path = join(tempRoot, "asp-server.opcore.json");
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return { path, manifest };
}

function aspServerManifest(version, indexSha256, providerBinPath) {
  return {
    manifestVersion: "asp-server/0.1",
    server: { id: "opcore", name: "Opcore", version },
    protocolVersions: ["asp/0.1"],
    capabilities: ["check"],
    capabilityProfiles: ["core-check-provider", "opcore-core-check"],
    entrypoint: { transport: "stdio", bin: providerBinPath, args: ["--stdio"] },
    artifact: { fingerprint: `sha256:${indexSha256}`, checksums: [{ path: "dist/index.js", sha256: indexSha256 }] },
    provenance: { publisher: "the-open-engine", source: "https://github.com/the-open-engine/opcore", license: "MIT" },
    accessExpectations: {
      filesystem: { read: ["workspace:snapshot"], write: [] },
      network: { outbound: false, allowlist: [] },
      secrets: { names: [] },
      environment: { inherit: false, variables: ["ASP_SESSION_ID", "PATH"] },
      dataClasses: ["source-code", "diff-metadata"]
    }
  };
}

export function aspEnv(project, aspHome) {
  const env = sanitizedEnv();
  env.ASP_HOME = aspHome;
  env.PATH = [join(project, "node_modules", ".bin"), env.PATH].join(":");
  return env;
}

export function createAspHostFixtureRepo(tempRoot) {
  const repoPath = join(tempRoot, "asp-host-fixture");
  mkdirSync(join(repoPath, "src"), { recursive: true });
  const repo = realpathSync(repoPath);
  writeFileSync(join(repo, "tsconfig.json"), `${JSON.stringify({ compilerOptions: { strict: true }, include: ["src/**/*.ts"] }, null, 2)}\n`);
  writeFileSync(join(repo, "src", "dogfood.ts"), "export const dogfoodValue: number = 1;\n");
  runRequired("git", ["init", "--quiet"], { cwd: repo });
  runRequired("git", ["update-index", "--add", "tsconfig.json", "src/dogfood.ts"], { cwd: repo });
  const tree = runRequired("git", ["write-tree"], { cwd: repo }).stdout.trim();
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "Opcore ASP Dogfood",
    GIT_AUTHOR_EMAIL: "opcore@example.invalid",
    GIT_COMMITTER_NAME: "Opcore ASP Dogfood",
    GIT_COMMITTER_EMAIL: "opcore@example.invalid"
  };
  const commit = runRequired("git", ["commit-tree", tree, "-m", "asp dogfood fixture baseline"], { cwd: repo, env: gitEnv }).stdout.trim();
  runRequired("git", ["branch", "-f", "main", commit], { cwd: repo });
  runRequired("git", ["checkout", "--quiet", "main"], { cwd: repo });
  writeFileSync(join(repo, "src", "dogfood.ts"), "export const dogfoodValue: number = 2;\n");
  const changedPaths = runRequired("git", ["diff", "--name-only", "HEAD", "--"], { cwd: repo }).stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  if (changedPaths.length === 0) throw new Error("ASP dogfood fixture must include at least one changed path");
  return { repo, temp: true, sourceRepoMutated: false, baselineCommitted: true, changedPaths };
}

export function runAspCommand({ repoRoot, asp, id, canonicalArgs, env }) {
  return commandReceipt({
    id,
    displayCommand: ["asp", ...canonicalArgs],
    command: process.execPath,
    args: [asp.aspBinPath, ...canonicalArgs],
    cwd: repoRoot,
    env,
    required: true,
    assertion: `${id} completed through standalone ASP manager`
  });
}

export function maybeRunCiVerify(repoRoot, asp, env) {
  const baseRef = resolveChangedFromRef(repoRoot);
  if (!baseRef) return undefined;
  return commandReceipt({
    id: "asp-ci-verify",
    displayCommand: ["asp", "ci", "verify", "--repo", repoRoot, "--changed-from", baseRef, "--json"],
    command: process.execPath,
    args: [asp.aspBinPath, "ci", "verify", "--repo", repoRoot, "--changed-from", baseRef, "--json"],
    cwd: repoRoot,
    env,
    required: false,
    assertion: "ASP CI verifier output recorded as host-owned evidence"
  });
}

export function runOpcoreSelfValidation(repoRoot) {
  const receipt = commandReceipt({
    id: "opcore-self-check",
    displayCommand: ["npm", "run", "opcore:self-check"],
    command: "npm",
    args: ["run", "opcore:self-check"],
    cwd: repoRoot,
    env: process.env,
    required: true,
    assertion: "Opcore validated its own changed implementation surface"
  });
  return {
    id: receipt.id,
    command: receipt.command,
    status: receipt.status,
    exitCode: receipt.exitCode,
    stdoutSha256: receipt.stdoutSha256,
    stderrSha256: receipt.stderrSha256,
    assertion: receipt.assertion
  };
}

export function commandReceipt({ id, displayCommand, command, args, cwd, env, required, assertion }) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 50 * 1024 * 1024
  });
  const receipt = receiptFromResult(id, displayCommand, result, assertion);
  if (required && result.status !== 0) throw commandFailure(displayCommand, cwd, result);
  return receipt;
}

function receiptFromResult(id, command, result, assertion) {
  return {
    id,
    command,
    status: result.status === 0 ? "passed" : "failed",
    exitCode: result.status,
    stdoutSha256: sha256(result.stdout || ""),
    stderrSha256: sha256(result.stderr || ""),
    output: parseJsonOutput(result.stdout || result.stderr || ""),
    assertion
  };
}

function commandFailure(command, cwd, result) {
  return new Error([
    `Command failed: ${command.join(" ")}`,
    `cwd: ${cwd}`,
    `status: ${result.status}`,
    `stdout:\n${result.stdout}`,
    `stderr:\n${result.stderr}`
  ].join("\n"));
}

export function collectInstalledPackages(project, tarballs) {
  return releaseReceiptPackageNames.flatMap((packageName) => {
    const packageRoot = join(project, "node_modules", ...packageName.split("/"));
    const manifestPath = join(packageRoot, "package.json");
    if (!existsSync(manifestPath)) return [];
    const manifest = readJson(manifestPath);
    const tarball = tarballs.find((entry) => entry.packageName === packageName);
    if (!tarball) throw new Error(`Missing tarball evidence for ${packageName}`);
    return [installedPackageEvidence(packageName, manifest, manifestPath, tarball, packageRoot)];
  });
}

function installedPackageEvidence(packageName, manifest, manifestPath, tarball, packageRoot) {
  return {
    packageName,
    version: manifest.version,
    tarball: { filename: tarball.filename, sha256: tarball.sha256 },
    installedManifest: {
      path: `node_modules/${packageName}/package.json`,
      sha256: sha256File(manifestPath),
      bins: manifest.bin ?? {}
    },
    installedFiles: collectInstalledFiles(packageRoot, packageName)
  };
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

export function collectParityBlockers(repoRoot) {
  void repoRoot;
  return [];
}

export function assuranceFromHost(hostDecision, hostReceipt) {
  const assurance = requireObject(hostDecision.assurance ?? hostReceipt.assurance, "host assurance");
  return {
    mode: String(assurance.mode || "unknown"),
    transactionGuarantee: String(assurance.transactionGuarantee || "unknown")
  };
}

export function writeReceiptDocs(repoRoot, receiptPath, summaryPath, receipt) {
  mkdirSync(join(repoRoot, "docs", "release"), { recursive: true });
  const receiptJson = `${JSON.stringify(receipt, null, 2)}\n`;
  writeFileSync(join(repoRoot, receiptPath), receiptJson);
  writeFileSync(join(repoRoot, summaryPath), summaryMarkdown(receipt, receiptPath, sha256(receiptJson)));
}

function summaryMarkdown(receipt, receiptPath, receiptSha256) {
  const blockers = receipt.unsupportedSurfaces.map((entry) => `- ${entry.surface}: ${entry.status}; ${entry.blocker}`).join("\n");
  return `# ASP Dogfood Receipt Summary

Issue #120 receipt for advisory standalone ASP manager dogfood.

Machine receipt: ${receiptPath}
Machine receipt SHA-256: ${receiptSha256}
Bootstrap source: ${receipt.manager.bootstrapSource}
Repo enrollment mode: ${receipt.repoEnrollment.mode}
Host fixture repo: ${receipt.hostFixture.temp ? "temporary" : "non-temporary"}
Host fixture changed paths: ${receipt.hostFixture.changedPaths.join(", ")}
Source repo mutated: ${receipt.hostFixture.sourceRepoMutated}
Provider command: ${receipt.provider.command.join(" ")}
Host assurance: ${receipt.hostEvaluation.check.assurance.mode}
Transaction guarantee: ${receipt.hostEvaluation.check.assurance.transactionGuarantee}
Self-validation: ${receipt.selfValidation.status}

## Deferred Coverage

${blockers}
`;
}

export function providerScanTexts(manifest) {
  return ["opcore-asp-provider --stdio", JSON.stringify(manifest)];
}

export function assertNoForbiddenProviderMarkers(receipt) {
  const findings = [];
  const legacyProviderBinMarker = ["lattice", "asp", "provider"].join("-");
  for (const text of providerScanTexts(receipt.provider.manifest.manifest)) {
    const normalized = text.replaceAll("\\", "/").toLowerCase();
    for (const marker of [...aspDogfoodForbiddenProviderMarkers, legacyProviderBinMarker]) {
      if (normalized.includes(marker.toLowerCase())) findings.push(marker);
    }
  }
  if (findings.length > 0) throw new Error(`ASP dogfood provider marker scan failed: ${[...new Set(findings)].join(", ")}`);
}

export function sanitizeReceiptForProvenance(value, aspRepoPath) {
  if (typeof value === "string") {
    if (value === aspRepoPath) return "<asp-repo>";
    return value.replaceAll(`${aspRepoPath}/`, "<asp-repo>/");
  }
  if (Array.isArray(value)) return value.map((entry) => sanitizeReceiptForProvenance(entry, aspRepoPath));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, sanitizeReceiptForProvenance(child, aspRepoPath)])
  );
}

export function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is required`);
  return value;
}

export function binPath(project, bin) {
  return join(project, "node_modules", ".bin", process.platform === "win32" ? `${bin}.cmd` : bin);
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function runRequired(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 50 * 1024 * 1024
  });
  if (result.status !== 0) throw commandFailure([command, ...args], options.cwd ?? process.cwd(), result);
  return result;
}

export function sha256File(path) {
  if (!existsSync(path)) throw new Error(`Missing file for checksum: ${path}`);
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error(`Checksum target is not a file: ${path}`);
  return sha256(readFileSync(path));
}

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function sanitizedEnv() {
  const env = { ...process.env };
  env.PATH = [dirname(process.execPath), "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
  return env;
}

function resolveChangedFromRef(repoRoot) {
  for (const candidate of ["origin/main", "origin/dev", "main", "HEAD"]) {
    const result = spawnSync("git", ["rev-parse", "--verify", `${candidate}^{tree}`], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    if (result.status === 0) return candidate;
  }
  return null;
}

function parseJsonOutput(text) {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}
