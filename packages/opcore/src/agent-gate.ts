import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  createNodeEditWorkspace,
  createPatchEditPlan,
  isCodexApplyPatch
} from "@the-open-engine/opcore-edit";
import type { HypotheticalOverlay, PreWriteValidationReceipt, ValidationRequest } from "@the-open-engine/opcore-contracts";

declare const process: {
  argv: string[];
  cwd(): string;
  env?: Record<string, string | undefined>;
  exitCode?: number;
  stdin: AsyncIterable<unknown>;
  stderr: {
    write(text: string): void;
  };
  stdout: {
    write(text: string): void;
  };
};

export interface OpcoreAgentGateCliRuntime {
  stdin?: AsyncIterable<unknown>;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

interface AgentGateArgs {
  harness: "claude" | "codex" | "unknown";
  repo?: string;
}

interface ToolRequest {
  toolName: string;
  normalizedToolName: string;
  toolInput: Record<string, unknown>;
  cwd?: string;
}

type AdapterResult =
  | { kind: "skip" }
  | { kind: "request"; toolName: string; request: ValidationRequest };

const writeTools = new Set(["write"]);
const editTools = new Set(["edit"]);
const multiEditTools = new Set(["multiedit", "multi_edit"]);
const applyPatchTools = new Set(["applypatch", "apply_patch"]);
const validationTimeoutMs = 30_000;
const maxFeedbackChars = 4000;

export function opcoreAgentGateHookScriptContent(): string {
  const moduleUrl = new URL("./agent-gate.js", import.meta.url).href;
  return [
    "#!/usr/bin/env node",
    `import { runOpcoreAgentGateCli } from ${JSON.stringify(moduleUrl)};`,
    "const exitCode = await runOpcoreAgentGateCli(process.argv.slice(2));",
    "process.exit(exitCode);",
    ""
  ].join("\n");
}

export async function runOpcoreAgentGateCli(
  argv: readonly string[] = process.argv.slice(2),
  runtime: OpcoreAgentGateCliRuntime = {}
): Promise<number> {
  const stderr = runtime.stderr ?? ((text: string) => process.stderr.write(text));
  try {
    const args = parseAgentGateArgs(argv);
    const rawInput = await readStdin(runtime.stdin ?? process.stdin);
    const mapped = await mapHookPayload(rawInput, args);
    if (mapped.kind === "skip") return 0;
    let receipt: PreWriteValidationReceipt;
    try {
      receipt = runPreWriteValidation(mapped.request);
    } catch (error) {
      stderr(`Opcore write gate blocked ${mapped.toolName}: validation command failed: ${errorMessage(error)}\n`);
      return 2;
    }
    if (receipt.ok) return 0;
    stderr(formatBlockFeedback(mapped.toolName, receipt));
    return 2;
  } catch (error) {
    stderr(`Opcore write gate skipped: ${errorMessage(error)}\n`);
    return 0;
  }
}

function parseAgentGateArgs(argv: readonly string[]): AgentGateArgs {
  const args: AgentGateArgs = { harness: "unknown" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--harness") {
      args.harness = normalizeHarness(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith("--harness=")) {
      args.harness = normalizeHarness(arg.slice("--harness=".length));
      continue;
    }
    if (arg === "--repo") {
      const repo = argv[index + 1];
      if (repo && !repo.startsWith("--")) args.repo = repo;
      index += 1;
      continue;
    }
    if (arg.startsWith("--repo=")) {
      const repo = arg.slice("--repo=".length);
      if (repo.length > 0) args.repo = repo;
    }
  }
  return args;
}

function normalizeHarness(value: string | undefined): AgentGateArgs["harness"] {
  if (value === "claude" || value === "claude-code") return "claude";
  if (value === "codex") return "codex";
  return "unknown";
}

async function mapHookPayload(rawInput: string, args: AgentGateArgs): Promise<AdapterResult> {
  if (rawInput.trim().length === 0) return { kind: "skip" };
  const envelope = JSON.parse(rawInput) as unknown;
  if (!isRecord(envelope)) throw new Error("hook payload must be a JSON object");
  const tool = extractToolRequest(envelope);
  if (tool === undefined) return { kind: "skip" };
  const repoRoot = resolveRepoRoot(args.repo, tool.cwd);
  const overlays = await overlaysForTool(repoRoot, tool);
  if (overlays.length === 0) return { kind: "skip" };
  return {
    kind: "request",
    toolName: tool.toolName,
    request: {
      requestId: `opcore-agent-gate-${Date.now()}`,
      repo: { repoRoot },
      scope: { kind: "files", files: overlays.map((overlay) => overlay.path) },
      graph: { mode: "optional", provider: "opcore-graph" },
      overlays,
      reportMode: "introduced"
    }
  };
}

function extractToolRequest(envelope: Record<string, unknown>): ToolRequest | undefined {
  const nestedTool = firstRecord(envelope.tool, envelope.toolCall, envelope.tool_call);
  const toolName = firstString(
    envelope.tool_name,
    envelope.toolName,
    envelope.name,
    nestedTool?.name,
    nestedTool?.tool_name,
    nestedTool?.toolName
  );
  const toolInput = firstRecord(
    envelope.tool_input,
    envelope.toolInput,
    envelope.input,
    nestedTool?.input,
    nestedTool?.tool_input,
    nestedTool?.toolInput
  ) ?? envelope;
  if (toolName === undefined) return undefined;
  return {
    toolName,
    normalizedToolName: toolName.toLowerCase().replaceAll("-", "_"),
    toolInput,
    cwd: firstString(envelope.cwd)
  };
}

async function overlaysForTool(repoRoot: string, tool: ToolRequest): Promise<HypotheticalOverlay[]> {
  if (writeTools.has(tool.normalizedToolName)) return [writeOverlay(repoRoot, tool.toolInput)];
  if (editTools.has(tool.normalizedToolName)) return [editOverlay(repoRoot, tool.toolInput)];
  if (multiEditTools.has(tool.normalizedToolName)) return [multiEditOverlay(repoRoot, tool.toolInput)];
  if (applyPatchTools.has(tool.normalizedToolName)) return await patchOverlays(repoRoot, tool.toolInput);
  return [];
}

function writeOverlay(repoRoot: string, input: Record<string, unknown>): HypotheticalOverlay {
  return {
    action: "write",
    path: resolveTargetPath(repoRoot, requiredString(firstString(input.file_path, input.filePath, input.path), "file_path")),
    content: requiredString(firstString(input.content, input.text), "content")
  };
}

function editOverlay(repoRoot: string, input: Record<string, unknown>): HypotheticalOverlay {
  const relativePath = resolveTargetPath(repoRoot, requiredString(firstString(input.file_path, input.filePath, input.path), "file_path"));
  const absolutePath = resolve(repoRoot, relativePath);
  const oldString = requiredString(firstString(input.old_string, input.oldString), "old_string");
  const newString = requiredString(firstString(input.new_string, input.newString), "new_string");
  const existing = readFileSync(absolutePath, "utf8");
  if (!existing.includes(oldString)) throw new Error(`old_string was not found in ${relativePath}`);
  return {
    action: "write",
    path: relativePath,
    content: existing.replace(oldString, newString)
  };
}

function multiEditOverlay(repoRoot: string, input: Record<string, unknown>): HypotheticalOverlay {
  const relativePath = resolveTargetPath(repoRoot, requiredString(firstString(input.file_path, input.filePath, input.path), "file_path"));
  const edits = Array.isArray(input.edits) ? input.edits : [];
  let content = readFileSync(resolve(repoRoot, relativePath), "utf8");
  for (const edit of edits) {
    if (!isRecord(edit)) throw new Error(`MultiEdit edit for ${relativePath} must be an object`);
    const oldString = requiredString(firstString(edit.old_string, edit.oldString), "old_string");
    const newString = requiredString(firstString(edit.new_string, edit.newString), "new_string");
    if (!content.includes(oldString)) throw new Error(`old_string was not found in ${relativePath}`);
    content = content.replace(oldString, newString);
  }
  return {
    action: "write",
    path: relativePath,
    content
  };
}

async function patchOverlays(repoRoot: string, input: Record<string, unknown>): Promise<HypotheticalOverlay[]> {
  const command = firstString(input.command, input.patch);
  if (command === undefined || !isCodexApplyPatch(command)) return [];
  const workspace = await createNodeEditWorkspace({ repoRoot });
  const planned = await createPatchEditPlan(workspace, {
    repo: { repoRoot },
    validation: { required: false },
    patch: command
  });
  if (!planned.ok) throw new Error(planned.refusal.message);
  const overlays: HypotheticalOverlay[] = [];
  for (const [path, content] of Object.entries(planned.afterState)) {
    if (content === undefined) continue;
    if (content === null) overlays.push({ action: "delete", path });
    else overlays.push({ action: "write", path, content });
  }
  return overlays;
}

function runPreWriteValidation(request: ValidationRequest): PreWriteValidationReceipt {
  const repoRoot = request.repo.repoRoot;
  if (repoRoot === undefined) throw new Error("pre-write validation requires repoRoot");
  const tempDir = mkdtempSync(resolve(tmpdir(), "opcore-agent-gate-"));
  const requestPath = resolve(tempDir, "validation-request.json");
  try {
    writeFileSync(requestPath, `${JSON.stringify(request)}\n`, "utf8");
    const result = spawnSync("opcore", ["validate", "pre-write", "--request-file", requestPath, "--timeout-ms", String(validationTimeoutMs), "--json"], {
      cwd: repoRoot,
      env: validationSpawnEnv(repoRoot),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    const parsed = parseValidationOutput(result.stdout);
    if (parsed?.receipt !== undefined) return parsed.receipt;
    if (result.error !== undefined) throw result.error;
    throw new Error(`opcore validate pre-write failed without a receipt: ${result.stderr || result.stdout || `exit ${String(result.status)}`}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function validationSpawnEnv(repoRoot: string): Record<string, string | undefined> {
  const env = { ...(process.env ?? {}) };
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const currentPath = env[pathKey] ?? "";
  const localBin = join(repoRoot, "node_modules", ".bin");
  env[pathKey] = currentPath.length > 0 ? `${localBin}${delimiter}${currentPath}` : localBin;
  return env;
}

function parseValidationOutput(stdout: string | null | undefined): { receipt?: PreWriteValidationReceipt } | undefined {
  const trimmed = (stdout ?? "").trim();
  if (trimmed.length === 0) return undefined;
  const parsed = JSON.parse(trimmed) as unknown;
  if (!isRecord(parsed) || !isRecord(parsed.receipt)) return undefined;
  return { receipt: parsed.receipt as unknown as PreWriteValidationReceipt };
}

function formatBlockFeedback(toolName: string, receipt: PreWriteValidationReceipt): string {
  const summary = receipt.failureSummary?.message ?? "Pre-write validation failed";
  const checks = receipt.checks && receipt.checks.length > 0 ? ` checks=${receipt.checks.join(",")}` : "";
  const paths = receipt.overlays && receipt.overlays.paths.length > 0 ? ` paths=${receipt.overlays.paths.join(",")}` : "";
  return truncateFeedback(`Opcore write gate blocked ${toolName}: ${summary} status=${receipt.validationStatus}${checks}${paths}\n`);
}

function truncateFeedback(text: string): string {
  return text.length <= maxFeedbackChars ? text : `${text.slice(0, maxFeedbackChars - 15).trimEnd()} [truncated]\n`;
}

function resolveRepoRoot(explicitRepo: string | undefined, cwd: string | undefined): string {
  if (explicitRepo !== undefined) return resolve(explicitRepo);
  const start = resolve(cwd ?? process.cwd());
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: start,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  return result.status === 0 && result.stdout.trim().length > 0 ? resolve(result.stdout.trim()) : start;
}

function resolveTargetPath(repoRoot: string, filePath: string): string {
  const absolute = isAbsolute(filePath) ? resolve(filePath) : resolve(repoRoot, filePath);
  const relativePath = relative(repoRoot, absolute);
  if (relativePath === "" || relativePath.startsWith("..") || relativePath.split(sep).includes("..") || isAbsolute(relativePath)) {
    throw new Error(`pre-write target must stay inside the repo: ${filePath}`);
  }
  return relativePath.replaceAll("\\", "/");
}

function requiredString(value: string | undefined, name: string): string {
  if (value === undefined) throw new Error(`${name} must be a string`);
  return value;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string") return value;
  }
  return undefined;
}

function firstRecord(...values: unknown[]): Record<string, unknown> | undefined {
  for (const value of values) {
    if (isRecord(value)) return value;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readStdin(stream: AsyncIterable<unknown>): Promise<string> {
  let input = "";
  for await (const chunk of stream) {
    input += typeof chunk === "string" ? chunk : chunkToString(chunk);
  }
  return input;
}

function chunkToString(chunk: unknown): string {
  if (
    typeof chunk === "object" &&
    chunk !== null &&
    "toString" in chunk &&
    typeof chunk.toString === "function"
  ) {
    return chunk.toString();
  }
  return String(chunk);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
