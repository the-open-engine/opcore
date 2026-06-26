#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  graphCoreNativePackageNameForTarget,
  graphCoreNativePackageNames,
  graphCoreNativeSupportedTargets,
  releaseReceiptCommandGroups,
  releaseReceiptPackageNames,
  releaseReceiptReportIds,
  validateManagedToolDescriptor,
  validateGraphReleaseReceipt,
  validateReleaseReceipt
} from "../packages/contracts/dist/index.js";
import { releasePackageDirForName } from "./release-package-dirs.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const packlistsPath = "tests/fixtures/package-packlists.json";
const descriptorPath = "packages/opcore/dist/descriptors/lattice.managed-tool.json";
const releaseReceiptPath = "docs/release/release-receipt.json";
const releaseSummaryPath = "docs/release/release-receipt.summary.md";
const licenseReportPath = "docs/release/license-report.md";
const provenanceReportPath = "docs/release/provenance-receipts.md";
const artifactAttestationPath = "docs/release/artifact-attestation.md";
const secretAllowlistPath = "docs/release/secret-scan-allowlist.json";
const graphReleaseReceiptPath = "docs/release/graph-release-receipt.json";
const packDestination = ".lattice/release/packages";

const args = new Set(process.argv.slice(2));
const writeDocs = args.has("--write");
const jsonOutput = args.has("--json") || !writeDocs;
const inspectPackagesOnly = args.has("--inspect-packages-only") || args.has("--inspect-package-only");
const inspectDescriptorOnly = args.has("--inspect-descriptor-only");
const scanSecretsOnly = args.has("--scan-secrets-only");

