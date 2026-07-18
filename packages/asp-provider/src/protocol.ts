import type { CommandTiming, ValidationScopeKind } from "@the-open-engine/opcore-contracts";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type SnapshotRef = {
  rev: string;
  dirty?: string;
  stampedAt?: string;
};

export type Baseline = SnapshotRef;
export type BlobRef = string;

export type ChangeKind = "create" | "modify" | "delete" | "rename";

export type Change = {
  path: string;
  kind: ChangeKind;
  from?: string;
  before?: BlobRef;
  after?: BlobRef | InlineBlob;
};

export type InlineBlob = {
  bytes: string;
  encoding?: "utf-8" | "utf8" | "base64";
};

export type ChangeSet = {
  baseline: Baseline;
  changes: readonly Change[];
};

export type CallSite = "interactive" | "gate" | "sweep";
export type Comparison = "all" | "introduced";

export type EvaluateChangesetParams = {
  callSite: CallSite;
  changeset: ChangeSet;
  changesetDigest?: string;
  comparison?: Comparison;
  timeoutMs?: number;
  basePolicyDigest?: string;
  requiredCheck?: string;
  checks?: readonly string[];
  scope?: { kind?: ValidationScopeKind; files?: readonly string[] };
};

export type CoveragePart = {
  scope: "changeset" | "workspace" | { paths: string[] };
  diagnosticSources: string[];
  rules: string[];
  comparison: string;
};

export type ProviderCoverageDegradation = {
  source: string;
  reason: string;
  requirement?: string;
  detail: string;
};

export type AssessmentCoverage = {
  requested: CoveragePart;
  covered: CoveragePart;
  degraded: ProviderCoverageDegradation[];
  unsupported: ProviderCoverageDegradation[];
  exhaustive: boolean;
  truncated: boolean;
};

export type Diagnostic = {
  code: string;
  severity: "error" | "warning" | "info";
  source: string;
  message: string;
  location: JsonObject;
  fingerprint: string;
  introduced?: boolean;
  help?: string;
  codeDescription?: JsonObject;
  fix?: JsonObject;
};

export type AssessmentStatus = "complete" | "incomplete" | "unsupported" | "error" | "cancelled";

export type Assessment = {
  status: AssessmentStatus;
  diagnostics: Diagnostic[];
  evidence?: JsonObject[];
  coverage: AssessmentCoverage;
  validAsOf: {
    baseline: Baseline;
    changesetDigest: string;
    blobs: BlobRef[];
  };
  provider: {
    id: string;
    version: string;
    configDigest: string;
    capabilityVersion: string;
    buildDigest?: string;
    artifactDigest?: string;
    capabilityFamily: string;
  };
  timing: CommandTiming;
  cache: JsonObject;
};

export type InitializeParams = {
  protocolVersion?: string;
  host?: JsonObject;
  hostCapabilities?: JsonObject;
  workspace?: {
    root?: string;
    baseline?: Baseline;
  };
  assuranceMode?: string;
};

export type InitializedParams = {
  grantedPermissions?: {
    read?: readonly string[];
    write?: boolean;
    network?: boolean;
  };
  baseline?: Baseline;
};

export type ReadBlobParams = {
  blobs?: readonly string[];
};

export type ListTreeParams = {
  paths?: readonly string[];
  globs?: readonly string[];
};

export type EncodedBlob = {
  id: string;
  encoding?: "utf-8" | "utf8" | "base64";
  bytes?: string;
  content?: string;
};

export type JsonRpcErrorObject = {
  code: number;
  message: string;
  data?: JsonObject;
};

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
};

export type JsonRpcPending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export type RpcThrowable = Error & {
  rpc?: JsonRpcErrorObject;
  rpcError?: JsonRpcErrorObject;
};

export const ASP_PROTOCOL_VERSION = "asp/0.1";
export const OPCORE_PROVIDER_ID = "opcore";
export const OPCORE_PROVIDER_PACKAGE = "opcore";
export const OPCORE_PROVIDER_VERSION = "0.2.1";
