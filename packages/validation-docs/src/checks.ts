import type { GraphFactEdge, GraphFactNode, RequiredContextDocPolicy, ValidationDiagnostic } from "@the-open-engine/opcore-contracts";
import type { ValidationCheckContext, ValidationCheckDefinition, ValidationCheckResult } from "@the-open-engine/opcore-validation";
import { countPhysicalLines, graphFactNodePath, graphFactPathFromEndpoint, splitPhysicalLines } from "@the-open-engine/opcore-validation";
import {
  defaultDocsHistoryThresholds,
  defaultDocsHubCoverageThresholds,
  docsCheckAdapter,
  docsCheckOwner,
  optInDocsDefaultScopes,
  repoWideDocsValidationScopes,
  supportedDocsValidationScopes
} from "./check-constants.js";
import {
  DOCS_CODE_BLOCKS_CHECK_ID,
  DOCS_CONTENT_QUALITY_CHECK_ID,
  DOCS_DRY_CHECK_ID,
  DOCS_EXISTENCE_CHECK_ID,
  DOCS_FRESHNESS_CHECK_ID,
  DOCS_HUB_COVERAGE_CHECK_ID,
  DOCS_LENGTH_CHECK_ID,
  DOCS_RULES_WHY_CHECK_ID,
  DOCS_SUBTREE_COVERAGE_CHECK_ID,
  DOCS_STALENESS_CHECK_ID
} from "./check-ids.js";
import { diagnostic, sortDiagnostics } from "./diagnostics.js";
import { assertGitHistoryAvailable, latestCommitIso } from "./history.js";
import { runDocsFreshnessCheck } from "./freshness.js";
import {
  isDocsPath,
  materializeDocsSnapshot,
  pathBasename,
  type DocsDocument,
  type DocsPolicyOptions
} from "./snapshot.js";

export interface DocsHistoryOptions {
  now?: string | Date;
  maxStaleDays?: number;
}

export interface DocsHubCoverageOptions {
  minFanIn?: number;
  minFanOut?: number;
  requireExplicitMention?: boolean;
}

export interface DocsSubtreeCoverageOptions {
  minLoc?: number;
}

export interface CreateDocsValidationChecksOptions extends DocsPolicyOptions {
  history?: DocsHistoryOptions;
  hubCoverage?: DocsHubCoverageOptions;
  subtreeCoverage?: DocsSubtreeCoverageOptions;
}

type DocsCheckRunner = (context: ValidationCheckContext) => Promise<ValidationCheckResult> | ValidationCheckResult;

export function createDocsExistenceCheck(options: DocsPolicyOptions = {}): ValidationCheckDefinition {
  return docsCheck(DOCS_EXISTENCE_CHECK_ID, "error", repoWideDocsValidationScopes, async (context) => {
    const snapshot = await materializeDocsSnapshot(context, options);
    const diagnostics = snapshot.requiredLocations
      .filter((location) => location.found.length === 0)
      .map((location) =>
        diagnostic({
          path: location.root === "." ? undefined : location.root,
          code: "DOCS_REQUIRED_CONTEXT_DOC_MISSING",
          message: `Required context doc is missing at ${location.root}: expected ${snapshot.policy.filenames.join(" or ")}.`
        })
      );
    return { diagnostics };
  });
}

export function createDocsStalenessCheck(options: CreateDocsValidationChecksOptions = {}): ValidationCheckDefinition {
  return docsCheck(DOCS_STALENESS_CHECK_ID, "warning", supportedDocsValidationScopes, async (context) => {
    const skipped = await skippedHistoryResult(context, options);
    if (skipped !== undefined) return skipped;
    const snapshot = await materializeDocsSnapshot(context, options);
    if (snapshot.docs.length === 0) return skippedDocsResult("No documentation files were selected.");
    const repoRoot = context.request.repo.repoRoot;
    if (repoRoot === undefined) return skippedHistoryUnavailableResult("Git history is unavailable: request.repo.repoRoot is missing.");
    const now = historyNow(options.history);
    const maxStaleDays = options.history?.maxStaleDays ?? defaultDocsHistoryThresholds.maxStaleDays;
    const diagnostics: ValidationDiagnostic[] = [];

    for (const doc of snapshot.docs) {
      const committed = latestCommitIso(repoRoot, doc.path);
      if (!committed.ok) return skippedHistoryUnavailableResult(committed.message);
      if (committed.value === undefined) continue;
      const ageDays = elapsedDays(committed.value, now);
      if (ageDays > maxStaleDays) {
        diagnostics.push(
          diagnostic({
            severity: "warning",
            path: doc.path,
            code: "DOCS_STALE",
            message: `Documentation was last committed ${Math.floor(ageDays)} days ago, over the ${maxStaleDays}-day staleness threshold.`
          })
        );
      }
    }
    return { diagnostics: sortDiagnostics(diagnostics) };
  });
}

