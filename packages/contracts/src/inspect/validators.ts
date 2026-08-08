import { includesString } from "../shared/primitives.js";
import { validateProviderStatus } from "../graph/provider-validators.js";
import { validateOptional, validateRequiredObject } from "../shared/validators-02.js";
import type { InspectRouteResult } from "./contracts-02.js";
import {
  validateInspectRouteName,
  validateInspectRoutePayload,
  validateInspectSymbolTarget,
} from "./helper-validators-01.js";
import { validateInspectRouteFailure } from "./helper-validators-02.js";

function validateInspectRouteResult(result: InspectRouteResult): InspectRouteResult {
  validateRequiredObject(result, "Inspect route result is required");
  const route = validateInspectRouteName((result as { route?: unknown }).route);
  if (!includesString(["ok", "error", "degraded"] as const, result.status)) {
    throw new Error(`Unknown inspect route result status: ${String((result as { status?: unknown }).status)}`);
  }
  validateOptional(result.providerStatus, validateProviderStatus);
  if (result.status === "ok") validateSuccessfulInspectResult(result, route);
  else if (result.status === "degraded" && inspectResultHasPayload(result, route))
    validateDegradedInspectResult(result, route);
  else validateFailedInspectResult(result, route);
  return result;
}

export { validateInspectRouteResult };

function validateSuccessfulInspectResult(result: InspectRouteResult, route: InspectRouteResult["route"]): void {
  const target = result.target;
  if (target === undefined) throw new Error(`Successful inspect ${route} result requires target`);
  validateInspectSymbolTarget(target, `Inspect ${route} target`);
  if (result.providerStatus === undefined || result.providerStatus.state !== "available") {
    throw new Error(`Successful inspect ${route} result requires available providerStatus`);
  }
  validateInspectRoutePayload(result, route);
  if (Object.hasOwn(result, "failure")) {
    throw new Error(`Successful inspect ${route} result must not include failure`);
  }
}

function validateDegradedInspectResult(result: InspectRouteResult, route: InspectRouteResult["route"]): void {
  const target = result.target;
  if (target === undefined) throw new Error(`Degraded inspect ${route} result requires target`);
  validateInspectSymbolTarget(target, `Inspect ${route} target`);
  if (result.providerStatus === undefined) {
    throw new Error(`Degraded inspect ${route} result requires providerStatus`);
  }
  validateInspectRoutePayload(result, route);
  const failure = result.failure;
  if (failure === undefined) throw new Error(`Degraded inspect ${route} result requires failure`);
  validateInspectRouteFailure(failure);
}

function validateFailedInspectResult(result: InspectRouteResult, route: InspectRouteResult["route"]): void {
  validateOptional(result.target, (target) => validateInspectSymbolTarget(target, `Inspect ${route} target`));
  const failure = result.failure;
  if (failure === undefined) throw new Error(`Failed inspect ${route} result requires failure`);
  validateInspectRouteFailure(failure);
  for (const field of ["references", "signatures", "implementations"] as const) {
    if (Object.hasOwn(result, field)) throw new Error(`Failed inspect ${route} result must not include ${field}`);
  }
}

function inspectResultHasPayload(result: InspectRouteResult, route: InspectRouteResult["route"]): boolean {
  return (
    (route === "references" && Object.hasOwn(result, "references")) ||
    (route === "signature" && Object.hasOwn(result, "signatures")) ||
    (route === "implementations" && Object.hasOwn(result, "implementations"))
  );
}

export { inspectResultHasPayload };
