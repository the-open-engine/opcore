import type {
  ValidationCheckManifestEntry,
  ValidationCheckOutcome,
  ValidationCheckRunStatus,
  ValidationDiagnostic,
  PythonValidationCapabilityRun,
  PythonProjectContext,
  GraphProviderStatus,
  ValidationRequest,
  ValidationScopeKind
} from "@the-open-engine/opcore-contracts";
import { validationCheckIdPattern, validationScopeKinds } from "@the-open-engine/opcore-contracts";
import type { ValidationGraphQueryRequirement, ValidationGraphQuerySession } from "./graph-client.js";
import type { ValidationFileView } from "./overlays.js";
import type { ValidationRunResources } from "./resources.js";
import type { ResolvedValidationScope } from "./scope.js";

const validationCheckIdRegex = new RegExp(validationCheckIdPattern);
const diagnosticSeverities = ["info", "warning", "error"] as const;

export interface ValidationCheckContext {
  request: ValidationRequest;
  selectedCheckIds: readonly string[];
  scope: ResolvedValidationScope;
  graphStatus: GraphProviderStatus;
  graph: ValidationGraphQuerySession;
  fileView: ValidationFileView;
  resources: ValidationRunResources;
  runtime: ValidationRuntimePolicy;
}

export type ValidationPersistentCacheMode = "enabled" | "disabled";
export type ValidationInactiveCheckState = "not_applicable" | "disabled";

export interface ValidationRuntimePolicy {
  persistentCaches: ValidationPersistentCacheMode;
}

export interface ValidationCheckResult {
  diagnostics?: readonly ValidationDiagnostic[];
  status?: ValidationCheckRunStatus;
  outcome?: ValidationCheckOutcome;
  failureMessage?: string;
  pythonProjectContexts?: readonly PythonProjectContext[];
  pythonCapabilityRuns?: readonly PythonValidationCapabilityRun[];
}

export interface ValidationCheckDefinition {
  id: string;
  owner: string;
  adapter: string;
  defaultSeverity: ValidationDiagnostic["severity"];
  supportedScopes: readonly ValidationScopeKind[];
  defaultScopes?: readonly ValidationScopeKind[];
  requiresGraph?: boolean;
  graphUsage?: "none" | "optional" | "required";
  inactiveResult?: (
    context: ValidationCheckContext,
    state: ValidationInactiveCheckState
  ) => ValidationCheckResult | readonly ValidationDiagnostic[] | void | Promise<ValidationCheckResult | readonly ValidationDiagnostic[] | void>;
  inactiveStateWhenUnselected?: ValidationInactiveCheckState;
  graphRequirements?: (
    context: ValidationCheckContext
  ) => readonly ValidationGraphQueryRequirement[] | Promise<readonly ValidationGraphQueryRequirement[]>;
  run: (context: ValidationCheckContext) => ValidationCheckResult | readonly ValidationDiagnostic[] | void | Promise<ValidationCheckResult | readonly ValidationDiagnostic[] | void>;
}

export interface ValidationCheckRegistry {
  readonly checks: readonly ValidationCheckDefinition[];
  readonly byId: ReadonlyMap<string, ValidationCheckDefinition>;
}

export class ValidationCheckRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationCheckRegistryError";
  }
}

export function createValidationCheckRegistry(checks: readonly ValidationCheckDefinition[] = []): ValidationCheckRegistry {
  return checks.reduce((registry, check) => registerValidationCheck(registry, check), emptyRegistry());
}

export function registerValidationCheck(
  registry: ValidationCheckRegistry,
  definition: ValidationCheckDefinition
): ValidationCheckRegistry {
  validateValidationCheckDefinition(definition);
  if (registry.byId.has(definition.id)) {
    throw new ValidationCheckRegistryError(`Duplicate validation check id: ${definition.id}`);
  }
  const checks = [...registry.checks, { ...definition, requiresGraph: definition.requiresGraph ?? false }];
  return createRegistryFromChecks(checks);
}

export function selectValidationChecks(
  registry: ValidationCheckRegistry,
  requestedChecks?: readonly string[]
): readonly ValidationCheckDefinition[] {
  if (requestedChecks === undefined) return registry.checks;
  const selected: ValidationCheckDefinition[] = [];
  const seen = new Set<string>();
  for (const checkId of requestedChecks) {
    validateValidationCheckId(checkId, "Validation requested check");
    if (seen.has(checkId)) continue;
    const check = registry.byId.get(checkId);
    if (check === undefined) {
      throw new ValidationCheckRegistryError(`Unknown validation check: ${checkId}`);
    }
    selected.push(check);
    seen.add(checkId);
  }
  return selected;
}

export function selectDefaultValidationChecksForScope(
  registry: ValidationCheckRegistry,
  scopeKind: ValidationScopeKind
): readonly ValidationCheckDefinition[] {
  return registry.checks.filter((check) => (check.defaultScopes ?? check.supportedScopes).includes(scopeKind));
}

