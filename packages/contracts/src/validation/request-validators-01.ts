import { validateOptional, validateRequiredObject } from "../shared/validators-02.js";
import { includesString } from "../shared/primitives.js";
import { validateProviderStatus } from "../graph/provider-validators.js";
import { graphProviderModes } from "../graph/vocabulary-01.js";
import { validateRepoRelativePath } from "../shared/path-validators.js";
import { validateNonEmptyString, validatePositiveInteger, validateStringArray } from "../shared/validators-01.js";
import type { ValidationDiagnostic, ValidationDiagnosticToolProvenance } from "./diagnostic-contracts.js";
import type {
  HypotheticalOverlay,
  ValidationGraphConfig,
  ValidationScope} from "./request-contracts.js";
import {
  validationScopeKinds,
} from "./request-contracts.js";
import { validationDiagnosticCategories } from "./vocabulary-01.js";

function validateValidationScope(scope: ValidationScope): ValidationScope {
  validateRequiredObject(scope, "Validation scope is required");
  if (!includesString(validationScopeKinds, scope.kind)) {
    throw new Error(`Unknown validation scope kind: ${String((scope as { kind?: unknown }).kind)}`);
  }
  if (scope.kind === "files") {
    validateStringArray(scope.files, "Validation scope files", {
      allowEmpty: false,
    });
    for (const file of scope.files) validateRepoRelativePath(file);
  }
  if (scope.kind === "changed") {
    validateNonEmptyString(scope.baseRef, "Validation changed scope baseRef");
  }
  if (scope.kind === "tree") {
    validateNonEmptyString(scope.treeRef, "Validation tree scope treeRef");
    validateNonEmptyString(scope.changedFrom, "Validation tree scope changedFrom");
  }
  if (scope.kind === "package") {
    validateNonEmptyString(scope.packageName, "Validation package scope packageName");
    validateRepoRelativePath(scope.packageRoot);
  }
  return scope;
}

export { validateValidationScope };

function validateValidationGraphConfig(graph: ValidationGraphConfig): ValidationGraphConfig {
  validateRequiredObject(graph, "Validation graph config is required");
  if (!includesString(graphProviderModes, graph.mode)) {
    throw new Error(`Unknown validation graph mode: ${String(graph.mode)}`);
  }
  if (graph.provider !== undefined) validateNonEmptyString(graph.provider, "Validation graph provider");
  if (graph.maxAgeMs !== undefined && (typeof graph.maxAgeMs !== "number" || graph.maxAgeMs < 0)) {
    throw new Error("Validation graph maxAgeMs must be non-negative");
  }
  if (graph.status !== undefined) {
    validateProviderStatus(graph.status);
    if (graph.status.mode !== graph.mode) {
      throw new Error("Validation graph status mode must match graph mode");
    }
    if (graph.provider !== undefined && graph.status.provider !== graph.provider) {
      throw new Error("Validation graph status provider must match graph provider");
    }
  }
  return graph;
}

export { validateValidationGraphConfig };

function validateHypotheticalOverlays(overlays: readonly HypotheticalOverlay[]): readonly HypotheticalOverlay[] {
  if (!Array.isArray(overlays)) {
    throw new Error("Validation request overlays must be an array");
  }
  const normalizedPaths = new Set<string>();
  for (const overlay of overlays) {
    validateHypotheticalOverlay(overlay);
    const normalizedPath = validateRepoRelativePath(overlay.path);
    if (normalizedPaths.has(normalizedPath)) {
      throw new Error(`Validation request overlays include duplicate path: ${normalizedPath}`);
    }
    normalizedPaths.add(normalizedPath);
  }
  return overlays;
}

export { validateHypotheticalOverlays };

function validateHypotheticalOverlay(overlay: HypotheticalOverlay): HypotheticalOverlay {
  validateRequiredObject(overlay, "Validation request overlay is required");
  validateRepoRelativePath(overlay.path);
  if (!includesString(["write", "delete"] as const, overlay.action)) {
    throw new Error(`Unknown validation overlay action: ${String((overlay as { action?: unknown }).action)}`);
  }
  if (overlay.action === "write") {
    if (typeof overlay.content !== "string") {
      throw new Error("Validation write overlay must include content");
    }
  }
  if (overlay.action === "delete" && Object.hasOwn(overlay, "content")) {
    throw new Error("Validation delete overlay must not include content");
  }
  if (overlay.checksumBefore !== undefined) {
    validateNonEmptyString(overlay.checksumBefore, "Validation overlay checksumBefore");
  }
  return overlay;
}

