import {
  validateExactValue,
  validateOptional,
  validateRequiredObject,
} from "../shared/validators-02.js";
import { includesString } from "../shared/primitives.js";
import { validateRepoIdentity } from "../shared/path-validators.js";
import { validateNonEmptyString } from "../shared/validators-01.js";
import type { GraphServeTransportStatus } from "./pipeline-contracts.js";
import {
  validateGraphProviderArtifactMetadata,
  validateProviderFailure,
} from "./protocol-validators.js";

function validateGraphServeTransportStatus(status: GraphServeTransportStatus): GraphServeTransportStatus {
  validateRequiredObject(status, "Graph serve transport status is required");
  validateExactValue(status.schemaVersion, 1, "Graph serve transport status schemaVersion must be 1");
  validateExactValue(
    status.protocol,
    "opcore.graph.daemon",
    "Graph serve transport status protocol must be opcore.graph.daemon",
  );
  validateExactValue(status.transport, "stdio", "Graph serve transport status transport must be stdio");
  if (!includesString(["ready", "error", "stopped"] as const, status.state)) {
    throw new Error(`Unknown graph serve transport state: ${String(status.state)}`);
  }
  validateRepoIdentity(status.repo);
  validateNonEmptyString(status.provider, "Graph serve transport status provider");
  validateOptional(status.pid, validateGraphServePid);
  validateOptional(status.artifact, validateGraphProviderArtifactMetadata);
  validateOptional(status.failure, validateProviderFailure);
  if (status.state === "error" && status.failure === undefined) {
    throw new Error("Graph serve transport error status must include failure");
  }
  validateOptional(status.message, (value) =>
    validateNonEmptyString(value, "Graph serve transport status message"),
  );
  return status;
}

export { validateGraphServeTransportStatus };

function validateGraphServePid(pid: number): void {
  if (!Number.isInteger(pid) || pid < 1) {
    throw new Error("Graph serve transport status pid must be positive");
  }
}
