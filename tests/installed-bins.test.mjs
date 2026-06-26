import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  graphCoreNativePackageNamesByTarget,
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

describe("installed package bins", () => {
  it("installs packed packages and exposes only canonical lattice bins", { timeout: 120000 }, () => {
    assert.ok(currentNativePackage, `unsupported local graph-core target ${currentTarget}`);
    const temp = mkdtempSync(join(tmpdir(), "lattice-installed-bins-"));
    try {
      const tarballs = packageNames.map((packageName) => packWorkspace(packageName, temp));
      const project = join(temp, "project");
      mkdirSync(project);
      run("npm", ["init", "-y"], { cwd: project });
      run("npm", ["install", "--ignore-scripts", ...tarballs], { cwd: project });

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
            manifest.exports["./manifests/opcore-asp-provider.provisional.json"],
            "./dist/manifests/opcore-asp-provider.provisional.json"
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
        } else assert.equal(Object.hasOwn(manifest, "bin"), false, packageName);
        assert.doesNotMatch(JSON.stringify(manifest), /file:\.\.\/|\.\.\/(contracts|cli|graph|edit|validation|fixtures)/);
      }
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("installs packed Opcore alone with the opcore and lattice bins", { timeout: 120000 }, () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-installed-bin-"));
    try {
      const tarballs = [
        "@the-open-engine/opcore-contracts",
        "@the-open-engine/opcore-graph",
        "@the-open-engine/opcore-edit",
        "@the-open-engine/opcore-validation",
        "@the-open-engine/opcore-validation-rust",
        "@the-open-engine/opcore-validation-typescript",
        "@the-open-engine/opcore"
      ].map((packageName) => packWorkspace(packageName, temp));
      const project = join(temp, "project");
      mkdirSync(project);
      run("npm", ["init", "-y"], { cwd: project });
      run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...tarballs], { cwd: project });

      assert.equal(existsSync(binPath(project, "opcore")), true);
      assert.equal(existsSync(binPath(project, "lattice")), true);
      for (const forbiddenBin of ["crg", "cix", "rox"]) {
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
