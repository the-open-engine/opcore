import type { GraphProviderStatus } from "../graph/provider-contracts-02.js";
import type {
  InspectImplementationEntry,
  InspectReferenceEntry,
  InspectSignatureEntry,
  InspectSymbolTarget,
  inspectFailureCategories,
} from "./contracts-01.js";

type InspectFailureCategory = (typeof inspectFailureCategories)[number];

export type { InspectFailureCategory };

interface InspectRouteFailure {
  category: InspectFailureCategory;
  message: string;
  candidates?: readonly InspectSymbolTarget[];
}

export type { InspectRouteFailure };

interface InspectReferenceResult {
  route: "references";
  status: "ok" | "degraded";
  target: InspectSymbolTarget;
  providerStatus: GraphProviderStatus;
  failure?: InspectRouteFailure;
  references: readonly InspectReferenceEntry[];
}

export type { InspectReferenceResult };

interface InspectSignatureResult {
  route: "signature";
  status: "ok" | "degraded";
  target: InspectSymbolTarget;
  providerStatus: GraphProviderStatus;
  failure?: InspectRouteFailure;
  signatures: readonly InspectSignatureEntry[];
}

export type { InspectSignatureResult };

interface InspectImplementationResult {
  route: "implementations";
  status: "ok" | "degraded";
  target: InspectSymbolTarget;
  providerStatus: GraphProviderStatus;
  failure?: InspectRouteFailure;
  implementations: readonly InspectImplementationEntry[];
}

export type { InspectImplementationResult };

interface InspectRouteErrorResult {
  route: "references" | "signature" | "implementations";
  status: "error" | "degraded";
  target?: InspectSymbolTarget;
  providerStatus?: GraphProviderStatus;
  failure: InspectRouteFailure;
}

export type { InspectRouteErrorResult };

type InspectRouteResult =
  | InspectReferenceResult
  | InspectSignatureResult
  | InspectImplementationResult
  | InspectRouteErrorResult;

export type { InspectRouteResult };
