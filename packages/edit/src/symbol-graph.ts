import type {
  EditRefusal,
  GraphDetectChangesRequest,
  GraphDetectChangesResult,
  GraphFactQueryRequest,
  GraphFactQueryResult,
  GraphNamedQueryRequest,
  GraphNamedQueryResult,
  GraphProviderMode,
  GraphProviderAvailableStatus,
  GraphProviderStatus,
  GraphReviewContextRequest,
  GraphReviewContextResult,
  GraphSearchRequest,
  GraphSearchResult,
  RepoIdentity
} from "@the-open-engine/opcore-contracts";
import { GRAPH_SCHEMA_VERSION, validateProviderStatus } from "@the-open-engine/opcore-contracts";
import { stableStringify } from "./hash.js";

type MaybePromise<T> = T | Promise<T>;

export interface EditGraphStatusRequest {
  repo: RepoIdentity;
  mode: GraphProviderMode;
}

export interface EditGraphProviderClient {
  status: (request: EditGraphStatusRequest) => MaybePromise<GraphProviderStatus | undefined>;
  factQuery: (request: GraphFactQueryRequest) => MaybePromise<GraphFactQueryResult>;
  namedQuery: (request: GraphNamedQueryRequest) => MaybePromise<GraphNamedQueryResult>;
  search: (request: GraphSearchRequest) => MaybePromise<GraphSearchResult>;
  reviewContext: (request: GraphReviewContextRequest) => MaybePromise<GraphReviewContextResult>;
  detectChanges: (request: GraphDetectChangesRequest) => MaybePromise<GraphDetectChangesResult>;
}

export function graphRequestBase(repo: RepoIdentity, mode: GraphProviderMode): {
  repo: RepoIdentity;
  schemaVersion: typeof GRAPH_SCHEMA_VERSION;
  mode: GraphProviderMode;
} {
  return {
    repo,
    schemaVersion: GRAPH_SCHEMA_VERSION,
    mode
  };
}

export function missingEditGraphStatus(repo: RepoIdentity, mode: GraphProviderMode): GraphProviderStatus {
  return validateProviderStatus({
    state: mode === "optional" ? "skipped" : "required_missing",
    mode,
    provider: "opcore-graph",
    schemaVersion: GRAPH_SCHEMA_VERSION,
    message: "GraphProvider client is not configured",
    failure: {
      category: "provider_missing",
      message: "GraphProvider client is not configured"
    }
  } as GraphProviderStatus);
}

export function editRefusalFromGraphStatus(status: GraphProviderStatus): EditRefusal | undefined {
  if (status.state === "available") return undefined;
  const message = status.message ?? ("failure" in status ? status.failure.message : undefined) ?? `GraphProvider is ${status.state}`;
  if (status.state === "schema_mismatch") {
    return {
      category: "schema_mismatch",
      message
    };
  }
  if (status.state === "required_missing" || status.state === "skipped") {
    return {
      category: "provider_required_missing",
      message
    };
  }
  if (status.state === "stale") {
    return {
      category: "conflict",
      message
    };
  }
  return {
    category: "validation_failed",
    message
  };
}

export function graphStatusFingerprint(status: GraphProviderStatus): string {
  return stableStringify({
    state: status.state,
    mode: status.mode,
    provider: status.provider,
    schemaVersion: status.schemaVersion,
    repo: "repo" in status ? status.repo : undefined,
    freshness: "freshness" in status ? status.freshness : undefined,
    failure: "failure" in status ? status.failure : undefined,
    expectedSchemaVersion: "expectedSchemaVersion" in status ? status.expectedSchemaVersion : undefined,
    actualSchemaVersion: "actualSchemaVersion" in status ? status.actualSchemaVersion : undefined
  });
}

export async function requiredGraphStatus(
  repo: RepoIdentity,
  client: EditGraphProviderClient | undefined
): Promise<{ ok: true; status: Extract<GraphProviderStatus, { state: "available" }> } | { ok: false; refusal: EditRefusal; status: GraphProviderStatus }> {
  let status: GraphProviderStatus;
  try {
    status = (await client?.status({ repo, mode: "required" })) ?? missingEditGraphStatus(repo, "required");
  } catch (error) {
    status = validateProviderStatus({
      state: "error",
      mode: "required",
      provider: "opcore-graph",
      schemaVersion: GRAPH_SCHEMA_VERSION,
      message: `GraphProvider status failed: ${errorMessage(error)}`,
      failure: {
        category: "query_failed",
        message: `GraphProvider status failed: ${errorMessage(error)}`
      }
    });
  }
  const refusal = editRefusalFromGraphStatus(status);
  if (refusal) return { ok: false, refusal, status };
  return { ok: true, status: status as Extract<GraphProviderStatus, { state: "available" }> };
}

export function availableResultOrRefusal<Result extends { status: GraphProviderStatus }>(
  result: Result,
  operation: string
): { ok: true; value: Extract<Result, { status: GraphProviderAvailableStatus }> } | { ok: false; refusal: EditRefusal } {
  const refusal = editRefusalFromGraphStatus(result.status);
  if (refusal) {
    return {
      ok: false,
      refusal: {
        ...refusal,
        message: `${operation} failed: ${refusal.message}`
      }
    };
  }
  return { ok: true, value: result as Extract<Result, { status: GraphProviderAvailableStatus }> };
}

export async function availableResultFromGraphCall<Result extends { status: GraphProviderStatus }>(
  operation: string,
  call: () => MaybePromise<Result>
): Promise<{ ok: true; value: Extract<Result, { status: GraphProviderAvailableStatus }> } | { ok: false; refusal: EditRefusal }> {
  try {
    return availableResultOrRefusal(await call(), operation);
  } catch (error) {
    return {
      ok: false,
      refusal: {
        category: "validation_failed",
        message: `${operation} failed: GraphProvider provider_error: ${errorMessage(error)}`
      }
    };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
