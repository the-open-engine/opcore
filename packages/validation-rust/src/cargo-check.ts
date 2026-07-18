import type {
  ValidationCheckDefinition,
  ValidationCheckResult,
  ValidationCheckContext,
  ValidationFileView
} from "@the-open-engine/opcore-validation";
import type { ValidationDiagnostic, ValidationDiagnosticCategory } from "@the-open-engine/opcore-contracts";
import { RUST_CARGO_CHECK_ID, RUST_CLIPPY_CHECK_ID, RUST_DEAD_CODE_CHECK_ID, RUST_RUSTDOC_CHECK_ID } from "./check-ids.js";
import { ownedClippyLints, rustCheckAdapter, rustCheckOwner, supportedRustValidationScopes } from "./check-constants.js";
import type { CargoMetadataPackage, CargoWorkspaceMetadata } from "./cargo-metadata.js";
import { loadCargoMetadata, resolveCargoPackageScope } from "./cargo-metadata.js";
import {
  commandInfrastructureFailure,
  commandUnavailableFailure,
  mapCargoJsonDiagnostics,
  metadataFailureResult,
  sortDiagnostics,
  stderrDiagnostic
} from "./diagnostics.js";
import { analyzeRustModuleGraph } from "./import-graph-check.js";
import { materializeRustWorkspace } from "./materialize.js";
import { runTool } from "./process.js";
import { skippedRustInputResult } from "./source-files.js";
import { toolAvailable } from "./toolchain.js";

