import type { ValidationCheckDefinition, ValidationCheckResult } from "@the-open-engine/opcore-validation";
import { isAbsolute, relative, resolve } from "node:path";
import { rustCheckAdapter, rustCheckOwner, supportedRustValidationScopes } from "./check-constants.js";
import { runTool, toolInvocation } from "./process.js";

export interface RustCommandGate {
  id: string;
  command: string;
  args?: readonly string[];
  cwd?: string;
  timeoutMs?: number;
}

export interface RustCommandGateOptions {
  commandGates?: readonly RustCommandGate[];
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

export function createCommandGateChecks(options: RustCommandGateOptions = {}): readonly ValidationCheckDefinition[] {
  return (options.commandGates ?? []).map((gate) => createCommandGateCheck(gate, options));
}

function createCommandGateCheck(
  gate: RustCommandGate,
  options: RustCommandGateOptions
): ValidationCheckDefinition {
  return {
    id: gate.id,
    owner: rustCheckOwner,
    adapter: rustCheckAdapter,
    defaultSeverity: "error",
    supportedScopes: supportedRustValidationScopes,
    requiresGraph: false,
    run: (context): ValidationCheckResult => {
      const repoRoot = context.request.repo.repoRoot;
      if (repoRoot === undefined) {
        return {
          status: "unsupported_request",
          failureMessage: `Rust command gate ${gate.id} requires request.repo.repoRoot`
        };
      }

      const resolution = resolveGateCommand(repoRoot, gate);
      if (resolution instanceof Error) {
        return {
          status: "unsupported_request",
          failureMessage: resolution.message
        };
      }

      const result = runTool(resolution.command, gate.args ?? [], {
        cwd: resolution.cwd,
        env: options.env,
        timeoutMs: gate.timeoutMs ?? options.timeoutMs
      });
      if (result.ok) return { diagnostics: [] };
      if (result.timedOut || result.status === null) {
        return {
          diagnostics: [],
          status: "infrastructure_failure",
          failureMessage: result.failureMessage ?? `Rust command gate ${gate.id} failed to run`
        };
      }
      return {
        diagnostics: [
          {
            category: "policy",
            severity: "error",
            code: "RUST_COMMAND_GATE_FAILED",
            message: commandGateFailureMessage(gate, result)
          }
        ]
      };
    }
  };
}

function resolveGateCommand(repoRoot: string, gate: RustCommandGate): { command: string; cwd: string } | Error {
  const cwd = resolveGateCwd(repoRoot, gate.cwd ?? ".");
  if (cwd instanceof Error) return cwd;
  if (gate.command.trim().length === 0) return new Error(`Rust command gate ${gate.id} command must be non-empty`);
  if (isAbsolute(gate.command)) return new Error(`Rust command gate ${gate.id} command must not be absolute`);
  if (containsParentTraversal(gate.command)) return new Error(`Rust command gate ${gate.id} command must not contain parent traversal`);
  const command = hasPathSeparator(gate.command) ? resolve(repoRoot, gate.command) : gate.command;
  if (hasPathSeparator(gate.command)) {
    const commandCheck = assertInsideRepo(repoRoot, command, `Rust command gate ${gate.id} command`);
    if (commandCheck instanceof Error) return commandCheck;
  }
  return { command, cwd };
}

function resolveGateCwd(repoRoot: string, cwd: string): string | Error {
  if (isAbsolute(cwd)) return new Error("Rust command gate cwd must be repo-relative");
  if (containsParentTraversal(cwd)) return new Error("Rust command gate cwd must not contain parent traversal");
  const resolved = resolve(repoRoot, cwd);
  return assertInsideRepo(repoRoot, resolved, "Rust command gate cwd") ?? resolved;
}

function assertInsideRepo(repoRoot: string, path: string, label: string): Error | undefined {
  const relativePath = relative(resolve(repoRoot), resolve(path));
  if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) return undefined;
  return new Error(`${label} must stay inside the repo`);
}

function containsParentTraversal(path: string): boolean {
  return path.split(/[\\/]+/).includes("..");
}

function hasPathSeparator(path: string): boolean {
  return path.includes("/") || path.includes("\\");
}

function commandGateFailureMessage(gate: RustCommandGate, result: ReturnType<typeof runTool>): string {
  const output = [result.stderr.trim(), result.stdout.trim()].filter((line) => line.length > 0).join("\n");
  const summary = output.length > 0 ? `\n${truncateOutput(output)}` : "";
  return `Rust command gate ${gate.id} failed: ${toolInvocation(result.command, result.args)} exited with status ${result.status}.${summary}`;
}

function truncateOutput(output: string): string {
  return output.length <= 2000 ? output : `${output.slice(0, 2000)}...`;
}
