import type { RepoIdentity } from "../graph/provider-contracts-01.js";
import type { ValidationResult } from "../validation/capability-contracts.js";
import type { ValidationRequest } from "../validation/request-contracts.js";
import type { EditRefusalCategory } from "./vocabulary.js";

interface RepoRelativeChangeBase {
  path: string;
  checksumBefore?: string;
  checksumAfter?: string;
}

export type { RepoRelativeChangeBase };

type RepoRelativeChange =
  | (RepoRelativeChangeBase & {
      kind: "create" | "replace";
      content: string;
    })
  | (RepoRelativeChangeBase & {
      kind: "delete";
    })
  | {
      kind: "rename";
      path: string;
      toPath: string;
      checksumBefore?: string;
    };

export type { RepoRelativeChange };

interface AtomicApplyMetadata {
  strategy: "all_or_nothing";
  planHash?: string;
  expectedBaseSha?: string;
}

export type { AtomicApplyMetadata };

interface EditPlanValidationRequirement {
  required: boolean;
  request: ValidationRequest;
}

export type { EditPlanValidationRequirement };

interface EditPlan {
  planId: string;
  repo: RepoIdentity;
  changes: readonly RepoRelativeChange[];
  atomic: AtomicApplyMetadata;
  validation: EditPlanValidationRequirement;
}

export type { EditPlan };

interface EditRefusal {
  category: EditRefusalCategory;
  message: string;
  path?: string;
}

export type { EditRefusal };

interface EditPlanResult {
  planId: string;
  ok: boolean;
  applied: boolean;
  appliedAt?: string;
  refusal?: EditRefusal;
  validation?: ValidationResult;
}

export type { EditPlanResult };

interface EditPlanRollbackState {
  completed: boolean;
  restoredPaths: readonly string[];
  failedPaths: readonly string[];
  cleanupFailedPaths: readonly string[];
}

export type { EditPlanRollbackState };

interface EditCommandResult {
  ok: boolean;
  applied: boolean;
  planId?: string;
  planHash?: string;
  appliedAt?: string;
  matchCount?: number;
  afterState?: Readonly<Record<string, string | null>>;
  validationRequest?: ValidationRequest;
  validation?: ValidationResult;
  refusal?: EditRefusal;
  rollback?: EditPlanRollbackState;
}

export type { EditCommandResult };
