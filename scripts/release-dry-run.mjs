#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { accessSync, constants, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  currentGraphCoreNativeTarget,
  graphCoreNativePackageForTarget,
  graphCoreNativePackageNames,
  graphCoreSupportedTargets
} from "./graph-native-targets.mjs";
import { releasePackageDirForName } from "./release-package-dirs.mjs";

const releaseVersion = "0.1.0";
const implementationPackages = [
  "@the-open-engine/opcore-contracts",
  "opcore",
  "@the-open-engine/opcore-graph",
  "@the-open-engine/opcore-edit",
  "@the-open-engine/opcore-validation",
  "@the-open-engine/opcore-validation-clone",
  "@the-open-engine/opcore-validation-docs",
  "@the-open-engine/opcore-validation-python",
  "@the-open-engine/opcore-validation-rust",
  "@the-open-engine/opcore-validation-typescript",
  "@the-open-engine/opcore-asp-provider"
];
const publicPackages = [
  ...graphCoreNativePackageNames,
  ...implementationPackages
];
const cloneProtocolMarker = Buffer.from("opcore.clone.v1", "utf8");
const target = currentGraphCoreNativeTarget();
const requireAllNativePackages = process.env.LATTICE_REQUIRE_ALL_NATIVE_PACKAGES === "1";

if (!graphCoreSupportedTargets.includes(target)) {
  throw new Error(`release:dry-run requires one of ${graphCoreSupportedTargets.join(", ")}; got ${target}`);
}

const installPackages = [
  "@the-open-engine/opcore-contracts",
  "opcore",
  "@the-open-engine/opcore-graph",
  graphCoreNativePackageNames.find((packageName) => packageName.endsWith(target)),
  "@the-open-engine/opcore-edit",
  "@the-open-engine/opcore-validation",
  "@the-open-engine/opcore-validation-clone",
  "@the-open-engine/opcore-validation-docs",
  "@the-open-engine/opcore-validation-python",
  "@the-open-engine/opcore-validation-rust",
  "@the-open-engine/opcore-validation-typescript",
  "@the-open-engine/opcore-asp-provider"
].filter(Boolean);

const tempRoot = mkdtempSync(join(tmpdir(), "lattice-release-dry-run-"));
try {
  const packDir = join(tempRoot, "packages");
  const project = join(tempRoot, "project");
  mkdirSync(packDir, { recursive: true });
  mkdirSync(project);

  prepareArtifacts();
  const tarballs = publicPackages.map((packageName) => packWorkspace(packageName, packDir));

  run("npm", ["init", "-y"], { cwd: project });
  const tarballsByPackage = new Map(publicPackages.map((packageName, index) => [packageName, tarballs[index]]));
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...installPackages.map((packageName) => tarballsByPackage.get(packageName))], {
    cwd: project
  });
  installFixture(project);

  const opcoreBin = join(project, "node_modules", ".bin", process.platform === "win32" ? "opcore.cmd" : "opcore");
  if (!existsSync(opcoreBin)) throw new Error("Installed opcore bin is missing");

  const help = run(opcoreBin, ["--help"], { cwd: project, env: sanitizedEnv() });
  if (!help.stdout.includes("Local code intelligence") || !help.stdout.includes("Examples:")) {
    throw new Error("Installed opcore --help did not include public first-run help");
  }

  runJson(opcoreBin, ["graph", "build", "--json"], project, "graph-build");
  runJson(opcoreBin, ["status", "--json"], project, "opcore-status");
  runJson(opcoreBin, ["graph", "search", "Greeting", "--limit", "5", "--json"], project, "graph-search");
  runJson(opcoreBin, ["graph", "impact", "--files", "src/components/GreetingCard.tsx", "--limit", "10", "--json"], project, "graph-impact");
  runJson(opcoreBin, ["check", "files", "src/components/GreetingCard.tsx", "--checks", "typescript.syntax", "--json"], project, "check-files");

  const requestPath = join(project, "pre-write.json");
  writeFileSync(
    requestPath,
    `${JSON.stringify({
      repo: { repoRoot: project },
      scope: { kind: "files", files: ["src/models.ts"] },
      graph: { mode: "optional", provider: "opcore-graph" },
      checks: ["typescript.syntax"],
      overlays: [{ path: "src/models.ts", action: "write", content: "export interface Greeting { message: string; }\n" }]
    })}\n`
  );
  const preWrite = runJson(
    opcoreBin,
    ["validate", "pre-write", "--request-file", requestPath, "--timeout-ms", "30000", "--json"],
    project,
    "validate-pre-write"
  );
  if (preWrite.receipt?.ok !== true) throw new Error("pre-write smoke did not return receipt.ok true");

  process.stdout.write(`release dry-run passed for ${releaseVersion} on ${target}\n`);
} finally {
  if (process.env.LATTICE_KEEP_RELEASE_DRY_RUN !== "1") {
    rmSync(tempRoot, { recursive: true, force: true });
  } else {
    process.stdout.write(`kept dry-run project at ${tempRoot}\n`);
  }
}

