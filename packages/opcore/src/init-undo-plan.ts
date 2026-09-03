import type { OpcoreInitPlanPayload } from "@the-open-engine/opcore-contracts";
import { AGENT_FILE_CANDIDATES } from "./init-constants.js";
import { actionPath } from "./init-action-helpers.js";
import { initContextPayload, initPayloadOptions } from "./init-context-payload.js";
import { scopeRoot } from "./init-prompts.js";
import { readUndoMetadata } from "./init-undo-metadata.js";
import type {
  InitContext,
  OpcoreSetupCommand,
  ParsedInitArgs
} from "./init-types.js";

export interface UndoPlanInput {
  repoRoot: string;
  requestedPath: string;
  homeRoot: string;
  options: ParsedInitArgs;
  context: InitContext;
}

export function planUndo(input: UndoPlanInput): OpcoreInitPlanPayload {
  const root = scopeRoot(input.repoRoot, input.homeRoot, input.options.scope);
  const metadata = readUndoMetadata(root, input.options.scope);
  return {
    schemaVersion: 1,
    mode: "undo",
    approved: input.options.approved && !input.options.dryRun,
    repo: { root: input.repoRoot, requestedPath: input.requestedPath },
    options: initPayloadOptions(input.options),
    agentFiles: metadata.entries
      .map((entry) => entry.path)
      .filter((path) => AGENT_FILE_CANDIDATES.includes(
        path as (typeof AGENT_FILE_CANDIDATES)[number]
      )),
    actions: metadata.entries.map((entry) => ({
      kind: entry.kind === "append_managed_line" ? "remove" : entry.existed ? "restore" : "remove",
      path: actionPath(input.options.scope, entry.path),
      targetScope: input.options.scope,
      summary: undoSummary(input.options.scope, entry),
      requiresApproval: !entry.path.startsWith(".opcore/"),
      outsideOpcore: !entry.path.startsWith(".opcore/")
    })),
    warnings: [],
    nextActions: input.options.approved && !input.options.dryRun
      ? [undoAppliedNextAction(input.options.command)]
      : [undoPreviewNextAction(input.options)],
    undoAvailable: true,
    ...initContextPayload(input.context)
  };
}

function undoSummary(
  scope: ParsedInitArgs["scope"],
  entry: ReturnType<typeof readUndoMetadata>["entries"][number]
): string {
  const path = actionPath(scope, entry.path);
  if (entry.kind === "append_managed_line") {
    return `Remove managed ${entry.line} gitignore entry from ${entry.path}.`;
  }
  return entry.existed
    ? `Restore ${path} from Opcore init backup.`
    : `Remove ${path} created by Opcore init.`;
}

export function undoAppliedNextAction(command: OpcoreSetupCommand): string {
  return command === "uninstall"
    ? "Opcore setup metadata was restored or removed; rerun opcore install to recreate setup."
    : "Opcore init metadata was restored or removed; rerun opcore init to recreate setup.";
}

function undoPreviewNextAction(options: ParsedInitArgs): string {
  if (options.command === "uninstall") {
    return `Run ${options.scope === "global"
      ? "opcore uninstall --global --yes"
      : "opcore uninstall --yes"} to restore or remove recorded setup files.`;
  }
  return `Run ${options.scope === "global"
    ? "opcore init --global --undo --approve"
    : "opcore init --undo --approve"} to restore or remove recorded setup files.`;
}
