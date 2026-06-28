import type { GraphProviderMode, ValidationReportMode, ValidationRequest, ValidationScope } from "@the-open-engine/opcore-contracts";
import { validateRepoRelativePath } from "@the-open-engine/opcore-contracts";

export type ValidationCommandKind = "check" | "validate";
export type CheckCommandRoute = "files" | "staged" | "changed" | "tree" | "all" | "manifest";
export type ValidateCommandRoute = "request" | "hypothetical" | "pre-write" | "manifest";

export const DEFAULT_PRE_WRITE_TIMEOUT_MS = 30000;

export interface ParsedValidationCommandOptions {
  route: CheckCommandRoute | ValidateCommandRoute;
  repoRoot?: string;
  graphMode: GraphProviderMode;
  graphModeOverride?: GraphProviderMode;
  checks?: readonly string[];
  reportMode?: ValidationReportMode;
  scope?: ValidationScope;
  requestFile?: string;
  timeoutMs?: number;
}

interface CommonValidationCommandOptions {
  positionals: string[];
  repoRoot?: string;
  repoFlag: boolean;
  files: readonly string[];
  filesFlag: boolean;
  staged: boolean;
  changed: boolean;
  treeRef?: string;
  treeFlag: boolean;
  changedFrom?: string;
  changedFromFlag: boolean;
  all: boolean;
  baseRef?: string;
  baseFlag: boolean;
  graphMode: GraphProviderMode;
  graphModeOverride?: GraphProviderMode;
  graphModeFlag: boolean;
  checks?: readonly string[];
  checkFilterFlag: boolean;
  reportMode?: ValidationReportMode;
  reportModeFlag: boolean;
  requestFile?: string;
  requestFileFlag: boolean;
  timeoutMs?: number;
  timeoutFlag: boolean;
}

export class ValidationCommandOptionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationCommandOptionsError";
  }
}

