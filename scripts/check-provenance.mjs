import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";

const forbiddenFileNames = new Set(["pyproject.toml", "setup.py", "setup.cfg", "Pipfile"]);
const forbiddenPackageNames = new Set(["code-review-graph", "gungnir"]);
const forbiddenPublicPackageNames = new Set([
  "@the-open-engine/opcore-cix",
  "@the-open-engine/opcore-rox",
  "@the-open-engine/opcore-rox-typescript"
]);
const publicPackageNames = new Set(["opcore"]);
const forbiddenPublicBins = new Set(["lattice", "crg", "cix", "rox"]);
const forbiddenGeneratedRoots = [
  ".ace/",
  ".agents/",
  ".claude/",
  ".codex/",
  ".gemini/",
  ".opencode/",
  ".code-review-graph/",
  ".rox-cache/",
  ".robustness-engine-cache/",
  "target/"
];
const forbiddenContent = [
  ["tirth8205", "code-review-graph"].join("/"),
  ["Copyright (c)", "Tirth Kanani"].join(" "),
  ["", "Users", "tom", "code", "covibes", ""].join("/"),
  ["", "Users", "tom", ".ace", ""].join("/"),
  ["LATTICE_ROX_SOURCE", "/"].join("="),
  ["LATTICE_CRG_SOURCE", "/"].join("="),
  ["LATTICE_CIX_SOURCE", "/"].join("=")
];
const args = new Set(process.argv.slice(2));
const jsonOutput = args.has("--json");

const files = trackedFiles();
for (const path of files) checkTrackedFile(path);
checkGeneratedGraphArtifactMetadata();
await checkGeneratedCliDescriptor();
await checkPackageOutputMarkers();
const historyCommitCount = checkGitHistoryProvenance();

