import { includesString } from "../shared/primitives.js";
import { validateExactStringSet, validateNonEmptyArray } from "../shared/validators-01.js";
import type {
  GraphReleaseCoreCommandId,
  GraphReleaseHandoffIssue,
  GraphReleaseRustCommandId} from "./graph-vocabulary-01.js";
import {
  graphReleaseHandoffIssues,
} from "./graph-vocabulary-01.js";
import type { GraphReleaseServeTransportId} from "./graph-vocabulary-02.js";
import { graphReleaseServeTransportIds } from "./graph-vocabulary-02.js";
import type { ReleaseReceiptPackageEvidence } from "./receipt-contracts-01.js";
import { validateReleaseReceiptPackage } from "./receipt-validators-01.js";
import { releaseReceiptPackageNames } from "./vocabulary-01.js";

function validateGraphReleaseHandoffIssue(issue: unknown): GraphReleaseHandoffIssue {
  if (!includesString(graphReleaseHandoffIssues, issue)) {
    throw new Error(`Unknown graph release handoff issue: ${String(issue)}`);
  }
  return issue;
}

export { validateGraphReleaseHandoffIssue };

function validateGraphReleaseServeTransportId(id: unknown): GraphReleaseServeTransportId {
  if (!includesString(graphReleaseServeTransportIds, id)) {
    throw new Error(`Unknown graph release serve transport id: ${String(id)}`);
  }
  return id;
}

export { validateGraphReleaseServeTransportId };

function graphReleaseOperationForServeTransportId(id: GraphReleaseServeTransportId): string {
  return id.replace("serve-jsonl-", "");
}

export { graphReleaseOperationForServeTransportId };

function graphReleaseRouteForCommandId(id: GraphReleaseCoreCommandId): {
  bin: "opcore";
  command: readonly string[];
  canonicalCommand: readonly string[];
} {
  const command = id.replace("opcore-graph-", "");
  return {
    bin: "opcore",
    command: ["graph", command],
    canonicalCommand: ["opcore", "graph", command],
  };
}

export { graphReleaseRouteForCommandId };

function graphReleaseRouteForRustCommandId(id: GraphReleaseRustCommandId): {
  bin: "opcore";
  command: readonly string[];
  canonicalCommand: readonly string[];
} {
  const command = id.replace("opcore-graph-rust-", "");
  return {
    bin: "opcore",
    command: ["graph", command],
    canonicalCommand: ["opcore", "graph", command],
  };
}

export { graphReleaseRouteForRustCommandId };

function validateReleaseReceiptPackages(packages: readonly ReleaseReceiptPackageEvidence[]): void {
  validateNonEmptyArray(packages, "Release receipt package evidence");
  validateExactStringSet(
    packages.map((entry) => entry.packageName),
    releaseReceiptPackageNames,
    "Release receipt package evidence",
  );
  for (const packageEvidence of packages) validateReleaseReceiptPackage(packageEvidence);
}

export { validateReleaseReceiptPackages };
