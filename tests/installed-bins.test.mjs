import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import {
  commandLatencyTelemetryArtifactPolicy,
  graphCoreNativePackageNamesByTarget,
  validateCommandLatencyRecord,
  validateManagedToolDescriptor
} from "../packages/contracts/dist/index.js";
import { releasePackageDirForName } from "../scripts/release-package-dirs.mjs";

const removedLegacyCommandField = `legacy${"Command"}`;
const currentTarget = `${process.platform}-${process.arch}`;
const currentNativePackage = graphCoreNativePackageNamesByTarget[currentTarget];

const packageNames = [
  "@the-open-engine/opcore-contracts",
  "@the-open-engine/opcore",
  "@the-open-engine/opcore-graph",
  currentNativePackage,
  "@the-open-engine/opcore-edit",
  "@the-open-engine/opcore-validation",
  "@the-open-engine/opcore-validation-rust",
  "@the-open-engine/opcore-validation-typescript",
  "@the-open-engine/opcore-asp-provider"
].filter(Boolean);
const opcoreOnlyPackageNames = [
  "@the-open-engine/opcore-contracts",
  "@the-open-engine/opcore-graph",
  "@the-open-engine/opcore-edit",
  "@the-open-engine/opcore-validation",
  "@the-open-engine/opcore-validation-rust",
  "@the-open-engine/opcore-validation-typescript",
  "@the-open-engine/opcore"
];
const onboardingForbiddenMarkers = /\b(?:crg|cix|rox)\b|\.ace\/runtime|LATTICE_CURRENT_TOOLS_DIR|\/Users\/tom|oldToolReplacementClaimed"?\s*:\s*true/i;
const skippedOnboardingSnapshotNames = new Set([".git", ".opcore", "node_modules"]);
const graphSupportedOnboardingExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".pyi"]);
const onboardingLanguageByExtension = new Map([
  [".ts", "TypeScript"],
  [".tsx", "TypeScript"],
  [".js", "JavaScript"],
  [".jsx", "JavaScript"],
  [".py", "Python"],
  [".pyi", "Python"],
  [".rs", "Rust"]
]);
let packedTarballsByPackageName;

