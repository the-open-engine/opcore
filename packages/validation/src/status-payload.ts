import type {
  GraphProviderMode,
  GraphProviderStatus,
  ValidationAdapterRuntimeStatus,
  ValidationStatusPayload
} from "@the-open-engine/lattice-contracts";
import { validateValidationStatusPayload } from "@the-open-engine/lattice-contracts";
import { createValidationCheckManifest, type ValidationCheckDefinition } from "./registry.js";
import { defaultValidationGraphProvider, missingGraphStatus } from "./request.js";

export interface CreateValidationStatusPayloadOptions {
  checks?: readonly ValidationCheckDefinition[];
  graphStatus?: GraphProviderStatus;
  graphMode?: GraphProviderMode;
  generatedAt?: string;
  daemon?: ValidationStatusPayload["daemon"];
  adapters?: readonly ValidationAdapterRuntimeStatus[];
}

export function createValidationStatusPayload(options: CreateValidationStatusPayloadOptions = {}): ValidationStatusPayload {
  const graphMode = options.graphMode ?? options.graphStatus?.mode ?? "optional";
  const entries = createValidationCheckManifest(options.checks ?? []);
  const graphStatus = options.graphStatus ?? missingGraphStatus(graphMode, defaultValidationGraphProvider);
  const payload: ValidationStatusPayload = {
    schemaVersion: 1,
    ready: entries.length > 0 && (graphMode === "optional" || graphStatus.state === "available"),
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    adapterRegistry: {
      checkRoutes: ["files", "staged", "changed", "tree", "all", "manifest"],
      validateRoutes: ["request", "hypothetical", "pre-write", "manifest"],
      checkIds: entries.map((entry) => entry.checkId),
      entries,
      adapters: options.adapters
    },
    graph: {
      mode: graphMode,
      status: graphStatus
    },
    daemon: options.daemon ?? {
      state: "not_configured"
    }
  };
  return validateValidationStatusPayload(payload);
}
