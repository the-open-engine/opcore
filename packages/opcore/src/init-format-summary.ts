import type { OpcoreInitPlanPayload } from "@the-open-engine/opcore-contracts";

export function approvalLine(
  payload: OpcoreInitPlanPayload,
  applied: boolean,
  approvalFlag?: string
): string {
  if (payload.interaction.promptState === "requested") return "Approval: awaiting TTY response.";
  if (payload.interaction.promptState === "declined") return "Approval: declined; no files written.";
  if (applied) return "Approval: applied.";
  const required = approvalFlag ?? (payload.mode === "undo" ? "--undo --approve" : "--approve");
  return payload.mode === "undo"
    ? `Approval: required; rerun with ${required} to restore/remove recorded files.`
    : `Approval: required; rerun with ${required} to write this setup.`;
}

export function languageSummary(payload: OpcoreInitPlanPayload): string {
  return payload.scan.languages.length === 0
    ? "none"
    : payload.scan.languages.map((entry) => `${entry.language} ${entry.files}`).join(", ");
}

export function unsupportedSummary(payload: OpcoreInitPlanPayload): string {
  return payload.scan.unsupportedStacks.length === 0
    ? "none"
    : payload.scan.unsupportedStacks.map((stack) => `${stack.language} ${stack.count}`).join(", ");
}

export function degradedToolSummary(payload: OpcoreInitPlanPayload): string {
  return payload.scan.degradedRustTools.length === 0
    ? "none"
    : payload.scan.degradedRustTools.map((tool) => `${tool.adapter}:${tool.tool}`).join(", ");
}

export function warningLines(payload: OpcoreInitPlanPayload): string[] {
  return payload.warnings.length === 0
    ? ["  none"]
    : payload.warnings.map((warning) => `  ${warning}`);
}

export function pythonManagerSummary(payload: OpcoreInitPlanPayload): string {
  const managers = payload.settings.python?.dependencyManagers;
  return managers?.length
    ? managers.map((manager) => `${manager.kind}:${manager.path}`).join(", ")
    : "none";
}

export function pythonEnvironmentSummary(payload: OpcoreInitPlanPayload): string {
  const environments = payload.settings.python?.virtualEnvironments;
  return environments?.length
    ? environments.map((environment) => environment.path).join(", ")
    : "none";
}
