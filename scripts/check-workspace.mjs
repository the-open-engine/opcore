import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";

const requiredContextHeader = "UPDATE THIS FILE when making architectural changes, adding patterns, or changing conventions.";
const packageTracks = [
  { dir: "contracts", name: "@the-open-engine/opcore-contracts" },
  { dir: "opcore", name: "@the-open-engine/opcore", bin: "opcore" },
  { dir: "graph", name: "@the-open-engine/opcore-graph" },
  { dir: "edit", name: "@the-open-engine/opcore-edit" },
  { dir: "validation", name: "@the-open-engine/opcore-validation" },
  { dir: "validation-rust", name: "@the-open-engine/opcore-validation-rust" },
  { dir: "validation-typescript", name: "@the-open-engine/opcore-validation-typescript" },
  { dir: "asp-provider", name: "@the-open-engine/opcore-asp-provider", bin: "opcore-asp-provider" },
  { dir: "fixtures", name: "@the-open-engine/opcore-fixtures" }
];
const releaseVersion = "0.1.0-alpha.0";
const packageNames = new Set(packageTracks.map((entry) => entry.name));
const publicPackageNames = new Set(packageTracks.filter((entry) => entry.dir !== "fixtures").map((entry) => entry.name));
const rootNativeOptionalDependencies = new Map([
  ["@the-open-engine/opcore-graph-core-darwin-arm64", "file:packages/opcore-graph-core-darwin-arm64"],
  ["@the-open-engine/opcore-graph-core-darwin-x64", "file:packages/opcore-graph-core-darwin-x64"],
  ["@the-open-engine/opcore-graph-core-linux-x64", "file:packages/opcore-graph-core-linux-x64"]
]);
const dependencyFields = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const requiredGitignoreTokens = [
  "node_modules/",
  "dist/",
  "*.tsbuildinfo",
  ".ace/",
  ".agents/",
  ".claude/",
  ".codex/",
  ".gemini/",
  ".opencode/",
  ".code-review-graph/",
  ".rox-cache/",
  ".robustness-engine-cache/",
  "target/",
  ".zeroshot/*",
  "!.zeroshot/settings.json"
];
const siblingRepoTokens = ["covibes", "orchestra", "cmdproof", "robustness-engine", "ace"];

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const fail = (message) => {
  throw new Error(message);
};
const requireIncludes = (name, content, token) => {
  if (!content.includes(token)) fail(`${name} must include ${token}`);
};
const assertDeepEqual = (actual, expected, message) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
};

