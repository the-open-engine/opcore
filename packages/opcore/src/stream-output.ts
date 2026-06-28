import type { CommandRouterResult } from "@the-open-engine/opcore-contracts";
import { commandRouterResultForJsonOutput } from "./json-output.js";

export function shouldWriteValidationStreamFinalJson(result: CommandRouterResult, argv: readonly string[]): boolean {
  return (
    !result.json &&
    result.owner === "validation" &&
    isValidationCommand(result.canonicalCommand) &&
    argv.some(isValidationStreamFlag)
  );
}

export function commandRouterResultForStreamFinalOutput(result: CommandRouterResult): CommandRouterResult {
  return commandRouterResultForJsonOutput({
    ...result,
    json: true
  });
}

function isValidationCommand(canonicalCommand: readonly string[]): boolean {
  return canonicalCommand[0] === "opcore" && (canonicalCommand[1] === "check" || canonicalCommand[1] === "validate");
}

function isValidationStreamFlag(arg: string): boolean {
  return arg === "--stream" || arg === "--ndjson" || arg === "--stream=ndjson";
}
