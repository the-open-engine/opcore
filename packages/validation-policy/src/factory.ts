import type { RequiredContextDocPolicy } from "@the-open-engine/opcore-contracts";
import type { ValidationCheckDefinition } from "@the-open-engine/opcore-validation";
import { createValidationCheckRegistry } from "@the-open-engine/opcore-validation";
import { createCloneValidationChecks } from "@the-open-engine/opcore-validation-clone";
import { createDocsValidationChecks, type CreateDocsValidationChecksOptions } from "@the-open-engine/opcore-validation-docs";
import { createNodePythonProjectWorkspace, createPythonValidationChecks } from "@the-open-engine/opcore-validation-python";
import { createRustValidationChecks } from "@the-open-engine/opcore-validation-rust";
import { createTypeScriptValidationChecks } from "@the-open-engine/opcore-validation-typescript";
import { readOpcoreRepoConfig } from "./config.js";
import { loadRepoCheckPacks } from "./check-packs.js";
import { withFilteredFileView } from "./path-policy.js";
import { configPath, type OpcoreClonePolicy, type OpcoreDocsPolicy, type OpcorePathPolicy, type OpcoreRepoConfig, type OpcoreRepoValidationPolicyOptions } from "./types.js";

export const defaultValidationChecks = createBuiltInValidationChecks();

export function validationChecksForRepoPolicy(
  repoRoot: string,
  options: OpcoreRepoValidationPolicyOptions = {}
): readonly ValidationCheckDefinition[] {
  const config = readOpcoreRepoConfig(repoRoot);
  return validationChecksForRepoConfig(repoRoot, config, options);
}

export function validationChecksForRepoPolicyAndCoverage(
  repoRoot: string,
  adapters: ReadonlySet<string>,
  options: OpcoreRepoValidationPolicyOptions = {}
): readonly ValidationCheckDefinition[] {
  return validationChecksForRepoPolicy(repoRoot, options).filter((check) => adapters.has(check.adapter));
}

export function createBuiltInValidationChecks(
  config?: OpcoreRepoConfig,
  options: OpcoreRepoValidationPolicyOptions = {},
  repoRoot?: string
): readonly ValidationCheckDefinition[] {
  const checksConfig = config?.validation.checks;
  const pythonWorkspace = options.pythonWorkspace ?? (repoRoot === undefined ? undefined : createNodePythonProjectWorkspace(repoRoot));
  return [
    ...createTypeScriptValidationChecks({
      fileLength: checksConfig?.typescript?.fileLength,
      functionMetrics: checksConfig?.typescript?.functionMetrics,
      lint:
        checksConfig?.typescript?.lint?.repoPlugin !== undefined && repoRoot !== undefined
          ? {
              repoRoot,
              repoPlugin: checksConfig.typescript.lint.repoPlugin,
              cacheDependencyGlobs: checksConfig.typescript.lint.cacheDependencyGlobs
            }
          : undefined,
      importGraph: checksConfig?.typescript?.importGraph,
      deadCode: checksConfig?.typescript?.deadCode
    }),
    ...createRustValidationChecks(rustValidationOptions(config)),
    ...createPythonValidationChecks({
      ...(pythonWorkspace === undefined ? {} : { nodeWorkspace: pythonWorkspace }),
      ...(options.pythonImportAnalyzer === undefined ? {} : { importAnalyzer: options.pythonImportAnalyzer })
    }),
    ...createDocsValidationChecks(docsValidationOptions(checksConfig?.docs)),
    ...cloneChecks(checksConfig?.clone, options)
  ];
}

function validationChecksForRepoConfig(
  repoRoot: string,
  config: OpcoreRepoConfig,
  options: OpcoreRepoValidationPolicyOptions
): readonly ValidationCheckDefinition[] {
  const builtIns = createBuiltInValidationChecks(config, options, repoRoot);
  const packChecks = loadRepoCheckPacks(repoRoot, config).flatMap((pack) => pack.checks);
  const available = [...builtIns, ...packChecks];
  createValidationCheckRegistry(available);

  const knownCheckIds = new Set(available.map((check) => check.id));
  const docsSelection = docsEnabledSelection(config.validation.checks.docs);
  const configuredDisabled = uniqueStrings([...config.validation.checks.disabled, ...docsSelection.disabled]);
  const configuredDefaults = uniqueStrings([...config.validation.checks.defaults, ...docsSelection.defaults]);
  assertKnownCheckIds(configuredDisabled, knownCheckIds, "validation.checks.disabled");
  assertKnownCheckIds(configuredDefaults, knownCheckIds, "validation.checks.defaults");

  const adapters = config.validation.adapters === undefined ? undefined : new Set<string>(config.validation.adapters);
  const disabled = new Set(configuredDisabled);
  const defaults = new Set(configuredDefaults);
  const filteredContexts = new WeakMap<object, Parameters<ValidationCheckDefinition["run"]>[0]>();
  const checks = available
    .filter((check) => adapters === undefined || adapters.has(check.adapter))
    .filter((check) => !disabled.has(check.id))
    .map((check) => applyDefaultScopePolicy(check, defaults))
    .map((check) => applyPathPolicy(check, config.validation.pathPolicy, filteredContexts));
  createValidationCheckRegistry(checks);
  return checks;
}