const root = readJson("package.json");
if (root.private !== true) fail("Root package must stay private");
for (const scriptName of [
  "ci",
  "ci:local",
  "setup",
  "setup:tools",
  "verify",
  "test:ci",
  "conformance:check",
  "pack:check",
  "release:hygiene",
  "release-receipt:check",
  "release-receipt:receipt",
  "release:dry-run",
  "release:publish",
  "cutover:check",
  "cutover:receipt",
  "license:report",
  "provenance:check",
  "graph:artifact",
  "asp-provider:manifest",
  "rust:fmt",
  "rust:clippy",
  "rust:test",
  "rust:check",
  "current-tools:validate-all",
  "current-tools:validate-rust-graph",
  "current-tools:validate-changed",
  "current-tools:graph-status"
]) {
  if (!root.scripts?.[scriptName]) fail(`Root package must expose ${scriptName} script`);
}
if (!root.scripts["current-tools:validate-rust-graph"].includes("scripts/check-rust-graph-function-metrics.mjs")) {
  fail("current-tools:validate-rust-graph must run scoped Rust graph function metrics script");
}
if (!root.scripts["current-tools:validate-changed"].includes("scripts/ci/run-rox-clean-changed-gate.mjs")) {
  fail("current-tools:validate-changed must run the clean changed-file Rox gate script");
}
for (const ciToken of [
  "lint",
  "rust:check",
  "build",
  "test:ci",
  "release-receipt:check",
  "graph-release:check",
  "cutover:check",
  "OPCORE_CUTOVER_REUSE_RELEASE_PACKAGES=1"
]) {
  requireIncludes("package.json scripts.ci", root.scripts.ci, ciToken);
}
for (const duplicateCiToken of ["conformance:check", "pack:check", "release:hygiene", "provenance:check"]) {
  if (root.scripts.ci.includes(duplicateCiToken)) {
    fail(`package.json scripts.ci must not run duplicate standalone ${duplicateCiToken}`);
  }
}
requireIncludes("package.json scripts.test", root.scripts.test, "tests/*.test.mjs");
requireIncludes(
  "package.json scripts.test:ci",
  root.scripts["test:ci"],
  "OPCORE_CI_RECEIPT_GATES_RUN_SEPARATELY=1"
);
requireIncludes("package.json scripts.test:ci", root.scripts["test:ci"], "tests/*.test.mjs");
const graphReleaseReceiptScript = readFileSync("scripts/generate-graph-release-receipt.mjs", "utf8");
for (const token of ["conformance:check", "pack:check", "license:report", "provenance:check"]) {
  requireIncludes("scripts/generate-graph-release-receipt.mjs", graphReleaseReceiptScript, token);
}
const releaseReceiptScript = readFileSync("scripts/generate-release-receipt.mjs", "utf8");
for (const token of ["scripts/check-release-hygiene.mjs", "scripts/check-provenance.mjs"]) {
  requireIncludes("scripts/generate-release-receipt.mjs", releaseReceiptScript, token);
}
const cutoverReceiptScript = readFileSync("scripts/generate-cutover-receipt.mjs", "utf8");
requireIncludes("scripts/generate-cutover-receipt.mjs", cutoverReceiptScript, "OPCORE_CUTOVER_REUSE_RELEASE_PACKAGES");
validateDependencySpecs("package.json", root);
assertDeepEqual(root.optionalDependencies ?? {}, Object.fromEntries(rootNativeOptionalDependencies), "Root native optionalDependencies");

for (const path of ["Cargo.toml", "Cargo.lock", "crates/graph-core/Cargo.toml"]) {
  if (!existsSync(path)) fail(`Missing Rust graph-core workspace file: ${path}`);
}
validateRustLintPolicy();
const cargoManifest = readFileSync("crates/graph-core/Cargo.toml", "utf8");
for (const token of ["name = \"lattice-graph-core\"", "name = \"lattice_graph_core\"", "name = \"lattice-graph-core\""]) {
  requireIncludes("crates/graph-core/Cargo.toml", cargoManifest, token);
}
requireIncludes("crates/graph-core/Cargo.toml", cargoManifest, "[lints]");
requireIncludes("crates/graph-core/Cargo.toml", cargoManifest, "workspace = true");

for (const track of packageTracks) {
  const packagePath = join("packages", track.dir, "package.json");
  if (!existsSync(packagePath)) fail(`Missing package manifest: ${packagePath}`);
  const manifest = readJson(packagePath);
  validatePackageManifest(packagePath, manifest, track);
  validateDependencySpecs(packagePath, manifest);
  validateTsconfig(join("packages", track.dir, "tsconfig.json"));
}

const agents = readFileSync("AGENTS.md", "utf8");
const claude = readFileSync("CLAUDE.md", "utf8");
if (agents !== claude) fail("AGENTS.md and CLAUDE.md must stay identical");
if (agents.split("\n", 1)[0] !== requiredContextHeader) {
  fail("Agent context files must start with the required update header");
}