export { validateHypotheticalOverlay };

function validateValidationDiagnostics(diagnostics: readonly ValidationDiagnostic[]): readonly ValidationDiagnostic[] {
  if (!Array.isArray(diagnostics)) {
    throw new Error("Validation result diagnostics must be an array");
  }
  for (const diagnostic of diagnostics) validateValidationDiagnostic(diagnostic);
  return diagnostics;
}

export { validateValidationDiagnostics };

function validateValidationDiagnostic(diagnostic: ValidationDiagnostic): ValidationDiagnostic {
  validateRequiredObject(diagnostic, "Validation diagnostic is required");
  if (!includesString(validationDiagnosticCategories, diagnostic.category)) {
    throw new Error(`Unknown validation diagnostic category: ${String(diagnostic.category)}`);
  }
  validateNonEmptyString(diagnostic.message, "Validation diagnostic message");
  if (diagnostic.path !== undefined) validateRepoRelativePath(diagnostic.path);
  if (!includesString(["info", "warning", "error"] as const, diagnostic.severity)) {
    throw new Error(`Unknown validation diagnostic severity: ${String(diagnostic.severity)}`);
  }
  if (diagnostic.code !== undefined) validateNonEmptyString(diagnostic.code, "Validation diagnostic code");
  validateValidationDiagnosticLocation(diagnostic);
  if (diagnostic.tool !== undefined) validateValidationDiagnosticTool(diagnostic.tool);
  return diagnostic;
}

export { validateValidationDiagnostic };

function validateValidationDiagnosticLocation(diagnostic: ValidationDiagnostic): void {
  for (const field of ["line", "column", "endLine", "endColumn"] as const) {
    if (diagnostic[field] !== undefined) validatePositiveInteger(diagnostic[field], `Validation diagnostic ${field}`);
  }
  validateValidationDiagnosticLocationPresence(diagnostic);
  validateValidationDiagnosticLocationOrder(diagnostic);
}

export { validateValidationDiagnosticLocation };

function validateValidationDiagnosticLocationPresence(diagnostic: ValidationDiagnostic): void {
  if (diagnostic.column !== undefined && diagnostic.line === undefined) {
    throw new Error("Validation diagnostic column requires line");
  }
  const hasEndLocation = diagnostic.endLine !== undefined || diagnostic.endColumn !== undefined;
  if (hasEndLocation && diagnostic.line === undefined) {
    throw new Error("Validation diagnostic end location requires line");
  }
  if (diagnostic.endColumn !== undefined && diagnostic.endLine === undefined) {
    throw new Error("Validation diagnostic endColumn requires endLine");
  }
}

function validateValidationDiagnosticLocationOrder(diagnostic: ValidationDiagnostic): void {
  if (diagnostic.line !== undefined && diagnostic.endLine !== undefined) {
    const startsAfterEnd =
      diagnostic.endLine < diagnostic.line ||
      (diagnostic.endLine === diagnostic.line &&
        diagnostic.column !== undefined &&
        diagnostic.endColumn !== undefined &&
        diagnostic.endColumn < diagnostic.column);
    if (startsAfterEnd) throw new Error("Validation diagnostic end location must not precede start location");
  }
}

function validateValidationDiagnosticTool(tool: ValidationDiagnosticToolProvenance): void {
  if (!tool || typeof tool !== "object") throw new Error("Validation diagnostic tool provenance is required");
  validateNonEmptyString(tool.name, "Validation diagnostic tool name");
  validateNonEmptyString(tool.command, "Validation diagnostic tool command");
  validateOptional(tool.version, (value) => validateNonEmptyString(value, "Validation diagnostic tool version"));
  validateOptional(tool.source, (value) => validateNonEmptyString(value, "Validation diagnostic tool source"));
  validateOptional(tool.cwd, (value) => validateNonEmptyString(value, "Validation diagnostic tool cwd"));
}

export { validateValidationDiagnosticTool };
