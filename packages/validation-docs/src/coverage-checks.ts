import type {
  GraphFactEdge,
  GraphFactNode,
  RequiredContextDocPolicy
} from "@the-open-engine/opcore-contracts";
import type {
  ValidationCheckContext,
  ValidationCheckDefinition
} from "@the-open-engine/opcore-validation";
import {
  countPhysicalLines,
  graphFactNodePath,
  graphFactPathFromEndpoint
} from "@the-open-engine/opcore-validation";
import {
  defaultDocsHubCoverageThresholds,
  repoWideDocsValidationScopes
} from "./check-constants.js";
import {
  DOCS_HUB_COVERAGE_CHECK_ID,
  DOCS_SUBTREE_COVERAGE_CHECK_ID
} from "./check-ids.js";
import { docsCheck } from "./check-definition.js";
import { withSelectedDocs } from "./document-check.js";
import { diagnostic } from "./diagnostics.js";
import type {
  CreateDocsValidationChecksOptions,
  DocsHubCoverageOptions
} from "./options.js";
import {
  isDocsPath,
  pathBasename,
  type DocsDocument
} from "./snapshot.js";

export function createDocsHubCoverageCheck(
  options: CreateDocsValidationChecksOptions = {}
): ValidationCheckDefinition {
  return {
    ...docsCheck(
      DOCS_HUB_COVERAGE_CHECK_ID,
      "warning",
      repoWideDocsValidationScopes,
      async (context) => {
        return withSelectedDocs(context, options, async (snapshot) => {
          const [nodeResult, importsFrom] = await Promise.all([
            context.graph.facts({
              kind: "nodes",
              nodeKinds: ["File", "file", "Module"]
            }),
            context.graph.importsFrom()
          ]);
          const hubs = hubPaths(
            nodeResult.nodes,
            importsFrom,
            snapshot.policy,
            options.hubCoverage
          );
          return hubs
            .filter(
              (hub) =>
                !docsMentionPath(
                  snapshot.docs,
                  hub.path,
                  options.hubCoverage?.requireExplicitMention === true
                )
            )
            .map((hub) =>
              diagnostic({
                severity: "warning",
                category: "graph",
                code: "DOCS_HUB_UNDOCUMENTED",
                message:
                  `Graph hub ${hub.path} has ${hub.fanIn} incoming and ` +
                  `${hub.fanOut} outgoing IMPORTS_FROM edges but is not ` +
                  "mentioned in discovered context docs."
              })
            );
        });
      }
    ),
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

export function createDocsSubtreeCoverageCheck(
  options: CreateDocsValidationChecksOptions = {}
): ValidationCheckDefinition {
  return docsCheck(
    DOCS_SUBTREE_COVERAGE_CHECK_ID,
    "warning",
    repoWideDocsValidationScopes,
    async (context) => {
      return withSelectedDocs(context, options, async (snapshot) => {
        const configuredMinLoc = options.subtreeCoverage?.minLoc;
        const minLoc = configuredMinLoc === undefined ? 10_000 : configuredMinLoc;
        const subtrees = await sourceSubtreeLoc(context);
        return [...subtrees]
          .filter(([, loc]) => loc >= minLoc)
          .filter(([subtree]) => !docsMentionPath(snapshot.docs, subtree, true))
          .map(([subtree, loc]) =>
            diagnostic({
              severity: "warning",
              path: subtree,
              code: "DOCS_SUBTREE_UNDOCUMENTED",
              message:
                `Source subtree ${subtree} has ${loc} lines but is not ` +
                "explicitly mentioned in discovered context docs."
            })
          );
      });
    }
  );
}

function hubPaths(
  nodes: readonly GraphFactNode[],
  edges: readonly GraphFactEdge[],
  policy: RequiredContextDocPolicy,
  options: DocsHubCoverageOptions | undefined
): readonly { path: string; fanIn: number; fanOut: number }[] {
  const nodePaths = new Set(
    nodes
      .map(graphFactNodePath)
      .filter(
        (path): path is string =>
          path !== undefined && !isDocsPath(path, policy)
      )
  );
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, number>();
  for (const edge of edges) {
    if (edge.kind !== "IMPORTS_FROM") continue;
    incrementPathCount(outgoing, graphFactPathFromEndpoint(edge.from), nodePaths);
    incrementPathCount(incoming, graphFactPathFromEndpoint(edge.to), nodePaths);
  }
  const minFanIn =
    options?.minFanIn ?? defaultDocsHubCoverageThresholds.minFanIn;
  const minFanOut = options?.minFanOut;
  return [...nodePaths]
    .map((path) => ({
      path,
      fanIn: incoming.get(path) ?? 0,
      fanOut: outgoing.get(path) ?? 0
    }))
    .filter(
      (hub) =>
        hub.fanIn >= minFanIn ||
        (minFanOut !== undefined && hub.fanOut >= minFanOut)
    )
    .sort(
      (left, right) =>
        right.fanIn - left.fanIn ||
        right.fanOut - left.fanOut ||
        left.path.localeCompare(right.path)
    );
}

function incrementPathCount(
  counts: Map<string, number>,
  path: string | undefined,
  allowed: ReadonlySet<string>
): void {
  if (path === undefined || !allowed.has(path)) return;
  counts.set(path, (counts.get(path) ?? 0) + 1);
}

function docsMentionPath(
  docs: readonly DocsDocument[],
  path: string,
  requireExplicit = false
): boolean {
  const basename = pathBasename(path).toLowerCase();
  const normalizedPath = path.toLowerCase();
  return docs.some((doc) => {
    const content = doc.content.toLowerCase();
    return (
      content.includes(normalizedPath) ||
      (!requireExplicit && content.includes(basename))
    );
  });
}

async function sourceSubtreeLoc(
  context: ValidationCheckContext
): Promise<ReadonlyMap<string, number>> {
  const totals = new Map<string, number>();
  const visibleFiles = await context.fileView.listVisibleFiles();
  for (const path of visibleFiles) {
    if (isDocsPath(path) || !isSourceLikePath(path)) continue;
    const result = await context.fileView.readAfter(path);
    if (result.status !== "found") continue;
    const subtree = path.split("/")[0] ?? path;
    totals.set(
      subtree,
      (totals.get(subtree) ?? 0) + countPhysicalLines(result.content)
    );
  }
  return totals;
}

function isSourceLikePath(path: string): boolean {
  return /\.(?:[cm]?[jt]sx?|pyi?|rs|toml)$/iu.test(path);
}
