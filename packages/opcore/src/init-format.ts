import type { OpcoreInitPlanPayload } from "@the-open-engine/opcore-contracts";
import {
  ACTIVE_PRE_COMMIT_HOOK_PATH,
  CLAUDE_SETTINGS_PATH
} from "./init-constants.js";
import type { OpcoreSetupCommand } from "./init-types.js";
import {
  approvalLine,
  degradedToolSummary,
  languageSummary,
  pythonEnvironmentSummary,
  pythonManagerSummary,
  unsupportedSummary,
  warningLines
} from "./init-format-summary.js";

export function formatSetupPlan(
  payload: OpcoreInitPlanPayload,
  applied: boolean,
  command: OpcoreSetupCommand
): string {
  if (command === "install") return formatInstallPlan(payload, applied);
  if (command === "uninstall") return formatUninstallPlan(payload, applied);
  return formatInitPlan(payload, applied);
}

function formatInstallPlan(payload: OpcoreInitPlanPayload, applied: boolean): string {
  const skillEnabled = payload.actions.some((action) => action.path.endsWith("/skills/opcore/SKILL.md"));
  const hooksEnabled = payload.actions.some((action) => action.path.endsWith(CLAUDE_SETTINGS_PATH));
  const preCommitEnabled = payload.actions.some((action) => action.path === ACTIVE_PRE_COMMIT_HOOK_PATH);
  const scanSummary =
    `Analyzed ${payload.scan.totalFiles} files; validation=${payload.scan.validationStatus}; ` +
    `diagnostics=${payload.scan.diagnosticCount}.`;
  return [
    "Opcore install:", `  ${scanSummary}`, "Setup choices:",
    `${skillEnabled ? "[x]" : "[ ]"} Install Opcore agent skill`,
    `${hooksEnabled ? "[x]" : "[ ]"} Install Claude Code and Codex write-gate hooks`,
    `${preCommitEnabled ? "[x]" : "[ ]"} Install Git pre-commit hook`, "",
    formatInitPlan(payload, applied, "--yes")
  ].join("\n");
}

function formatUninstallPlan(payload: OpcoreInitPlanPayload, applied: boolean): string {
  return [
    "Opcore uninstall:",
    "  Restore or remove only files recorded in .opcore/init-undo.json.",
    "",
    formatInitPlan(payload, applied, "--yes")
  ].join("\n");
}

function formatInitPlan(payload: OpcoreInitPlanPayload, applied: boolean, approvalFlag?: string): string {
  const actions = payload.actions.map((action) => `- ${action.kind} ${action.path}: ${action.summary}`);
  return [
    "Coverage:", `  files=${payload.scan.totalFiles}`,
    `  graph-supported=${payload.scan.graphSupportedFiles}`,
    `  validation-supported=${payload.scan.validationSupportedFiles}`,
    `  validation-retained=${payload.scan.validationRetainedFiles}`,
    `  unsupported=${unsupportedSummary(payload)}`, `  languages=${languageSummary(payload)}`,
    `  degraded-validation-tools=${degradedToolSummary(payload)}`,
    `  python-dependency-managers=${pythonManagerSummary(payload)}`,
    `  python-virtualenvs=${pythonEnvironmentSummary(payload)}`,
    "Findings:", `  diagnostics=${payload.scan.diagnosticCount}`,
    `  validation=${payload.scan.validationStatus}`,
    `  failed-checks=${payload.scan.failedChecks.length === 0 ? "none" : payload.scan.failedChecks.join(", ")}`,
    `  graph=${payload.scan.graphState}`, `  activation=${payload.scan.activationLevel}`,
    "Warnings:", ...warningLines(payload), payload.mode === "undo" ? "Undo:" : "Setup:",
    `Repo: ${payload.repo.root}`, `Scope: ${payload.options.scope}`, `Mode: ${payload.mode}`,
    `Approved: ${payload.approved ? "yes" : "no"}`, "Actions:", ...actions,
    approvalLine(payload, applied, approvalFlag), "Timing:",
    `  first-output-ms=${payload.timings.firstOutputMs} scan-ms=${payload.timings.scanMs} ` +
      `total-ms=${payload.timings.totalMs}`
  ].join("\n");
}

export function formatInteractiveOutcome(payload: OpcoreInitPlanPayload, command: OpcoreSetupCommand): string {
  return payload.approved
    ? `opcore ${command} applied\nApproval: applied.`
    : `opcore ${command} declined\nApproval: declined; no files written.`;
}
