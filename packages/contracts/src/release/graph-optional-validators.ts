import { validateGraphReleaseSurfaceClassification } from "../command/helper-validators.js";
import { includesString } from "../shared/primitives.js";
import { validateNonEmptyArray, validateNonEmptyString } from "../shared/validators-01.js";
import type { GraphReleaseOptionalSurfaceReceipt } from "./graph-contracts.js";
import type {
  GraphReleaseDeferredChild} from "./graph-vocabulary-01.js";
import {
  graphReleaseDeferredChildren,
  graphReleaseOptionalAnalysisSurfaces,
} from "./graph-vocabulary-01.js";

function validateGraphReleaseOptionalSurfaces(surfaces: readonly GraphReleaseOptionalSurfaceReceipt[]): void {
  validateNonEmptyArray(surfaces, "Graph release optionalSurfaces");
  for (const surface of surfaces) {
    if (!surface || typeof surface !== "object") throw new Error("Graph release optional surface is required");
    validateGraphReleaseDeferredChild(surface.issue, "Graph release optional surface issue");
    validateNonEmptyString(surface.id, "Graph release optional surface id");
    validateGraphReleaseSurfaceClassification(surface.classification);
    if (surface.status !== "unsupported" && surface.status !== "deferred") {
      throw new Error("Graph release optional surface status must be unsupported or deferred");
    }
    if (surface.classification === "required") {
      throw new Error("Graph release optional surfaces must not mark staged graph release surfaces as required");
    }
  }
  validateGraphReleaseOptionalAnalysisSurfaceSet(surfaces, "Graph release optional surfaces");
}

export { validateGraphReleaseOptionalSurfaces };

function validateGraphReleaseOptionalAnalysisSurfaceSet(
  surfaces: readonly Pick<GraphReleaseOptionalSurfaceReceipt, "issue" | "id" | "classification" | "status">[],
  label: string,
): void {
  const actual = surfaces.map(graphReleaseOptionalSurfaceKey).sort();
  const expected = graphReleaseOptionalAnalysisSurfaces.map(graphReleaseOptionalSurfaceKey).sort();
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new Error(`${label} must match staged graph release surfaces`);
  }
}

export { validateGraphReleaseOptionalAnalysisSurfaceSet };

function graphReleaseOptionalSurfaceKey(
  surface: Pick<GraphReleaseOptionalSurfaceReceipt, "issue" | "id" | "classification" | "status">,
): string {
  return `${surface.issue}:${surface.id}:${surface.classification}:${surface.status}`;
}

export { graphReleaseOptionalSurfaceKey };

function validateGraphReleaseDeferredChild(
  issue: unknown,
  label = "Graph release deferred child",
): GraphReleaseDeferredChild {
  if (!includesString(graphReleaseDeferredChildren, issue)) {
    throw new Error(`${label} must be one of ${graphReleaseDeferredChildren.join(", ")}`);
  }
  return issue;
}

export { validateGraphReleaseDeferredChild };
