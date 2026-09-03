import type { CommandExitSemantics, CommandRouterManifest } from "./contracts.js";

const commandExitSemantics: CommandExitSemantics = {
  ok: 0,
  error: 1,
  notImplemented: 2,
  unsupported: 64,
  jsonStable: true,
};

export { commandExitSemantics };

const commandRouterManifest: CommandRouterManifest = {
  schemaVersion: 1,
  packageName: "opcore",
  bins: ["opcore"],
  exitSemantics: commandExitSemantics,
  ownershipBoundaries: [
    {
      owner: "graph",
      summary: "Graph provider owns extraction, persistent facts, freshness, query, search, and impact contracts.",
    },
    {
      owner: "inspect",
      summary: "Inspect owns read-only code intelligence over graph facts and language-service surfaces.",
    },
    {
      owner: "edit",
      summary: "Edit planner owns symbol-aware rename, move, signature, patch, and tree edit orchestration.",
    },
    {
      owner: "validation",
      summary: "Validation owns checks, hypothetical validation, manifests, failure policy, and check status.",
    },
    {
      owner: "runtime",
      summary: "Runtime owns shared router health, help, and doctor surfaces.",
    },
  ],
  commandGroups: [
    {
      name: "graph",
      owner: "graph",
      canonicalCommand: ["opcore", "graph"],
      commands: [
        "build",
        "update",
        "watch",
        "status",
        "query",
        "serve",
        "impact",
        "review-context",
        "detect-changes",
        "search",
      ],
      summary:
        "GraphProvider build, update, watch, status, query, impact, review context, change detection, " +
        "daemon lifecycle, and freshness behavior.",
    },
    {
      name: "inspect",
      owner: "inspect",
      canonicalCommand: ["opcore", "inspect"],
      commands: ["symbols", "definition", "references", "signature", "implementations", "search"],
      summary: "Read-only code intelligence over graph and inspect-owned language services.",
    },
    {
      name: "edit",
      owner: "edit",
      canonicalCommand: ["opcore", "edit"],
      commands: ["exact", "multi", "search-replace", "check", "apply", "patch", "tree", "rename", "move", "signature"],
      summary:
        "Exact edit, multi-edit, search-replace, patch/tree, graph-backed symbol rename/move/signature, " +
        "preview/check, and apply routes.",
    },
    {
      name: "check",
      owner: "validation",
      canonicalCommand: ["opcore", "check"],
      commands: ["files", "staged", "changed", "tree", "all", "manifest"],
      summary: "Mechanical check execution and check manifest behavior.",
    },
    {
      name: "validate",
      owner: "validation",
      canonicalCommand: ["opcore", "validate"],
      commands: ["request", "hypothetical", "pre-write", "manifest"],
      summary: "Hypothetical, pre-write, and validation request behavior.",
    },
    {
      name: "status",
      owner: "runtime",
      canonicalCommand: ["opcore", "status"],
      commands: ["status"],
      summary: "Shared router and runtime health status.",
    },
    {
      name: "doctor",
      owner: "runtime",
      canonicalCommand: ["opcore", "doctor"],
      commands: ["doctor"],
      summary: "Shared runtime diagnostic summary.",
    },
  ],
};

export { commandRouterManifest };
