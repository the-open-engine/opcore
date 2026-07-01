import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  commandLatencyTelemetryArtifactPolicy,
  graphCoreNativePackageNamesByTarget,
  validateCommandLatencyRecord,
  validateManagedToolDescriptor
} from "../packages/contracts/dist/index.js";
import { releasePackageDirForName } from "../scripts/release-package-dirs.mjs";

const removedLegacyCommandField = `legacy${"Command"}`;
const onboardingForbiddenOutput = /(^|[\\/"'\s])(?:lattice|crg|cix|rox)(?:$|[\\/"'\s])|\.ace\/runtime|LATTICE_CURRENT_TOOLS_DIR|\/Users\/tom|oldToolReplacementClaimed"?\s*:\s*true/i;
const currentTarget = `${process.platform}-${process.arch}`;
const currentNativePackage = graphCoreNativePackageNamesByTarget[currentTarget];

const packageNames = [
  "@the-open-engine/opcore-contracts",
  "@the-open-engine/opcore",
  "@the-open-engine/opcore-graph",
  currentNativePackage,
  "@the-open-engine/opcore-edit",
  "@the-open-engine/opcore-validation",
  "@the-open-engine/opcore-validation-clone",
  "@the-open-engine/opcore-validation-docs",
  "@the-open-engine/opcore-validation-python",
  "@the-open-engine/opcore-validation-rust",
  "@the-open-engine/opcore-validation-typescript",
  "@the-open-engine/opcore-asp-provider"
].filter(Boolean);

describe("installed package bins", () => {
  it("installs packed packages and exposes only canonical Opcore bins", { timeout: 120000 }, () => {
    assert.ok(currentNativePackage, `unsupported local graph-core target ${currentTarget}`);
    const temp = mkdtempSync(join(tmpdir(), "lattice-installed-bins-"));
    try {
      const tarballs = packageNames.map((packageName) => packWorkspace(packageName, temp));
      const project = join(temp, "project");
      mkdirSync(project);
      run("npm", ["init", "-y"], { cwd: project });
      run("npm", ["install", "--ignore-scripts", ...tarballs], { cwd: project });

      assert.equal(existsSync(binPath(project, "opcore")), true);
      assert.equal(existsSync(binPath(project, "opcore-asp-provider")), true);
      for (const oldBin of ["lattice", "crg", "cix", "rox"]) assert.equal(existsSync(binPath(project, oldBin)), false, oldBin);

      assertAspProviderInitializeSmoke(project);
      assertSmoke(project, ["status", "--json"], 0);
      const opcoreStatus = assertSmoke(project, ["status", "--json"], 0, "opcore");
      assert.deepEqual(opcoreStatus.canonicalCommand, ["opcore", "status"]);
      assert.equal(Object.hasOwn(opcoreStatus, "repoState"), true);
      assert.equal(Object.hasOwn(opcoreStatus, "validationResult"), false);
      const opcoreScan = assertSmoke(project, ["--json"], 0, "opcore");
      assert.deepEqual(opcoreScan.canonicalCommand, ["opcore", "scan"]);
      assert.equal(Object.hasOwn(opcoreScan, "validationResult"), true);
      const opcoreInit = assertSmoke(project, ["init", "--json"], 0, "opcore");
      assert.deepEqual(opcoreInit.canonicalCommand, ["opcore", "init"]);
      assert.equal(opcoreInit.opcoreInit.mode, "plan");
      assert.equal(Object.hasOwn(opcoreInit.opcoreInit, "scan"), true);
      assert.equal(Array.isArray(opcoreInit.opcoreInit.settings.languages), true);
      assert.equal(opcoreInit.opcoreInit.timings.scanMs >= 0, true);
      assert.equal(existsSync(join(project, ".opcore", "config")), false);
      assert.equal(existsSync(join(project, "AGENTS.md")), false);
      const opcoreMeasure = assertSmoke(project, ["measure", "--json"], 0, "opcore");
      assert.deepEqual(opcoreMeasure.canonicalCommand, ["opcore", "measure"]);
      assert.equal(opcoreMeasure.opcoreMeasure.kind, "opcore_measure_delta");
      const opcoreTry = assertSmoke(project, ["try", "--json"], 0, "opcore");
      assert.deepEqual(opcoreTry.canonicalCommand, ["opcore", "try"]);
      assert.equal(opcoreTry.opcoreTry.published, false);
      assert.deepEqual(
        opcoreTry.opcoreTry.scenarios.map((scenario) => scenario.id).sort(),
        ["mixed-repo", "python-package", "rust-crate", "typescript-app", "unsupported-files"]
      );
      rmSync(opcoreTry.opcoreTry.sampleRoot, { recursive: true, force: true });
      const graphStatus = assertSmoke(project, ["graph", "status", "--json"], 0);
      assert.deepEqual(graphStatus.canonicalCommand, ["opcore", "graph", "status"]);
      assert.equal(graphStatus.providerStatus.provider, "opcore-graph");
      assert.equal(graphStatus.providerStatus.state, "stale");
      assertSmoke(project, ["graph", "build", "--json"], 0);
      assert.equal(assertSmoke(project, ["graph", "query", "--json"], 0).providerStatus.state, "available");
      assert.equal(assertSmoke(project, ["graph", "search", "opcore", "--json"], 0).providerStatus.state, "available");
      assert.equal(assertSmoke(project, ["graph", "serve", "--json"], 0).graphServe.state, "ready");
      assertServeTransport(project);
      assertGraphArtifact(project);
      mkdirSync(join(project, "src"), { recursive: true });
      writeFileSync(join(project, "src/a.ts"), "old\n");
      const editPatch = assertSmoke(project, [
        "edit",
        "patch",
        "--request-json",
        JSON.stringify({ patch: patchFor("src/a.ts", "old", "new") }),
        "--json"
      ], 0);
      assert.equal(editPatch.editPlan.changes[0].content, "new\n");
      const editTree = assertSmoke(project, [
        "edit",
        "tree",
        "--request-json",
        JSON.stringify({ files: [{ path: "src/a.ts", content: "tree\n" }] }),
        "--json"
      ], 0);
      assert.equal(editTree.editPlan.changes[0].content, "tree\n");
      const editExact = assertSmoke(project, ["edit", "exact", "--path", "src/a.ts", "--expected", "old", "--replacement", "new", "--json"], 0);
      assert.equal(editExact.editPlan.changes[0].content, "new\n");
      assert.equal(readFileSync(join(project, "src/a.ts"), "utf8"), "old\n");
      assertSmoke(project, ["edit", "multi-edit", "--json"], 64);
      assert.deepEqual(
        assertSmoke(project, ["check", "manifest", "--json"], 0).validationResult.manifest.entries.map((entry) => entry.checkId),
        [
          "typescript.syntax",
          "typescript.types",
          "typescript.lint",
          "typescript.import-graph",
          "typescript.dead-code",
          "typescript.function-metrics",
          "typescript.relevant-tests",
          "typescript.file-length",
          "rust.source-hygiene",
          "rust.fmt",
          "rust.cargo-check",
          "rust.clippy",
          "rust.rustdoc",
          "rust.import-graph",
          "rust.dead-code",
          "rust.graph-signals",
          "rust.unused-deps",
          "rust.file-length",
          "rust.function-metrics",
          "python.syntax",
          "python.source-hygiene",
          "python.types",
          "python.import-graph",
          "python.dead-code",
          "python.relevant-tests",
          "docs.existence",
          "docs.staleness",
          "docs.freshness",
          "docs.length",
          "docs.dry",
          "docs.content-quality",
          "docs.code-blocks",
          "docs.rules-why",
          "docs.hub-coverage",
          "clone.duplication"
        ]
      );
      assert.equal(assertSmoke(project, ["validate", "manifest", "--json"], 0).validationResult.status, "passed");
      assertManagedDescriptor(project);

      for (const packageName of packageNames) {
        const manifestPath = join(project, "node_modules", ...packageName.split("/"), "package.json");
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        if (packageName === "@the-open-engine/opcore") {
          assert.deepEqual(manifest.bin, { opcore: "dist/index.js" });
          assert.equal(
            manifest.exports["./descriptors/opcore.managed-tool.json"],
            "./dist/descriptors/opcore.managed-tool.json"
          );
        } else if (packageName === "@the-open-engine/opcore-asp-provider") {
          assert.deepEqual(manifest.bin, { "opcore-asp-provider": "dist/index.js" });
          assert.equal(
            manifest.exports["./manifests/asp-server.json"],
            "./dist/manifests/asp-server.json"
          );
          assert.equal(
            manifest.exports["./manifests/opcore-asp-provider.provisional.json"],
            "./dist/manifests/opcore-asp-provider.provisional.json"
          );
          const canonicalManifestPath = join(
            project,
            "node_modules",
            "@the-open-engine",
            "opcore-asp-provider",
            "dist",
            "manifests",
            "asp-server.json"
          );
          assert.equal(
            existsSync(
              join(
                project,
                "node_modules",
                "@the-open-engine",
                "opcore-asp-provider",
                "dist",
                "manifests",
                "opcore-asp-provider.provisional.json"
              )
            ),
            true
          );
          assert.equal(existsSync(canonicalManifestPath), true, canonicalManifestPath);
          const canonicalManifest = JSON.parse(readFileSync(canonicalManifestPath, "utf8"));
          const installedIndexPath = join(
            project,
            "node_modules",
            "@the-open-engine",
            "opcore-asp-provider",
            "dist",
            "index.js"
          );
          const installedIndexSha256 = createHash("sha256").update(readFileSync(installedIndexPath)).digest("hex");
          assert.deepEqual(canonicalManifest.entrypoint, { transport: "stdio", bin: "opcore-asp-provider", args: ["--stdio"] });
          assert.equal(canonicalManifest.artifact.fingerprint, `sha256:${installedIndexSha256}`);
          assert.deepEqual(canonicalManifest.artifact.checksums, [{ path: "dist/index.js", sha256: installedIndexSha256 }]);
        } else assert.equal(Object.hasOwn(manifest, "bin"), false, packageName);
        assert.doesNotMatch(JSON.stringify(manifest), /file:\.\.\/|\.\.\/(contracts|cli|graph|edit|validation|fixtures)/);
      }
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("installs packed Opcore alone with the opcore bin", { timeout: 120000 }, () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-installed-bin-"));
    try {
      const tarballs = [
        "@the-open-engine/opcore-contracts",
        "@the-open-engine/opcore-graph",
        "@the-open-engine/opcore-edit",
        "@the-open-engine/opcore-validation",
        "@the-open-engine/opcore-validation-clone",
        "@the-open-engine/opcore-validation-docs",
        "@the-open-engine/opcore-validation-python",
        "@the-open-engine/opcore-validation-rust",
        "@the-open-engine/opcore-validation-typescript",
        "@the-open-engine/opcore-asp-provider",
        "@the-open-engine/opcore"
      ].map((packageName) => packWorkspace(packageName, temp));
      const project = join(temp, "project");
      mkdirSync(project);
      run("npm", ["init", "-y"], { cwd: project });
      run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...tarballs], { cwd: project });

      assert.equal(existsSync(binPath(project, "opcore")), true);
      for (const forbiddenBin of ["lattice", "crg", "cix", "rox"]) {
        assert.equal(existsSync(binPath(project, forbiddenBin)), false, forbiddenBin);
      }
      const status = assertSmoke(project, ["status", "--json"], 0, "opcore");
      assert.deepEqual(status.canonicalCommand, ["opcore", "status"]);
      const tryResult = assertSmoke(project, ["try", "--json"], 0, "opcore");
      assert.equal(tryResult.opcoreTry.published, false);
      rmSync(tryResult.opcoreTry.sampleRoot, { recursive: true, force: true });
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("runs installed Opcore onboarding smoke outside node_modules bin", { timeout: 180000 }, () => {
    assert.ok(currentNativePackage, `unsupported local graph-core target ${currentTarget}`);
    const temp = mkdtempSync(join(tmpdir(), "opcore-installed-onboarding-"));
    try {
      const tarballs = [
        "@the-open-engine/opcore-contracts",
        "@the-open-engine/opcore-graph",
        currentNativePackage,
        "@the-open-engine/opcore-edit",
        "@the-open-engine/opcore-validation",
        "@the-open-engine/opcore-validation-clone",
        "@the-open-engine/opcore-validation-docs",
        "@the-open-engine/opcore-validation-python",
        "@the-open-engine/opcore-validation-rust",
        "@the-open-engine/opcore-validation-typescript",
        "@the-open-engine/opcore-asp-provider",
        "@the-open-engine/opcore"
      ].map((packageName) => packWorkspace(packageName, temp));
      const project = join(temp, "project");
      const globalPrefix = join(temp, "global-prefix");
      mkdirSync(project);
      mkdirSync(globalPrefix);
      run("npm", ["init", "-y"], { cwd: project });
      run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...tarballs], { cwd: project });
      run("npm", ["install", "-g", "--prefix", globalPrefix, "--ignore-scripts", "--no-audit", "--no-fund", ...tarballs], {
        cwd: temp
      });

      const localRealOpcore = realpathSync(binPath(project, "opcore"));
      assert.doesNotMatch(localRealOpcore.replaceAll("\\", "/"), /\/node_modules\/\.bin\//);
      const telemetryPath = join(temp, "latency-artifacts", commandLatencyTelemetryArtifactPolicy.path);
      assert.deepEqual(assertCliJson(localRealOpcore, ["status", "--json"], 0, project).canonicalCommand, ["opcore", "status"]);

      const globalOpcore = globalBinPath(globalPrefix, "opcore");
      assert.equal(existsSync(globalOpcore), true, globalOpcore);
      assert.doesNotMatch(globalOpcore.replaceAll("\\", "/"), /\/node_modules\/\.bin\//);
      assert.deepEqual(assertCliJson(globalOpcore, ["status", "--json"], 0, project).canonicalCommand, ["opcore", "status"]);

      const fixtures = createOnboardingFixtures(join(temp, "fixtures"));
      for (const fixture of fixtures) {
        const status = assertCliJson(globalOpcore, ["status", "--repo", fixture.repoRoot, "--json"], 0, fixture.repoRoot);
        assertFixtureCoverage(status.repoState, fixture);

        const originalGitignore = readOptionalFile(join(fixture.repoRoot, ".gitignore"));
        const sourceSnapshot = snapshotFiles(fixture.repoRoot, fixture.sourceFiles);
        if (fixture.id === "fresh-git") assertHeadUnresolved(fixture.repoRoot);

        const plan = assertCliJson(globalOpcore, ["init", "--repo", fixture.repoRoot, "--json"], 0, fixture.repoRoot, {
          fixture,
          telemetryPath
        });
        assert.deepEqual(plan.canonicalCommand, ["opcore", "init"], fixture.id);
        assert.equal(plan.opcoreInit.mode, "plan", fixture.id);
        assert.equal(plan.opcoreInit.approved, false, fixture.id);
        assertTimingPayload(plan.opcoreInit.timings);
        assert.equal(existsSync(join(fixture.repoRoot, ".opcore", "config")), false, fixture.id);
        assert.equal(existsSync(join(fixture.repoRoot, "AGENTS.md")), false, fixture.id);
        assertFixtureInitHonesty(plan.opcoreInit, fixture);
        assertSourceSnapshot(fixture.repoRoot, sourceSnapshot);

        const scan = assertCliJson(globalOpcore, ["--repo", fixture.repoRoot, "--json"], 0, fixture.repoRoot, {
          env: fixture.scanEnv,
          fixture,
          telemetryPath
        });
        assert.deepEqual(scan.canonicalCommand, ["opcore", "scan"], fixture.id);
        assert.equal(Object.hasOwn(scan, "validationResult"), true, fixture.id);
        assertFixtureCoverage(scan.repoState, fixture);
        assertSourceSnapshot(fixture.repoRoot, sourceSnapshot);

        const apply = assertCliJson(globalOpcore, ["init", "--repo", fixture.repoRoot, "--approve", "--json"], 0, fixture.repoRoot, {
          fixture,
          telemetryPath
        });
        assert.equal(apply.opcoreInit.mode, "apply", fixture.id);
        assert.equal(apply.opcoreInit.approved, true, fixture.id);
        assertTimingPayload(apply.opcoreInit.timings);
        assertFixtureInitHonesty(apply.opcoreInit, fixture);
        assert.equal(opcoreGitignoreLineCount(fixture.repoRoot), 1, fixture.id);
        assert.equal(existsSync(join(fixture.repoRoot, ".opcore", "config")), true, fixture.id);
        assert.equal(existsSync(join(fixture.repoRoot, ".opcore", "init-undo.json")), true, fixture.id);
        assertSourceSnapshot(fixture.repoRoot, sourceSnapshot);

        if (fixture.id === "fresh-git") {
          assertHeadUnresolved(fixture.repoRoot);
          const beforeCheck = snapshotFiles(fixture.repoRoot, fixture.sourceFiles);
          const check = assertCliJson(globalOpcore, ["check", "--changed", "--repo", fixture.repoRoot, "--json"], 0, fixture.repoRoot, {
            fixture,
            telemetryPath
          });
          assert.deepEqual(check.canonicalCommand, [
            "opcore",
            "check",
            "changed",
            "--report-mode",
            "introduced",
            "--base",
            "HEAD",
            "--repo",
            fixture.repoRoot
          ]);
          assert.equal(Object.hasOwn(check, "validationResult"), true);
          assert.equal(check.validationResult.status, "passed");
          assertSourceSnapshot(fixture.repoRoot, beforeCheck);
          assertHeadUnresolved(fixture.repoRoot);
        }

        const undo = assertCliJson(globalOpcore, ["init", "--undo", "--repo", fixture.repoRoot, "--approve", "--json"], 0, fixture.repoRoot, {
          fixture,
          telemetryPath
        });
        assert.equal(undo.opcoreInit.mode, "undo", fixture.id);
        assert.equal(undo.opcoreInit.approved, true, fixture.id);
        assertTimingPayload(undo.opcoreInit.timings);
        assert.equal(readOptionalFile(join(fixture.repoRoot, ".gitignore")), originalGitignore, fixture.id);
        assert.equal(existsSync(join(fixture.repoRoot, "AGENTS.md")), false, fixture.id);
        assert.equal(existsSync(join(fixture.repoRoot, ".opcore", "config")), false, fixture.id);
        assert.equal(existsSync(join(fixture.repoRoot, ".opcore", "init-undo.json")), false, fixture.id);
        assertSourceSnapshot(fixture.repoRoot, sourceSnapshot);
        if (fixture.id === "fresh-git") assertHeadUnresolved(fixture.repoRoot);
      }

      const records = readLatencyRecords(telemetryPath);
      assert.equal(records.length > fixtures.length * 3, true);
      assert.equal(records.length <= commandLatencyTelemetryArtifactPolicy.maxRecords, true);
      assert.equal(readFileSync(telemetryPath).byteLength <= commandLatencyTelemetryArtifactPolicy.maxBytes, true);
      assert.deepEqual(
        [...new Set(records.map((record) => record.canonicalCommand[1]))].sort(),
        ["check", "init", "scan"]
      );
      assert.equal(records.every((record) => validateCommandLatencyRecord(record) === record), true);
      assert.doesNotMatch(readFileSync(telemetryPath, "utf8"), onboardingForbiddenOutput);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});

function packWorkspace(packageName, destination) {
  const result = run("npm", ["pack", "--json", "--pack-destination", destination], {
    cwd: releasePackageDirForName(packageName)
  });
  const parsed = JSON.parse(result.stdout);
  return join(destination, parsed[0].filename);
}

function patchFor(path, before, after) {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1 +1 @@",
    `-${before}`,
    `+${after}`,
    ""
  ].join("\n");
}

function assertGraphArtifact(project) {
  const nativeDir = join(
    project,
    "node_modules",
        ...currentNativePackage.split("/")
      );
  const binary = join(nativeDir, "opcore-graph-core");
  const checksumPath = join(nativeDir, "opcore-graph-core.sha256");
  const metadataPath = join(nativeDir, "metadata.json");
  assert.equal(existsSync(binary), true, binary);
  assert.equal(existsSync(checksumPath), true, checksumPath);
  assert.equal(existsSync(metadataPath), true, metadataPath);
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  assert.equal(metadata.artifactName, "opcore-graph-core");
  assert.equal(metadata.targetPlatform, currentTarget);
  const expected = readFileSync(checksumPath, "utf8").trim().split(/\s+/)[0];
  const actual = createHash("sha256").update(readFileSync(binary)).digest("hex");
  assert.equal(actual, expected);
  assert.equal(metadata.checksumSha256, actual);
}

function assertManagedDescriptor(project) {
  const descriptorPath = join(
    project,
    "node_modules",
    "@the-open-engine",
    "opcore",
    "dist",
    "descriptors",
    "opcore.managed-tool.json"
  );
  assert.equal(existsSync(descriptorPath), true, descriptorPath);
  const descriptorText = readFileSync(descriptorPath, "utf8");
  assert.doesNotMatch(
    descriptorText,
    /(^|[\\/"'\s])\.ace(?:[\\/"'\s]|$)|LATTICE_CURRENT_TOOLS_DIR|\/Users\/tom|(^|[\\/\s])(?:lattice|crg|cix|rox)(?:$|[\\/\s])/i
  );
  const descriptor = validateManagedToolDescriptor(JSON.parse(descriptorText));
  assert.deepEqual(
    descriptor.commandGroups.map((group) => group.name),
    ["graph", "inspect", "edit", "check", "validate", "status", "doctor"]
  );
  assert.equal(existsSync(binPath(project, "opcore")), true);
  const currentNativeDescriptor = descriptor.capabilities.graph.nativeArtifacts.find((entry) => entry.targetPlatform === currentTarget);
  assert.ok(currentNativeDescriptor, `descriptor native target ${currentTarget}`);
  const requiredReferenceIds = new Set([
    "cli-entrypoint",
    "descriptor",
    "contracts-schema",
    currentNativeDescriptor.artifactIds.binaryArtifactId,
    currentNativeDescriptor.artifactIds.metadataArtifactId,
    currentNativeDescriptor.artifactIds.checksumArtifactId,
    currentNativeDescriptor.artifactIds.checksumId
  ]);
  for (const reference of [...descriptor.artifacts, ...descriptor.checksums].filter((entry) => requiredReferenceIds.has(entry.id))) {
    const packageRoot = join(project, "node_modules", ...reference.packageName.split("/"));
    const expectedPath = join(packageRoot, reference.path);
    assert.equal(existsSync(expectedPath), true, `${reference.packageName}:${reference.path}`);
  }
}

function assertSmoke(project, args, expectedExitCode, bin = "opcore") {
  return assertCliJson(binPath(project, bin), args, expectedExitCode, project);
}

function assertCliJson(command, args, expectedExitCode, cwd, options = {}) {
  const startedAt = performance.now();
  const result = run(command, args, { cwd, env: options.env, expectedStatus: expectedExitCode });
  const durationMs = nonNegativeDuration(performance.now() - startedAt);
  assert.doesNotMatch(result.stdout, onboardingForbiddenOutput);
  assert.doesNotMatch(result.stderr, onboardingForbiddenOutput);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.exitCode, expectedExitCode);
  assert.equal(
    parsed.status,
    expectedExitCode === 0 ? "ok" : expectedExitCode === 1 ? "error" : expectedExitCode === 64 ? "unsupported" : "not_implemented"
  );
  assert.equal(Object.hasOwn(parsed, "alias"), false);
  assert.equal(Object.hasOwn(parsed, removedLegacyCommandField), false);
  assert.notEqual(parsed.oldToolReplacementClaimed, true);
  assert.doesNotMatch(JSON.stringify(parsed), onboardingForbiddenOutput);
  if (options.telemetryPath) {
    writeLatencyRecord(options.telemetryPath, createLatencyRecord(command, parsed, options.fixture, cwd, durationMs));
  }
  return parsed;
}

function assertServeTransport(project) {
  const requests = [
    {
      protocol: "opcore.graph.daemon",
      requestId: "installed-ping",
      schemaVersion: 1,
      operation: "ping",
      repo: {
        repoRoot: project
      }
    },
    {
      protocol: "opcore.graph.daemon",
      requestId: "installed-shutdown",
      schemaVersion: 1,
      operation: "shutdown",
      repo: {
        repoRoot: project
      }
    }
  ];
  const result = spawnSync(binPath(project, "opcore"), ["graph", "serve", "--repo", project], {
    cwd: project,
    input: `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"]
  });
  assert.equal(result.stderr, "");
  assert.equal(result.status, 0, result.stdout);
  const responses = result.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  assert.equal(responses.length, 2);
  assert.equal(responses[0].status.state, "available");
  assert.equal(responses[1].status.state, "available");
}

function assertAspProviderInitializeSmoke(project) {
  const request = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "asp/0.1",
      host: { name: "installed-bin-smoke", version: "0.1.0-test" },
      hostCapabilities: { readBlob: true, listTree: true, putBlob: false },
      workspace: {
        root: project,
        baseline: { rev: "tree:installed-smoke", stampedAt: "2026-06-24T00:00:00.000Z" }
      }
    }
  };
  const result = spawnSync(binPath(project, "opcore-asp-provider"), ["--stdio"], {
    cwd: project,
    input: `${JSON.stringify(request)}\n`,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"]
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1, `stdout:\n${result.stdout}`);
  const response = JSON.parse(lines[0]);
  assert.equal(response.jsonrpc, "2.0");
  assert.equal(response.id, 1);
  assert.equal(response.result.serverInfo.name, "opcore");
  assert.deepEqual(response.result.capabilityFamilies, ["check"]);
  assert.deepEqual(response.result.requestedPermissions, { read: ["**/*"], write: false, network: false });
}

function binPath(project, bin) {
  return join(project, "node_modules", ".bin", process.platform === "win32" ? `${bin}.cmd` : bin);
}

function globalBinPath(prefix, bin) {
  return process.platform === "win32" ? join(prefix, `${bin}.cmd`) : join(prefix, "bin", bin);
}

function createOnboardingFixtures(root) {
  return [
    createOnboardingFixture(root, "ts-js", {
      files: {
        "src/index.ts": "export const answer: number = 42;\n",
        "src/util.js": "export function double(value) { return value * 2; }\n"
      },
      coverage: {
        TypeScript: { files: 1, graphSupported: true, validationSupported: true },
        JavaScript: { files: 1, graphSupported: true, validationSupported: true }
      }
    }),
    createOnboardingFixture(root, "rust", {
      files: {
        "Cargo.toml": rustCargoToml("opcore_onboarding_rust"),
        "src/lib.rs": "pub fn answer() -> usize {\n    42\n}\n"
      },
      coverage: {
        Rust: { files: 2, graphSupported: true, graphSupportedFiles: 1, validationSupported: true }
      },
      scanEnv: sourceSafeOpcoreEnv()
    }),
    createOnboardingFixture(root, "mixed", {
      files: {
        "src/index.ts": "export const label: string = 'mixed';\n",
        "Cargo.toml": rustCargoToml("opcore_onboarding_mixed"),
        "src/lib.rs": "pub fn label() -> &'static str {\n    \"mixed\"\n}\n"
      },
      coverage: {
        TypeScript: { files: 1, graphSupported: true, validationSupported: true },
        Rust: { files: 2, graphSupported: true, graphSupportedFiles: 1, validationSupported: true }
      },
      scanEnv: sourceSafeOpcoreEnv()
    }),
    createOnboardingFixture(root, "python-degraded", {
      files: {
        "src/app.py": "def answer() -> int:\n    return 42\n",
        "src/app.pyi": "def answer() -> int: ...\n"
      },
      coverage: {
        Python: { files: 2, graphSupported: true, validationSupported: true }
      }
    }),
    createOnboardingFixture(root, "fresh-git", {
      files: {
        ".gitignore": "dist/\n",
        "src/fresh.ts": "export const fresh: number = 1;\n"
      },
      sourceFiles: ["src/fresh.ts"],
      extraFiles: 1,
      coverage: {
        TypeScript: { files: 1, graphSupported: true, validationSupported: true }
      }
    })
  ];
}

function createOnboardingFixture(root, id, definition) {
  const repoRoot = join(root, id);
  mkdirSync(repoRoot, { recursive: true });
  run("git", ["init", "-q"], { cwd: repoRoot });
  run("git", ["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: repoRoot });
  for (const [path, content] of Object.entries(definition.files)) {
    const absolute = join(repoRoot, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  return {
    id,
    repoRoot,
    extraFiles: definition.extraFiles ?? 0,
    sourceFiles: definition.sourceFiles ?? Object.keys(definition.files).filter((path) => path !== ".gitignore"),
    coverage: definition.coverage,
    scanEnv: definition.scanEnv
  };
}

function rustCargoToml(name) {
  return `[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2021"\n\n[lib]\npath = "src/lib.rs"\n`;
}

function sourceSafeOpcoreEnv() {
  return {
    PATH: [dirname(process.execPath), "/usr/bin", "/bin", "/opt/homebrew/bin"].join(":"),
    NO_COLOR: "1"
  };
}

function assertFixtureCoverage(repoState, fixture) {
  assert.equal(repoState.repo.git.available, true, fixture.id);
  assert.equal(repoState.coverage.totalFiles, expectedFixtureTotalFiles(fixture), `${fixture.id} total files`);
  assert.equal(repoState.coverage.graph.supportedFiles, expectedFixtureFiles(fixture, "graphSupported"), `${fixture.id} graph aggregate`);
  assert.equal(
    repoState.coverage.validation.supportedFiles,
    expectedFixtureFiles(fixture, "validationSupported"),
    `${fixture.id} validation aggregate`
  );
  assert.equal(repoState.coverage.validation.retainedFiles, 0, `${fixture.id} retained aggregate`);
  assert.equal(repoState.coverage.unsupported.totalFiles, 0, `${fixture.id} unsupported aggregate`);
  assert.deepEqual(
    repoState.coverage.languages.map((entry) => entry.language).sort(),
    Object.keys(fixture.coverage).sort(),
    `${fixture.id} language set`
  );
  for (const [language, expected] of Object.entries(fixture.coverage)) {
    const actual = repoState.coverage.languages.find((entry) => entry.language === language);
    assert.ok(actual, `${fixture.id} ${language}`);
    assert.equal(actual.files, expected.files, `${fixture.id} ${language} files`);
    assert.equal(actual.graphSupported, expected.graphSupported, `${fixture.id} ${language} graph`);
    assert.equal(actual.validationSupported, expected.validationSupported, `${fixture.id} ${language} validation`);
  }
}

function assertFixtureInitHonesty(initPayload, fixture) {
  assert.equal(initPayload.scan.totalFiles, expectedFixtureTotalFiles(fixture), `${fixture.id} init total files`);
  assert.equal(initPayload.scan.graphSupportedFiles, expectedFixtureFiles(fixture, "graphSupported"), `${fixture.id} init graph aggregate`);
  assert.equal(
    initPayload.scan.validationSupportedFiles,
    expectedFixtureFiles(fixture, "validationSupported"),
    `${fixture.id} init validation aggregate`
  );
  assert.equal(initPayload.scan.validationRetainedFiles, 0, `${fixture.id} init retained aggregate`);
  assert.deepEqual(
    initPayload.settings.languages.map((entry) => entry.language).sort(),
    Object.keys(fixture.coverage).sort(),
    `${fixture.id} init language set`
  );
  for (const [language, expected] of Object.entries(fixture.coverage)) {
    const setting = initPayload.settings.languages.find((entry) => entry.language === language);
    assert.ok(setting, `${fixture.id} init ${language}`);
    assert.equal(setting.files, expected.files, `${fixture.id} init ${language} files`);
    assert.equal(setting.graph, expected.graphSupported ? "supported" : "unsupported", `${fixture.id} init ${language} graph`);
    assert.equal(
      setting.validation === "supported" || setting.validation === "degraded" || setting.validation === "retained",
      expected.validationSupported,
      `${fixture.id} init ${language} validation`
    );
  }
  if (fixture.id === "python-degraded") {
    const python = initPayload.settings.languages.find((entry) => entry.language === "Python");
    assert.equal(python.validation, "degraded");
    assert.equal(python.state, "degraded");
    assert.equal(initPayload.scan.diagnosticCount, 2);
  }
}

function expectedFixtureTotalFiles(fixture) {
  return fixture.extraFiles + Object.values(fixture.coverage).reduce((sum, entry) => sum + entry.files, 0);
}

function expectedFixtureFiles(fixture, key) {
  return Object.values(fixture.coverage)
    .reduce((sum, entry) => sum + expectedCoverageFiles(entry, key), 0);
}

function expectedCoverageFiles(entry, key) {
  const countKey = `${key}Files`;
  if (Number.isInteger(entry[countKey])) return entry[countKey];
  return entry[key] ? entry.files : 0;
}

function snapshotFiles(repoRoot, paths) {
  return new Map(paths.map((path) => [path, createHash("sha256").update(readFileSync(join(repoRoot, path))).digest("hex")]));
}

function assertSourceSnapshot(repoRoot, snapshot) {
  for (const [path, expected] of snapshot) {
    assert.equal(createHash("sha256").update(readFileSync(join(repoRoot, path))).digest("hex"), expected, path);
  }
}

function assertTimingPayload(timings) {
  for (const field of ["scanMs", "planMs", "promptMs", "applyMs", "totalMs", "firstOutputMs"]) {
    assert.equal(Number.isFinite(timings[field]), true, field);
    assert.equal(timings[field] >= 0, true, field);
  }
  assert.equal(timings.firstOutputMs, timings.scanMs);
  assert.equal(timings.totalMs >= timings.firstOutputMs, true);
}

function createLatencyRecord(command, parsed, fixture, cwd, durationMs) {
  return validateCommandLatencyRecord({
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    bin: "opcore",
    canonicalCommand: latencyCanonicalCommand(parsed.canonicalCommand),
    owner: parsed.owner,
    status: parsed.status,
    exitCode: parsed.exitCode,
    repo: latencyRepoShape(parsed, fixture, cwd),
    timing: {
      durationMs,
      phases: latencyPhases(parsed, durationMs),
      processState: "cold"
    },
    opcoreVersion: opcoreVersionForBin(command)
  });
}

function writeLatencyRecord(path, record) {
  const existing = existsSync(path)
    ? readLatencyRecords(path)
    : [];
  const records = [...existing, validateCommandLatencyRecord(record)].slice(-commandLatencyTelemetryArtifactPolicy.maxRecords);
  let lines = records.map((entry) => JSON.stringify(entry));
  while (Buffer.byteLength(`${lines.join("\n")}\n`) > commandLatencyTelemetryArtifactPolicy.maxBytes && lines.length > 0) {
    lines = lines.slice(1);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.length === 0 ? "" : `${lines.join("\n")}\n`);
}

function readLatencyRecords(path) {
  return readFileSync(path, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function latencyCanonicalCommand(canonicalCommand) {
  const safe = [];
  for (let index = 0; index < canonicalCommand.length; index += 1) {
    const token = canonicalCommand[index];
    if (token === "--repo") {
      index += 1;
      continue;
    }
    if (!token.includes("/") && !token.includes("\\")) safe.push(token);
  }
  return safe;
}

function latencyRepoShape(parsed, fixture, cwd) {
  const coverage = parsed.repoState?.coverage;
  const git = parsed.repoState?.repo?.git;
  if (coverage) {
    return {
      totalFiles: coverage.totalFiles,
      languages: coverage.languages.map((entry) => ({ language: entry.language, files: entry.files })),
      graph: {
        supportedFiles: coverage.graph.supportedFiles,
        unsupportedFiles: Math.max(0, coverage.totalFiles - coverage.graph.supportedFiles)
      },
      git: {
        available: git?.available === true,
        ...(typeof git?.clean === "boolean" ? { clean: git.clean } : {})
      }
    };
  }
  const scan = parsed.opcoreInit?.scan;
  if (scan) {
    return {
      totalFiles: scan.totalFiles,
      languages: scan.languages.map((entry) => ({ language: entry.language, files: entry.files })),
      graph: {
        supportedFiles: scan.graphSupportedFiles,
        unsupportedFiles: Math.max(0, scan.totalFiles - scan.graphSupportedFiles)
      },
      git: gitShape(cwd)
    };
  }
  if (fixture) return fixtureRepoShape(fixture);
  return {
    totalFiles: 0,
    languages: [],
    graph: { supportedFiles: 0, unsupportedFiles: 0 },
    git: gitShape(cwd)
  };
}

function fixtureRepoShape(fixture) {
  const languages = Object.entries(fixture.coverage).map(([language, expected]) => ({
    language,
    files: expected.files
  }));
  const totalFiles = languages.reduce((sum, entry) => sum + entry.files, 0);
  const graphSupportedFiles = expectedFixtureFiles(fixture, "graphSupported");
  return {
    totalFiles,
    languages,
    graph: {
      supportedFiles: graphSupportedFiles,
      unsupportedFiles: Math.max(0, totalFiles - graphSupportedFiles)
    },
    git: gitShape(fixture.repoRoot)
  };
}

function latencyPhases(parsed, durationMs) {
  const phases = [{ phase: "total", durationMs }];
  const firstOutputMs = parsed.opcoreInit?.timings?.firstOutputMs;
  if (typeof firstOutputMs === "number") phases.unshift({ phase: "first_output", durationMs: nonNegativeDuration(firstOutputMs) });
  return phases;
}

function gitShape(repoRoot) {
  const available = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (available.status !== 0) return { available: false };
  const status = spawnSync("git", ["status", "--porcelain"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  return { available: true, clean: status.status === 0 && status.stdout.trim() === "" };
}

function opcoreVersionForBin(command) {
  let current = dirname(realpathSync(command));
  while (current !== dirname(current)) {
    const manifestPath = join(current, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (manifest.name === "@the-open-engine/opcore" && typeof manifest.version === "string") return manifest.version;
    }
    current = dirname(current);
  }
  return "0.1.0";
}

function opcoreGitignoreLineCount(repoRoot) {
  return readFileSync(join(repoRoot, ".gitignore"), "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() === ".opcore/")
    .length;
}

function readOptionalFile(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function assertHeadUnresolved(repoRoot) {
  const result = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  assert.notEqual(result.status, 0, `HEAD unexpectedly resolved:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

function nonNegativeDuration(value) {
  return Math.max(0, Math.round(value * 1000) / 1000);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env,
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