export function parseCheckCommandOptions(args: readonly string[]): ParsedValidationCommandOptions {
  const state = parseCommonOptions(args);
  let route: CheckCommandRoute | undefined;
  let scope: ValidationScope | undefined;
  const scopes: ValidationScope[] = [];
  const positionals = state.positionals;
  const positionalRoute = positionals[0];

  if (positionalRoute === "manifest") {
    route = "manifest";
    if (positionals.length > 1) throw new ValidationCommandOptionsError("opcore check manifest does not accept operands");
  } else if (positionalRoute === "files") {
    route = "files";
    const files = state.files.length > 0 ? state.files : normalizeFiles(positionals.slice(1));
    scopes.push({ kind: "files", files });
  } else if (positionalRoute === "staged") {
    route = "staged";
    rejectExtraPositionals(positionals, "staged");
    scopes.push({ kind: "staged" });
  } else if (positionalRoute === "changed") {
    route = "changed";
    rejectExtraPositionals(positionals, "changed");
    if (state.baseRef === undefined) throw new ValidationCommandOptionsError("opcore check changed requires --base");
    scopes.push({ kind: "changed", baseRef: state.baseRef });
  } else if (positionalRoute === "tree") {
    route = "tree";
    rejectExtraPositionals(positionals, "tree");
    if (state.treeRef === undefined) throw new ValidationCommandOptionsError("opcore check tree requires --tree");
    if (state.changedFrom === undefined) throw new ValidationCommandOptionsError("opcore check tree requires --changed-from");
    scopes.push({ kind: "tree", treeRef: state.treeRef, changedFrom: state.changedFrom });
  } else if (positionalRoute === "all") {
    route = "all";
    rejectExtraPositionals(positionals, "all");
    scopes.push({ kind: "all" });
  } else if (positionalRoute !== undefined) {
    throw new ValidationCommandOptionsError(`unsupported opcore check route: ${positionalRoute}`);
  }

  if (state.files.length > 0 && route !== "files" && route !== "manifest") {
    scopes.push({ kind: "files", files: state.files });
    route = route ?? "files";
  }
  if (state.staged) {
    scopes.push({ kind: "staged" });
    route = route ?? "staged";
  }
  if (state.changed) {
    if (state.baseRef === undefined) throw new ValidationCommandOptionsError("opcore check --changed requires --base");
    scopes.push({ kind: "changed", baseRef: state.baseRef });
    route = route ?? "changed";
  }
  if (state.treeRef !== undefined && route !== "tree") {
    if (state.changedFrom === undefined) throw new ValidationCommandOptionsError("opcore check --tree requires --changed-from");
    scopes.push({ kind: "tree", treeRef: state.treeRef, changedFrom: state.changedFrom });
    route = route ?? "tree";
  }
  if (state.all) {
    scopes.push({ kind: "all" });
    route = route ?? "all";
  }

  if (route === "manifest") {
    rejectManifestExecutionOptions("opcore check manifest", state);
    if (scopes.length > 0) throw new ValidationCommandOptionsError("opcore check manifest cannot be combined with a scope");
    return { route, repoRoot: state.repoRoot, graphMode: state.graphMode, graphModeOverride: state.graphModeOverride, checks: state.checks };
  }
  rejectDisallowedOptions("opcore check", requestFileFlagNames(state));
  rejectDisallowedOptions("opcore check", timeoutFlagNames(state));
  if (state.baseFlag && !state.changed && route !== "changed") {
    throw new ValidationCommandOptionsError("opcore check --base requires the changed scope");
  }
  if (state.changedFromFlag && route !== "tree") {
    throw new ValidationCommandOptionsError("opcore check --changed-from requires the tree scope");
  }
  if (scopes.length !== 1) {
    throw new ValidationCommandOptionsError(
      scopes.length === 0 ? "opcore check requires exactly one scope" : "opcore check accepts exactly one scope"
    );
  }
  scope = scopes[0];
  if (scope.kind === "files" && scope.files.length === 0) {
    throw new ValidationCommandOptionsError("opcore check files requires at least one file");
  }
  const parsed: ParsedValidationCommandOptions = {
    route: (route ?? scope.kind) as CheckCommandRoute,
    repoRoot: state.repoRoot,
    graphMode: state.graphMode,
    graphModeOverride: state.graphModeOverride,
    checks: state.checks,
    scope
  };
  if (state.reportMode !== undefined) parsed.reportMode = state.reportMode;
  else if (parsed.route === "changed") parsed.reportMode = "introduced";
  return parsed;
}