export function createValidationCheckManifest(
  registryOrChecks: ValidationCheckRegistry | readonly ValidationCheckDefinition[]
): readonly ValidationCheckManifestEntry[] {
  const checks: readonly ValidationCheckDefinition[] = isValidationCheckRegistry(registryOrChecks)
    ? registryOrChecks.checks
    : registryOrChecks;
  return checks.map((check) => ({
    checkId: check.id,
    owner: check.owner,
    adapter: check.adapter,
    defaultSeverity: check.defaultSeverity,
    supportedScopes: [...check.supportedScopes],
    requiresGraph: check.requiresGraph ?? false
  }));
}

function isValidationCheckRegistry(value: ValidationCheckRegistry | readonly ValidationCheckDefinition[]): value is ValidationCheckRegistry {
  return !Array.isArray(value) && "checks" in value && "byId" in value;
}

function emptyRegistry(): ValidationCheckRegistry {
  return {
    checks: [],
    byId: new Map()
  };
}

function createRegistryFromChecks(checks: readonly ValidationCheckDefinition[]): ValidationCheckRegistry {
  return {
    checks,
    byId: new Map(checks.map((check) => [check.id, check]))
  };
}

function validateValidationCheckDefinition(definition: ValidationCheckDefinition): void {
  if (!definition || typeof definition !== "object") {
    throw new ValidationCheckRegistryError("Validation check definition is required");
  }
  validateValidationCheckId(definition.id, "Validation check id");
  validateNonEmptyString(definition.owner, "Validation check owner");
  validateNonEmptyString(definition.adapter, "Validation check adapter");
  if (!diagnosticSeverities.includes(definition.defaultSeverity)) {
    throw new ValidationCheckRegistryError(`Unknown validation check defaultSeverity: ${String(definition.defaultSeverity)}`);
  }
  if (!Array.isArray(definition.supportedScopes) || definition.supportedScopes.length === 0) {
    throw new ValidationCheckRegistryError("Validation check supportedScopes must be a non-empty array");
  }
  for (const scope of definition.supportedScopes) {
    if (!validationScopeKinds.includes(scope)) {
      throw new ValidationCheckRegistryError(`Unknown validation check supported scope: ${String(scope)}`);
    }
  }
  if (definition.defaultScopes !== undefined) {
    if (!Array.isArray(definition.defaultScopes)) {
      throw new ValidationCheckRegistryError("Validation check defaultScopes must be an array when provided");
    }
    for (const scope of definition.defaultScopes) {
      if (!validationScopeKinds.includes(scope)) {
        throw new ValidationCheckRegistryError(`Unknown validation check default scope: ${String(scope)}`);
      }
      if (!definition.supportedScopes.includes(scope)) {
        throw new ValidationCheckRegistryError(`Validation check default scope must also be supported: ${String(scope)}`);
      }
    }
  }
  if (definition.requiresGraph !== undefined && typeof definition.requiresGraph !== "boolean") {
    throw new ValidationCheckRegistryError("Validation check requiresGraph must be boolean");
  }
  if (definition.graphUsage !== undefined && !["none", "optional", "required"].includes(definition.graphUsage)) {
    throw new ValidationCheckRegistryError("Validation check graphUsage must be none, optional, or required");
  }
  if (definition.inactiveResult !== undefined && typeof definition.inactiveResult !== "function") {
    throw new ValidationCheckRegistryError("Validation check inactiveResult must be a function");
  }
  if (definition.inactiveStateWhenUnselected !== undefined) {
    if (definition.inactiveResult === undefined) {
      throw new ValidationCheckRegistryError("Validation check inactiveStateWhenUnselected requires inactiveResult");
    }
    if (definition.inactiveStateWhenUnselected !== "not_applicable" && definition.inactiveStateWhenUnselected !== "disabled") {
      throw new ValidationCheckRegistryError(
        `Unknown validation check inactiveStateWhenUnselected: ${String(definition.inactiveStateWhenUnselected)}`
      );
    }
  }
  if (definition.graphRequirements !== undefined && typeof definition.graphRequirements !== "function") {
    throw new ValidationCheckRegistryError("Validation check graphRequirements must be a function");
  }
  if (typeof definition.run !== "function") {
    throw new ValidationCheckRegistryError("Validation check run must be a function");
  }
}

function validateValidationCheckId(checkId: unknown, label: string): string {
  const value = validateNonEmptyString(checkId, label);
  if (!validationCheckIdRegex.test(value)) {
    throw new ValidationCheckRegistryError(`${label} must be a stable validation check id`);
  }
  return value;
}

function validateNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationCheckRegistryError(`${label} must be a non-empty string`);
  }
  return value;
}