describe("installed package bins", () => {
  let suiteTemp;
  let fullProject;
  let opcoreOnlyProject;
  let globalPrefix;
  let localRealBin;
  let globalBin;

  before(() => {
    assert.ok(currentNativePackage, `unsupported local graph-core target ${currentTarget}`);
    suiteTemp = mkdtempSync(join(tmpdir(), "lattice-installed-bins-"));
    packedTarballsByPackageName = new Map(packageNames.map((packageName) => [packageName, packWorkspace(packageName, suiteTemp)]));
    fullProject = installProject(join(suiteTemp, "project"), tarballsFor(packageNames));
    globalPrefix = installGlobalPrefix(join(suiteTemp, "global-prefix"), tarballsFor(packageNames), fullProject);
    opcoreOnlyProject = installProject(join(suiteTemp, "opcore-only-project"), tarballsFor(opcoreOnlyPackageNames));
    localRealBin = realpathSync(binPath(fullProject, "opcore"));
    globalBin = join(globalPrefix, "bin", "opcore");
  }, { timeout: 180000 });

  after(() => {
    if (suiteTemp) rmSync(suiteTemp, { recursive: true, force: true });
  });

  it("installs packed packages and exposes only canonical lattice bins", { timeout: 120000 }, () => {
      const project = fullProject;

      assert.equal(existsSync(binPath(project, "lattice")), true);
      assert.equal(existsSync(binPath(project, "opcore")), true);
      assert.equal(existsSync(binPath(project, "opcore-asp-provider")), true);
      for (const oldBin of ["crg", "cix", "rox"]) assert.equal(existsSync(binPath(project, oldBin)), false, oldBin);

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
        ["mixed-repo", "rust-crate", "typescript-app", "unsupported-files"]
      );
      rmSync(opcoreTry.opcoreTry.sampleRoot, { recursive: true, force: true });
      const graphStatus = assertSmoke(project, ["graph", "status", "--json"], 0);
      assert.deepEqual(graphStatus.canonicalCommand, ["lattice", "graph", "status"]);
      assert.equal(graphStatus.providerStatus.provider, "lattice-graph");
      assert.equal(graphStatus.providerStatus.state, "stale");
      assertSmoke(project, ["graph", "build", "--json"], 0);
      assert.equal(assertSmoke(project, ["graph", "query", "--json"], 0).providerStatus.state, "available");
      assert.equal(assertSmoke(project, ["graph", "search", "lattice", "--json"], 0).providerStatus.state, "available");
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
          "typescript.import-graph",
          "typescript.dead-code",
          "typescript.relevant-tests",
          "rust.source-hygiene",
          "rust.fmt",
          "rust.cargo-check",
          "rust.clippy",
          "rust.rustdoc",
          "rust.import-graph",
          "rust.dead-code",
          "rust.unused-deps",
          "rust.file-length",
          "rust.function-metrics"
        ]
      );
      assert.equal(assertSmoke(project, ["validate", "manifest", "--json"], 0).validationResult.status, "passed");
      assertManagedDescriptor(project);

      for (const packageName of packageNames) {
        const manifestPath = join(project, "node_modules", ...packageName.split("/"), "package.json");
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        if (packageName === "@the-open-engine/opcore") {
          assert.deepEqual(manifest.bin, { opcore: "dist/index.js", lattice: "dist/lattice/index.js" });
          assert.equal(
            manifest.exports["./descriptors/lattice.managed-tool.json"],
            "./dist/descriptors/lattice.managed-tool.json"
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
  });

  it("installs packed Opcore alone with the opcore and lattice bins", { timeout: 30000 }, () => {
      const project = opcoreOnlyProject;

      assert.equal(existsSync(binPath(project, "opcore")), true);
      assert.equal(existsSync(binPath(project, "lattice")), true);
      for (const forbiddenBin of ["crg", "cix", "rox"]) {
        assert.equal(existsSync(binPath(project, forbiddenBin)), false, forbiddenBin);
      }
      const status = assertSmoke(project, ["status", "--json"], 0, "opcore");
      assert.deepEqual(status.canonicalCommand, ["opcore", "status"]);
  });

  it("runs installed Opcore onboarding outside .bin across fixture stacks", { timeout: 120000 }, () => {
      assert.equal(pathSegments(localRealBin).includes(".bin"), false);
      assert.equal(existsSync(globalBin), true, globalBin);
      const localHelp = runInstalledOpcore(localRealBin, ["--help"], fullProject, 0);
      const globalHelp = runInstalledOpcore(globalBin, ["--help"], fullProject, 0);
      assert.match(localHelp.stdout, /^Opcore\b/);
      assert.match(globalHelp.stdout, /^Opcore\b/);
      assertNoForbiddenOpcoreOutput(localHelp, "local help");
      assertNoForbiddenOpcoreOutput(globalHelp, "global help");

      const latencyPath = join(suiteTemp, "onboarding-latency.jsonl");
      const fixtureRoot = join(suiteTemp, "onboarding-fixtures");
      rmSync(latencyPath, { force: true });
      rmSync(fixtureRoot, { recursive: true, force: true });
      for (const kind of ["ts-js", "rust", "mixed", "python", "fresh-git"]) {
        const fixture = createOnboardingFixtureRepo(join(fixtureRoot, kind), kind);
        const initialHashes = snapshotSourceHashes(fixture.repoRoot);
        const initialGitignore = readOptionalFile(join(fixture.repoRoot, ".gitignore"));

        if (kind === "fresh-git") assertHeadUnresolved(fixture.repoRoot);
        const plan = runInstalledOpcore(localRealBin, ["init", "--repo", fixture.repoRoot, "--json"], fixture.repoRoot, 0);
        writeLatencyRecord(latencyPath, plan.latencyRecord);
        assert.deepEqual(plan.parsed.canonicalCommand, ["opcore", "init"], kind);
        assert.equal(plan.parsed.opcoreInit.mode, "plan", kind);
        assert.equal(plan.parsed.opcoreInit.approved, false, kind);
        assert.equal(existsSync(join(fixture.repoRoot, ".opcore", "config")), false, kind);
        assert.equal(existsSync(join(fixture.repoRoot, "AGENTS.md")), false, kind);
        assert.deepEqual(snapshotSourceHashes(fixture.repoRoot), initialHashes, `${kind} plan source hashes`);
        assertNoForbiddenOpcoreOutput(plan, `${kind} plan`);

        const apply = runInstalledOpcore(localRealBin, ["init", "--repo", fixture.repoRoot, "--approve", "--json"], fixture.repoRoot, 0);
        writeLatencyRecord(latencyPath, apply.latencyRecord);
        assert.deepEqual(apply.parsed.canonicalCommand, ["opcore", "init"], kind);
        assert.equal(apply.parsed.opcoreInit.mode, "apply", kind);
        assert.equal(apply.parsed.opcoreInit.approved, true, kind);
        assert.equal(apply.parsed.opcoreInit.undoAvailable, true, kind);
        assert.equal(apply.parsed.opcoreInit.timings.totalMs >= 0, true, kind);
        assert.equal(apply.parsed.opcoreInit.timings.firstOutputMs >= 0, true, kind);
        assert.equal(existsSync(join(fixture.repoRoot, ".opcore", "config")), true, kind);
        assert.equal(existsSync(join(fixture.repoRoot, "AGENTS.md")), true, kind);
        assert.equal(opcoreGitignoreLineCount(fixture.repoRoot), 1, kind);
        assertStackHonesty(kind, apply.parsed.opcoreInit);
        assert.deepEqual(snapshotSourceHashes(fixture.repoRoot), initialHashes, `${kind} init source hashes`);
        assertNoForbiddenOpcoreOutput(apply, `${kind} apply`);

        const scan = runInstalledOpcore(localRealBin, ["--repo", fixture.repoRoot, "--json"], fixture.repoRoot, 0);
        writeLatencyRecord(latencyPath, scan.latencyRecord);
        assert.deepEqual(scan.parsed.canonicalCommand, ["opcore", "scan"], kind);
        assert.equal(Object.hasOwn(scan.parsed, "validationResult"), true, kind);
        assert.deepEqual(snapshotSourceHashes(fixture.repoRoot), initialHashes, `${kind} scan source hashes`);
        assertNoForbiddenOpcoreOutput(scan, `${kind} scan`);

        if (kind === "fresh-git") {
          assertHeadUnresolved(fixture.repoRoot);
          const check = runInstalledOpcore(
            localRealBin,
            ["check", "--changed", "--checks", "typescript.syntax", "--json"],
            fixture.repoRoot,
            0
          );
          writeLatencyRecord(latencyPath, check.latencyRecord);
          assert.deepEqual(check.parsed.canonicalCommand, [
            "opcore",
            "check",
            "changed",
            "--base",
            "HEAD",
            "--checks",
            "typescript.syntax"
          ]);
          assert.equal(check.parsed.validationResult.status, "passed");
          assert.deepEqual(snapshotSourceHashes(fixture.repoRoot), initialHashes, "fresh-git check source hashes");
          assertNoForbiddenOpcoreOutput(check, `${kind} check`);
          assertHeadUnresolved(fixture.repoRoot);
        }

        const undo = runInstalledOpcore(localRealBin, ["init", "--repo", fixture.repoRoot, "--undo", "--approve", "--json"], fixture.repoRoot, 0);
        writeLatencyRecord(latencyPath, undo.latencyRecord);
        assert.equal(undo.parsed.opcoreInit.mode, "undo", kind);
        assert.equal(undo.parsed.opcoreInit.approved, true, kind);
        assert.equal(existsSync(join(fixture.repoRoot, ".opcore", "config")), false, kind);
        assert.equal(existsSync(join(fixture.repoRoot, "AGENTS.md")), false, kind);
        assert.equal(readOptionalFile(join(fixture.repoRoot, ".gitignore")), initialGitignore, kind);
        assert.deepEqual(snapshotSourceHashes(fixture.repoRoot), initialHashes, `${kind} undo source hashes`);
        assertNoForbiddenOpcoreOutput(undo, `${kind} undo`);
        if (kind === "fresh-git") assertHeadUnresolved(fixture.repoRoot);
      }

      const records = readLatencyRecords(latencyPath);
      assert.equal(records.length <= commandLatencyTelemetryArtifactPolicy.maxRecords, true);
      assert.equal(readFileSync(latencyPath).byteLength <= commandLatencyTelemetryArtifactPolicy.maxBytes, true);
      assert.equal(records.every((record) => record.bin === "opcore"), true);
      assert.equal(records.every((record) => validateCommandLatencyRecord(record) === record), true);
      assert.deepEqual(
        [...new Set(records.map((record) => record.canonicalCommand[1]))].sort(),
        ["check", "init", "scan"]
      );
      assert.doesNotMatch(readFileSync(latencyPath, "utf8"), /\/Users\/tom|\.ace\/runtime|LATTICE_CURRENT_TOOLS_DIR|src\/|Cargo\.toml|scripts\/app\.py/);
  });
});

