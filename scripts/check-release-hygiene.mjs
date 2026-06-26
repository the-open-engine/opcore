import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";

const publicDocs = [
  "README.md",
  "docs/quickstart.md",
  "docs/concepts.md",
  "docs/examples.md",
  "docs/agent-integration.md",
  "docs/demo.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CHANGELOG.md",
  "CODE_OF_CONDUCT.md",
  ".changeset/README.md"
];
const communityFiles = [
  ".github/ISSUE_TEMPLATE/bug_report.md",
  ".github/ISSUE_TEMPLATE/feature_request.md",
  ".github/ISSUE_TEMPLATE/docs_issue.md",
  ".github/pull_request_template.md"
];
const releaseEvidenceFiles = [
  "docs/release/license-report.md",
  "docs/release/provenance-receipts.md",
  "docs/release/cutover-receipt.summary.md",
  "docs/release/artifact-attestation.md"
];
const root = JSON.parse(readFileSync("package.json", "utf8"));
const publishScript = readFileSync("scripts/release-publish.mjs", "utf8");

for (const scriptName of [
  "license:report",
  "release-receipt:check",
  "release-receipt:receipt",
  "cutover:check",
  "cutover:receipt",
  "release:dry-run",
  "release:publish"
]) {
  if (!root.scripts?.[scriptName]) throw new Error(`Root package must expose ${scriptName}`);
}

for (const path of [...publicDocs, ...communityFiles]) requireFile(path);

for (const token of ["npm\", [\"token\", \"list\", \"--json\"]", "bypass_2fa", "package write permission"]) {
  if (!publishScript.includes(token)) throw new Error(`scripts/release-publish.mjs must include npm publish readiness token: ${token}`);
}

const readme = readFileSync("README.md", "utf8");
for (const token of [
  "Local code scans, honest coverage, setup guidance, and changed-file validation for coding agents.",
  "npm install -g @the-open-engine/opcore@0.1.0-alpha.0",
  "opcore try",
  "opcore --repo .",
  "opcore init --repo . --approve",
  "opcore check --changed --json",
  "opcore measure --repo .",
  "0.1.0-alpha.0",
  "darwin-arm64",
  "linux-x64"
]) {
  if (!readme.includes(token)) throw new Error(`README.md must include ${token}`);
}

for (const path of publicDocs) {
  const content = readFileSync(path, "utf8");
  if (/(private repo|unreleased|before public release|covibes\/covibes#)/i.test(content)) {
    throw new Error(`${path} contains stale private-release wording`);
  }
}

checkLaunchNaming();
checkLaunchClaims();

for (const path of releaseEvidenceFiles) {
  requireFile(path);
  const content = readFileSync(path, "utf8");
  if (!/(maintainer|release|provenance|cutover|artifact)/i.test(content)) {
    throw new Error(`${path} must describe maintainer release evidence`);
  }
}

console.log("release hygiene check passed");

function requireFile(path) {
  if (!existsSync(path)) throw new Error(`Missing release hygiene file: ${path}`);
}

function checkLaunchNaming() {
  const findings = [];
  for (const path of launchFacingFiles()) {
    const content = readFileSync(path, "utf8");
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!/[Ll]attice/.test(line)) continue;
      if (isAllowlistedOldNameHit(path, line)) continue;
      findings.push(`${path}:${index + 1}: ${line.trim()}`);
    }
  }
  if (findings.length > 0) {
    throw new Error(`Launch-facing Opcore naming gate failed:\n${findings.join("\n")}`);
  }
}

function checkLaunchClaims() {
  const forbiddenClaims = [
    { label: "public ASP standard claim", pattern: /\bASP\b.{0,80}\b(public standard|standard now|standardized)\b/i },
    { label: "old-tool replacement claim", pattern: /\breplaces?\s+(Rox|CRG|CIX)\b|\b(Rox|CRG|CIX)\b.{0,80}\breplaces?\b/i },
    { label: "universal stack claim", pattern: /\b(every|all)\s+(stack|language|platform)\b|\buniversal\s+(stack|language|platform)\s+coverage\b/i },
    { label: "universal agent claim", pattern: /\b(every|all)\s+agents?\b|\bworks with every agent\b/i },
    { label: "AI authorship claim", pattern: /\bAI authorship\b|\bauthorship detection\b|\bdetects? AI\b/i },
    { label: "scanner claim", pattern: /\bSAST\b|\bsecurity scanner\b/i },
    { label: "automatic fix claim", pattern: /\bautomatic fixes\b|\bautomatically fixes\b|\bauto-?fix(?:es)?\b/i },
    { label: "unsupported coverage claim", pattern: /\bunsupported (platforms?|languages?|stacks?)\b.{0,80}\b(covered|supported|analyzed)\b/i }
  ];
  const findings = [];
  for (const path of launchFacingFiles()) {
    const content = readFileSync(path, "utf8");
    for (const claim of forbiddenClaims) {
      if (claim.pattern.test(content)) findings.push(`${path}: ${claim.label}`);
    }
  }
  if (findings.length > 0) {
    throw new Error(`Launch-facing claim scrub failed:\n${findings.join("\n")}`);
  }
}

function launchFacingFiles() {
  return [
    "README.md",
    "docs/quickstart.md",
    "docs/concepts.md",
    "docs/examples.md",
    "docs/agent-integration.md",
    "docs/demo.md",
    "packages/opcore/README.md",
    "packages/opcore/package.json",
    ...walkFiles("packages/opcore/src").filter((path) => path.endsWith(".ts"))
  ];
}

function walkFiles(rootPath) {
  const files = [];
  const stack = [rootPath];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    for (const entry of readdirSync(current)) {
      const path = `${current}/${entry}`;
      const stats = statSync(path);
      if (stats.isDirectory()) stack.push(path);
      else if (stats.isFile()) files.push(path);
    }
  }
  return files.sort();
}

function isAllowlistedOldNameHit(path, line) {
  const trimmed = line.trim();
  const allowlist = [
    {
      reason: "transitional internal package dependency",
      matches: () => path === "packages/opcore/package.json" && /"@the-open-engine\/lattice-(contracts|graph|validation|validation-rust|validation-typescript)"/.test(trimmed)
    },
    {
      reason: "transitional repository URL",
      matches: () => path === "packages/opcore/package.json" && /github\.com\/the-open-engine\/lattice\.git/.test(trimmed)
    },
    {
      reason: "transitional internal package import",
      matches: () => path.startsWith("packages/opcore/src/") && /@the-open-engine\/lattice-(contracts|graph|validation|validation-rust|validation-typescript)/.test(trimmed)
    },
    {
      reason: "internal graph provider id",
      matches: () => path.startsWith("packages/opcore/src/") && /lattice-graph/.test(trimmed)
    },
    {
      reason: "internal skipped cache directory",
      matches: () => path.startsWith("packages/opcore/src/") && /"\.lattice"/.test(trimmed)
    },
    {
      reason: "internal adapter message normalization",
      matches: () => path === "packages/opcore/src/check.ts" && /replace\(\^?\/?\^?lattice/.test(trimmed)
    }
  ];
  return allowlist.some((entry) => entry.matches());
}
