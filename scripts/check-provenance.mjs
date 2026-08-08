import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";

const forbiddenFileNames = new Set(["pyproject.toml", "setup.py", "setup.cfg", "Pipfile"]);
const forbiddenGeneratedRoots = [
  ".agents/",
  ".claude/",
  ".codex/",
  ".gemini/",
  ".opencode/",
  "target/"
];
const publicPackageNames = new Set(["opcore"]);
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

function checkTrackedFile(path) {
  const entry = path.split("/").at(-1);
  if (forbiddenFileNames.has(entry)) throw new Error(`Forbidden Python packaging file in repository: ${path}`);
  if (forbiddenGeneratedRoots.some((root) => path.startsWith(root))) {
    throw new Error(`Generated provider or build state must not be tracked: ${path}`);
  }
  if (path.endsWith(".tsbuildinfo")) throw new Error(`Generated TypeScript build info must not be tracked: ${path}`);
  if (
    path.endsWith("metadata.json") &&
    (path.includes("packages/graph/dist/native/") || path.includes("packages/opcore-graph-core-"))
  ) {
    checkGraphArtifactMetadata(path);
  }
  if (entry === "package.json") checkPackageJson(path);
  if (entry === "tsconfig.json") checkTsconfig(path);
  if (path.endsWith("descriptors/opcore.managed-tool.json")) checkDescriptorStrings(path, readFileSync(path, "utf8"));
}

function checkGraphArtifactMetadata(path) {
  const metadata = JSON.parse(readFileSync(path, "utf8"));
  for (const key of ["binaryPath", "checksumPath"]) {
    const value = metadata[key];
    if (typeof value !== "string") throw new Error(`Graph artifact metadata ${path}.${key} must be a string`);
    assertRepoRelative(value, `Graph artifact metadata ${path}.${key}`);
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
  if (/\/Users\/[^/\s]+|[A-Za-z]:\\Users\\/u.test(content)) {
    throw new Error(`Generated descriptor contains a user-specific path: ${path}`);
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
  const packageInfos = Object.entries(releasePackageDirsByName).map(([packageName, packageRoot]) => ({
    packageName,
    packageRoot
  }));
  const findings = scrubLaunchTextEntries([
    ...collectBuiltDistTextEntries(process.cwd()),
    ...collectNpmPackTextEntries(process.cwd(), packageInfos)
  ]);
  if (findings.length > 0) {
    throw new Error(`Package output marker scrub failed:\n${formatLaunchScrubFindings(findings).join("\n")}`);
  }
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
    if (/(^|\/)\.git(\/|$)|objects\/pack|refs\/heads/.test(path)) {
      throw new Error(`Forbidden copied git history marker in git history ${commit}: ${path}`);
    }
  }

  const grep = spawnSync("git", ["grep", "-I", "-n", "-E", "objects/pack|refs/heads", commit, "--", "."], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (grep.status !== 0 && grep.status !== 1) throw new Error(`Unable to grep git history ${commit}: ${grep.stderr}`);
  const findings = grep.stdout
    .split("\n")
    .filter(Boolean)
    .filter((line) => isCopiedHistoryEvidence(line, commit));
  if (findings.length > 0) {
    throw new Error(`Forbidden copied git history provenance in ${commit}:\n${findings.join("\n")}`);
  }
}

function isCopiedHistoryEvidence(line, commit) {
  const parsed = parseHistoryGrepLine(line, commit);
  if (!parsed) return false;
  if (isProvenancePolicyPath(parsed.path)) return false;
  if (/objects\/pack/.test(parsed.text)) return true;
  for (const match of parsed.text.matchAll(/refs\/heads\/[A-Za-z0-9._/-]+/g)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const quote = parsed.text[start - 1];
    if (!((quote === `"` || quote === `'` || quote === "`") && parsed.text[end] === quote)) return true;
  }
  return false;
}

function isProvenancePolicyPath(path) {
  return path === "scripts/check-provenance.mjs" || path === "tests/provenance-policy.test.mjs";
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

function provenanceMarkdown(scannedFileCount, historyCommitCount) {
  return `# Provenance Receipts

Maintainer provenance evidence for the Opcore release gate.

- Current-tree files scanned: ${scannedFileCount}
- Git-history commits scanned: ${historyCommitCount}
- Generated provider/build state findings: 0
- Copied git-history marker findings: 0
- Package-boundary findings: 0
`;
}

function readDirNames(path) {
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function checkPackageJson(path) {
  const manifest = JSON.parse(readFileSync(path, "utf8"));
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

function assertRepoRelative(value, label) {
  const normalized = normalize(value).replaceAll("\\", "/");
  if (isAbsolute(value) || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error(`${label} must not contain absolute or parent paths`);
  }
}