function packWorkspace(packageName, destination) {
  const result = run("npm", ["pack", "--json", "--pack-destination", destination], {
    cwd: releasePackageDirForName(packageName)
  });
  const parsed = JSON.parse(result.stdout);
  return join(destination, parsed[0].filename);
}

function tarballsFor(names) {
  return names.map((packageName) => {
    const tarball = packedTarballsByPackageName.get(packageName);
    assert.ok(tarball, `missing packed tarball for ${packageName}`);
    return tarball;
  });
}

function installProject(project, tarballs) {
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "package.json"), `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`);
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...tarballs], { cwd: project });
  return project;
}

function installGlobalPrefix(prefix, tarballs, cwd) {
  mkdirSync(prefix, { recursive: true });
  run("npm", ["install", "-g", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", ...tarballs], { cwd });
  return prefix;
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
  const binary = join(nativeDir, "lattice-graph-core");
  const checksumPath = join(nativeDir, "lattice-graph-core.sha256");
  const metadataPath = join(nativeDir, "metadata.json");
  assert.equal(existsSync(binary), true, binary);
  assert.equal(existsSync(checksumPath), true, checksumPath);
  assert.equal(existsSync(metadataPath), true, metadataPath);
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  assert.equal(metadata.artifactName, "lattice-graph-core");
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
    "lattice.managed-tool.json"
  );
  assert.equal(existsSync(descriptorPath), true, descriptorPath);
  const descriptorText = readFileSync(descriptorPath, "utf8");
  assert.doesNotMatch(
    descriptorText,
    /(^|[\\/"'\s])\.ace(?:[\\/"'\s]|$)|LATTICE_CURRENT_TOOLS_DIR|\/Users\/tom|(^|[\\/\s])(?:crg|cix|rox)(?:$|[\\/\s])/i
  );
  const descriptor = validateManagedToolDescriptor(JSON.parse(descriptorText));
  assert.deepEqual(
    descriptor.commandGroups.map((group) => group.name),
    ["graph", "inspect", "edit", "check", "validate", "status", "doctor"]
  );
  assert.equal(existsSync(binPath(project, "lattice")), true);
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

function assertSmoke(project, args, expectedExitCode, bin = "lattice") {
  const result = run(binPath(project, bin), args, { cwd: project, expectedStatus: expectedExitCode });
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.exitCode, expectedExitCode);
  assert.equal(
    parsed.status,
    expectedExitCode === 0 ? "ok" : expectedExitCode === 1 ? "error" : expectedExitCode === 64 ? "unsupported" : "not_implemented"
  );
  assert.equal(Object.hasOwn(parsed, "alias"), false);
  assert.equal(Object.hasOwn(parsed, removedLegacyCommandField), false);
  return parsed;
}

function assertServeTransport(project) {
  const requests = [
    {
      protocol: "lattice.graph.daemon",
      requestId: "installed-ping",
      schemaVersion: 1,
      operation: "ping",
      repo: {
        repoRoot: project
      }
    },
    {
      protocol: "lattice.graph.daemon",
      requestId: "installed-shutdown",
      schemaVersion: 1,
      operation: "shutdown",
      repo: {
        repoRoot: project
      }
    }
  ];
  const result = spawnSync(binPath(project, "lattice"), ["graph", "serve", "--repo", project], {
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

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
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

function runInstalledOpcore(execPath, args, cwd, expectedExit) {
  const startedAt = performance.now();
  const result = spawnSync(execPath, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, npm_config_loglevel: "silent" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const durationMs = nonNegativeDuration(performance.now() - startedAt);
  const status = result.status ?? 1;
  if (status !== expectedExit) {
    throw new Error(
      [
        `Command failed: ${execPath} ${args.join(" ")}`,
        `cwd: ${cwd}`,
        `status: ${status}`,
        `expectedStatus: ${expectedExit}`,
        result.error ? `error: ${result.error.stack ?? result.error.message}` : "",
        `stdout:\n${result.stdout}`,
        `stderr:\n${result.stderr}`
      ].filter(Boolean).join("\n")
    );
  }
  const parsed = parseOpcoreStdout(result.stdout, args);
  const repoPath = repoPathFromArgs(args, cwd);
  return {
    status,
    stdout: result.stdout,
    stderr: result.stderr,
    parsed,
    durationMs,
    latencyRecord: createLatencyRecord({ execPath, args, cwd: repoPath, status, parsed, durationMs })
  };
}

function assertNoForbiddenOpcoreOutput(result, label) {
  assert.doesNotMatch(result.stdout, onboardingForbiddenMarkers, `${label} stdout`);
  assert.doesNotMatch(result.stderr, onboardingForbiddenMarkers, `${label} stderr`);
}

function writeLatencyRecord(path, record) {
  validateCommandLatencyRecord(record);
  const existing = existsSync(path)
    ? readFileSync(path, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
    : [];
  const records = [...existing, record].slice(-commandLatencyTelemetryArtifactPolicy.maxRecords);
  let lines = records.map((entry) => JSON.stringify(validateCommandLatencyRecord(entry)));
  while (Buffer.byteLength(`${lines.join("\n")}\n`) > commandLatencyTelemetryArtifactPolicy.maxBytes && lines.length > 0) {
    lines = lines.slice(1);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.length === 0 ? "" : `${lines.join("\n")}\n`);
}

function createOnboardingFixtureRepo(root, kind) {
  mkdirSync(root, { recursive: true });
  run("git", ["init", "-q"], { cwd: root });
  if (kind === "ts-js") {
    writeFixtureFile(root, ".gitignore", "node_modules/\n");
    writeFixtureFile(root, "tsconfig.json", `${JSON.stringify(tsconfig({ allowJs: true }), null, 2)}\n`);
    writeFixtureFile(root, "src/util.js", "export function double(input) {\n  return input * 2;\n}\n");
    writeFixtureFile(root, "src/index.ts", "import { double } from \"./util.js\";\n\nexport const value: number = double(2);\n");
  } else if (kind === "rust") {
    writeFixtureFile(root, "Cargo.toml", rustCargoToml("opcore_onboarding_rust"));
    writeFixtureFile(root, "src/lib.rs", "pub fn value() -> i32 {\n    1\n}\n");
  } else if (kind === "mixed") {
    writeFixtureFile(root, "tsconfig.json", `${JSON.stringify(tsconfig(), null, 2)}\n`);
    writeFixtureFile(root, "src/index.ts", "export const value: number = 1;\n");
    writeFixtureFile(root, "Cargo.toml", rustCargoToml("opcore_onboarding_mixed"));
    writeFixtureFile(root, "src/lib.rs", "pub fn value() -> i32 {\n    1\n}\n");
  } else if (kind === "python") {
    writeFixtureFile(root, "scripts/app.py", "def main():\n    return 1\n");
  } else if (kind === "fresh-git") {
    writeFixtureFile(root, "tsconfig.json", `${JSON.stringify(tsconfig(), null, 2)}\n`);
    writeFixtureFile(root, "src/index.ts", "export const value: number = 1;\n");
  } else {
    throw new Error(`Unknown fixture kind: ${kind}`);
  }
  return { kind, repoRoot: root };
}

function snapshotSourceHashes(root) {
  const files = collectOnboardingFiles(root).filter((path) => {
    const repoRelative = relative(root, path).split(sep).join("/");
    return repoRelative !== "AGENTS.md" && repoRelative !== ".gitignore";
  });
  return Object.fromEntries(
    files.map((path) => {
      const content = readFileSync(path);
      return [relative(root, path).split(sep).join("/"), createHash("sha256").update(content).digest("hex")];
    }).sort(([left], [right]) => left.localeCompare(right))
  );
}

function createLatencyRecord({ execPath, args, cwd, status, parsed, durationMs }) {
  const firstOutputMs = parsed?.opcoreInit?.timings?.firstOutputMs ?? durationMs;
  return validateCommandLatencyRecord({
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    bin: "opcore",
    canonicalCommand: parsed?.canonicalCommand ?? canonicalCommandForArgs(args),
    owner: parsed?.owner ?? "runtime",
    status: parsed?.status ?? (status === 0 ? "ok" : "error"),
    exitCode: status,
    repo: repoShapeFingerprint(cwd, parsed),
    timing: {
      durationMs,
      phases: [
        { phase: "first_output", durationMs: nonNegativeDuration(firstOutputMs) },
        { phase: "total", durationMs }
      ],
      processState: "cold"
    },
    opcoreVersion: opcoreVersionForBin(execPath)
  });
}

function repoShapeFingerprint(repoPath, parsed) {
  const coverage = parsed?.repoState?.coverage;
  const git = parsed?.repoState?.repo?.git;
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
  const initScan = parsed?.opcoreInit?.scan;
  if (initScan) {
    return {
      totalFiles: initScan.totalFiles,
      languages: initScan.languages.map((entry) => ({ language: entry.language, files: entry.files })),
      graph: {
        supportedFiles: initScan.graphSupportedFiles,
        unsupportedFiles: Math.max(0, initScan.totalFiles - initScan.graphSupportedFiles)
      },
      git: gitShape(repoPath)
    };
  }
  return filesystemRepoShape(repoPath);
}

function filesystemRepoShape(repoPath) {
  const languageCounts = new Map();
  let graphSupportedFiles = 0;
  for (const file of collectOnboardingFiles(repoPath)) {
    const basename = file.split(sep).at(-1);
    const extension = basename === "Cargo.toml" || basename === "Cargo.lock" ? ".rs" : extname(file);
    const language = onboardingLanguageByExtension.get(extension);
    if (!language) continue;
    languageCounts.set(language, (languageCounts.get(language) ?? 0) + 1);
    if (graphSupportedOnboardingExtensions.has(extension)) graphSupportedFiles += 1;
  }
  const totalFiles = [...languageCounts.values()].reduce((sum, count) => sum + count, 0);
  return {
    totalFiles,
    languages: [...languageCounts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([language, files]) => ({ language, files })),
    graph: {
      supportedFiles: graphSupportedFiles,
      unsupportedFiles: Math.max(0, totalFiles - graphSupportedFiles)
    },
    git: gitShape(repoPath)
  };
}

function gitShape(repoPath) {
  const inside = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: repoPath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (inside.status !== 0) return { available: false };
  const status = spawnSync("git", ["status", "--porcelain"], {
    cwd: repoPath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  return { available: true, clean: status.status === 0 && status.stdout.trim() === "" };
}

function parseOpcoreStdout(stdout, args) {
  const trimmed = stdout.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  if (args.includes("--json")) throw new Error(`Expected JSON stdout for opcore ${args.join(" ")}:\n${stdout}`);
  return undefined;
}

function canonicalCommandForArgs(args) {
  if (args.length === 0 || args[0]?.startsWith("--")) return ["opcore", "scan"];
  if (args[0] === "--help" || args[0] === "-h" || args[0] === "help") return ["opcore", "help"];
  return ["opcore", args[0].replace(/^-+/, "") || "scan"];
}

function repoPathFromArgs(args, cwd) {
  const repoIndex = args.indexOf("--repo");
  if (repoIndex >= 0) {
    const repoPath = args[repoIndex + 1];
    if (!repoPath) throw new Error("Missing --repo path");
    return resolve(cwd, repoPath);
  }
  return cwd;
}

function collectOnboardingFiles(root) {
  if (!existsSync(root)) return [];
  const entries = [];
  function visit(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (skippedOnboardingSnapshotNames.has(entry.name)) continue;
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() || (entry.isSymbolicLink() && statSync(child).isFile())) entries.push(child);
    }
  }
  visit(root);
  return entries.sort();
}

function opcoreVersionForBin(execPath) {
  let current = dirname(realpathSync(execPath));
  while (current !== dirname(current)) {
    const manifestPath = join(current, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (manifest.name === "@the-open-engine/opcore" && typeof manifest.version === "string") return manifest.version;
    }
    current = dirname(current);
  }
  return "0.1.0-alpha.0";
}

function assertStackHonesty(kind, initPayload) {
  const scan = initPayload.scan;
  const languages = initPayload.settings.languages;
  const languageNames = languages.map((entry) => entry.language).sort();
  if (kind === "ts-js" || kind === "fresh-git") {
    assert.equal(scan.validationSupportedFiles > 0, true, kind);
    assert.equal(languageNames.includes("TypeScript"), true, kind);
    return;
  }
  if (kind === "rust") {
    const rust = languages.find((entry) => entry.language === "Rust");
    assert.ok(rust, "rust language setting");
    assert.equal(["supported", "degraded", "retained"].includes(rust.validation), true, rust.validation);
    assert.equal(scan.validationSupportedFiles + scan.validationRetainedFiles > 0 || scan.degradedRustTools.length > 0, true);
    return;
  }
  if (kind === "mixed") {
    assert.equal(languageNames.includes("Rust"), true, kind);
    assert.equal(languageNames.includes("TypeScript"), true, kind);
    return;
  }
  if (kind === "python") {
    assert.equal(scan.graphSupportedFiles, 1);
    assert.equal(scan.validationSupportedFiles, 0);
    assert.equal(scan.diagnosticCount, 0);
    const python = languages.find((entry) => entry.language === "Python");
    assert.ok(python, "python language setting");
    assert.equal(python.graph, "supported");
    assert.equal(python.validation, "unsupported");
    assert.equal(python.state, "unsupported");
  }
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

function readLatencyRecords(path) {
  return readFileSync(path, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function writeFixtureFile(root, path, content) {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function tsconfig(options = {}) {
  return {
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Node",
      strict: true,
      noEmit: true,
      ...options
    },
    include: ["src/**/*"]
  };
}

function rustCargoToml(name) {
  return `[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2021"\n\n[lib]\npath = "src/lib.rs"\n`;
}

function pathSegments(path) {
  return path.split(/[\\/]+/).filter(Boolean);
}

function nonNegativeDuration(value) {
  return Math.max(0, Math.round(value * 1000) / 1000);
}