export function parseValidateCommandOptions(args: readonly string[]): ParsedValidationCommandOptions {
  const state = parseCommonOptions(args);
  const positionals = state.positionals;
  const [head, ...rest] = positionals;
  let route: ValidateCommandRoute = "request";
  if (head === "manifest") {
    route = "manifest";
    if (rest.length > 0) throw new ValidationCommandOptionsError("opcore validate manifest does not accept operands");
  } else if (head === "hypothetical") {
    route = "hypothetical";
    if (rest.length > 0) throw new ValidationCommandOptionsError("opcore validate hypothetical does not accept operands");
  } else if (head === "pre-write") {
    route = "pre-write";
    if (rest.length > 0) throw new ValidationCommandOptionsError("opcore validate pre-write does not accept operands");
  } else if (head === "request") {
    route = "request";
    if (rest.length > 0) throw new ValidationCommandOptionsError("opcore validate request does not accept operands");
  } else if (head !== undefined) {
    throw new ValidationCommandOptionsError(`unsupported opcore validate route: ${head}`);
  }

  if (route === "manifest") {
    rejectManifestExecutionOptions("opcore validate manifest", state);
    return { route, repoRoot: state.repoRoot, graphMode: state.graphMode, graphModeOverride: state.graphModeOverride, checks: state.checks };
  }
  if (route === "pre-write") {
    rejectDisallowedOptions(`opcore validate ${route}`, [
      ...repoFlagNames(state),
      ...scopeFlagNames(state),
      ...checkFilterFlagNames(state),
      ...graphModeFlagNames(state)
    ]);
    if (state.requestFile === undefined) throw new ValidationCommandOptionsError("opcore validate pre-write requires --request-file");
    if (state.requestFile === "-") throw new ValidationCommandOptionsError("stdin request payloads are not supported");
    return {
      route,
      graphMode: state.graphMode,
      requestFile: state.requestFile,
      reportMode: state.reportMode ?? "introduced",
      timeoutMs: state.timeoutMs ?? DEFAULT_PRE_WRITE_TIMEOUT_MS
    };
  }
  rejectDisallowedOptions(`opcore validate ${route}`, scopeFlagNames(state));
  rejectDisallowedOptions(`opcore validate ${route}`, timeoutFlagNames(state));
  if (state.requestFile === undefined) throw new ValidationCommandOptionsError("opcore validate requires --request-file");
  const parsed: ParsedValidationCommandOptions = {
    route,
    repoRoot: state.repoRoot,
    graphMode: state.graphMode,
    graphModeOverride: state.graphModeOverride,
    checks: state.checks,
    requestFile: state.requestFile
  };
  if (state.reportMode !== undefined) parsed.reportMode = state.reportMode;
  return parsed;
}