const runtimeArdPath = "docs/architecture/runtime-cli-ard.md";
if (!existsSync(runtimeArdPath)) fail(`Missing runtime CLI ARD: ${runtimeArdPath}`);
const runtimeArd = readFileSync(runtimeArdPath, "utf8");
const readme = readFileSync("README.md", "utf8");
const quickstart = readFileSync("docs/quickstart.md", "utf8");
const opcorePackageReadme = readFileSync("packages/opcore/README.md", "utf8");
for (const [name, content] of [
  ["AGENTS.md", agents],
  ["CLAUDE.md", claude],
  ["README.md", readme]
]) {
  requireIncludes(name, content, "@docs/architecture/runtime-cli-ard.md");
  requireIncludes(name, content, "hybrid");
}
for (const token of [
  "Opcore",
  "npm install -g @the-open-engine/opcore@0.1.0-alpha.0",
  "opcore try",
  "opcore --repo .",
  "opcore init --repo . --approve",
  "opcore check --changed --json",
  "opcore measure --repo ."
]) {
  requireIncludes("README.md", readme, token);
}
for (const [name, content] of [
  ["README.md", readme],
  ["docs/quickstart.md", quickstart],
  ["packages/opcore/README.md", opcorePackageReadme]
]) {
  for (const token of [
    "npx @the-open-engine/opcore@0.1.0-alpha.0 init",
    "npm install -g @the-open-engine/opcore@0.1.0-alpha.0",
    "npm prefix -g",
    "$(npm prefix -g)/bin",
    "darwin-arm64",
    "darwin-x64",
    "linux-x64",
    "Unsupported platforms return typed degraded status",
    "Windows is out of scope for `0.1.0-alpha.0`",
    "freshly `git init` repo with no commits",
    "opcore check --changed --json"
  ]) {
    requireIncludes(name, content, token);
  }
}
for (const token of [
  "Decision: hybrid",
  "Rust graph core",
  "TypeScript contracts",
  "lattice graph",
  "lattice inspect",
  "lattice edit",
  "lattice check",
  "lattice validate",
  "lattice status",
  "lattice doctor",
  "do not collapse graph, edit, and policy ownership into one muddled abstraction",
  "#21"
]) {
  requireIncludes(runtimeArdPath, runtimeArd, token);
}

for (const path of [
  "ace.json",
  "rox.json",
  ".zeroshot/settings.json",
  "scripts/setup-current-tools.sh",
  "scripts/dev-env.sh",
  "scripts/check-rust-graph-function-metrics.mjs",
  "scripts/build-graph-core-artifact.mjs",
  "scripts/ci/run-local-ci-equivalent.sh"
]) {
  if (!existsSync(path)) fail(`Missing agent tooling file: ${path}`);
}

const ace = readJson("ace.json");
const mcpArgs = ace.mcpServers?.["code-review-graph"]?.args ?? [];
if (!mcpArgs.some((arg) => arg.includes(".ace/runtime/bin/crg") && arg.includes("serve --repo"))) {
  fail("ace.json must route code-review-graph MCP through the generated current crg wrapper");
}

const rox = readJson("rox.json");
if (!rox.adapters?.includes("typescript")) fail("rox.json must validate the current TypeScript scaffold");
if (!rox.adapters?.includes("rust")) fail("rox.json must declare the current Rust scaffold adapter");
if (!rox.extensions?.includes("scripts/check-rust-graph-function-metrics.mjs")) {
  fail("rox.json must run scoped Rust graph function metrics during repo-wide Rox checks");
}
if (!rox.packages?.includes("crates")) {
  fail('rox.json packages must include "crates" for all-mode Rust graph-core function metrics');
}
for (const includePath of ["packages/", "scripts/", "tests/", "crates/"]) {
  if (!rox.checks?.codeQuality?.include?.includes(includePath)) {
    fail(`rox.json checks.codeQuality.include must include "${includePath}"`);
  }
}
for (const mode of ["staged", "changed", "files"]) {
  if (!rox.checks?.codeQuality?.when?.modes?.includes(mode)) {
    fail(`rox.json checks.codeQuality.when.modes must include "${mode}"`);
  }
}
const rustGates = rox.extensionConfig?.rustGates;
if (rustGates?.workspace !== "Cargo.toml" || rustGates?.package !== "lattice-graph-core") {
  fail("rox.json must include schema-compatible Rust graph-core gate metadata under extensionConfig.rustGates");
}
for (const rustCheck of ["cargo fmt --check", "cargo clippy --all-targets --all-features -- -D warnings", "cargo test"]) {
  if (!rustGates.commands?.includes(rustCheck)) fail(`rox.json rustGates must include ${rustCheck}`);
}

