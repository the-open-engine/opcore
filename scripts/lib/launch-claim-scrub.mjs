import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

// Shared claim-scrub patterns for Opcore launch-facing surfaces (EPIC #14).
// Keep these in sync with docs/planning/opcore-alpha-roadmap.md "Public Wording Rules".
// Both scripts/check-release-hygiene.mjs and tests/launch-claim-scrub.test.mjs consume
// this module so the gate and its test never drift apart.
export const forbiddenLaunchClaims = [
  { label: "public ASP standard claim", pattern: /\bASP\b.{0,80}\b(public standard|standard now|standardized|the standard)\b/i },
  { label: "old-tool replacement claim", pattern: /\breplaces?\s+(Rox|CRG|CIX)\b|\b(Rox|CRG|CIX)\b.{0,80}\breplaces?\b/i },
  { label: "generic Opcore replacement claim", pattern: /\bopcore\b[^.\n]{0,40}\breplaces?\b/i },
  { label: "universal stack claim", pattern: /\b(every|all)\s+(stack|language|platform)\b|\buniversal\s+(stack|language|platform)\s+coverage\b/i },
  { label: "universal agent claim", pattern: /\b(every|all)\s+agents?\b|\bworks with every agent\b/i },
  { label: "AI authorship claim", pattern: /\bAI authorship\b|\bauthorship detection\b|\bdetects? AI\b/i },
  { label: "scanner claim", pattern: /\bSAST\b|\bsecurity scanner\b/i },
  { label: "automatic fix claim", pattern: /\bautomatic fixes\b|\bautomatically fixes\b|\bauto-?fix(?:es)?\b/i },
  { label: "unsupported coverage claim", pattern: /\bunsupported (platforms?|languages?|stacks?)\b.{0,80}\b(covered|supported|analyzed)\b/i },
  // EPIC #14 / #15 coordination additions.
  { label: "blended score claim", pattern: /\b(blended|overall|composite|unified|single|aggregate)[\s-]+((quality|health|robustness)[\s-]+)?score\b|\b(quality|health|robustness)[\s-]+score\b/i },
  { label: "asp router command claim", pattern: /\b(opcore|lattice)\s+asp\b/i },
  { label: "provider authority claim", pattern: /\bgate\s+(authority|permission)\b|\bprovider\b[^.\n]{0,40}\b(grants?|confers?|owns?|holds?)\b[^.\n]{0,25}\b(authority|permission|gate decision)\b/i },
  { label: "ACE-managed distribution claim", pattern: /\bACE[- ]managed\b|\bACE[- ]provision/i },
  { label: "old product name", pattern: /\b[Ll]attice\b/ },
  { label: "doubled Opcore token", pattern: /\bOpcore\/Opcore\b/ }
];

export function scrubLaunchClaims(text) {
  return forbiddenLaunchClaims.filter((claim) => claim.pattern.test(text)).map((claim) => claim.label);
}

export function scrubLaunchTextEntries(entries) {
  const findings = [];
  for (const entry of entries) {
    const text = String(entry.text ?? "");
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      for (const claim of forbiddenLaunchClaims) {
        if (!claim.pattern.test(line)) continue;
        if (isAllowlistedLaunchScrubHit(entry, line, claim.label)) continue;
        findings.push({
          entryLabel: entry.label,
          line: index + 1,
          label: claim.label,
          text: line.trim()
        });
      }
    }
  }
  return findings;
}

export function formatLaunchScrubFindings(findings) {
  return findings.map((finding) => `${finding.entryLabel}:${finding.line}: ${finding.label}: ${finding.text}`);
}

export function assertLaunchScrubClean(entries, title = "Launch/package scrub failed") {
  const findings = scrubLaunchTextEntries(entries);
  if (findings.length > 0) throw new Error(`${title}:\n${formatLaunchScrubFindings(findings).join("\n")}`);
}

export function collectLaunchSourceTextEntries(repoRoot) {
  return launchClaimScrubFiles(repoRoot).map((path) => textEntry(repoRoot, "source", path));
}

export function collectPublicRuntimeSourceTextEntries(repoRoot) {
  return walkFiles(join(repoRoot, "packages/validation/src"))
    .filter((path) => path.endsWith(".ts"))
    .map((path) => textEntry(repoRoot, "source-runtime", path));
}