function packWorkspace(packageName, destination) {
  const result = run("npm", ["pack", "--json", "--pack-destination", destination], {
    cwd: releasePackageDirForName(packageName)
  });
  const parsed = JSON.parse(result.stdout)[0];
  if (parsed.version !== releaseVersion) throw new Error(`${packageName} packed version ${parsed.version}, expected ${releaseVersion}`);
  return join(destination, parsed.filename);
}

function prepareArtifacts() {
  if (!requireAllNativePackages) {
    run("npm", ["run", "build"]);
    return;
  }
  assertCompleteNativeArtifacts();
  run(process.execPath, [join("node_modules", "typescript", "bin", "tsc"), "-b", "--pretty", "false"]);
  run(process.execPath, ["scripts/write-cli-descriptor.mjs"]);
  run(process.execPath, ["scripts/write-asp-provider-manifest.mjs"]);
}

function assertCompleteNativeArtifacts() {
  for (const nativeTarget of graphCoreSupportedTargets) {
    const nativePackage = graphCoreNativePackageForTarget(nativeTarget);
    const binary = join(nativePackage.packageDir, "opcore-graph-core");
    const checksum = join(nativePackage.packageDir, "opcore-graph-core.sha256");
    const metadata = join(nativePackage.packageDir, "metadata.json");
    for (const path of [binary, checksum, metadata]) {
      if (!existsSync(path)) throw new Error(`release:dry-run requires prebuilt native artifact file ${path}`);
    }
    try {
      accessSync(binary, constants.X_OK);
    } catch {
      throw new Error(`${nativePackage.packageName} binary must be executable after artifact download: ${binary}`);
    }
    const parsedMetadata = JSON.parse(readFileSync(metadata, "utf8"));
    if (parsedMetadata.targetPlatform !== nativeTarget) {
      throw new Error(`${metadata} targetPlatform ${parsedMetadata.targetPlatform}, expected ${nativeTarget}`);
    }
    if (parsedMetadata.binaryPath !== "opcore-graph-core" || parsedMetadata.checksumPath !== "opcore-graph-core.sha256") {
      throw new Error(`${metadata} must reference package-local opcore-graph-core and opcore-graph-core.sha256`);
    }
    const actualChecksum = createHash("sha256").update(readFileSync(binary)).digest("hex");
    const checksumFile = readFileSync(checksum, "utf8").trim().split(/\s+/)[0];
    if (parsedMetadata.checksumSha256 !== actualChecksum || checksumFile !== actualChecksum) {
      throw new Error(`${nativePackage.packageName} checksum mismatch for ${nativeTarget}`);
    }
    if (!readFileSync(binary).includes(cloneProtocolMarker)) {
      throw new Error(`${nativePackage.packageName} binary must include clone protocol opcore.clone.v1`);
    }
  }
}

function installFixture(project) {
  cpSync("packages/fixtures/source-extraction/wave1/src", join(project, "src"), { recursive: true });
  cpSync("packages/fixtures/source-extraction/wave1/tsconfig.json", join(project, "tsconfig.json"));
}

function runJson(command, args, cwd, id) {
  const result = run(command, args, { cwd, env: sanitizedEnv() });
  const parsed = JSON.parse(result.stdout);
  if (parsed.status !== "ok") throw new Error(`${id} returned ${parsed.status}: ${result.stdout}`);
  return parsed;
}

function sanitizedEnv() {
  const env = { ...process.env };
  for (const key of [
    "LATTICE_CURRENT_TOOLS_DIR",
    "ACE_CURRENT_TOOLS_DIR",
    "LATTICE_CURRENT_ROX_PATH",
    "LATTICE_CURRENT_CRG_PATH",
    "LATTICE_CURRENT_CIX_PATH"
  ]) {
    delete env[key];
  }
  env.PATH = [dirname(process.execPath), "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
  env.npm_lifecycle_event = undefined;
  return env;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) {
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