function cloneChecks(
  policy: OpcoreClonePolicy | undefined,
  options: OpcoreRepoValidationPolicyOptions
): readonly ValidationCheckDefinition[] {
  if (options.clone === false) return [];
  return createCloneValidationChecks({
    ...(options.clone?.invoke !== undefined ? { invoke: options.clone.invoke } : {}),
    ...cloneValidationOptions(policy)
  });
}

function rustValidationOptions(config?: OpcoreRepoConfig): Parameters<typeof createRustValidationChecks>[0] {
  return {
    ...(config?.validation.timeoutMs !== undefined ? { timeoutMs: config.validation.timeoutMs } : {}),
    ...(config?.validation.checks.rust?.fileLength !== undefined ? { fileLength: config.validation.checks.rust.fileLength } : {}),
    ...(config?.validation.checks.rust?.functionMetrics !== undefined
      ? { functionMetrics: config.validation.checks.rust.functionMetrics }
      : {}),
    ...(config?.validation.checks.rust?.commandGates !== undefined
      ? { commandGates: config.validation.checks.rust.commandGates }
      : {})
  };
}

function docsValidationOptions(policy: OpcoreDocsPolicy | undefined): CreateDocsValidationChecksOptions {
  return {
    ...(policy?.policy !== undefined ? { policy: policy.policy as unknown as RequiredContextDocPolicy } : {}),
    ...(policy?.history !== undefined ? { history: policy.history } : {}),
    ...(policy?.hubCoverage !== undefined ? { hubCoverage: docsHubCoverageOptions(policy.hubCoverage) } : {}),
    ...(policy?.subtreeCoverage !== undefined ? { subtreeCoverage: policy.subtreeCoverage } : {})
  };
}

function docsHubCoverageOptions(
  policy: NonNullable<OpcoreDocsPolicy["hubCoverage"]>
): NonNullable<CreateDocsValidationChecksOptions["hubCoverage"]> {
  return {
    ...(policy.minFanIn !== undefined ? { minFanIn: policy.minFanIn } : {}),
    ...(policy.minFanOut !== undefined ? { minFanOut: policy.minFanOut } : {}),
    ...(policy.requireExplicitMention !== undefined ? { requireExplicitMention: policy.requireExplicitMention } : {})
  };
}

function cloneValidationOptions(policy: OpcoreClonePolicy | undefined) {
  return {
    ...(policy?.windowSize !== undefined ? { windowSize: policy.windowSize } : {}),
    ...(policy?.minLines !== undefined ? { minLines: policy.minLines } : {}),
    ...(policy?.minTokens !== undefined ? { minTokens: policy.minTokens } : {}),
    ...(policy?.threshold !== undefined ? { threshold: policy.threshold } : {}),
    ...(policy?.partitions !== undefined ? { partitions: policy.partitions } : {}),
    ...(policy?.exclude !== undefined ? { exclude: policy.exclude } : {}),
    ...(policy?.modes !== undefined ? { modes: policy.modes } : {})
  };
}

function applyDefaultScopePolicy(check: ValidationCheckDefinition, defaults: ReadonlySet<string>): ValidationCheckDefinition {
  if (!defaults.has(check.id)) return check;
  return { ...check, defaultScopes: check.supportedScopes };
}

function applyPathPolicy(
  check: ValidationCheckDefinition,
  pathPolicy: OpcorePathPolicy | undefined,
  filteredContexts: WeakMap<object, Parameters<ValidationCheckDefinition["run"]>[0]>
): ValidationCheckDefinition {
  if (pathPolicy === undefined) return check;
  const filteredContext = (context: Parameters<ValidationCheckDefinition["run"]>[0]) => {
    const existing = filteredContexts.get(context.fileView);
    if (existing !== undefined) return existing;
    const filtered = withFilteredFileView(context, pathPolicy);
    filteredContexts.set(context.fileView, filtered);
    return filtered;
  };
  const run: ValidationCheckDefinition["run"] = (context) => check.run(filteredContext(context));
  if (check.graphRequirements === undefined) return { ...check, run };
  const graphRequirements: NonNullable<ValidationCheckDefinition["graphRequirements"]> = (context) =>
    check.graphRequirements?.(filteredContext(context)) ?? [];
  return { ...check, graphRequirements, run };
}

function assertKnownCheckIds(values: readonly string[], knownCheckIds: ReadonlySet<string>, path: string): void {
  for (const value of values) {
    if (!knownCheckIds.has(value)) throw new Error(`Invalid Opcore config ${configPath}: unknown check id ${value}`);
  }
}

function docsEnabledSelection(policy: OpcoreDocsPolicy | undefined): { disabled: readonly string[]; defaults: readonly string[] } {
  const enabled = policy?.enabled;
  if (enabled === undefined) return { disabled: [], defaults: [] };
  const disabled: string[] = [];
  const defaults: string[] = [];
  const mapping: Record<string, string> = {
    existence: "docs.existence",
    freshness: "docs.freshness",
    staleness: "docs.staleness",
    length: "docs.length",
    hubCoverage: "docs.hub-coverage",
    subtreeCoverage: "docs.subtree-coverage"
  };
  for (const [key, value] of Object.entries(enabled)) {
    const checkId = mapping[key];
    if (checkId === undefined) continue;
    if (value) defaults.push(checkId);
    else disabled.push(checkId);
  }
  return { disabled, defaults };
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