export function createDocsFreshnessCheck(options: CreateDocsValidationChecksOptions = {}): ValidationCheckDefinition {
  return docsCheck(DOCS_FRESHNESS_CHECK_ID, "warning", supportedDocsValidationScopes, (context) =>
    runDocsFreshnessCheck(context, options)
  );
}

export function createDocsLengthCheck(options: DocsPolicyOptions = {}): ValidationCheckDefinition {
  return docsCheck(DOCS_LENGTH_CHECK_ID, "error", supportedDocsValidationScopes, async (context) => {
    const snapshot = await materializeDocsSnapshot(context, options);
    if (snapshot.docs.length === 0) return skippedDocsResult("No documentation files were selected.");
    return {
      diagnostics: sortDiagnostics(
        snapshot.docs.flatMap((doc) => lengthDiagnostics(doc, snapshot.policy))
      )
    };
  });
}

export function createDocsDryCheck(options: DocsPolicyOptions = {}): ValidationCheckDefinition {
  return docsCheck(DOCS_DRY_CHECK_ID, "warning", supportedDocsValidationScopes, async (context) => {
    const snapshot = await materializeDocsSnapshot(context, options);
    if (snapshot.docs.length === 0) return skippedDocsResult("No documentation files were selected.");
    const seen = new Map<string, string>();
    const diagnostics: ValidationDiagnostic[] = [];
    for (const doc of snapshot.docs) {
      for (const paragraph of normalizedParagraphs(doc.content)) {
        const existing = seen.get(paragraph);
        if (existing === undefined) {
          seen.set(paragraph, doc.path);
          continue;
        }
        if (existing === doc.path) continue;
        diagnostics.push(
          diagnostic({
            severity: "warning",
            path: doc.path,
            code: "DOCS_DRY_DUPLICATE_PARAGRAPH",
            message: `Documentation repeats a long paragraph already present in ${existing}.`
          })
        );
        break;
      }
    }
    return { diagnostics: sortDiagnostics(diagnostics) };
  });
}

export function createDocsContentQualityCheck(options: DocsPolicyOptions = {}): ValidationCheckDefinition {
  return docsCheck(DOCS_CONTENT_QUALITY_CHECK_ID, "error", supportedDocsValidationScopes, async (context) => {
    const snapshot = await materializeDocsSnapshot(context, options);
    if (snapshot.docs.length === 0) return skippedDocsResult("No documentation files were selected.");
    return { diagnostics: sortDiagnostics(snapshot.docs.flatMap(contentQualityDiagnostics)) };
  });
}

export function createDocsCodeBlocksCheck(options: DocsPolicyOptions = {}): ValidationCheckDefinition {
  return docsCheck(DOCS_CODE_BLOCKS_CHECK_ID, "error", supportedDocsValidationScopes, async (context) => {
    const snapshot = await materializeDocsSnapshot(context, options);
    if (snapshot.docs.length === 0) return skippedDocsResult("No documentation files were selected.");
    return { diagnostics: sortDiagnostics(snapshot.docs.flatMap(codeBlockDiagnostics)) };
  });
}

export function createDocsRulesWhyCheck(options: DocsPolicyOptions = {}): ValidationCheckDefinition {
  return docsCheck(DOCS_RULES_WHY_CHECK_ID, "error", supportedDocsValidationScopes, async (context) => {
    const snapshot = await materializeDocsSnapshot(context, options);
    if (snapshot.docs.length === 0) return skippedDocsResult("No documentation files were selected.");
    return { diagnostics: sortDiagnostics(snapshot.docs.flatMap(ruleWhyDiagnostics)) };
  });
}