const zeroshot = readJson(".zeroshot/settings.json");
if (zeroshot.github?.prBase !== "main" || zeroshot.worktree?.baseRef !== "origin/main") {
  fail("Zeroshot must target the lattice main branch");
}
if (!zeroshot.worktree?.setup?.includes("npm run setup")) fail("Zeroshot setup must generate current-tool wrappers");

const setupTools = readFileSync("scripts/setup-current-tools.sh", "utf8");
for (const token of [
  "LATTICE_CURRENT_TOOLS_DIR",
  "external ACE-managed tools",
  "implementation_package_dir",
  "packages/graph",
  "aceTools",
  "binRoot",
  "latticeCurrentTools",
  "rust-code-analysis-cli"
]) {
  requireIncludes("scripts/setup-current-tools.sh", setupTools, token);
}

if (!existsSync(".changeset")) fail("Missing .changeset directory");

const gitignore = readFileSync(".gitignore", "utf8");
for (const token of requiredGitignoreTokens) requireIncludes(".gitignore", gitignore, token);

for (const workflow of [".github/workflows/ci.yml", ".github/workflows/provenance.yml"]) {
  const content = readFileSync(workflow, "utf8");
  validateWorkflow(workflow, content);
  if (workflow.endsWith("ci.yml") && !content.includes("dtolnay/rust-toolchain")) {
    fail(`${workflow} must install stable Rust`);
  }
  if (workflow.endsWith("provenance.yml")) {
    validateProvenanceWorkflow(workflow, content);
  }
}

validateReservedGraphNaming();
validateRustGraphCoreNaming();
validateGraphConsumerBoundaries();
validateLocalCiEquivalent();

const trackedBuildInfo = spawnSync("git", ["ls-files", "*.tsbuildinfo"], { encoding: "utf8" });
if (trackedBuildInfo.status !== 0) fail(`Unable to inspect tracked files: ${trackedBuildInfo.stderr}`);
if (trackedBuildInfo.stdout.trim().length > 0) {
  fail(`Generated TypeScript build info must not be checked in:\n${trackedBuildInfo.stdout.trim()}`);
}

const trackedTarget = spawnSync("git", ["ls-files", "target"], { encoding: "utf8" });
if (trackedTarget.status !== 0) fail(`Unable to inspect tracked Rust target files: ${trackedTarget.stderr}`);
if (trackedTarget.stdout.trim().length > 0) {
  fail(`Generated Rust target files must not be checked in:\n${trackedTarget.stdout.trim()}`);
}

console.log("workspace check passed");