function parseCommonOptions(args: readonly string[]): {
  positionals: string[];
  repoRoot?: string;
  repoFlag: boolean;
  files: readonly string[];
  filesFlag: boolean;
  staged: boolean;
  changed: boolean;
  treeRef?: string;
  treeFlag: boolean;
  changedFrom?: string;
  changedFromFlag: boolean;
  all: boolean;
  baseRef?: string;
  baseFlag: boolean;
  graphMode: GraphProviderMode;
  graphModeOverride?: GraphProviderMode;
  graphModeFlag: boolean;
  checks?: readonly string[];
  checkFilterFlag: boolean;
  reportMode?: ValidationReportMode;
  reportModeFlag: boolean;
  requestFile?: string;
  requestFileFlag: boolean;
  timeoutMs?: number;
  timeoutFlag: boolean;
} {
  const state = {
    positionals: [] as string[],
    repoRoot: undefined as string | undefined,
    repoFlag: false,
    files: [] as string[],
    filesFlag: false,
    staged: false,
    changed: false,
    treeRef: undefined as string | undefined,
    treeFlag: false,
    changedFrom: undefined as string | undefined,
    changedFromFlag: false,
    all: false,
    baseRef: undefined as string | undefined,
    baseFlag: false,
    graphMode: "optional" as GraphProviderMode,
    graphModeOverride: undefined as GraphProviderMode | undefined,
    graphModeFlag: false,
    checks: [] as string[],
    checkFilterFlag: false,
    reportMode: undefined as ValidationReportMode | undefined,
    reportModeFlag: false,
    requestFile: undefined as string | undefined,
    requestFileFlag: false,
    timeoutMs: undefined as number | undefined,
    timeoutFlag: false
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--repo") {
      state.repoFlag = true;
      state.repoRoot = requiredValue(args, ++index, "--repo");
    }
    else if (arg.startsWith("--repo=")) {
      state.repoFlag = true;
      state.repoRoot = inlineValue(arg, "--repo");
    }
    else if (arg === "--files") {
      state.filesFlag = true;
      state.files.push(...consumeFiles(args, () => ++index, (nextIndex) => (index = nextIndex)));
    } else if (arg.startsWith("--files=")) {
      state.filesFlag = true;
      state.files.push(...splitPaths(inlineValue(arg, "--files")));
    }
    else if (arg === "--staged") state.staged = true;
    else if (arg === "--changed") state.changed = true;
    else if (arg === "--tree") {
      state.treeFlag = true;
      state.treeRef = requiredValue(args, ++index, "--tree");
    } else if (arg.startsWith("--tree=")) {
      state.treeFlag = true;
      state.treeRef = inlineValue(arg, "--tree");
    }
    else if (arg === "--changed-from") {
      state.changedFromFlag = true;
      state.changedFrom = requiredValue(args, ++index, "--changed-from");
    } else if (arg.startsWith("--changed-from=")) {
      state.changedFromFlag = true;
      state.changedFrom = inlineValue(arg, "--changed-from");
    }
    else if (arg === "--all") state.all = true;
    else if (arg === "--base") {
      state.baseFlag = true;
      state.baseRef = requiredValue(args, ++index, "--base");
    } else if (arg.startsWith("--base=")) {
      state.baseFlag = true;
      state.baseRef = inlineValue(arg, "--base");
    }
    else if (arg === "--graph-mode") {
      state.graphModeFlag = true;
      state.graphMode = graphMode(requiredValue(args, ++index, "--graph-mode"));
      state.graphModeOverride = state.graphMode;
    } else if (arg.startsWith("--graph-mode=")) {
      state.graphModeFlag = true;
      state.graphMode = graphMode(inlineValue(arg, "--graph-mode"));
      state.graphModeOverride = state.graphMode;
    }
    else if (arg === "--check") {
      state.checkFilterFlag = true;
      state.checks.push(requiredValue(args, ++index, "--check"));
    } else if (arg.startsWith("--check=")) {
      state.checkFilterFlag = true;
      state.checks.push(inlineValue(arg, "--check"));
    } else if (arg === "--checks") {
      state.checkFilterFlag = true;
      state.checks.push(...splitPaths(requiredValue(args, ++index, "--checks")));
    } else if (arg.startsWith("--checks=")) {
      state.checkFilterFlag = true;
      state.checks.push(...splitPaths(inlineValue(arg, "--checks")));
    }
    else if (arg === "--introduced") {
      state.reportModeFlag = true;
      state.reportMode = "introduced";
    }
    else if (arg === "--report-mode") {
      state.reportModeFlag = true;
      state.reportMode = reportModeValue(requiredValue(args, ++index, "--report-mode"));
    } else if (arg.startsWith("--report-mode=")) {
      state.reportModeFlag = true;
      state.reportMode = reportModeValue(inlineValue(arg, "--report-mode"));
    }
    else if (arg === "--request-file") {
      state.requestFileFlag = true;
      state.requestFile = requiredValue(args, ++index, "--request-file");
    } else if (arg.startsWith("--request-file=")) {
      state.requestFileFlag = true;
      state.requestFile = inlineValue(arg, "--request-file");
    } else if (arg === "--timeout-ms") {
      state.timeoutFlag = true;
      state.timeoutMs = positiveIntegerValue(requiredValue(args, ++index, "--timeout-ms"), "--timeout-ms");
    } else if (arg.startsWith("--timeout-ms=")) {
      state.timeoutFlag = true;
      state.timeoutMs = positiveIntegerValue(arg.slice("--timeout-ms=".length), "--timeout-ms");
    }
    else if (arg.startsWith("-")) throw new ValidationCommandOptionsError(`unsupported validation flag: ${arg}`);
    else state.positionals.push(arg);
  }
  return {
    ...state,
    files: normalizeFiles(state.files),
    checks: state.checks.length > 0 ? normalizeChecks(state.checks) : undefined
  };
}

function rejectManifestExecutionOptions(command: string, state: CommonValidationCommandOptions): void {
  rejectDisallowedOptions(command, [
    ...scopeFlagNames(state),
    ...requestFileFlagNames(state),
    ...checkFilterFlagNames(state),
    ...graphModeFlagNames(state),
    ...reportModeFlagNames(state),
    ...timeoutFlagNames(state)
  ]);
}