try {
  const descriptor = readDescriptor();
  if (scanSecretsOnly) {
    const secretHistory = scanSecrets();
    outputPayload(secretHistory, "secret/history scan passed");
  } else if (inspectPackagesOnly) {
    const packages = collectPackageEvidence(descriptor);
    outputPayload({ schemaVersion: 1, packages }, "package inspection passed");
  } else if (inspectDescriptorOnly) {
    const packages = collectPackageEvidence(descriptor);
    const descriptorEvidence = collectDescriptorEvidence(descriptor, packages);
    outputPayload({ schemaVersion: 1, descriptor: descriptorEvidence }, "descriptor inspection passed");
  } else {
    const receipt = generateReceipt(descriptor);
    const validated = validateReleaseReceipt(receipt);
    if (writeDocs) writeReleaseDocs(validated);
    outputPayload(validated, `release receipt written to ${releaseReceiptPath}`);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}

function generateReceipt(descriptor) {
  const packages = collectPackageEvidence(descriptor);
  const descriptorEvidence = collectDescriptorEvidence(descriptor, packages);
  const nativeArtifacts = packages.flatMap((entry) => entry.nativeArtifacts);
  const license = collectLicenseEvidence();
  const provenance = collectProvenanceEvidence();
  const secretHistory = scanSecrets();
  const graphReleaseReceipt = collectGraphReleaseReceipt();
  const reports = collectReports({ license, provenance, secretHistory, graphReleaseReceipt });
  return {
    schemaVersion: 1,
    issue: "#29",
    origin: "covibes-authored-release-proof",
    generatedAt: new Date().toISOString(),
    commitSha: git(["rev-parse", "HEAD"]).trim(),
    privateRepo: true,
    packageNames: releaseReceiptPackageNames,
    commandGroups: releaseReceiptCommandGroups,
    packages,
    descriptor: descriptorEvidence,
    nativeArtifacts,
    license,
    provenance,
    secretHistory,
    reports,
    graphReleaseReceipt
  };
}

function collectPackageEvidence(descriptor) {
  const packlists = readJson(packlistsPath);
  rmSync(join(repoRoot, packDestination), { recursive: true, force: true });
  mkdirSync(join(repoRoot, packDestination), { recursive: true });
  return releaseReceiptPackageNames.map((packageName) => collectOnePackageEvidence(packageName, packlists, descriptor));
}

function collectOnePackageEvidence(packageName, packlists, descriptor) {
  const fixture = packlists[packageName];
  if (!fixture?.directory) throw new Error(`Missing package packlist fixture for ${packageName}`);
  const packageRoot = fixture.directory;
  const manifest = readJson(`${packageRoot}/package.json`);
  if (manifest.name !== packageName) throw new Error(`${packageRoot}/package.json name mismatch: ${manifest.name}`);
  const pack = runJson("npm", ["pack", "--json", "--pack-destination", join(repoRoot, packDestination)], {
    cwd: join(repoRoot, releasePackageDirForName(packageName))
  })[0];
  const files = (pack.files ?? []).map((entry) => entry.path).sort();
  const expectedFiles = expectedPackFiles(fixture).sort();
  assertSameSet(files, expectedFiles, `${packageName} packed files`);
  const tarballPath = `${packDestination}/${pack.filename}`;
  const tarballAbsolutePath = join(repoRoot, tarballPath);
  if (!existsSync(tarballAbsolutePath)) throw new Error(`npm pack did not write tarball: ${tarballPath}`);
  const bins = manifest.bin ?? {};
  validateNoOldPublicIdentity(packageName, manifest, bins);
  const nativeArtifacts = graphCoreNativePackageNames.includes(packageName) ? collectNativeArtifacts(packageRoot, packageName, descriptor) : [];
  return {
    packageName,
    packageRoot,
    version: manifest.version,
    manifest: {
      name: manifest.name,
      version: manifest.version,
      license: manifest.license,
      main: manifest.main,
      types: manifest.types,
      files: manifest.files ?? [],
      bins,
      dependencies: manifest.dependencies ?? {},
      ...(manifest.optionalDependencies ? { optionalDependencies: manifest.optionalDependencies } : {}),
      ...(manifest.os ? { os: manifest.os } : {}),
      ...(manifest.cpu ? { cpu: manifest.cpu } : {}),
      bundledDependencies: manifest.bundleDependencies ?? manifest.bundledDependencies ?? pack.bundled ?? []
    },
    tarball: {
      filename: pack.filename,
      path: tarballPath,
      sha256: sha256File(tarballAbsolutePath),
      integrity: pack.integrity,
      shasum: pack.shasum
    },
    files,
    fileCount: files.length,
    expectedFiles,
    expectedFileCount: expectedFiles.length,
    bins,
    descriptorReferences: descriptor.artifacts.filter((artifact) => artifact.packageName === packageName),
    nativeArtifacts
  };
}

function expectedPackFiles(fixture) {
  return [...fixture.expectedFiles];
}

function collectNativeArtifacts(packageRoot, packageName, descriptor) {
  const target = graphCoreNativeTargetForPackageName(packageName);
  const binary = requiredDescriptorArtifact(descriptor, `graph-core-binary-${target}`);
  const metadataArtifact = requiredDescriptorArtifact(descriptor, `graph-core-metadata-${target}`);
  const checksumArtifact = requiredDescriptorArtifact(descriptor, `graph-core-checksum-${target}`);
  const descriptorChecksum = requiredDescriptorChecksum(descriptor, `graph-core-binary-sha256-${target}`);
  const binaryAbsolutePath = join(repoRoot, packageRoot, binary.path);
  const checksumAbsolutePath = join(repoRoot, packageRoot, checksumArtifact.path);
  const metadataAbsolutePath = join(repoRoot, packageRoot, metadataArtifact.path);
  for (const path of [binaryAbsolutePath, checksumAbsolutePath, metadataAbsolutePath]) {
    if (!existsSync(path)) throw new Error(`Missing graph native artifact evidence: ${relative(repoRoot, path)}`);
  }
  const binarySha256 = sha256File(binaryAbsolutePath);
  const checksumText = readFileSync(checksumAbsolutePath, "utf8").trim();
  if (!checksumText.startsWith(binarySha256)) {
    throw new Error(`Graph native checksum file does not match binary: ${relative(repoRoot, checksumAbsolutePath)}`);
  }
  const metadata = JSON.parse(readFileSync(metadataAbsolutePath, "utf8"));
  if (metadata.checksumSha256 !== binarySha256) {
    throw new Error(`Graph native metadata checksumSha256 does not match binary: ${relative(repoRoot, metadataAbsolutePath)}`);
  }
  if (metadata.targetPlatform !== target || metadata.binaryPath !== binary.path || metadata.checksumPath !== checksumArtifact.path) {
    throw new Error("Graph native metadata paths must match descriptor artifacts");
  }
  return [
    {
      packageName,
      targetPlatform: metadata.targetPlatform,
      metadata,
      binaryPath: binary.path,
      checksumPath: checksumArtifact.path,
      metadataPath: metadataArtifact.path,
      binarySha256,
      checksumFileSha256: sha256File(checksumAbsolutePath),
      metadataSha256: sha256File(metadataAbsolutePath),
      descriptorArtifactId: binary.id,
      descriptorChecksumId: descriptorChecksum.id
    }
  ];
}

function graphCoreNativeTargetForPackageName(packageName) {
  const target = graphCoreNativeSupportedTargets.find((entry) => graphCoreNativePackageNameForTarget(entry) === packageName);
  if (!target) throw new Error(`Unknown Opcore graph-core native package: ${packageName}`);
  return target;
}

function collectDescriptorEvidence(descriptor, packages) {
  const descriptorAbsolutePath = join(repoRoot, descriptorPath);
  if (!existsSync(descriptorAbsolutePath)) throw new Error(`Missing managed tool descriptor: ${descriptorPath}. Run npm run build first.`);
  const commandGroups = descriptor.commandGroups.map((group) => ({
    name: group.name,
    canonicalCommand: group.canonicalCommand,
    packageName: group.packageName
  }));
  assertSameSet(commandGroups.map((group) => group.name), releaseReceiptCommandGroups, "descriptor command groups");
  const resolvedArtifacts = descriptor.artifacts.map((artifact) => {
    assertPackageFile(packages, artifact.packageName, artifact.path, `descriptor artifact ${artifact.id}`);
    return {
      id: artifact.id,
      packageName: artifact.packageName,
      path: artifact.path,
      type: artifact.type,
      required: artifact.required,
      packageFile: true,
      ...(artifact.checksumRef ? { checksumRef: artifact.checksumRef } : {})
    };
  });
  const resolvedChecksums = descriptor.checksums.map((checksum) => {
    assertPackageFile(packages, checksum.packageName, checksum.path, `descriptor checksum ${checksum.id}`);
    const packageRoot = packages.find((entry) => entry.packageName === checksum.packageName)?.packageRoot;
    const checksumPath = join(repoRoot, packageRoot, checksum.path);
    const artifact = descriptor.artifacts.find((entry) => entry.id === checksum.artifactRef);
    if (!artifact) throw new Error(`Descriptor checksum ${checksum.id} references missing artifact ${checksum.artifactRef}`);
    const artifactPath = join(repoRoot, packageRoot, artifact.path);
    const value = checksum.value ?? (existsSync(artifactPath) ? sha256File(artifactPath) : sha256File(checksumPath));
    return {
      id: checksum.id,
      packageName: checksum.packageName,
      path: checksum.path,
      algorithm: "sha256",
      artifactRef: checksum.artifactRef,
      required: checksum.required,
      packageFile: true,
      value
    };
  });
  return {
    path: descriptorPath,
    packageName: "@the-open-engine/opcore",
    checksumSha256: sha256File(descriptorAbsolutePath),
    descriptor,
    commandGroups,
    resolvedArtifacts,
    resolvedChecksums
  };
}

function collectLicenseEvidence() {
  const args = ["scripts/license-report.mjs", "--json"];
  if (writeDocs) args.push("--write", licenseReportPath);
  const report = runJson(process.execPath, args);
  const markdown = report.markdown ?? "";
  return {
    reportPath: licenseReportPath,
    reportSha256: sha256(markdown),
    productionDependencyCount: report.productionDependencyCount,
    bundledDependencyCount: report.bundledDependencyCount,
    workspacePackageCount: releaseReceiptPackageNames.length,
    unresolvedLicenseCount: report.unresolvedLicenseCount,
    packages: [
      ...report.productionDependencies.map((entry) => ({ ...entry, bundled: false })),
      ...report.bundledRuntimeDependencies.map((entry) => ({ ...entry, bundled: true }))
    ]
  };
}

function collectProvenanceEvidence() {
  const report = runJson(process.execPath, ["scripts/check-provenance.mjs", "--json"]);
  const markdown = report.markdown ?? "";
  if (writeDocs) writeFileSync(join(repoRoot, provenanceReportPath), markdown);
  return {
    reportPath: provenanceReportPath,
    reportSha256: sha256(markdown),
    scannedFileCount: report.scannedFileCount,
    historyCommitCount: report.historyCommitCount,
    findingCount: 0,
    findings: []
  };
}

function collectGraphReleaseReceipt() {
  const receiptAbsolutePath = join(repoRoot, graphReleaseReceiptPath);
  if (!existsSync(receiptAbsolutePath)) {
    throw new Error(`Missing graph release receipt input evidence: ${graphReleaseReceiptPath}. Run npm run graph-release:receipt.`);
  }
  const receipt = validateGraphReleaseReceipt(JSON.parse(readFileSync(receiptAbsolutePath, "utf8")));
  return {
    path: graphReleaseReceiptPath,
    issue: receipt.issue,
    checksumSha256: sha256File(receiptAbsolutePath)
  };
}

function collectReports({ license, provenance, secretHistory, graphReleaseReceipt }) {
  const releaseHygiene = runCommand(process.execPath, ["scripts/check-release-hygiene.mjs"]);
  const reportsById = {
    "package-inspection": {
      id: "package-inspection",
      command: ["node", "scripts/generate-release-receipt.mjs", "--inspect-packages-only"],
      status: "passed",
      exitCode: 0,
      path: releaseReceiptPath,
      summary: "npm pack package inspection passed"
    },
    license: {
      id: "license",
      command: ["node", "scripts/license-report.mjs", "--json"],
      status: "passed",
      exitCode: 0,
      path: license.reportPath,
      checksumSha256: license.reportSha256,
      summary: `${license.productionDependencyCount} production dependencies, ${license.unresolvedLicenseCount} unresolved`
    },
    provenance: {
      id: "provenance",
      command: ["node", "scripts/check-provenance.mjs", "--json"],
      status: "passed",
      exitCode: 0,
      path: provenance.reportPath,
      checksumSha256: provenance.reportSha256,
      summary: `${provenance.scannedFileCount} files, ${provenance.historyCommitCount} commits scanned`
    },
    "release-hygiene": {
      id: "release-hygiene",
      command: ["node", "scripts/check-release-hygiene.mjs"],
      status: "passed",
      exitCode: 0,
      path: artifactAttestationPath,
      checksumSha256: existsSync(join(repoRoot, artifactAttestationPath)) ? sha256File(join(repoRoot, artifactAttestationPath)) : undefined,
      summary: releaseHygiene.stdout.trim() || "release hygiene passed"
    },
    "graph-release": {
      id: "graph-release",
      command: ["node", "scripts/generate-graph-release-receipt.mjs", "--json"],
      status: "passed",
      exitCode: 0,
      path: graphReleaseReceipt.path,
      checksumSha256: graphReleaseReceipt.checksumSha256,
      summary: "graph release receipt #17 validated as input evidence"
    },
    "secret-history": {
      id: "secret-history",
      command: ["node", "scripts/generate-release-receipt.mjs", "--scan-secrets-only"],
      status: "passed",
      exitCode: 0,
      path: secretHistory.allowlistPath,
      checksumSha256: secretHistory.allowlistSha256,
      summary: `${secretHistory.currentTreeScannedFileCount} files, ${secretHistory.gitHistoryScannedCommitCount} commits scanned`
    }
  };
  return releaseReceiptReportIds.map((id) => reportsById[id]);
}

function scanSecrets() {
  const allowlist = readSecretAllowlist();
  const currentFindings = scanCurrentTreeSecrets(allowlist);
  const history = scanGitHistorySecrets(allowlist);
  const findings = [...currentFindings, ...history.findings];
  const unallowlisted = findings.filter((finding) => !finding.allowlisted);
  if (unallowlisted.length > 0) {
    throw new Error(`Secret/history scan found unallowlisted findings:\n${unallowlisted.map(formatSecretFinding).join("\n")}`);
  }
  return {
    allowlistPath: secretAllowlistPath,
    allowlistSha256: sha256File(join(repoRoot, secretAllowlistPath)),
    currentTreeScannedFileCount: currentFindings.scannedFileCount ?? scanCurrentTreeFiles().length,
    gitHistoryScannedCommitCount: history.commitCount,
    findingCount: 0,
    findings: []
  };
}

function scanCurrentTreeSecrets(allowlist) {
  const files = scanCurrentTreeFiles();
  const findings = [];
  for (const path of files) {
    if (!isTextFile(path)) continue;
    const text = readFileSync(join(repoRoot, path), "utf8");
    findings.push(...scanTextForSecrets(text, { scope: "current-tree", path }, allowlist));
  }
  findings.scannedFileCount = files.length;
  return findings;
}

function scanGitHistorySecrets(allowlist) {
  assertFullHistory("Secret history scan");
  const commits = git(["rev-list", "--all"]).trim().split("\n").filter(Boolean);
  const findings = [];
  for (const commit of commits) {
    const grep = spawnSync(
      "git",
      ["grep", "-I", "-n", "-E", secretGrepPattern(), commit, "--", "."],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    if (grep.status !== 0 && grep.status !== 1) failCommand("git", ["grep", "-I", "-n", "-E", secretGrepPattern(), commit, "--", "."], grep);
    for (const line of grep.stdout.split("\n").filter(Boolean)) {
      const parsed = parseGitGrepLine(line, commit);
      if (!parsed || isSecretScanPathSkipped(parsed.path)) continue;
      findings.push(...scanTextForSecrets(parsed.text, parsed, allowlist));
    }
  }
  return { commitCount: commits.length, findings };
}

function scanTextForSecrets(text, location, allowlist) {
  const findings = [];
  for (const detector of secretDetectors()) {
    detector.pattern.lastIndex = 0;
    for (const match of text.matchAll(detector.pattern)) {
      const secret = match[0];
      const fingerprint = secretFingerprint(detector.kind, secret, location);
      const finding = {
        scope: location.scope,
        kind: detector.kind,
        path: location.path,
        commit: location.commit,
        line: location.line,
        fingerprint,
        allowlisted: isSecretFindingAllowlisted(
          {
            scope: location.scope,
            kind: detector.kind,
            path: location.path,
            commit: location.commit,
            line: location.line,
            fingerprint
          },
          allowlist
        )
      };
      findings.push(finding);
    }
  }
  return findings;
}

function secretDetectors() {
  return [
    { kind: "private_key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
    { kind: "aws_access_key_id", pattern: /AKIA[0-9A-Z]{16}/g },
    { kind: "github_token", pattern: /gh[pousr]_[A-Za-z0-9_]{36,}/g },
    { kind: "slack_token", pattern: /xox[baprs]-[A-Za-z0-9-]{20,}/g },
    { kind: "google_api_key", pattern: /AIza[0-9A-Za-z_-]{35}/g },
    { kind: "openai_api_key", pattern: /sk-[A-Za-z0-9_-]{32,}/g },
    {
      kind: "credential_assignment",
      pattern: /\b(?:password|passwd|api[_-]?key|secret|token)\b\s*[:=]\s*["'][^"'\n]{12,}["']/gi
    }
  ];
}

function secretGrepPattern() {
  return String.raw`(-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{36,}|xox[baprs]-[A-Za-z0-9-]{20,}|AIza[0-9A-Za-z_-]{35}|sk-[A-Za-z0-9_-]{32,}|(password|passwd|api[_-]?key|secret|token)[[:space:]]*[:=][[:space:]]*['"][^'"]{12,}['"])`;
}

function scanCurrentTreeFiles() {
  const result = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: repoRoot,
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) failCommand("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], result);
  return result.stdout
    .toString("utf8")
    .split("\0")
    .filter((path) => path && existsSync(join(repoRoot, path)) && !isSecretScanPathSkipped(path));
}

function readSecretAllowlist() {
  if (!existsSync(join(repoRoot, secretAllowlistPath))) {
    throw new Error(`Missing secret scan allowlist: ${secretAllowlistPath}`);
  }
  const allowlist = readJson(secretAllowlistPath);
  if (allowlist.schemaVersion !== 1 || !Array.isArray(allowlist.entries)) {
    throw new Error("Secret scan allowlist must have schemaVersion=1 and entries[]");
  }
  return allowlist.entries.map((entry, index) => normalizeSecretAllowlistEntry(entry, index));
}

function normalizeSecretAllowlistEntry(entry, index) {
  const label = `Secret scan allowlist entry ${index}`;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`${label} must be an object`);
  }
  const normalized = {
    scope: entry.scope ?? (entry.commit ? "git-history" : "current-tree"),
    kind: optionalString(entry.kind, `${label} kind`),
    path: optionalRepoRelativePath(entry.path, `${label} path`),
    commit: optionalString(entry.commit, `${label} commit`),
    fingerprint: optionalSecretFingerprint(entry.fingerprint, `${label} fingerprint`),
    reviewer: requiredString(entry.reviewer, `${label} reviewer`),
    reason: requiredString(entry.reason, `${label} reason`),
    expiresAt: requiredFutureDate(entry.expiresAt, `${label} expiresAt`)
  };
  if (!["current-tree", "git-history"].includes(normalized.scope)) {
    throw new Error(`${label} scope must be current-tree or git-history`);
  }
  if (normalized.scope === "current-tree" && !normalized.path) {
    throw new Error(`${label} current-tree entries must include path`);
  }
  if (normalized.scope === "current-tree" && normalized.commit) {
    throw new Error(`${label} current-tree entries must not include commit`);
  }
  if (normalized.scope === "git-history" && !normalized.commit) {
    throw new Error(`${label} git-history entries must include commit`);
  }
  return normalized;
}

function isSecretFindingAllowlisted(finding, allowlist) {
  return allowlist.some((entry) => {
    if (entry.scope !== finding.scope) return false;
    if (entry.kind && entry.kind !== finding.kind) return false;
    if (entry.fingerprint && entry.fingerprint !== finding.fingerprint) return false;
    if (entry.path && entry.path !== finding.path) return false;
    if (entry.commit && entry.commit !== finding.commit) return false;
    return true;
  });
}

function parseGitGrepLine(line, commit) {
  const withoutCommit = line.startsWith(`${commit}:`) ? line.slice(commit.length + 1) : line;
  const first = withoutCommit.indexOf(":");
  if (first === -1) return undefined;
  const second = withoutCommit.indexOf(":", first + 1);
  if (second === -1) return undefined;
  return {
    scope: "git-history",
    commit,
    path: withoutCommit.slice(0, first),
    line: Number(withoutCommit.slice(first + 1, second)),
    text: withoutCommit.slice(second + 1)
  };
}

function isSecretScanPathSkipped(path) {
  return /(^|\/)(node_modules|dist|target|\.git|\.ace|\.lattice|\.zeroshot)(\/|$)/.test(path) || /\.(png|jpe?g|gif|pdf|tgz|zip|sqlite|db)$/i.test(path);
}

function isTextFile(path) {
  return !/\.(png|jpe?g|gif|pdf|tgz|zip|sqlite|db)$/i.test(path);
}

function formatSecretFinding(finding) {
  return `${finding.scope}:${finding.commit ? `${finding.commit}:` : ""}${finding.path ?? "<unknown>"}:${finding.line ?? 0}:${finding.kind}:${finding.fingerprint}`;
}

function secretFingerprint(kind, secret, location) {
  return `sha256:${sha256(`${kind}\0${secret}\0${location.scope}\0${location.path ?? ""}\0${location.line ?? ""}`)}`;
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function optionalString(value, label) {
  if (value === undefined) return undefined;
  return requiredString(value, label);
}

function optionalRepoRelativePath(value, label) {
  if (value === undefined) return undefined;
  const path = requiredString(value, label);
  if (path.includes("\0") || /^[\\/]/.test(path) || /^[A-Za-z]:[\\/]/.test(path) || path === ".." || path.startsWith("../") || path.includes("/../")) {
    throw new Error(`${label} must be a repo-relative path`);
  }
  return path;
}

function optionalSecretFingerprint(value, label) {
  if (value === undefined) return undefined;
  const fingerprint = requiredString(value, label);
  if (!/^sha256:[a-f0-9]{64}$/i.test(fingerprint)) throw new Error(`${label} must be sha256:<64 hex chars>`);
  return fingerprint;
}

function requiredFutureDate(value, label) {
  const dateText = requiredString(value, label);
  const expiresAt = new Date(dateText);
  if (Number.isNaN(expiresAt.getTime())) throw new Error(`${label} must be an ISO date`);
  if (expiresAt.getTime() <= Date.now()) throw new Error(`${label} must be in the future`);
  return dateText;
}

function writeReleaseDocs(receipt) {
  mkdirSync(join(repoRoot, "docs/release"), { recursive: true });
  const receiptJson = `${JSON.stringify(receipt, null, 2)}\n`;
  writeFileSync(join(repoRoot, releaseReceiptPath), receiptJson);
  writeFileSync(join(repoRoot, releaseSummaryPath), releaseSummaryMarkdown(receipt, sha256(receiptJson)));
  writeArtifactAttestation(receipt);
}

function releaseSummaryMarkdown(receipt, receiptSha256) {
  const packageRows = receipt.packages
    .map((entry) => `| ${entry.packageName} | ${entry.tarball.filename} | ${entry.tarball.sha256} | ${entry.fileCount} |`)
    .join("\n");
  const reportRows = receipt.reports
    .map((entry) => `| ${entry.id} | ${entry.status} | ${entry.checksumSha256 ?? "n/a"} | ${entry.summary} |`)
    .join("\n");
  return `# Release Receipt Summary

Maintainer release receipt for the Lattice alpha package gate.

Machine receipt: ${releaseReceiptPath}
Machine receipt SHA-256: ${receiptSha256}

Canonical command groups: ${receipt.commandGroups.join(", ")}
Native graph artifacts: ${receipt.nativeArtifacts.length}
Secret/history findings: ${receipt.secretHistory.findingCount}
License unresolved count: ${receipt.license.unresolvedLicenseCount}

## Packages

| Package | Tarball | SHA-256 | Files |
|---------|---------|---------|-------|
${packageRows}

## Reports

| Report | Status | SHA-256 | Summary |
|--------|--------|---------|---------|
${reportRows}

Secret allowlist: ${secretAllowlistPath}. Add entries only for reviewed false positives with path or commit scope, reviewer, reason, expiry, and optional fingerprint/kind narrowing.

Publish status: this gate packs and verifies artifacts only. Publishing remains manual.
`;
}

function writeArtifactAttestation(receipt) {
  const nativeRows = receipt.nativeArtifacts
    .map((entry) => `| ${entry.targetPlatform} | ${entry.binaryPath} | ${entry.binarySha256} | ${entry.checksumPath} |`)
    .join("\n");
  const existing = existsSync(join(repoRoot, artifactAttestationPath))
    ? readFileSync(join(repoRoot, artifactAttestationPath), "utf8")
    : "";
  const cutoverBlock = existing.match(/\n## Cutover Gate\n[\s\S]*$/)?.[0].trimEnd() ?? "";
  writeFileSync(
    join(repoRoot, artifactAttestationPath),
    `# Artifact Attestation

This repository keeps release artifact attestations executable for maintainers.

The release receipt gate proves package tarballs, descriptor references, native graph artifacts, license inventory, provenance, and secret/history hygiene.

Machine receipt: ${releaseReceiptPath}
Human summary: ${releaseSummaryPath}
Graph input evidence: ${graphReleaseReceiptPath}

## Native Artifacts

| Platform | Binary | Binary SHA-256 | Checksum File |
|----------|--------|----------------|---------------|
${nativeRows}

No package publishing happens in this gate.
${cutoverBlock ? `${cutoverBlock}\n` : ""}`
  );
}

function readDescriptor() {
  const descriptorAbsolutePath = join(repoRoot, descriptorPath);
  if (!existsSync(descriptorAbsolutePath)) throw new Error(`Missing managed tool descriptor: ${descriptorPath}. Run npm run build first.`);
  return validateManagedToolDescriptor(JSON.parse(readFileSync(descriptorAbsolutePath, "utf8")));
}

function validateNoOldPublicIdentity(packageName, manifest, bins) {
  if (/(?:^|[-/])(crg|cix|rox)(?:$|-)/i.test(String(manifest.name))) {
    throw new Error(`${packageName} exposes forbidden old package identity ${manifest.name}`);
  }
  for (const bin of Object.keys(bins)) {
    if (["crg", "cix", "rox"].includes(bin)) throw new Error(`${packageName} exposes forbidden old public bin ${bin}`);
  }
  if (packageName === "@the-open-engine/opcore") assertSameSet(Object.keys(bins), ["lattice", "opcore"], `${packageName} bins`);
  else if (packageName === "@the-open-engine/opcore-asp-provider") {
    assertSameSet(Object.keys(bins), ["opcore-asp-provider"], `${packageName} bins`);
  }
  else if (Object.keys(bins).length > 0) throw new Error(`${packageName} must not expose public bins`);
}

function assertPackageFile(packages, packageName, path, label) {
  const packageEvidence = packages.find((entry) => entry.packageName === packageName);
  if (!packageEvidence) throw new Error(`${label} references unknown package ${packageName}`);
  if (!packageEvidence.files.includes(path)) throw new Error(`${label} does not resolve to a packaged file: ${packageName}:${path}`);
}

function requiredDescriptorArtifact(descriptor, id) {
  const artifact = descriptor.artifacts.find((entry) => entry.id === id);
  if (!artifact) throw new Error(`Missing descriptor artifact ${id}`);
  return artifact;
}

function requiredDescriptorChecksum(descriptor, id) {
  const checksum = descriptor.checksums.find((entry) => entry.id === id);
  if (!checksum) throw new Error(`Missing descriptor checksum ${id}`);
  return checksum;
}

function assertFullHistory(label) {
  const shallow = spawnSync("git", ["rev-parse", "--is-shallow-repository"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (shallow.status === 0 && shallow.stdout.trim() === "true") {
    throw new Error(`${label} requires full git history; use actions/checkout fetch-depth: 0`);
  }
}

function outputPayload(payload, text) {
  if (jsonOutput) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write(`${text}\n`);
}

function readJson(path) {
  return JSON.parse(readFileSync(join(repoRoot, path), "utf8"));
}

function runJson(command, args, options = {}) {
  const result = runCommand(command, args, options);
  return JSON.parse(result.stdout);
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) failCommand(command, args, result);
  return result;
}

function git(args) {
  return runCommand("git", args).stdout;
}

function assertSameSet(actual, expected, label) {
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  if (JSON.stringify(actualSorted) !== JSON.stringify(expectedSorted)) {
    throw new Error(`${label} mismatch\nexpected:\n${expectedSorted.join("\n")}\nactual:\n${actualSorted.join("\n")}`);
  }
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

function failCommand(command, args, result) {
  throw new Error(
    [
      `Command failed: ${command} ${args.join(" ")}`,
      `status: ${result.status}`,
      `stdout:\n${result.stdout}`,
      `stderr:\n${result.stderr}`
    ].join("\n")
  );
}
