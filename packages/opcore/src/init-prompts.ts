import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type {
  InitScope,
  OpcoreInitRuntime,
  OpcoreSetupCommand,
  ParsedInitArgs
} from "./init-types.js";

export function shouldPromptForApproval(
  json: boolean,
  options: ParsedInitArgs,
  runtime: OpcoreInitRuntime
): runtime is OpcoreInitRuntime & { readLine: (prompt: string) => Promise<string> } {
  return !json &&
    !options.approved &&
    !options.dryRun &&
    !options.undo &&
    isInteractiveRuntime(runtime) &&
    typeof runtime.readLine === "function";
}

export function shouldPromptForScope(
  json: boolean,
  options: ParsedInitArgs,
  git: boolean,
  runtime: OpcoreInitRuntime
): runtime is OpcoreInitRuntime & { readLine: (prompt: string) => Promise<string> } {
  return git &&
    !json &&
    !options.approved &&
    !options.dryRun &&
    !options.undo &&
    !options.scopeExplicit &&
    !options.repoExplicit &&
    isInteractiveRuntime(runtime) &&
    typeof runtime.readLine === "function";
}

export function parseScopeAnswer(answer: string | undefined): InitScope {
  const normalized = (answer ?? "").trim().toLowerCase();
  return normalized === "g" || normalized === "global" ? "global" : "repo";
}

export function initHomeRoot(runtime: OpcoreInitRuntime): string {
  return realpathSync(resolve(runtime.homeDir ?? homedir()));
}

export function scopeRoot(repoRoot: string, homeRoot: string, scope: InitScope): string {
  return scope === "global" ? homeRoot : repoRoot;
}

export function isInteractiveRuntime(runtime: OpcoreInitRuntime): boolean {
  return runtime.stdinIsTTY === true && runtime.stdoutIsTTY === true;
}

export function isApprovedAnswer(answer: string | undefined, command: OpcoreSetupCommand): boolean {
  const normalized = (answer ?? "").trim().toLowerCase();
  if (command === "install") return normalized === "" || normalized === "y" || normalized === "yes";
  return normalized === "y" || normalized === "yes";
}

export function approvalPromptSuffix(command: OpcoreSetupCommand): string {
  return command === "install" ? "[Y/n]" : "[y/N]";
}