export function collectBuiltDistTextEntries(repoRoot) {
  const packagesDir = join(repoRoot, "packages");
  if (!existsSync(packagesDir)) return [];
  return readdirSync(packagesDir)
    .flatMap((dir) => walkFiles(join(packagesDir, dir, "dist")))
    .filter((path) => isScrubbableTextPath(path))
    .map((path) => textEntry(repoRoot, "built-dist", path));
}

export function collectPackageSourceTextEntries({ repoRoot, packageName, packageRoot, files, labelPrefix = "npm-pack" }) {
  return files
    .filter((path) => isScrubbableTextPath(path))
    .map((path) => {
      const absolutePath = join(repoRoot, packageRoot, path);
      if (!existsSync(absolutePath)) return undefined;
      return {
        label: `${labelPrefix}:${packageName}:package/${path}`,
        path: absolutePath,
        text: readFileSync(absolutePath, "utf8")
      };
    })
    .filter(Boolean);
}

export function collectNpmPackTextEntries(repoRoot, packageInfos) {
  const destination = mkdtempSync(join(tmpdir(), "opcore-launch-scrub-pack-"));
  try {
    return packageInfos.flatMap((info) => {
      const packageRoot = resolve(repoRoot, info.packageRoot);
      const result = spawnSync("npm", ["pack", "--json", "--pack-destination", destination], {
        cwd: packageRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 50 * 1024 * 1024
      });
      if (result.status !== 0) {
        throw new Error(`npm pack failed for ${info.packageName}: ${result.stderr || result.stdout}`);
      }
      const pack = JSON.parse(result.stdout)[0];
      return collectPackageTarballTextEntries(join(destination, pack.filename), `npm-pack:${info.packageName}`);
    });
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
}

export function collectPackageTarballTextEntries(tarballPath, labelPrefix = "npm-pack") {
  const list = runTar(["-tf", tarballPath], `list ${tarballPath}`)
    .split(/\r?\n/)
    .filter((path) => path.length > 0 && isScrubbableTextPath(path));
  return list.map((path) => ({
    label: `${labelPrefix}:${path}`,
    text: runTar(["-xOf", tarballPath, path], `read ${tarballPath}:${path}`)
  }));
}

export function collectInstalledPackageTextEntries(projectRoot, packageNames) {
  return packageNames.flatMap((packageName) => {
    const packageRoot = join(projectRoot, "node_modules", ...packageName.split("/"));
    if (!existsSync(packageRoot)) return [];
    return walkFiles(packageRoot)
      .filter((path) => isScrubbableTextPath(path))
      .map((path) => ({
        label: `installed-package:${packageName}:${relative(packageRoot, path).split("\\").join("/")}`,
        path,
        text: readFileSync(path, "utf8")
      }));
  });
}

// Absolute paths for every launch-facing surface that must survive the claim scrub.
// This is intentionally broader than the naming gate: it covers every public package
// README, not just packages/opcore, so a forbidden claim cannot hide in a sibling page.
export function launchClaimScrubFiles(repoRoot) {
  const explicit = [
    "README.md",
    "docs/quickstart.md",
    "docs/concepts.md",
    "docs/examples.md",
    "docs/agent-integration.md",
    "docs/demo.md",
    "packages/asp-provider/dist/manifests/asp-server.json",
    "packages/opcore/package.json"
  ];
  const packagesDir = join(repoRoot, "packages");
  const packageReadmes = existsSync(packagesDir)
    ? readdirSync(packagesDir)
        .map((dir) => `packages/${dir}/README.md`)
        .filter((rel) => existsSync(join(repoRoot, rel)))
    : [];
  const opcoreSrc = walkFiles(join(repoRoot, "packages/opcore/src"))
    .filter((path) => path.endsWith(".ts"))
    .map((abs) => relative(repoRoot, abs));
  return [...new Set([...explicit, ...packageReadmes, ...opcoreSrc])]
    .filter((rel) => existsSync(join(repoRoot, rel)))
    .sort()
    .map((rel) => join(repoRoot, rel));
}

function walkFiles(rootPath) {
  if (!existsSync(rootPath)) return [];
  const files = [];
  const stack = [rootPath];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      const stats = statSync(path);
      if (stats.isDirectory()) stack.push(path);
      else if (stats.isFile()) files.push(path);
    }
  }
  return files.sort();
}