function validatePackageManifest(packagePath, manifest, track) {
  if (manifest.name !== track.name) fail(`${packagePath} name must be ${track.name}`);
  if (manifest.version !== releaseVersion) fail(`${manifest.name} version must be ${releaseVersion}`);
  if (typeof manifest.description !== "string" || manifest.description.length < 20) {
    fail(`${manifest.name} must have a public package description`);
  }
  if (!Array.isArray(manifest.keywords) || manifest.keywords.length < 4) fail(`${manifest.name} must declare package keywords`);
  if (manifest.main !== "dist/index.js") fail(`${manifest.name} main must be dist/index.js`);
  if (manifest.types !== "dist/index.d.ts") fail(`${manifest.name} types must be dist/index.d.ts`);
  assertDeepEqual(manifest.exports?.["."], { types: "./dist/index.d.ts", default: "./dist/index.js" }, `${manifest.name} exports["."]`);
  if (track.dir === "contracts") {
    assertDeepEqual(
      manifest.exports?.["./schemas/lattice-contracts.schema.json"],
      "./schemas/lattice-contracts.schema.json",
      `${manifest.name} schema export`
    );
    assertDeepEqual(manifest.files, ["dist", "schemas", "README.md"], `${manifest.name} files`);
  } else if (track.dir === "fixtures") {
    assertDeepEqual(
      manifest.files,
      [
        "dist",
        "descriptors",
        "graph-search",
        "graph-release",
        "graph-query",
        "graph-pipeline",
        "validation-contract",
        "graph-reference-evidence",
        "inspect-symbol-parity",
        "source-extraction",
        "README.md"
      ],
      `${manifest.name} files`
    );
  } else {
    assertDeepEqual(manifest.files, ["dist", "README.md"], `${manifest.name} files`);
  }
  if (!manifest.scripts?.build) fail(`${manifest.name} must declare scripts.build`);
  if (manifest.license !== "MIT") fail(`${manifest.name} license must be MIT`);
  if (!manifest.engines?.node?.includes(">=22")) fail(`${manifest.name} engines.node must require Node >=22`);
  if (manifest.repository?.directory !== `packages/${track.dir}`) {
    fail(`${manifest.name} repository.directory must be packages/${track.dir}`);
  }
  if (track.dir === "fixtures") {
    if (manifest.private !== true) fail(`${manifest.name} must stay private/internal for ${releaseVersion}`);
    if (hasOwn(manifest, "publishConfig")) fail(`${manifest.name} must not declare publishConfig`);
  } else {
    if (hasOwn(manifest, "private")) fail(`${manifest.name} must not declare private`);
    assertDeepEqual(manifest.publishConfig, { access: "public" }, `${manifest.name} publishConfig`);
    if (!publicPackageNames.has(manifest.name)) fail(`${manifest.name} is not in the public package set`);
  }
  if (manifest.name.includes("code-review-graph") || manifest.name.includes("gungnir")) {
    fail(`${manifest.name} uses a forbidden public package name`);
  }
  if (track.dir === "opcore") {
    assertDeepEqual(manifest.bin, { opcore: "dist/index.js", lattice: "dist/lattice/index.js" }, `${manifest.name} bin`);
  } else if (track.dir === "asp-provider") {
    assertDeepEqual(manifest.bin, { "opcore-asp-provider": "dist/index.js" }, `${manifest.name} bin`);
  } else if (hasOwn(manifest, "bin")) {
    fail(`${manifest.name} must not declare CLI bins`);
  }
  for (const forbiddenBin of ["crg", "cix", "rox"]) {
    if (manifest.bin && hasOwn(manifest.bin, forbiddenBin)) {
      fail(`${manifest.name} exposes forbidden old bin ${forbiddenBin}`);
    }
  }
}

function validateRustLintPolicy() {
  const workspaceManifest = readFileSync("Cargo.toml", "utf8");
  for (const token of [
    "[workspace.lints.rust]",
    'unsafe_code = "forbid"',
    "[workspace.lints.clippy]",
    'unwrap_used = "deny"',
    'expect_used = "deny"',
    'panic = "deny"',
    'todo = "deny"',
    'unimplemented = "deny"',
    'unreachable = "deny"',
    'indexing_slicing = "deny"',
    'cast_possible_truncation = "deny"',
    'cast_sign_loss = "deny"'
  ]) {
    requireIncludes("Cargo.toml", workspaceManifest, token);
  }
}

function validateLocalCiEquivalent() {
  const localCi = readFileSync("scripts/ci/run-local-ci-equivalent.sh", "utf8");
  for (const token of [
    "npm run setup:tools",
    "npm run ci",
    "npm run current-tools:validate-all",
    "npm run current-tools:validate-rust-graph"
  ]) {
    requireIncludes("scripts/ci/run-local-ci-equivalent.sh", localCi, token);
  }
}

function validateDependencySpecs(manifestPath, manifest) {
  for (const field of dependencyFields) {
    for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
      if (typeof spec !== "string") continue;
      if (packageNames.has(name) && spec !== releaseVersion) {
        fail(`${manifestPath} ${field}.${name} must use exact internal version ${releaseVersion}`);
      }
      for (const token of siblingRepoTokens) {
        if (spec.includes(`../${token}`) || spec.includes(`..\\${token}`)) {
          fail(`${manifestPath} ${field}.${name} must not reference sibling repo ${token}`);
        }
      }
      const allowedRootNativeOptional =
        manifestPath === "package.json" &&
        field === "optionalDependencies" &&
        rootNativeOptionalDependencies.get(name) === spec;
      if (spec.startsWith("file:") && !allowedRootNativeOptional) {
        fail(`${manifestPath} ${field}.${name} must not use file dependencies`);
      }
    }
  }
}

