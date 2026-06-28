import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createValidationRunner } from "../../packages/validation/dist/index.js";
import {
  DOCS_EXISTENCE_CHECK_ID,
  createDocsValidationChecks
} from "../../packages/validation-docs/dist/index.js";

export function runner(options = {}) {
  return createValidationRunner({
    workspace: workspace(options),
    checks: options.checks ?? createDocsValidationChecks(),
    graphProviderClient: options.graphProviderClient
  });
}

export function request(overrides = {}) {
  return {
    requestId: "validation-docs-1",
    repo: {
      repoId: "opcore-docs-test"
    },
    scope: {
      kind: "repo"
    },
    graph: {
      mode: "optional",
      provider: "opcore-graph"
    },
    overlays: [],
    checks: [DOCS_EXISTENCE_CHECK_ID],
    ...overrides
  };
}

export function nodeWorkspace(root) {
  return {
    readFile: (path) => {
      try {
        return { status: "found", content: readFileSync(join(root, path), "utf8") };
      } catch {
        return { status: "missing" };
      }
    },
    listRepoFiles: () => ({ files: walkFiles(root) }),
    listChangedFiles: () => ({ files: walkFiles(root) }),
    listStagedFiles: () => ({ files: walkFiles(root) }),
    listPackageFiles: (_packageName, packageRoot) => ({
      files: walkFiles(root).filter((path) => path === packageRoot || path.startsWith(`${packageRoot}/`))
    })
  };
}

export function validGuidance(topic) {
  return [
    "UPDATE THIS FILE when making architectural changes, adding patterns, or changing conventions.",
    "",
    `# ${topic}`,
    "",
    "ALWAYS keep validation behavior generic across repositories - WHY: release checks must not depend on one private workspace.",
    "",
    "Use package-owned adapters and shared contracts when adding validation checks.",
    "Document any convention changes in the relevant repository guidance before changing behavior.",
    ""
  ].join("\n");
}

export function git(cwd, args, env = {}) {
  const result = spawnSync("git", args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

export function graphClient(overrides = {}) {
  return {
    status: (validationRequest) => availableStatus(validationRequest.graph.mode, validationRequest.repo),
    factQuery: (query) => availableFactResult(query, [], []),
    namedQuery: () => {
      throw new Error("unexpected namedQuery");
    },
    impact: () => {
      throw new Error("unexpected impact");
    },
    reviewContext: () => {
      throw new Error("unexpected reviewContext");
    },
    detectChanges: () => {
      throw new Error("unexpected detectChanges");
    },
    ...overrides
  };
}

export function availableFactResult(query, nodes, edges) {
  return {
    requestId: query.requestId,
    status: availableStatus(query.mode, query.repo),
    metadata: {
      schemaVersion: 1,
      provider: "opcore-graph",
      repo: query.repo,
      generatedAt: "2024-04-15T00:00:00.000Z",
      freshness: freshness(),
      nodeKinds: ["File", "file"],
      edgeKinds: ["IMPORTS_FROM"]
    },
    nodes: graphNodesForSelector(query, nodes),
    edges: graphEdgesForSelector(query, edges)
  };
}

export function graphNodesForSelector(query, nodes) {
  if (query.selector.kind !== "nodes" && query.selector.kind !== "symbols") return [];
  const ids = new Set(query.selector.ids ?? []);
  const kinds = new Set(query.selector.nodeKinds ?? []);
  return nodes.filter((node) => {
    if (ids.size > 0 && !ids.has(node.id)) return false;
    if (kinds.size > 0 && !kinds.has(node.kind)) return false;
    return true;
  });
}

export function graphEdgesForSelector(query, edges) {
  if (query.selector.kind !== "edges") return [];
  const kinds = new Set(query.selector.edgeKinds ?? []);
  return edges.filter((edge) => kinds.size === 0 || kinds.has(edge.kind));
}

export function fileNode(path) {
  return {
    id: `file:${path}`,
    kind: "File",
    path,
    name: path.split("/").at(-1),
    attributes: { language: path.endsWith(".ts") ? "typescript" : "unknown" }
  };
}

function workspace(options = {}) {
  const files = new Map(Object.entries(options.files ?? { "AGENTS.md": validGuidance("default guidance") }));
  return {
    readFile: (path) => (files.has(path) ? { status: "found", content: files.get(path) } : { status: "missing" }),
    listChangedFiles: () => ({ files: [...files.keys()] }),
    listStagedFiles: () => ({ files: [...files.keys()] }),
    listRepoFiles: () => ({ files: [...files.keys()] }),
    listPackageFiles: (_packageName, packageRoot) => ({
      files: [...files.keys()].filter((path) => path === packageRoot || path.startsWith(`${packageRoot}/`))
    })
  };
}

function walkFiles(root, prefix = "") {
  const files = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const path = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...walkFiles(root, path));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

function availableStatus(mode = "optional", repo = { repoId: "opcore-docs-test" }) {
  return {
    state: "available",
    mode,
    provider: "opcore-graph",
    schemaVersion: 1,
    repo,
    freshness: freshness(),
    nodes_by_kind: {},
    edges_by_kind: {}
  };
}

function freshness() {
  return {
    state: "fresh",
    ageMs: 0,
    stale: false,
    generatedAt: "2024-04-15T00:00:00.000Z"
  };
}