function textEntry(repoRoot, prefix, path) {
  return {
    label: `${prefix}:${relative(repoRoot, path).split("\\").join("/")}`,
    path,
    text: readFileSync(path, "utf8")
  };
}

function isScrubbableTextPath(path) {
  const normalized = path.split("\\").join("/");
  return /\.(?:cjs|d\.ts|js|json|md|mjs|sha256|ts|tsx|txt|yaml|yml)$/.test(normalized);
}

function runTar(args, label) {
  const result = spawnSync("tar", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 50 * 1024 * 1024
  });
  if (result.status !== 0) throw new Error(`Unable to ${label}: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function isAllowlistedLaunchScrubHit(entry, line, label) {
  return launchScrubAllowlist.some((allowlistEntry) => allowlistEntry.matches(entry, line, label));
}

const launchScrubAllowlist = [
  {
    reason: "roadmap old-name policy warning",
    matches: (_entry, line) => /["'`]Lattice["'`]\s+as product or launch branding/i.test(line)
  },
  {
    reason: "internal graph store path",
    matches: (_entry, line) => /(^|[\\/"'`\s])\.lattice(?:[\\/."'`\s-]|$)/i.test(line)
  },
  {
    reason: "graph watch environment variable",
    matches: (_entry, line) => /\bLATTICE_GRAPH_WATCH_PATHS\b/.test(line)
  },
  {
    reason: "internal graph package and daemon identifiers",
    matches: (_entry, line) => /\blattice-graph(?:-core)?\b|\blattice\.graph\.daemon\b/.test(line)
  },
  {
    reason: "retained generated descriptor path",
    matches: (_entry, line) => /(^|[\\/"'`])dist[\\/]lattice(?:[\\/"'`]|\b)/i.test(line)
  },
  {
    reason: "legacy ASP manifest compatibility marker",
    matches: (_entry, line) =>
      /legacyAspProviderBinMarker|aspDogfoodForbiddenProviderMarkers|dist\/bin\/lattice|lattice(?:["'`,\s]+|-)asp(?:["'`,\s]+|-)provider/i.test(line)
  },
  {
    reason: "ASP provider package/runtime wording",
    matches: (_entry, line) => /\bOpcore ASP (?:provider|state)\b/.test(line)
  },
  {
    reason: "explicit provider authority disclaimer",
    matches: (_entry, line) => /does not grant authority/i.test(line)
  },
  {
    reason: "old-bin policy definitions",
    matches: (entry, line) =>
      /oldBins(?:Absent)?|old public bin|old tool bins|forbiddenPublicBins|forbiddenBin|oldBin|Release receipt package exposes old public bin|oldAliasPattern|manifest\.name\.includes\("lattice"\)|\["lattice",\s*"crg",\s*"cix",\s*"rox"\]/i.test(line) ||
      (/(?:opcore-contracts|packages\/contracts)/.test(entry.label) && /^\s*(?:lattice:\s*true;|"lattice"[:,]?\s*(?:\{|$))/.test(line))
  },
  {
    reason: "ASP dogfood forbidden-marker schema",
    matches: (entry, line) =>
      /(?:opcore-contracts|packages\/contracts)/.test(entry.label) &&
      (/^\s*"opcore asp(?: serve)?",?\s*$/.test(line) || /^\s*"const":\s*"opcore asp(?: serve)?"\s*$/.test(line))
  },
  {
    reason: "internal virtual repository path",
    matches: (_entry, line) => /__lattice_repo__/.test(line)
  },
  {
    reason: "transitional advanced-router implementation names",
    matches: (_entry, line) => /\b(?:runLatticeDirectCli|routeLattice|latticeGraphProvider)\b/.test(line)
  },
  {
    reason: "fixture graph identifiers and metadata keys",
    matches: (entry, line) =>
      /\brepo:lattice\b|lattice_snapshot_metadata|lattice_store/.test(line) ||
      (/graph-reference-evidence/.test(entry.label) && /\blattice-[a-z0-9-]+\b/i.test(line))
  },
  {
    reason: "internal temporary path prefixes",
    matches: (_entry, line) =>
      /lattice-(?:gate|installed-bins|missing-query|release-dry-run|router|validation)|\.lattice-edit/i.test(line)
  }
];