function validateTsconfig(tsconfigPath) {
  if (!existsSync(tsconfigPath)) fail(`Missing package tsconfig: ${tsconfigPath}`);
  const tsconfig = readJson(tsconfigPath);
  for (const key of ["outDir", "declarationDir", "tsBuildInfoFile"]) {
    const value = tsconfig.compilerOptions?.[key];
    if (!value) continue;
    const normalized = normalize(value).replaceAll("\\", "/");
    const segments = normalized.split("/");
    if (isAbsolute(value) || segments.includes("..")) {
      fail(`${tsconfigPath} compilerOptions.${key} must not reference parent directories or absolute paths: ${value}`);
    }
  }
}

function validateWorkflow(path, content) {
  if (!content.includes("pull_request:")) fail(`${path} must run on pull_request`);
  if (!content.includes("push:")) fail(`${path} must run on push`);
  if (!/permissions:\s*\n\s*contents:\s*read\b/.test(content)) fail(`${path} permissions.contents must be read`);
  if (content.includes("${{ secrets.")) fail(`${path} must not reference GitHub secrets`);
  if (content.includes("id-token")) fail(`${path} must not request id-token permissions`);
  if (!/fetch-depth:\s*0\b/.test(content)) fail(`${path} checkout must use fetch-depth: 0 for release provenance history scans`);
  const branches = extractPushBranches(content);
  assertDeepEqual(branches, ["main"], `${path} push.branches`);
}

function validateProvenanceWorkflow(path, content) {
  requireCommandBefore(
    path,
    content,
    "dtolnay/rust-toolchain@stable",
    "npm run build",
    "for release receipt native artifact generation"
  );
  requireCommandBefore(
    path,
    content,
    "npm run build",
    "npm run release-receipt:check",
    "because release-receipt:check imports ignored dist artifacts"
  );
}

function requireCommandBefore(path, content, earlier, later, reason) {
  const earlierIndex = content.indexOf(earlier);
  const laterIndex = content.indexOf(later);
  if (earlierIndex === -1 || laterIndex === -1 || earlierIndex > laterIndex) {
    fail(`${path} must run ${earlier} before ${later} ${reason}`);
  }
}

function validateReservedGraphNaming() {
  const legacyPackagePath = ["packages", "crg"].join("/");
  const legacyPackageName = `@the-open-engine/opcore-${"crg"}`;
  const legacyProviderName = ["cr", "g"].join("");
  const quotedLegacyProviderName = `["']${escapeRegExp(legacyProviderName)}["']`;
  const providerLiteralPattern = new RegExp(
    `(?:^|[^A-Za-z0-9_$])["']?provider["']?\\s*:\\s*${quotedLegacyProviderName}`
  );
  const providerNameMetadataPattern = new RegExp(
    `(?:^|[^A-Za-z0-9_$])["']?providerName["']?\\s*:\\s*${quotedLegacyProviderName}`
  );
  const providerNameConstantPattern = new RegExp(
    `(?:^|[^A-Za-z0-9_$])(?:[A-Za-z_$][\\w$]*ProviderName|providerName)\\s*(?::\\s*[^=]+)?=\\s*${quotedLegacyProviderName}`
  );
  const checks = [
    { label: "legacy graph package path", token: legacyPackagePath },
    { label: "legacy graph package name", token: legacyPackageName },
    { label: "legacy graph provider literal", pattern: providerLiteralPattern },
    { label: "legacy graph provider name metadata", pattern: providerNameMetadataPattern },
    { label: "legacy graph provider name constant", pattern: providerNameConstantPattern },
    { label: "legacy graph product description", token: `code-intelligence monorepo for \`${legacyProviderName}\`` },
    { label: "legacy graph package-track description", token: `graph production belongs in \`${legacyProviderName}\`` }
  ];
  const violations = [];
  for (const path of scanTextFiles(".")) {
    if (isReservedGraphNamingAllowlisted(path)) continue;
    const content = readFileSync(path, "utf8");
    const lines = content.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      for (const check of checks) {
        const matched = check.token ? line.includes(check.token) : check.pattern.test(line);
        if (matched) violations.push(`${path}:${index + 1}: ${check.label}`);
      }
    }
  }
  if (violations.length > 0) {
    fail(`reserved graph naming references must use graph implementation names:\n${violations.join("\n")}`);
  }
}