const markdown = provenanceMarkdown(files.length, historyCommitCount);
if (jsonOutput) {
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        status: "passed",
        scannedFileCount: files.length,
        historyCommitCount,
        findings: [],
        markdown
      },
      null,
      2
    )}\n`
  );
} else {
  process.stdout.write("provenance check passed\n");
}

function trackedFiles() {
  const result = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) throw new Error(`Unable to list tracked files: ${result.stderr.toString("utf8")}`);
  return result.stdout
    .toString("utf8")
    .split("\0")
    .filter((path) => path.length > 0 && existsSync(path));
}

function isForbiddenGeneratedRoot(path) {
  return forbiddenGeneratedRoots.some((root) => path.startsWith(root));
}

function checkTrackedFile(path) {
  const entry = path.split("/").at(-1);
  if (forbiddenFileNames.has(entry)) throw new Error(`Forbidden Python packaging file in clean-room repo: ${path}`);
  if (isForbiddenGeneratedRoot(path)) {
    throw new Error(`Generated/private runtime state must not be tracked: ${path}`);
  }
  if (path.endsWith(".tsbuildinfo")) throw new Error(`Generated TypeScript build info must not be tracked: ${path}`);
  if (path.startsWith("target/")) throw new Error(`Generated Rust target files must not be tracked: ${path}`);
  if (
    path.endsWith("metadata.json") &&
    (path.includes("packages/graph/dist/native/") || path.includes("packages/opcore-graph-core-"))
  ) {
    checkGraphArtifactMetadata(path);
  }

  if (entry === "package.json") checkPackageJson(path);
  if (entry === "tsconfig.json") checkTsconfig(path);
  if (!isTextFile(path)) return;
  const content = readFileSync(path, "utf8");
  if (path.endsWith("descriptors/opcore.managed-tool.json")) checkDescriptorStrings(path, content);
  if (isPythonSourceOrMetadataPath(path) && /code[-_]review[-_]graph|gungnir|tirth8205|Tirth Kanani/i.test(content)) {
    throw new Error(`Forbidden Python code-review-graph source marker in ${path}`);
  }
  for (const forbidden of forbiddenContent) {
    if (content.includes(forbidden)) throw new Error(`Forbidden provenance marker in ${path}: ${forbidden}`);
  }
}

function checkGraphArtifactMetadata(path) {
  const metadata = JSON.parse(readFileSync(path, "utf8"));
  for (const key of ["binaryPath", "checksumPath"]) {
    const value = metadata[key];
    if (typeof value !== "string") throw new Error(`Graph artifact metadata ${path}.${key} must be a string`);
    if (isAbsolute(value) || value.startsWith("../") || value.includes("/../")) {
      throw new Error(`Graph artifact metadata ${path}.${key} must not contain absolute or parent paths`);
    }
    if (/^(\/|[A-Za-z]:|~)|(^|\/)(covibes|orchestra|cmdproof|robustness-engine|ace)(\/|$)/.test(value)) {
      throw new Error(`Graph artifact metadata ${path}.${key} must not contain private/global paths`);
    }
  }
}

function checkGeneratedGraphArtifactMetadata() {
  const roots = [
    "packages/graph/dist/native",
    "packages/opcore-graph-core-darwin-arm64",
    "packages/opcore-graph-core-darwin-x64",
    "packages/opcore-graph-core-linux-x64"
  ];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    if (root === "packages/graph/dist/native") {
      for (const target of readDirNames(root)) {
        const metadataPath = `${root}/${target}/metadata.json`;
        if (existsSync(metadataPath)) checkGraphArtifactMetadata(metadataPath);
      }
      continue;
    }
    const metadataPath = `${root}/metadata.json`;
    if (existsSync(metadataPath)) checkGraphArtifactMetadata(metadataPath);
  }
}

async function checkGeneratedCliDescriptor() {
  const descriptorPath = "packages/opcore/dist/descriptors/opcore.managed-tool.json";
  if (!existsSync(descriptorPath)) return;
  const descriptorText = readFileSync(descriptorPath, "utf8");
  checkDescriptorStrings(descriptorPath, descriptorText);
  const { validateManagedToolDescriptor } = await import("../packages/contracts/dist/index.js");
  validateManagedToolDescriptor(JSON.parse(descriptorText));
}

function checkDescriptorStrings(path, content) {
  const forbidden = [
    "LATTICE_CURRENT_TOOLS_DIR",
    "/Users/tom",
    "\\Users\\tom"
  ];
  for (const marker of forbidden) {
    if (content.includes(marker)) throw new Error(`Forbidden descriptor marker in ${path}: ${marker}`);
  }
  if (/(^|[\\/"'\s])\.ace(?:[\\/"'\s]|$)/i.test(content)) {
    throw new Error(`Forbidden private runtime path in generated descriptor: ${path}`);
  }
  if (/(^|[\\/\s])(?:lattice|crg|cix|rox)(?:$|[\\/\s])/i.test(content)) {
    throw new Error(`Forbidden old public alias in generated descriptor: ${path}`);
  }
}

async function checkPackageOutputMarkers() {
  if (!existsSync("scripts/lib/launch-claim-scrub.mjs") || !existsSync("scripts/release-package-dirs.mjs")) return;
  const {
    collectBuiltDistTextEntries,
    collectNpmPackTextEntries,
    formatLaunchScrubFindings,
    scrubLaunchTextEntries
  } = await import("./lib/launch-claim-scrub.mjs");
  const { releasePackageDirsByName } = await import("./release-package-dirs.mjs");
  const findings = scrubLaunchTextEntries([
    ...collectBuiltDistTextEntries(process.cwd()),
    ...collectNpmPackTextEntries(process.cwd(), releasePackageInfos(releasePackageDirsByName))
  ]);
  if (findings.length > 0) throw new Error(`Package output marker scrub failed:\n${formatLaunchScrubFindings(findings).join("\n")}`);
}

function releasePackageInfos(releasePackageDirsByName) {
  return Object.entries(releasePackageDirsByName).map(([packageName, packageRoot]) => ({ packageName, packageRoot }));
}

function checkGitHistoryProvenance() {
  const shallow = spawnSync("git", ["rev-parse", "--is-shallow-repository"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (shallow.status === 0 && shallow.stdout.trim() === "true") {
    throw new Error("Provenance history scan requires full git history; use actions/checkout fetch-depth: 0");
  }
  const commitsResult = spawnSync("git", ["rev-list", "--all"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (commitsResult.status !== 0) throw new Error(`Unable to list git history: ${commitsResult.stderr}`);
  const commits = commitsResult.stdout.trim().split("\n").filter(Boolean);
  for (const commit of commits) checkCommitProvenance(commit);
  return commits.length;
}

function checkCommitProvenance(commit) {
  const tree = spawnSync("git", ["ls-tree", "-r", "--name-only", commit], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (tree.status !== 0) throw new Error(`Unable to inspect git tree ${commit}: ${tree.stderr}`);
  for (const path of tree.stdout.split("\n").filter(Boolean)) {
    const entry = path.split("/").at(-1);
    if (forbiddenFileNames.has(entry)) {
      throw new Error(`Forbidden Python packaging file in git history ${commit}: ${path}`);
    }
    if (/(^|\/)\.git(\/|$)|objects\/pack|refs\/heads/.test(path) && !isAllowedOldToolMentionPath(path)) {
      throw new Error(`Forbidden copied git history marker in git history ${commit}: ${path}`);
    }
  }

  const grep = spawnSync(
    "git",
    [
      "grep",
      "-I",
      "-n",
      "-E",
      String.raw`(code[-_]review[-_]graph|gungnir|tirth8205|Tirth Kanani|objects/pack|refs/heads)`,
      commit,
      "--",
      "."
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  if (grep.status !== 0 && grep.status !== 1) throw new Error(`Unable to grep git history ${commit}: ${grep.stderr}`);
  const findings = grep.stdout
    .split("\n")
    .filter(Boolean)
    .filter((line) => isForbiddenHistoryProvenanceLine(line, commit));
  if (findings.length > 0) {
    throw new Error(`Forbidden Python code-review-graph provenance in git history ${commit}:\n${findings.join("\n")}`);
  }
}

function isForbiddenHistoryProvenanceLine(line, commit) {
  const parsed = parseHistoryGrepLine(line, commit);
  if (!parsed) return false;
  if (isAllowedOldToolMentionPath(parsed.path) || isProvenancePolicyPath(parsed.path)) return false;
  if (/objects\/pack/.test(parsed.text)) return true;
  if (containsUnquotedGitHeadRef(parsed.text)) return true;
  if (isPackageMetadataPath(parsed.path) && /code[-_]review[-_]graph|gungnir/i.test(parsed.text)) return true;
  if (isPythonSourceOrMetadataPath(parsed.path) && /code[-_]review[-_]graph|gungnir|tirth8205|Tirth Kanani/i.test(parsed.text)) return true;
  return false;
}

function containsUnquotedGitHeadRef(text) {
  for (const match of text.matchAll(/refs\/heads\/[A-Za-z0-9._/-]+/g)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const quote = text[start - 1];
    if (!((quote === `"` || quote === `'` || quote === "`") && text[end] === quote)) return true;
  }
  return false;
}

function parseHistoryGrepLine(line, commit) {
  const withoutCommit = line.startsWith(`${commit}:`) ? line.slice(commit.length + 1) : line;
  const first = withoutCommit.indexOf(":");
  if (first === -1) return undefined;
  const second = withoutCommit.indexOf(":", first + 1);
  if (second === -1) return undefined;
  return {
    path: withoutCommit.slice(0, first),
    line: Number(withoutCommit.slice(first + 1, second)),
    text: withoutCommit.slice(second + 1)
  };
}

function isPackageMetadataPath(path) {
  const entry = path.split("/").at(-1);
  return entry === "package.json" || forbiddenFileNames.has(entry);
}

function isPythonSourceOrMetadataPath(path) {
  return isPackageMetadataPath(path) || path.endsWith(".py");
}

function isProvenancePolicyPath(path) {
  return [
    /^scripts\/check-provenance\.mjs$/,
    /^scripts\/generate-graph-release-receipt\.mjs$/,
    /^scripts\/generate-release-receipt\.mjs$/,
    /^scripts\/generate-cutover-receipt\.mjs$/,
    /^packages\/contracts\/src\/index\.ts$/,
    /^packages\/contracts\/schemas\/opcore-contracts\.schema\.json$/,
    /^tests\//
  ].some((pattern) => pattern.test(path));
}

function isAllowedOldToolMentionPath(path) {
  return [
    /^docs\/graph-reference-evidence\//,
    /^docs\/release\//,
    /^packages\/fixtures\/graph-reference-evidence\//,
    /^tests\/fixtures\/graph-reference-evidence\//,
    /^scripts\/setup-current-tools\.sh$/,
    /^scripts\/dev-env\.sh$/,
    /^AGENTS\.md$/,
    /^CLAUDE\.md$/,
    /^ace\.json$/
  ].some((pattern) => pattern.test(path));
}

function provenanceMarkdown(scannedFileCount, historyCommitCount) {
  return `# Provenance Receipts

