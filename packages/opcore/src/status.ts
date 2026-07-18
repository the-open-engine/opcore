import type {
  CommandRouterResult,
  OpcoreRepoStatePayload,
  ParsedCommandArgv
} from "@the-open-engine/opcore-contracts";
import { createCommandRouterResult } from "@the-open-engine/opcore-contracts";
import {
  isStatusHelpArg,
  opcoreStatusHelpMessage,
  parseOpcoreStatusArgs
} from "./status-args.js";
import { errorMessage } from "./status-errors.js";
import { formatOpcoreStatus } from "./status-format.js";
import { resolveRepo } from "./status-repo.js";
import { createRepoState } from "./status-state.js";

export { commonSkippedPathSegments } from "./source-policy.js";
export { parseOpcoreRepoArgs, parseOpcoreStatusArgs } from "./status-args.js";
export { formatOpcoreStatus } from "./status-format.js";
export { resolveRepo, type RepoResolution } from "./status-repo.js";
export { createRepoState } from "./status-state.js";
export { validationPolicySummary } from "./status-validation.js";

export async function routeOpcoreStatus(argv: readonly string[], parsed: ParsedCommandArgv): Promise<CommandRouterResult> {
  const rest = parsed.args.slice(1);
  if (rest.some((arg) => isStatusHelpArg(arg))) return statusHelpResult(argv, parsed);
  const parsedStatus = parseOpcoreStatusArgs(rest);
  if (!parsedStatus.ok) return statusErrorResult(argv, parsed, parsedStatus.message);
  const resolution = resolveRepo(parsedStatus.repo, "opcore status");
  if (!resolution.ok) return statusErrorResult(argv, parsed, resolution.message);

  let repoState: OpcoreRepoStatePayload;
  try {
    repoState = await createRepoState(resolution.resolution);
  } catch (error) {
    return statusErrorResult(argv, parsed, errorMessage(error));
  }
  const includeAspLine = parsedStatus.showAspLine || repoState.activation.asp.state === "enrolled";
  return createCommandRouterResult({
    bin: "opcore",
    argv,
    canonicalCommand: ["opcore", "status"],
    owner: "runtime",
    status: "ok",
    json: parsed.json,
    message: formatOpcoreStatus(repoState, { includeAspLine }),
    repoState
  });
}

function statusHelpResult(argv: readonly string[], parsed: ParsedCommandArgv): CommandRouterResult {
  return createCommandRouterResult({
    bin: "opcore",
    argv,
    canonicalCommand: ["opcore", "status", "help"],
    owner: "runtime",
    status: "ok",
    json: parsed.json,
    message: opcoreStatusHelpMessage()
  });
}

function statusErrorResult(
  argv: readonly string[],
  parsed: ParsedCommandArgv,
  message: string
): CommandRouterResult {
  return createCommandRouterResult({
    bin: "opcore",
    argv,
    canonicalCommand: ["opcore", "status"],
    owner: "runtime",
    status: "error",
    json: parsed.json,
    message
  });
}
