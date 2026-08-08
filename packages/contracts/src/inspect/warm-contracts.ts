import type { EditRefusal, RepoRelativeChange } from "../edit/contracts.js";
import type { CommandTiming } from "../product/latency-contracts.js";
import type { InspectReferenceEntry, InspectReferenceTarget } from "./contracts-01.js";
import type { InspectRouteFailure } from "./contracts-02.js";

const aspWarmMethodNames = ["inspect/references", "edit/rename", "check/evaluate", "session/shutdown"] as const;

export { aspWarmMethodNames };

type AspWarmMethodName = (typeof aspWarmMethodNames)[number];

export type { AspWarmMethodName };

interface AspWarmProviderSummary {
  id: "opcore";
  capabilityFamily: "inspect" | "edit" | "session";
}

export type { AspWarmProviderSummary };

interface AspWarmInspectReferencesParams {
  path: string;
  symbolName: string;
  line?: number;
  column?: number;
  limit?: number;
}

export type { AspWarmInspectReferencesParams };

interface AspWarmInspectReferencesOkResult {
  route: "references";
  status: "ok";
  target: InspectReferenceTarget;
  references: readonly InspectReferenceEntry[];
}

export type { AspWarmInspectReferencesOkResult };

interface AspWarmInspectReferencesErrorResult {
  route: "references";
  status: "error";
  target?: InspectReferenceTarget;
  failure: InspectRouteFailure;
}

export type { AspWarmInspectReferencesErrorResult };

interface AspWarmInspectReferencesResponse {
  provider: AspWarmProviderSummary;
  inspectResult: AspWarmInspectReferencesOkResult | AspWarmInspectReferencesErrorResult;
  timing: CommandTiming;
}

export type { AspWarmInspectReferencesResponse };

interface SymbolEditTarget {
  path: string;
  name: string;
  line?: number;
  column?: number;
  nodeId?: string;
}

export type { SymbolEditTarget };

interface AspWarmEditRenameParams {
  target: SymbolEditTarget;
  newName: string;
}

export type { AspWarmEditRenameParams };

interface AspWarmAffectedChecksum {
  path: string;
  checksumBefore?: string;
  checksumAfter?: string;
}

export type { AspWarmAffectedChecksum };

interface AspWarmEditRenamePreviewResult {
  route: "rename";
  status: "preview";
  changes: readonly RepoRelativeChange[];
  affectedChecksums: readonly AspWarmAffectedChecksum[];
}

export type { AspWarmEditRenamePreviewResult };

interface AspWarmEditRenameRefusedResult {
  route: "rename";
  status: "refused";
  refusal: EditRefusal;
}

export type { AspWarmEditRenameRefusedResult };

interface AspWarmEditRenameResponse {
  provider: AspWarmProviderSummary;
  editResult: AspWarmEditRenamePreviewResult | AspWarmEditRenameRefusedResult;
  timing: CommandTiming;
}

export type { AspWarmEditRenameResponse };

interface AspWarmSessionShutdownResponse {
  provider: AspWarmProviderSummary;
  session: {
    state: "shutdown";
  };
  timing: CommandTiming;
}

export type { AspWarmSessionShutdownResponse };
