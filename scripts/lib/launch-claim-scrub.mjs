import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

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
  { label: "ACE-managed distribution claim", pattern: /\bACE[- ]managed\b|\bACE[- ]provision/i }
];

export function scrubLaunchClaims(text) {
  return forbiddenLaunchClaims.filter((claim) => claim.pattern.test(text)).map((claim) => claim.label);
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
