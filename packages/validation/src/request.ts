import type {
  GraphProviderMode,
  GraphProviderStatus,
  HypotheticalOverlay,
  RepoIdentity,
  ValidationRequest,
  ValidationScope
} from "@the-open-engine/opcore-contracts";
import { validateValidationRequestPayload } from "@the-open-engine/opcore-contracts";

export const defaultValidationGraphProvider = "opcore-graph" as const;

export interface NormalizeValidationRequestOptions {
  provider?: string;
  checks?: readonly string[];
}

export function missingGraphStatus(
  mode: GraphProviderMode,
  provider: string = defaultValidationGraphProvider
): GraphProviderStatus {
  const message = "Graph provider is not configured";
  if (mode === "required") {
    return {
      state: "required_missing",
      mode,
      provider,
      schemaVersion: 1,
      message,
      failure: {
        category: "provider_missing",
        message
      }
    };
  }
  return {
    state: "skipped",
    mode,
    provider,
    schemaVersion: 1,
    message,
    failure: {
      category: "provider_missing",
      message
    }
  };
}

export function validateValidationRequestContract(request: ValidationRequest): ValidationRequest {
  return validateValidationRequestPayload(request);
}

export function normalizeValidationRequest(
  request: ValidationRequest,
  options: NormalizeValidationRequestOptions = {}
): ValidationRequest {
  const checks = request.checks ?? options.checks;
  const normalized: ValidationRequest = {
    ...request,
    repo: normalizeRepoIdentity(request.repo),
    scope: normalizeValidationScope(request.scope),
    graph: {
      ...request.graph,
      provider: request.graph.provider ?? options.provider ?? defaultValidationGraphProvider
    },
    overlays: request.overlays.map(normalizeHypotheticalOverlay)
  };
  if (checks !== undefined) normalized.checks = normalizeChecks(checks);
  return validateValidationRequestPayload(normalized);
}

function normalizeRepoIdentity(repo: RepoIdentity): RepoIdentity {
  return {
    ...repo,
    repoRoot: repo.repoRoot?.replaceAll("\\", "/")
  };
}

function normalizeValidationScope(scope: ValidationScope): ValidationScope {
  if (scope.kind === "files") {
    return {
      ...scope,
      files: scope.files.map(normalizePath)
    };
  }
  if (scope.kind === "package") {
    return {
      ...scope,
      packageRoot: normalizePath(scope.packageRoot)
    };
  }
  return scope;
}

function normalizeHypotheticalOverlay(overlay: HypotheticalOverlay): HypotheticalOverlay {
  return {
    ...overlay,
    path: normalizePath(overlay.path)
  };
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function normalizeChecks(checks: readonly string[]): readonly string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const check of checks) {
    if (typeof check !== "string") {
      throw new Error("Validation request checks must be an array of strings");
    }
    const checkId = check.trim();
    if (checkId.length === 0) {
      throw new Error("Validation request checks entries must include non-whitespace content");
    }
    if (!seen.has(checkId)) normalized.push(checkId);
    seen.add(checkId);
  }
  return normalized;
}