export function createDocsHubCoverageCheck(options: CreateDocsValidationChecksOptions = {}): ValidationCheckDefinition {
  return {
    ...docsCheck(DOCS_HUB_COVERAGE_CHECK_ID, "warning", repoWideDocsValidationScopes, async (context) => {
      const snapshot = await materializeDocsSnapshot(context, options);
      if (snapshot.docs.length === 0) return skippedDocsResult("No documentation files were selected.");
      const [nodeResult, importsFrom] = await Promise.all([
        context.graph.facts({ kind: "nodes", nodeKinds: ["File", "file", "Module"] }),
        context.graph.importsFrom()
      ]);
      const hubs = hubPaths(nodeResult.nodes, importsFrom, snapshot.policy, options.hubCoverage);
      const documentedHubs = hubs.filter((hub) =>
        !docsMentionPath(snapshot.docs, hub.path, options.hubCoverage?.requireExplicitMention === true)
      );
      return {
        diagnostics: documentedHubs.map((hub) =>
          diagnostic({
            severity: "warning",
            category: "graph",
            code: "DOCS_HUB_UNDOCUMENTED",
            message: `Graph hub ${hub.path} has ${hub.fanIn} incoming and ${hub.fanOut} outgoing IMPORTS_FROM edges but is not mentioned in discovered context docs.`
          })
        )
      };
    }),
    requiresGraph: true,
    graphRequirements: () => [
      {
        operation: "factQuery",
        selector: {
          kind: "nodes",
          nodeKinds: ["File", "file", "Module"]
        }
      },
      {
        operation: "factQuery",
        selector: {
          kind: "edges",
          edgeKinds: ["IMPORTS_FROM"]
        }
      }
    ]
  };
}

export function createDocsSubtreeCoverageCheck(options: CreateDocsValidationChecksOptions = {}): ValidationCheckDefinition {
  return docsCheck(DOCS_SUBTREE_COVERAGE_CHECK_ID, "warning", repoWideDocsValidationScopes, async (context) => {
    const snapshot = await materializeDocsSnapshot(context, options);
    if (snapshot.docs.length === 0) return skippedDocsResult("No documentation files were selected.");
    const minLoc = options.subtreeCoverage?.minLoc ?? 10_000;
    const subtrees = await sourceSubtreeLoc(context);
    return {
      diagnostics: sortDiagnostics(
        [...subtrees]
          .filter(([, loc]) => loc >= minLoc)
          .filter(([subtree]) => !docsMentionPath(snapshot.docs, subtree, true))
          .map(([subtree, loc]) =>
            diagnostic({
              severity: "warning",
              path: subtree,
              code: "DOCS_SUBTREE_UNDOCUMENTED",
              message: `Source subtree ${subtree} has ${loc} lines but is not explicitly mentioned in discovered context docs.`
            })
          )
      )
    };
  });
}

function docsCheck(
  id: string,
  defaultSeverity: ValidationDiagnostic["severity"],
  supportedScopes: readonly ValidationCheckDefinition["supportedScopes"][number][],
  run: DocsCheckRunner
): ValidationCheckDefinition {
  return {
    id,
    owner: docsCheckOwner,
    adapter: docsCheckAdapter,
    defaultSeverity,
    supportedScopes,
    defaultScopes: optInDocsDefaultScopes,
    requiresGraph: false,
    run
  };
}

async function skippedHistoryResult(
  context: ValidationCheckContext,
  options: DocsPolicyOptions
): Promise<ValidationCheckResult | undefined> {
  const snapshot = await materializeDocsSnapshot(context, options);
  if (snapshot.hasOverlays) {
    return skippedDocsResult("Documentation Git-history checks require committed state and skip when overlays are present.");
  }
  const repoRoot = context.request.repo.repoRoot;
  if (repoRoot === undefined) {
    return skippedHistoryUnavailableResult("Git history is unavailable: request.repo.repoRoot is missing.");
  }
  const available = assertGitHistoryAvailable(repoRoot);
  return available.ok ? undefined : skippedHistoryUnavailableResult(available.message);
}

