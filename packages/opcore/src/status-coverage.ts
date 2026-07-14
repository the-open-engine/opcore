import type { OpcoreRepoStatePayload } from "@the-open-engine/opcore-contracts";
import { basename, extname } from "node:path";

type SourcePolicyState = "supported" | "retained" | "unsupported";

interface SourcePolicy {
  language: string;
  unsupportedStack?: string;
  graphSupported: boolean;
  validationSupported: boolean;
  retained: boolean;
  state: SourcePolicyState;
}

interface CoverageAccumulator {
  graphCounts: Map<string, number>;
  validationCounts: Map<string, number>;
  unsupportedCounts: Map<string, { language: string; count: number; examples: string[] }>;
  languageCounts: Map<string, { files: number; graphSupported: boolean; validationSupported: boolean }>;
  graphSupportedFiles: number;
  validationSupportedFiles: number;
  retainedFiles: number;
}

function supportedPolicy(language: string, graphSupported: boolean, validationSupported: boolean): SourcePolicy {
  return { language, graphSupported, validationSupported, retained: false, state: "supported" };
}

function retainedPolicy(language: string): SourcePolicy {
  return { language, graphSupported: false, validationSupported: false, retained: true, state: "retained" };
}

function unsupportedPolicy(language: string, unsupportedStack = language): SourcePolicy {
  return { language, unsupportedStack, graphSupported: false, validationSupported: false, retained: false, state: "unsupported" };
}

// Keep this status policy in lockstep with crates/graph-core/src/extraction/language.rs.
const sourcePolicies = new Map<string, SourcePolicy>([
  [".ts", supportedPolicy("TypeScript", true, true)],
  [".tsx", supportedPolicy("TypeScript", true, true)],
  [".js", supportedPolicy("JavaScript", true, true)],
  [".jsx", supportedPolicy("JavaScript", true, true)],
  [".mts", supportedPolicy("TypeScript", true, true)],
  [".cts", supportedPolicy("TypeScript", true, true)],
  [".rs", supportedPolicy("Rust", true, true)],
  [".inc", supportedPolicy("Rust", false, true)],
  ["Cargo.toml", supportedPolicy("Rust", false, true)],
  ["Cargo.lock", retainedPolicy("Rust")],
  [".py", supportedPolicy("Python", true, true)],
  [".pyi", supportedPolicy("Python", true, true)],
  [".mjs", unsupportedPolicy("JavaScript", "ESM JavaScript")],
  [".cjs", unsupportedPolicy("JavaScript", "CommonJS JavaScript")],
  [".vue", unsupportedPolicy("Vue")],
  [".svelte", unsupportedPolicy("Svelte")],
  [".go", unsupportedPolicy("Go")],
  [".java", unsupportedPolicy("Java")],
  [".rb", unsupportedPolicy("Ruby")],
  [".php", unsupportedPolicy("PHP")],
  [".swift", unsupportedPolicy("Swift")],
  [".kt", unsupportedPolicy("Kotlin")],
  [".kts", unsupportedPolicy("Kotlin")],
  [".scala", unsupportedPolicy("Scala")],
  [".lua", unsupportedPolicy("Lua")],
  [".cs", unsupportedPolicy("C#")],
  [".c", unsupportedPolicy("C")],
  [".cc", unsupportedPolicy("C++")],
  [".cpp", unsupportedPolicy("C++")],
  [".h", unsupportedPolicy("C/C++ Header")],
  [".hpp", unsupportedPolicy("C++ Header")]
]);

export function computeCoverage(files: readonly string[]): OpcoreRepoStatePayload["coverage"] {
  const accumulator = createAccumulator();
  for (const file of files) recordFileCoverage(accumulator, file);
  return coverageResult(accumulator, files.length);
}

function createAccumulator(): CoverageAccumulator {
  return {
    graphCounts: new Map(),
    validationCounts: new Map(),
    unsupportedCounts: new Map(),
    languageCounts: new Map(),
    graphSupportedFiles: 0,
    validationSupportedFiles: 0,
    retainedFiles: 0
  };
}

function recordFileCoverage(accumulator: CoverageAccumulator, file: string): void {
  const kind = fileKind(file);
  const policy = sourcePolicies.get(kind);
  if (!policy) return;
  if (policy.graphSupported) {
    accumulator.graphSupportedFiles += 1;
    increment(accumulator.graphCounts, kind);
  }
  if (policy.validationSupported) {
    accumulator.validationSupportedFiles += 1;
    increment(accumulator.validationCounts, kind);
  }
  if (policy.retained) accumulator.retainedFiles += 1;
  if (!policy.graphSupported && !policy.validationSupported && !policy.retained) {
    recordUnsupported(accumulator.unsupportedCounts, kind, policy, file);
  }
  recordLanguage(accumulator.languageCounts, policy);
}

function recordUnsupported(
  counts: CoverageAccumulator["unsupportedCounts"],
  kind: string,
  policy: SourcePolicy,
  file: string
): void {
  const current = counts.get(kind) ?? { language: policy.unsupportedStack ?? policy.language, count: 0, examples: [] };
  current.count += 1;
  if (current.examples.length < 3) current.examples.push(file);
  counts.set(kind, current);
}

function recordLanguage(counts: CoverageAccumulator["languageCounts"], policy: SourcePolicy): void {
  const validationSupported = policy.validationSupported || policy.retained;
  const current = counts.get(policy.language) ?? {
    files: 0,
    graphSupported: policy.graphSupported,
    validationSupported
  };
  current.files += 1;
  current.graphSupported ||= policy.graphSupported;
  current.validationSupported ||= validationSupported;
  counts.set(policy.language, current);
}

function coverageResult(
  accumulator: CoverageAccumulator,
  totalFiles: number
): OpcoreRepoStatePayload["coverage"] {
  return {
    totalFiles,
    languages: [...accumulator.languageCounts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([language, value]) => ({ language, ...value })),
    graph: {
      supportedFiles: accumulator.graphSupportedFiles,
      extensions: countEntries(accumulator.graphCounts)
    },
    validation: {
      supportedFiles: accumulator.validationSupportedFiles,
      retainedFiles: accumulator.retainedFiles,
      extensions: countEntries(accumulator.validationCounts)
    },
    unsupported: {
      totalFiles: [...accumulator.unsupportedCounts.values()].reduce((sum, entry) => sum + entry.count, 0),
      stacks: [...accumulator.unsupportedCounts.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([extension, value]) => ({ extension, ...value }))
    }
  };
}

function fileKind(file: string): string {
  const name = basename(file);
  if (name === "Cargo.toml" || name === "Cargo.lock") return name;
  return extname(name);
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function countEntries(map: Map<string, number>): { extension: string; count: number }[] {
  return [...map.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([extension, count]) => ({ extension, count }));
}
