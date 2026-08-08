import { includesString } from "../shared/primitives.js";
import { validateRepoRelativePath } from "../shared/path-validators.js";
import {
  validateNonEmptyString,
  validateNonNegativeInteger,
  validatePositiveInteger,
  validateStringArray,
} from "../shared/validators-01.js";
import {
  validateBoolean,
  validateOptional,
  validateRequiredObject,
} from "../shared/validators-02.js";
import type {
  InspectImplementationEntry,
  InspectReferenceEntry,
  InspectSignatureEntry,
  InspectSignatureParameter,
  InspectSignatureTypeParameter,
  InspectSymbolEvidence,
  InspectSymbolSummary,
  InspectSymbolTarget,
  InspectTextSpan} from "./contracts-01.js";
import {
  inspectImplementationKinds,
  inspectSignatureKinds,
} from "./contracts-01.js";
import type { InspectRouteResult } from "./contracts-02.js";

function validateInspectRouteName(route: unknown): InspectRouteResult["route"] {
  if (!includesString(["references", "signature", "implementations"] as const, route)) {
    throw new Error(`Unknown inspect route result route: ${String(route)}`);
  }
  return route;
}

export { validateInspectRouteName };

function validateInspectRoutePayload(result: InspectRouteResult, route: InspectRouteResult["route"]): void {
  validateInspectRoutePayloadFields(result, route);
  if (route === "references") {
    return validateInspectReferencesPayload("references" in result ? result.references : undefined);
  }
  if (route === "signature") {
    return validateInspectSignaturesPayload("signatures" in result ? result.signatures : undefined);
  }
  validateInspectImplementationsPayload("implementations" in result ? result.implementations : undefined);
}

export { validateInspectRoutePayload };

function validateInspectRoutePayloadFields(result: InspectRouteResult, route: InspectRouteResult["route"]): void {
  const payloadFields = ["references", "signatures", "implementations"] as const;
  const expectedFields = {
    references: "references",
    signature: "signatures",
    implementations: "implementations",
  } as const;
  const expectedField = expectedFields[route];
  for (const field of payloadFields) {
    if (field !== expectedField && Object.hasOwn(result, field)) {
      throw new Error(`Inspect ${route} result must not include ${field}`);
    }
  }
}

function validateInspectReferencesPayload(references: readonly InspectReferenceEntry[] | undefined): void {
  if (!Array.isArray(references)) throw new Error("Inspect references result references must be an array");
  for (const reference of references) validateInspectReferenceEntry(reference);
}

function validateInspectSignaturesPayload(signatures: readonly InspectSignatureEntry[] | undefined): void {
  if (!Array.isArray(signatures)) throw new Error("Inspect signature result signatures must be an array");
  for (const signature of signatures) validateInspectSignatureEntry(signature);
}

function validateInspectImplementationsPayload(
  implementations: readonly InspectImplementationEntry[] | undefined,
): void {
  if (!Array.isArray(implementations))
    throw new Error("Inspect implementations result implementations must be an array");
  for (const implementation of implementations) validateInspectImplementationEntry(implementation);
}

function validateInspectSymbolTarget(target: InspectSymbolTarget, label: string): InspectSymbolTarget {
  validateRequiredObject(target, `${label} is required`);
  if (!includesString(["node", "file_symbol"] as const, target.kind)) {
    throw new Error(`Unknown ${label} kind: ${String((target as { kind?: unknown }).kind)}`);
  }
  if (target.kind === "node") validateInspectNodeTarget(target, label);
  else validateInspectFileSymbolTarget(target, label);
  return target;
}

export { validateInspectSymbolTarget };

function validateInspectNodeTarget(target: InspectSymbolTarget, label: string): void {
  validateNonEmptyString(target.nodeId, `${label} nodeId`);
  const fileSymbolFields = [target.path, target.symbolName, target.line, target.column];
  if (fileSymbolFields.some((value) => value !== undefined)) {
    throw new Error(`${label} node target must not include file-symbol fields`);
  }
}