function rejectDisallowedOptions(command: string, flags: readonly string[]): void {
  const uniqueFlags = [...new Set(flags)];
  if (uniqueFlags.length > 0) {
    throw new ValidationCommandOptionsError(`${command} cannot be combined with ${uniqueFlags.join(", ")}`);
  }
}

function scopeFlagNames(state: CommonValidationCommandOptions): string[] {
  const flags: string[] = [];
  if (state.filesFlag) flags.push("--files");
  if (state.staged) flags.push("--staged");
  if (state.changed) flags.push("--changed");
  if (state.treeFlag) flags.push("--tree");
  if (state.changedFromFlag) flags.push("--changed-from");
  if (state.all) flags.push("--all");
  if (state.baseFlag) flags.push("--base");
  return flags;
}

function requestFileFlagNames(state: CommonValidationCommandOptions): string[] {
  return state.requestFileFlag ? ["--request-file"] : [];
}

function repoFlagNames(state: CommonValidationCommandOptions): string[] {
  return state.repoFlag ? ["--repo"] : [];
}

function checkFilterFlagNames(state: CommonValidationCommandOptions): string[] {
  return state.checkFilterFlag ? ["--check/--checks"] : [];
}

function graphModeFlagNames(state: CommonValidationCommandOptions): string[] {
  return state.graphModeFlag ? ["--graph-mode"] : [];
}

function reportModeFlagNames(state: CommonValidationCommandOptions): string[] {
  return state.reportModeFlag ? ["--report-mode"] : [];
}

function timeoutFlagNames(state: CommonValidationCommandOptions): string[] {
  return state.timeoutFlag ? ["--timeout-ms"] : [];
}

function consumeFiles(
  args: readonly string[],
  firstIndex: () => number,
  setIndex: (index: number) => void
): string[] {
  const values: string[] = [];
  let index = firstIndex();
  while (index < args.length) {
    const value = args[index];
    if (value === undefined || value.startsWith("--")) break;
    values.push(...splitPaths(value));
    index += 1;
  }
  if (values.length === 0) throw new ValidationCommandOptionsError("--files requires at least one path");
  setIndex(index - 1);
  return values;
}

function normalizeFiles(files: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const file of files) {
    const path = validateRepoRelativePath(file.trim());
    if (!seen.has(path)) normalized.push(path);
    seen.add(path);
  }
  return normalized;
}

function normalizeChecks(checks: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const check of checks) {
    const checkId = check.trim();
    if (checkId.length === 0) throw new ValidationCommandOptionsError("validation check ids must not be blank");
    if (!seen.has(checkId)) normalized.push(checkId);
    seen.add(checkId);
  }
  return normalized;
}

function rejectExtraPositionals(positionals: readonly string[], route: string): void {
  if (positionals.length > 1) throw new ValidationCommandOptionsError(`opcore check ${route} does not accept operands`);
}

function requiredValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new ValidationCommandOptionsError(`${flag} requires a value`);
  return value;
}

function inlineValue(arg: string, flag: string): string {
  const value = arg.slice(`${flag}=`.length);
  if (!value) throw new ValidationCommandOptionsError(`${flag} requires a value`);
  return value;
}

function positiveIntegerValue(value: string, flag: string): number {
  if (!/^[1-9]\d*$/.test(value)) throw new ValidationCommandOptionsError(`${flag} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new ValidationCommandOptionsError(`${flag} must be a positive integer`);
  return parsed;
}

function graphMode(value: string): GraphProviderMode {
  if (value === "optional" || value === "required") return value;
  throw new ValidationCommandOptionsError(`unsupported validation graph mode: ${value}`);
}

function reportModeValue(value: string): ValidationReportMode {
  if (value === "all" || value === "introduced") return value;
  throw new ValidationCommandOptionsError("--report-mode must be all or introduced");
}

function splitPaths(value: string): string[] {
  return value
    .split(/[,:]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}