function skippedDocsResult(message: string): ValidationCheckResult {
  return {
    status: "skipped",
    diagnostics: [],
    failureMessage: message
  };
}

function skippedHistoryUnavailableResult(message: string): ValidationCheckResult {
  return skippedDocsResult(message.startsWith("Git history is unavailable") ? message : `Git history is unavailable: ${message}`);
}

function lengthDiagnostics(doc: DocsDocument, policy: RequiredContextDocPolicy): readonly ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = [];
  if (doc.content.trim().length < policy.minimumContentLength) {
    diagnostics.push(
      diagnostic({
        path: doc.path,
        code: "DOCS_TOO_SHORT",
        message: `Documentation content is shorter than the ${policy.minimumContentLength}-character require-context-doc policy minimum.`
      })
    );
  }
  const lines = splitPhysicalLines(doc.content);
  const totalLines = countPhysicalLines(doc.content);
  if (policy.maxLines !== undefined && totalLines > policy.maxLines) {
    diagnostics.push(
      diagnostic({
        path: doc.path,
        code: "DOCS_TOO_LONG",
        message: `Documentation has ${totalLines} lines; max is ${policy.maxLines}.`
      })
    );
  }
  if (policy.maxSectionLines !== undefined) {
    const section = longestSectionLineCount(lines);
    if (section > policy.maxSectionLines) {
      diagnostics.push(
        diagnostic({
          path: doc.path,
          code: "DOCS_SECTION_TOO_LONG",
          message: `Documentation section has ${section} lines; max is ${policy.maxSectionLines}.`
        })
      );
    }
  }
  return diagnostics;
}

function historyNow(options: DocsHistoryOptions | undefined): Date {
  if (options?.now instanceof Date) return options.now;
  if (typeof options?.now === "string") return new Date(options.now);
  return new Date();
}

function elapsedDays(iso: string, now: Date): number {
  return (now.getTime() - Date.parse(iso)) / (24 * 60 * 60 * 1000);
}

function normalizedParagraphs(content: string): readonly string[] {
  return content
    .split(/\n\s*\n/u)
    .map((paragraph) => paragraph.replace(/\s+/gu, " ").trim())
    .filter((paragraph) => paragraph.length >= 80 && !paragraph.startsWith("```"));
}

function longestSectionLineCount(lines: readonly string[]): number {
  let current = 0;
  let longest = 0;
  for (const line of lines) {
    if (/^\s*#{1,6}\s+/u.test(line)) {
      longest = Math.max(longest, current);
      current = 1;
      continue;
    }
    current += 1;
  }
  return Math.max(longest, current);
}

function contentQualityDiagnostics(doc: DocsDocument): readonly ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = [];
  const lines = doc.content.split(/\r?\n/u);
  lines.forEach((line, index) => {
    if (/\b(TODO|TBD|FIXME|placeholder|lorem ipsum)\b/iu.test(line)) {
      diagnostics.push(
        diagnostic({
          path: doc.path,
          code: "DOCS_CONTENT_PLACEHOLDER",
          message: `Documentation contains placeholder text on line ${index + 1}.`
        })
      );
    }
    if (/^(<{7}|={7}|>{7})/u.test(line)) {
      diagnostics.push(
        diagnostic({
          path: doc.path,
          code: "DOCS_CONTENT_CONFLICT_MARKER",
          message: `Documentation contains an unresolved conflict marker on line ${index + 1}.`
        })
      );
    }
  });
  return diagnostics;
}

function codeBlockDiagnostics(doc: DocsDocument): readonly ValidationDiagnostic[] {
  if (!isMarkdownLike(doc.path)) return [];
  let openFenceLine: number | undefined;
  const diagnostics: ValidationDiagnostic[] = [];
  doc.content.split(/\r?\n/u).forEach((line, index) => {
    if (!line.trimStart().startsWith("```")) return;
    if (openFenceLine === undefined) {
      openFenceLine = index + 1;
    } else {
      openFenceLine = undefined;
    }
  });
  if (openFenceLine !== undefined) {
    diagnostics.push(
      diagnostic({
        path: doc.path,
        code: "DOCS_CODE_BLOCK_UNCLOSED",
        message: `Markdown code block opened on line ${openFenceLine} is not closed.`
      })
    );
  }
  return diagnostics;
}