Maintainer provenance evidence for the Opcore alpha release gate.

- Current-tree files scanned: ${scannedFileCount}
- Git-history commits scanned: ${historyCommitCount}
- Python code-review-graph source findings: 0
- Python package metadata findings: 0
- Copied git-history marker findings: 0

Allowed old-tool mentions are limited to dev current-tool setup, ACE routing, and graph reference evidence fixtures.
`;
}

function readDirNames(path) {
  const result = spawnSync("find", [path, "-mindepth", "1", "-maxdepth", "1", "-type", "d"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) throw new Error(`Unable to inspect ${path}: ${result.stderr}`);
  return result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((entry) => entry.slice(path.length + 1));
}

function checkPackageJson(path) {
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (forbiddenPackageNames.has(manifest.name)) throw new Error(`Forbidden package name in ${path}: ${manifest.name}`);
  if (forbiddenPublicPackageNames.has(manifest.name)) {
    throw new Error(`Forbidden old lattice package identity in ${path}: ${manifest.name}`);
  }
  for (const bin of Object.keys(manifest.bin ?? {})) {
    if (forbiddenPublicBins.has(bin)) throw new Error(`Forbidden old public bin in ${path}: ${bin}`);
  }
  if (Object.prototype.hasOwnProperty.call(manifest, "publishConfig")) {
    if (!publicPackageNames.has(manifest.name) || manifest.publishConfig?.access !== "public") {
      throw new Error(`publishConfig must be public and limited to public release packages: ${path}`);
    }
  }
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
      if (typeof spec !== "string" || !spec.startsWith("file:")) continue;
      const target = spec.slice("file:".length).replaceAll("\\", "/");
      if (target.startsWith("../../") || target.startsWith("/") || isAbsolute(target)) {
        throw new Error(`${path} ${field}.${name} must not reference sibling or parent file dependency ${spec}`);
      }
      if (/^\.\.\/(covibes|orchestra|cmdproof|robustness-engine|ace)(\/|$)/.test(target)) {
        throw new Error(`${path} ${field}.${name} must not reference sibling repo ${spec}`);
      }
    }
  }
}

function checkTsconfig(path) {
  const tsconfig = JSON.parse(readFileSync(path, "utf8"));
  for (const key of ["outDir", "declarationDir", "tsBuildInfoFile"]) {
    const value = tsconfig.compilerOptions?.[key];
    if (!value) continue;
    const normalized = normalize(value).replaceAll("\\", "/");
    if (isAbsolute(value) || normalized.split("/").includes("..")) {
      throw new Error(`${path} compilerOptions.${key} must not reference parent output path ${value}`);
    }
  }
}

function isTextFile(path) {
  return !/\.(png|jpg|jpeg|gif|pdf|tgz|zip)$/i.test(path);
}
