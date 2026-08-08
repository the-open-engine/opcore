import type { GraphSnapshotMetadata } from "../graph/provider-contracts-02.js";
import { validateRepoIdentity } from "./path-validators.js";
import { validateGraphFreshness } from "./validators-01.js";
export {
  collectStrings,
  validateArray,
  validateBoolean,
  validateExactValue,
  validateObject,
  validateOptional,
  validateRequiredObject,
} from "./primitives.js";
import {
  validateRequiredObject,
} from "./primitives.js";

function validateGraphSnapshotMetadata(metadata: GraphSnapshotMetadata): GraphSnapshotMetadata {
  validateRequiredObject(metadata, "Graph snapshot metadata is required");
  if (typeof metadata.schemaVersion !== "number") {
    throw new Error("Graph snapshot metadata must include numeric schemaVersion");
  }
  if (typeof metadata.provider !== "string" || metadata.provider.length === 0) {
    throw new Error("Graph snapshot metadata must include provider");
  }
  validateRepoIdentity(metadata.repo);
  validateGraphFreshness(metadata.freshness, "Graph snapshot");
  if (!Array.isArray(metadata.nodeKinds) || !Array.isArray(metadata.edgeKinds)) {
    throw new Error("Graph snapshot metadata must include nodeKinds and edgeKinds");
  }
  return metadata;
}

export { validateGraphSnapshotMetadata };
