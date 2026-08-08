import type {
  OpcoreInitScanSummary,
  OpcoreInitSettings
} from "@the-open-engine/opcore-contracts";
import { CONFIG_PATH } from "./init-constants.js";
import { isPlainObject } from "./init-data.js";
import { readJsonObject } from "./init-files.js";

export interface InitConfigInput {
  repoRoot: string;
  failClosedHook: boolean;
  activePreCommitHook: boolean;
  writeGateHooks: boolean;
  scan: OpcoreInitScanSummary;
  settings: OpcoreInitSettings;
}

export function createConfig(input: InitConfigInput): Record<string, unknown> {
  const existing = readJsonObject(input.repoRoot, CONFIG_PATH);
  const hooks = isPlainObject(existing.hooks) ? existing.hooks : {};
  const guidance = isPlainObject(existing.guidance) ? existing.guidance : {};
  const onboarding = isPlainObject(existing.onboarding) ? existing.onboarding : {};
  return {
    ...existing,
    schemaVersion: 1,
    kind: "opcore_init_config",
    onboarding: {
      ...onboarding,
      scan: isPlainObject(onboarding.scan) ? onboarding.scan : input.scan,
      languages: Array.isArray(onboarding.languages) ? onboarding.languages : input.settings.languages,
      timingPayload: true
    },
    guidance: {
      ...guidance,
      checkCommand: "opcore check --changed",
      preserveExistingGuardrails: true,
      treatUnsupportedCoverageHonestly: true,
      directProductAuthority: "opcore"
    },
    hooks: createHookConfig(hooks, input)
  };
}

function createHookConfig(
  existing: Record<string, unknown>,
  input: InitConfigInput
): Record<string, unknown> {
  const harnesses = input.writeGateHooks
    ? ["claude-code", "codex"]
    : Array.isArray(existing.harnesses) ? existing.harnesses : [];
  return {
    ...existing,
    failClosedPreCommit:
      existing.failClosedPreCommit === true || input.failClosedHook || input.activePreCommitHook,
    activePreCommit: existing.activePreCommit === true || input.activePreCommitHook,
    writeGate: existing.writeGate === true || input.writeGateHooks,
    harnesses
  };
}