function validateInspectFileSymbolTarget(target: InspectSymbolTarget, label: string): void {
  validateRepoRelativePath(validateNonEmptyString(target.path, `${label} path`));
  validateNonEmptyString(target.symbolName, `${label} symbolName`);
  validateOptional(target.line, (value) => validatePositiveInteger(value, `${label} line`));
  validateOptional(target.column, (value) => validatePositiveInteger(value, `${label} column`));
  validateOptional(target.nodeId, (value) => validateNonEmptyString(value, `${label} nodeId`));
}

const validateInspectReferenceTarget = validateInspectSymbolTarget;

export { validateInspectReferenceTarget };

function validateInspectReferenceEntry(entry: InspectReferenceEntry): InspectReferenceEntry {
  if (!entry || typeof entry !== "object") throw new Error("Inspect reference entry is required");
  validateRepoRelativePath(entry.file);
  validatePositiveInteger(entry.line, "Inspect reference entry line");
  validatePositiveInteger(entry.column, "Inspect reference entry column");
  validateNonEmptyString(entry.text, "Inspect reference entry text");
  validateInspectTextSpan(entry.span, "Inspect reference span");
  validateInspectSymbolSummary(entry.symbol, "Inspect reference entry symbol");
  if (typeof entry.isDefinition !== "boolean") throw new Error("Inspect reference entry isDefinition must be boolean");
  if (entry.isDeclaration !== undefined && typeof entry.isDeclaration !== "boolean") {
    throw new Error("Inspect reference entry isDeclaration must be boolean");
  }
  validateInspectSymbolEvidence(entry.evidence, "Inspect reference entry evidence");
  return entry;
}

export { validateInspectReferenceEntry };

function validateInspectSymbolEvidence(evidence: InspectSymbolEvidence, label: string): InspectSymbolEvidence {
  if (!evidence || typeof evidence !== "object") throw new Error(`${label} is required`);
  validateStringArray(evidence.graphNodeIds, `${label} graphNodeIds`, {
    allowEmpty: true,
  });
  if (!includesString(["graph", "language_service"] as const, evidence.resolver)) {
    throw new Error(`Unknown ${label} resolver: ${String(evidence.resolver)}`);
  }
  return evidence;
}

export { validateInspectSymbolEvidence };

function validateInspectSignatureEntry(entry: InspectSignatureEntry): InspectSignatureEntry {
  validateRequiredObject(entry, "Inspect signature entry is required");
  validateRepoRelativePath(entry.file);
  validatePositiveInteger(entry.line, "Inspect signature entry line");
  validatePositiveInteger(entry.column, "Inspect signature entry column");
  validateNonEmptyString(entry.text, "Inspect signature entry text");
  validateNonEmptyString(entry.signature, "Inspect signature entry signature");
  if (!includesString(inspectSignatureKinds, entry.kind)) {
    throw new Error(`Unknown inspect signature entry kind: ${String(entry.kind)}`);
  }
  validateInspectSignatureParameters(entry);
  validateBoolean(entry.exported, "Inspect signature entry exported");
  validateBoolean(entry.async, "Inspect signature entry async");
  validateOptional(entry.returnType, (value) =>
    validateNonEmptyString(value, "Inspect signature entry returnType"),
  );
  validateInspectTextSpan(entry.span, "Inspect signature span");
  validateInspectSymbolSummary(entry.symbol, "Inspect signature entry symbol");
  validateOptional(entry.overloadIndex, (value) =>
    validateNonNegativeInteger(value, "Inspect signature entry overloadIndex"),
  );
  validateInspectSymbolEvidence(entry.evidence, "Inspect signature entry evidence");
  return entry;
}

export { validateInspectSignatureEntry };

function validateInspectSignatureParameters(entry: InspectSignatureEntry): void {
  if (!Array.isArray(entry.parameters)) throw new Error("Inspect signature entry parameters must be an array");
  for (const parameter of entry.parameters) validateInspectSignatureParameter(parameter);
  if (!Array.isArray(entry.typeParameters)) {
    throw new Error("Inspect signature entry typeParameters must be an array");
  }
  for (const typeParameter of entry.typeParameters) validateInspectSignatureTypeParameter(typeParameter);
}