export interface RustCommandCheckOptions {
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

interface CachedCargoCheckExecution {
  args: readonly string[];
  metadata: CargoWorkspaceMetadata;
  member?: CargoMetadataPackage;
  result: ReturnType<typeof runTool>;
  workspaceRoot: string;
}

type CachedCargoCheckResult =
  | {
      ok: true;
      execution: CachedCargoCheckExecution;
    }
  | {
      ok: false;
      result: ValidationCheckResult;
    };

const cargoCheckArgs = ["check", "--message-format=json", "--all-targets", "--all-features"] as const;
const cargoCheckCache = new WeakMap<ValidationFileView, Map<string, Promise<CachedCargoCheckResult>>>();

export function createCargoCheck(options: RustCommandCheckOptions = {}): ValidationCheckDefinition {
  return {
    id: RUST_CARGO_CHECK_ID,
    owner: rustCheckOwner,
    adapter: rustCheckAdapter,
    defaultSeverity: "error",
    supportedScopes: supportedRustValidationScopes,
    run: async (context) => {
      const skipped = skippedRustInputResult(context);
      if (skipped !== undefined) return skipped;
      const cached = await cachedCargoCheck(context, options);
      if (!cached.ok) return cached.result;
      return cargoExecutionResult(cached.execution, {
        category: "types",
        excludeCodes: ["dead_code"]
      });
    }
  };
}

export function createClippyCheck(options: RustCommandCheckOptions = {}): ValidationCheckDefinition {
  return cargoCommandCheck({
    id: RUST_CLIPPY_CHECK_ID,
    category: "lint",
    args: [
      "clippy",
      "--message-format=json",
      "--all-targets",
      "--all-features",
      "--",
      ...ownedClippyLints.flatMap((lint) => ["-D", lint])
    ],
    options,
    errorCodes: ownedClippyLints
  });
}

export function createDeadCodeCheck(options: RustCommandCheckOptions = {}): ValidationCheckDefinition {
  return {
    id: RUST_DEAD_CODE_CHECK_ID,
    owner: rustCheckOwner,
    adapter: rustCheckAdapter,
    defaultSeverity: "error",
    supportedScopes: supportedRustValidationScopes,
    run: (context) => runDeadCodeCheck(context, options)
  };
}

export function createRustdocCheck(options: RustCommandCheckOptions = {}): ValidationCheckDefinition {
  return {
    ...cargoCommandCheck({
      id: RUST_RUSTDOC_CHECK_ID,
      category: "types",
      args: ["doc", "--no-deps", "--all-features", "--message-format=json"],
      options
    }),
    run: async (context) => {
      const skipped = skippedRustInputResult(context);
      if (skipped !== undefined) return skipped;
      if (!toolAvailable("rustdoc", { env: options.env })) {
        return {
          status: "unsupported_request",
          diagnostics: [],
          failureMessage: "rustdoc is unavailable"
        };
      }
      return runCargoTool(context, {
        category: "types",
        args: ["doc", "--no-deps", "--all-features", "--message-format=json"],
        options,
        forceSeverity: "error"
      });
    }
  };
}

function cargoCommandCheck(args: {
  id: string;
  category: ValidationDiagnosticCategory;
  args: readonly string[];
  options: RustCommandCheckOptions;
  includeCodes?: readonly string[];
  excludeCodes?: readonly string[];
  errorCodes?: readonly string[];
  forceSeverity?: ValidationDiagnostic["severity"];
}): ValidationCheckDefinition {
  return {
    id: args.id,
    owner: rustCheckOwner,
    adapter: rustCheckAdapter,
    defaultSeverity: "error",
    supportedScopes: supportedRustValidationScopes,
    run: (context) =>
      runCargoTool(context, {
        category: args.category,
        args: args.args,
        options: args.options,
        includeCodes: args.includeCodes,
        excludeCodes: args.excludeCodes,
        errorCodes: args.errorCodes,
        forceSeverity: args.forceSeverity
      })
  };
}

async function runCargoTool(
  context: ValidationCheckContext,
  args: {
    category: ValidationDiagnosticCategory;
    args: readonly string[];
    options: RustCommandCheckOptions;
    includeCodes?: readonly string[];
    excludeCodes?: readonly string[];
    errorCodes?: readonly string[];
    forceSeverity?: ValidationDiagnostic["severity"];
  }
): Promise<ValidationCheckResult> {
  const skipped = skippedRustInputResult(context);
  if (skipped !== undefined) return skipped;
  const materialized = await materializeRustWorkspace(context, { env: args.options.env });
  const metadata = loadCargoMetadata(materialized.root, {
    ...args.options,
    cargoTargetCacheKey: materialized.cargoTargetCacheKey
  });
  if (!metadata.ok) return metadataFailureResult(metadata);
  const packageScope = resolveCargoPackageScope(metadata.metadata, context.scope);
  if (!packageScope.ok) return metadataFailureResult(packageScope);
  const commandArgs = scopedCargoArgs(args.args, packageScope.member);
  const result = runTool("cargo", commandArgs, {
    cwd: materialized.root,
    cargoTargetCacheKey: materialized.cargoTargetCacheKey,
    env: args.options.env,
    timeoutMs: args.options.timeoutMs,
    allowedExitCodes: [0, 101]
  });
  return (
    commandInfrastructureFailure(result) ??
    cargoDiagnosticsResult(result.stdout, materialized.root, args) ??
    cargoCommandFailureResult(result, args) ?? { diagnostics: [] }
  );
}

function cargoDiagnosticsResult(
  stdout: string,
  workspaceRoot: string,
  args: {
    category: ValidationDiagnosticCategory;
    includeCodes?: readonly string[];
    excludeCodes?: readonly string[];
    errorCodes?: readonly string[];
    forceSeverity?: ValidationDiagnostic["severity"];
  }
): ValidationCheckResult | undefined {
  const diagnostics = mapCargoJsonDiagnostics(stdout, args.category, workspaceRoot, {
    includeCodes: args.includeCodes,
    excludeCodes: args.excludeCodes,
    errorCodes: args.errorCodes,
    forceSeverity: args.forceSeverity
  });
  return diagnostics.length > 0 ? { diagnostics } : undefined;
}

function cargoCommandFailureResult(
  result: ReturnType<typeof runTool>,
  args: { category: ValidationDiagnosticCategory; args: readonly string[] }
): ValidationCheckResult | undefined {
  const unavailableFailure = commandUnavailableFailure(result, args.args[0] ?? "cargo");
  if (unavailableFailure !== undefined) return unavailableFailure;
  if (result.ok && result.status === 0) return undefined;
  return {
    diagnostics: [
      stderrDiagnostic({
        category: args.category,
        path: "Cargo.toml",
        code: "RUST_CARGO_COMMAND",
        stderr: result.stderr || result.stdout,
        fallback: "Rust cargo command failed"
      })
    ]
  };
}

async function cachedCargoCheck(
  context: ValidationCheckContext,
  options: RustCommandCheckOptions
): Promise<CachedCargoCheckResult> {
  const key = cargoCheckCacheKey(context, options);
  let fileViewCache = cargoCheckCache.get(context.fileView);
  if (fileViewCache === undefined) {
    fileViewCache = new Map();
    cargoCheckCache.set(context.fileView, fileViewCache);
  }
  const cached = fileViewCache.get(key);
  if (cached !== undefined) return cached;
  const promise = runCachedCargoCheck(context, options);
  fileViewCache.set(key, promise);
  return promise;
}

async function runCachedCargoCheck(
  context: ValidationCheckContext,
  options: RustCommandCheckOptions
): Promise<CachedCargoCheckResult> {
  const materialized = await materializeRustWorkspace(context, { env: options.env });
  const metadata = loadCargoMetadata(materialized.root, {
    ...options,
    cargoTargetCacheKey: materialized.cargoTargetCacheKey
  });
  if (!metadata.ok) return { ok: false, result: metadataFailureResult(metadata) };
  const packageScope = resolveCargoPackageScope(metadata.metadata, context.scope);
  if (!packageScope.ok) return { ok: false, result: metadataFailureResult(packageScope) };
  const commandArgs = scopedCargoArgs(cargoCheckArgs, packageScope.member);
  const result = runTool("cargo", commandArgs, {
    cwd: materialized.root,
    cargoTargetCacheKey: materialized.cargoTargetCacheKey,
    env: options.env,
    timeoutMs: options.timeoutMs,
    allowedExitCodes: [0, 101]
  });
  return {
    ok: true,
    execution: {
      args: commandArgs,
      metadata: metadata.metadata,
      member: packageScope.member,
      result,
      workspaceRoot: materialized.root
    }
  };
}

function cargoExecutionResult(
  execution: CachedCargoCheckExecution,
  args: {
    category: ValidationDiagnosticCategory;
    includeCodes?: readonly string[];
    excludeCodes?: readonly string[];
    errorCodes?: readonly string[];
    forceSeverity?: ValidationDiagnostic["severity"];
  }
): ValidationCheckResult {
  return (
    commandInfrastructureFailure(execution.result) ??
    cargoDiagnosticsResult(execution.result.stdout, execution.workspaceRoot, args) ??
    cargoCommandFailureResult(execution.result, { category: args.category, args: execution.args }) ?? { diagnostics: [] }
  );
}

function cargoCheckCacheKey(context: ValidationCheckContext, options: RustCommandCheckOptions): string {
  const env = options.env ?? process.env;
  return JSON.stringify({
    timeoutMs: options.timeoutMs,
    scope: {
      kind: context.scope.kind,
      packageName: context.scope.packageName,
      packageRoot: context.scope.packageRoot
    },
    env: {
      CARGO: env.CARGO ?? "",
      CARGO_BUILD_TARGET: env.CARGO_BUILD_TARGET ?? "",
      PATH: env.PATH ?? "",
      RUSTC: env.RUSTC ?? "",
      RUSTFLAGS: env.RUSTFLAGS ?? "",
      RUSTUP_TOOLCHAIN: env.RUSTUP_TOOLCHAIN ?? ""
    }
  });
}

function scopedCargoArgs(args: readonly string[], member: CargoMetadataPackage | undefined): readonly string[] {
  if (member === undefined) return args;
  const command = args[0];
  if (command === undefined) return args;
  return [command, "-p", member.name, ...args.slice(1)];
}

async function runDeadCodeCheck(context: ValidationCheckContext, options: RustCommandCheckOptions): Promise<ValidationCheckResult> {
  const skipped = skippedRustInputResult(context);
  if (skipped !== undefined) return skipped;
  const cached = await cachedCargoCheck(context, options);
  if (!cached.ok) return cached.result;
  const infrastructureFailure = commandInfrastructureFailure(cached.execution.result);
  if (infrastructureFailure !== undefined) return infrastructureFailure;
  const cargoDiagnostics = mapCargoJsonDiagnostics(cached.execution.result.stdout, "lint", cached.execution.workspaceRoot, {
    includeCodes: ["dead_code"],
    forceSeverity: "error"
  });
  const graphAnalysis = await analyzeRustModuleGraph(context, cached.execution.metadata, cached.execution.member, {
    unresolvedModules: false,
    unresolvedUses: false,
    cycles: false,
    orphanDiagnosticCode: "RUST_DEAD_ORPHAN_SOURCE",
    orphanMessage: (path) => `Rust source file is unreachable from Cargo targets and may contain dead code: ${path}`
  });
  const diagnostics = sortDiagnostics([...cargoDiagnostics, ...graphAnalysis.diagnostics]);
  if (diagnostics.length > 0) return { diagnostics };
  return cargoCommandFailureResult(cached.execution.result, {
    category: "lint",
    args: cached.execution.args
  }) ?? { diagnostics: [] };
}
