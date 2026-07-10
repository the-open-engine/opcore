import type {
  CloneAnalysisRequest,
  CloneAnalysisResult,
  CloneFinding,
  CloneSourceReadMode,
  HypotheticalOverlay,
  ValidationDiagnostic
} from "@the-open-engine/opcore-contracts";
import {
  CLONE_PROTOCOL,
  validateCloneAnalysisResult
} from "@the-open-engine/opcore-contracts";
import type {
  ValidationCheckContext,
  ValidationCheckDefinition,
  ValidationCheckResult
} from "@the-open-engine/opcore-validation";
import { CLONE_DUPLICATION_CHECK_ID } from "./check-ids.js";
import {
  cloneCheckAdapter,
  cloneCheckOwner,
  supportedCloneValidationScopes
} from "./check-constants.js";
import { cloneInputPaths, cloneSourcePaths, isCloneSourcePath, skippedCloneInputResult } from "./source-files.js";

export interface CloneNativeInvoker {
  invoke: (request: CloneAnalysisRequest) => CloneAnalysisResult | Promise<CloneAnalysisResult>;
}

export interface CreateCloneDuplicationCheckOptions {
  invoke?: CloneNativeInvoker["invoke"];
  windowSize?: number;
  minLines?: number;
  minTokens?: number;
  threshold?: number;
  partitions?: readonly (readonly string[])[];
  exclude?: readonly string[];
  modes?: readonly string[];
}

export function createCloneDuplicationCheck(
  options: CreateCloneDuplicationCheckOptions = {}
): ValidationCheckDefinition {
  return {
    id: CLONE_DUPLICATION_CHECK_ID,
    owner: cloneCheckOwner,
    adapter: cloneCheckAdapter,
    defaultSeverity: "error",
    supportedScopes: supportedCloneValidationScopes,
    requiresGraph: false,
    run: async (context) => {
      if (options.modes !== undefined && !options.modes.includes(context.scope.kind)) {
        return {
          status: "skipped",
          diagnostics: [],
          failureMessage: `Clone duplication check is not enabled for ${context.scope.kind} scope.`
        };
      }
      const skipped = skippedCloneInputResult(context);
      if (skipped !== undefined) return skipped;
      return runCloneDuplicationCheck(context, options);
    }
  };
}

async function runCloneDuplicationCheck(
  context: ValidationCheckContext,
  options: CreateCloneDuplicationCheckOptions
): Promise<ValidationCheckResult> {
  const invoke = options.invoke ?? missingCloneInvoker;
  try {
    const request = await cloneAnalysisRequest(context, options);
    const result = validateCloneAnalysisResult(await invoke(request));
    return {
      diagnostics: sortDiagnostics(result.findings.map(cloneFindingDiagnostic))
    };
  } catch (error) {
    return {
      status: "infrastructure_failure",
      diagnostics: [],
      failureMessage: error instanceof Error ? error.message : String(error)
    };
  }
}

async function cloneAnalysisRequest(
  context: ValidationCheckContext,
  options: Pick<CreateCloneDuplicationCheckOptions, "windowSize" | "minLines" | "minTokens" | "threshold" | "partitions" | "exclude" | "modes">
): Promise<CloneAnalysisRequest> {
  const paths = [...cloneInputPaths(context)];
  const sourcePaths = await cloneSourcePaths(context, paths);
  const overlays = cloneOverlays(context);
  return {
    protocol: CLONE_PROTOCOL,
    ...(context.request.requestId !== undefined ? { requestId: context.request.requestId } : {}),
    schemaVersion: 1,
    repo: context.request.repo,
    reportMode: context.request.reportMode ?? "all",
    paths,
    sourcePaths,
    ...cloneSourceReadOptions(context),
    overlays,
    ...(options.windowSize !== undefined ? { windowSize: options.windowSize } : {}),
    ...(options.minLines !== undefined ? { minLines: options.minLines } : {}),
    ...(options.minTokens !== undefined ? { minTokens: options.minTokens } : {}),
    ...(options.threshold !== undefined ? { threshold: options.threshold } : {}),
    ...(options.partitions !== undefined ? { partitions: options.partitions } : {}),
    ...(options.exclude !== undefined ? { exclude: options.exclude } : {}),
    ...(options.modes !== undefined ? { modes: options.modes } : {})
  };
}

function cloneOverlays(context: ValidationCheckContext): readonly HypotheticalOverlay[] {
  return context.fileView.overlays.filter((overlay) => isCloneSourcePath(overlay.path)).map((overlay) => {
    if (overlay.action === "write") {
      if (overlay.content === undefined) {
        throw new Error(`Clone write overlay is missing content for ${overlay.path}`);
      }
      return {
        path: overlay.path,
        action: "write",
        content: overlay.content,
        ...(overlay.checksumBefore !== undefined ? { checksumBefore: overlay.checksumBefore } : {})
      };
    }
    return {
      path: overlay.path,
      action: "delete",
      ...(overlay.checksumBefore !== undefined ? { checksumBefore: overlay.checksumBefore } : {})
    };
  });
}

function cloneSourceReadOptions(context: ValidationCheckContext): {
  sourceReadMode?: CloneSourceReadMode;
  sourceTreeRef?: string;
} {
  if (context.fileView.defaultReadState === "before" && context.scope.kind === "changed" && context.scope.baseRef !== undefined) {
    return { sourceReadMode: "gitTree", sourceTreeRef: context.scope.baseRef };
  }
  if (context.scope.kind === "staged") return { sourceReadMode: "gitIndex" };
  if (context.scope.kind === "tree" && context.scope.treeRef !== undefined) {
    return { sourceReadMode: "gitTree", sourceTreeRef: context.scope.treeRef };
  }
  return { sourceReadMode: "disk" };
}

function cloneFindingDiagnostic(finding: CloneFinding): ValidationDiagnostic {
  return {
    category: "policy",
    severity: "error",
    code: "CLONE_DUPLICATE",
    path: finding.path,
    message: `Duplicate code ${finding.cloneClassId} in ${finding.path} also appears in ${finding.peerPath}.`
  };
}

function sortDiagnostics(diagnostics: readonly ValidationDiagnostic[]): readonly ValidationDiagnostic[] {
  return [...diagnostics].sort((left, right) =>
    `${left.path ?? ""}\0${left.code ?? ""}\0${left.message}`.localeCompare(
      `${right.path ?? ""}\0${right.code ?? ""}\0${right.message}`
    )
  );
}

function missingCloneInvoker(): CloneAnalysisResult {
  throw new Error("clone native invoker is unavailable");
}