function validateInspectSignatureParameter(parameter: InspectSignatureParameter): InspectSignatureParameter {
  if (!parameter || typeof parameter !== "object") throw new Error("Inspect signature parameter is required");
  validateNonEmptyString(parameter.name, "Inspect signature parameter name");
  validateNonEmptyString(parameter.type, "Inspect signature parameter type");
  if (typeof parameter.optional !== "boolean") throw new Error("Inspect signature parameter optional must be boolean");
  if (parameter.rest !== undefined && typeof parameter.rest !== "boolean") {
    throw new Error("Inspect signature parameter rest must be boolean");
  }
  if (parameter.defaultValue !== undefined)
    validateNonEmptyString(parameter.defaultValue, "Inspect signature parameter defaultValue");
  return parameter;
}

export { validateInspectSignatureParameter };

function validateInspectSignatureTypeParameter(
  typeParameter: InspectSignatureTypeParameter,
): InspectSignatureTypeParameter {
  if (!typeParameter || typeof typeParameter !== "object")
    throw new Error("Inspect signature typeParameter is required");
  validateNonEmptyString(typeParameter.name, "Inspect signature typeParameter name");
  if (typeParameter.constraint !== undefined) {
    validateNonEmptyString(typeParameter.constraint, "Inspect signature typeParameter constraint");
  }
  if (typeParameter.default !== undefined) {
    validateNonEmptyString(typeParameter.default, "Inspect signature typeParameter default");
  }
  return typeParameter;
}

export { validateInspectSignatureTypeParameter };

function validateInspectImplementationEntry(entry: InspectImplementationEntry): InspectImplementationEntry {
  if (!entry || typeof entry !== "object") throw new Error("Inspect implementation entry is required");
  validateRepoRelativePath(entry.file);
  validatePositiveInteger(entry.line, "Inspect implementation entry line");
  validatePositiveInteger(entry.column, "Inspect implementation entry column");
  validateNonEmptyString(entry.text, "Inspect implementation entry text");
  validateInspectTextSpan(entry.span, "Inspect implementation span");
  if (Object.hasOwn(entry, "implements"))
    throw new Error("Inspect implementation entry must use target, not implements");
  if (!includesString(inspectImplementationKinds, entry.kind)) {
    throw new Error(`Unknown Inspect implementation entry kind: ${String(entry.kind)}`);
  }
  validateInspectSymbolSummary(entry.symbol, "Inspect implementation entry symbol");
  validateInspectSymbolSummary(entry.target, "Inspect implementation entry target");
  if (entry.isDeclaration !== undefined && typeof entry.isDeclaration !== "boolean") {
    throw new Error("Inspect implementation entry isDeclaration must be boolean");
  }
  validateInspectSymbolEvidence(entry.evidence, "Inspect implementation entry evidence");
  return entry;
}

export { validateInspectImplementationEntry };

function validateInspectTextSpan(span: InspectTextSpan, label: string): InspectTextSpan {
  if (!span || typeof span !== "object") throw new Error(`${label} is required`);
  validatePositiveInteger(span.startLine, `${label} startLine`);
  validatePositiveInteger(span.startColumn, `${label} startColumn`);
  validatePositiveInteger(span.endLine, `${label} endLine`);
  validatePositiveInteger(span.endColumn, `${label} endColumn`);
  if (span.endLine < span.startLine || (span.endLine === span.startLine && span.endColumn < span.startColumn)) {
    throw new Error(`${label} end must be after start`);
  }
  if (span.startOffset !== undefined) validateNonNegativeInteger(span.startOffset, `${label} startOffset`);
  if (span.endOffset !== undefined) validateNonNegativeInteger(span.endOffset, `${label} endOffset`);
  return span;
}

export { validateInspectTextSpan };

function validateInspectSymbolSummary(symbol: InspectSymbolSummary, label: string): InspectSymbolSummary {
  if (!symbol || typeof symbol !== "object") throw new Error(`${label} is required`);
  validateNonEmptyString(symbol.id, `${label} id`);
  validateNonEmptyString(symbol.name, `${label} name`);
  if (symbol.kind !== undefined) validateNonEmptyString(symbol.kind, `${label} kind`);
  return symbol;
}

export { validateInspectSymbolSummary };