function validateRustGraphCoreNaming() {
  for (const path of ["Cargo.toml", "crates/graph-core/Cargo.toml"]) {
    const content = readFileSync(path, "utf8");
    if (/name\s*=\s*["'][^"']*crg[^"']*["']/i.test(content)) {
      fail(`${path} must not use crg in Rust package, crate, or native artifact names`);
    }
  }
  const graphPackage = readJson("packages/graph/package.json");
  if (JSON.stringify(graphPackage).match(/lattice-crg-core|graph-crg-core/i)) {
    fail("packages/graph/package.json must not use crg in native artifact metadata");
  }
}

function validateGraphConsumerBoundaries() {
  const forbidden = [
    /@the-open-engine\/opcore-graph/,
    /graph-core/i,
    /lattice-graph-core/i,
    /resolveGraphCoreArtifact/i,
    /native artifact loader/i,
    /graph sqlite/i,
    /raw sqlite/i
  ];
  for (const packageDir of ["edit", "validation"]) {
    for (const path of scanTextFiles(`packages/${packageDir}/src`)) {
      const content = readFileSync(path, "utf8");
      for (const pattern of forbidden) {
        if (pattern.test(content)) {
          fail(`${path} must consume graph-core only through GraphProvider contracts`);
        }
      }
    }
  }
}

function scanTextFiles(dir) {
  const skipDirs = new Set([
    ".git",
    "node_modules",
    "dist",
    ".ace",
    ".agents",
    ".claude",
    ".codex",
    ".gemini",
    ".opencode",
    ".code-review-graph",
    ".rox-cache",
    ".robustness-engine-cache",
    "target"
  ]);
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = dir === "." ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue;
      files.push(...scanTextFiles(path));
      continue;
    }
    if (!entry.isFile() && !(entry.isSymbolicLink() && statSync(path).isFile())) continue;
    if (isTextFile(path)) files.push(path);
  }
  return files;
}

function isTextFile(path) {
  const textExtensions = new Set([
    ".cjs",
    ".css",
    ".html",
    ".json",
    ".js",
    ".jsx",
    ".lock",
    ".md",
    ".mjs",
    ".mts",
    ".rs",
    ".sh",
    ".ts",
    ".toml",
    ".tsx",
    ".txt",
    ".yaml",
    ".yml"
  ]);
  if (["AGENTS.md", "CLAUDE.md", "README.md", "package-lock.json", "package.json"].includes(path)) return true;
  const dot = path.lastIndexOf(".");
  return dot !== -1 && textExtensions.has(path.slice(dot));
}

function isReservedGraphNamingAllowlisted(path) {
  return [
    /^docs\/graph-reference-evidence\//,
    /^packages\/fixtures\/graph-pipeline\//,
    /^packages\/fixtures\/graph-query\//,
    /^packages\/fixtures\/graph-reference-evidence\//,
    /^tests\/fixtures\/graph-reference-evidence\//
  ].some((pattern) => pattern.test(path));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractPushBranches(content) {
  const lines = content.split(/\r?\n/);
  const branches = [];
  let inPush = false;
  let inBranches = false;
  for (const line of lines) {
    if (/^  [A-Za-z_]+:/.test(line) && !/^  push:/.test(line)) {
      inPush = false;
      inBranches = false;
    }
    if (/^  push:/.test(line)) {
      inPush = true;
      inBranches = false;
      continue;
    }
    if (!inPush) continue;
    if (/^    branches:/.test(line)) {
      inBranches = true;
      continue;
    }
    if (inBranches) {
      const match = line.match(/^\s*-\s*(\S+)\s*$/);
      if (match) branches.push(match[1]);
      else if (/^\s*\S/.test(line)) inBranches = false;
    }
  }
  return branches;
}