function ruleWhyDiagnostics(doc: DocsDocument): readonly ValidationDiagnostic[] {
  if (!doc.requiredContext) return [];
  const diagnostics: ValidationDiagnostic[] = [];
  doc.content.split(/\r?\n/u).forEach((line, index) => {
    const trimmed = line.trim();
    if (!/^(?:[-*]\s*)?(ALWAYS|NEVER|MUST|SHOULD)\b/u.test(trimmed)) return;
    if (/\bWHY:\b/u.test(trimmed) || /\bbecause\b/iu.test(trimmed)) return;
    diagnostics.push(
      diagnostic({
        path: doc.path,
        code: "DOCS_RULE_WITHOUT_WHY",
        message: `Context-doc rule on line ${index + 1} is missing a WHY rationale.`
      })
    );
  });
  return diagnostics;
}

function hubPaths(
  nodes: readonly GraphFactNode[],
  edges: readonly GraphFactEdge[],
  policy: RequiredContextDocPolicy,
  options: DocsHubCoverageOptions | undefined
): readonly { path: string; fanIn: number; fanOut: number }[] {
  const nodePaths = new Set(nodes.map(nodePath).filter((path): path is string => path !== undefined && !isDocsPath(path, policy)));
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, number>();
  for (const edge of edges) {
    if (edge.kind !== "IMPORTS_FROM") continue;
    const sourcePath = endpointPath(edge.from);
    const targetPath = endpointPath(edge.to);
    if (sourcePath !== undefined && nodePaths.has(sourcePath)) {
      outgoing.set(sourcePath, (outgoing.get(sourcePath) ?? 0) + 1);
    }
    if (targetPath !== undefined && nodePaths.has(targetPath)) {
      incoming.set(targetPath, (incoming.get(targetPath) ?? 0) + 1);
    }
  }
  const minFanIn = options?.minFanIn ?? defaultDocsHubCoverageThresholds.minFanIn;
  const minFanOut = options?.minFanOut;
  return [...nodePaths]
    .map((path) => ({ path, fanIn: incoming.get(path) ?? 0, fanOut: outgoing.get(path) ?? 0 }))
    .filter((hub) => hub.fanIn >= minFanIn || (minFanOut !== undefined && hub.fanOut >= minFanOut))
    .sort((left, right) => right.fanIn - left.fanIn || right.fanOut - left.fanOut || left.path.localeCompare(right.path));
}

function docsMentionPath(docs: readonly DocsDocument[], path: string, requireExplicit = false): boolean {
  const basename = pathBasename(path).toLowerCase();
  const normalizedPath = path.toLowerCase();
  return docs.some((doc) => {
    const content = doc.content.toLowerCase();
    return content.includes(normalizedPath) || (!requireExplicit && content.includes(basename));
  });
}

async function sourceSubtreeLoc(context: ValidationCheckContext): Promise<ReadonlyMap<string, number>> {
  const totals = new Map<string, number>();
  for (const path of context.fileView.visibleFiles) {
    if (isDocsPath(path) || !isSourceLikePath(path)) continue;
    const result = await context.fileView.readAfter(path);
    if (result.status !== "found") continue;
    const subtree = firstPathSegment(path);
    totals.set(subtree, (totals.get(subtree) ?? 0) + countPhysicalLines(result.content));
  }
  return totals;
}

function isSourceLikePath(path: string): boolean {
  return /\.(?:[cm]?[jt]sx?|pyi?|rs|toml)$/iu.test(path);
}

function firstPathSegment(path: string): string {
  return path.split("/")[0] ?? path;
}

function nodePath(node: GraphFactNode): string | undefined {
  return graphFactNodePath(node);
}

function endpointPath(endpoint: string): string | undefined {
  return graphFactPathFromEndpoint(endpoint);
}

function isMarkdownLike(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".mdx") || lower.endsWith(".rst") || lower.endsWith(".adoc");
}
