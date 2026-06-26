import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  CommandAdapterRequest,
  CommandRouterResult,
  EditCommandResult,
  EditPlan,
  EditRefusal,
  RepoIdentity
} from "@the-open-engine/opcore-contracts";
import {
  createCommandRouterResult,
  validateEditPlanPayload
} from "@the-open-engine/opcore-contracts";
import { previewEditPlan, type EditPlanPreviewSuccess } from "./atomic-writer.js";
import {
  parseEditCommandArgs,
  type ParsedEditCommand
} from "./command-parser.js";
import {
  createExactEditPlan,
  createMultiEditPlan,
  createSearchReplaceFilesEditPlan,
  type EditPlannerResult,
  type MultiEditFileRequest,
  type SearchReplaceFileRequest
} from "./planner.js";
import { createPatchEditPlan, type PatchEditPlanRequest } from "./patch-tree-command.js";
import { createTreeEditPlan, type ApplyTreePlanRequest } from "./tree-planner.js";
import { validateExistingPathInsideRepo } from "./path-policy.js";
import { planSymbolEditCommand, symbolPayloadRequired } from "./symbol-command.js";
import type { EditGraphProviderClient } from "./symbol-graph.js";
import {
  previewAndValidateEditPlan,
  validateAndApplyEditPlan,
  type EditValidationOptions
} from "./validated-apply.js";
import type { EditValidationRunner } from "./validation.js";
import { createNodeEditWorkspace, type EditWorkspace } from "./workspace.js";

export interface CreateEditCommandAdapterOptions {
  repoRoot?: string;
  readFile?: (path: string) => Promise<string>;
  readStdin?: () => Promise<string>;
  validationRunner?: EditValidationRunner;
  validationTimeoutMs?: number;
  graphProviderClient?: EditGraphProviderClient;
}

type JsonRecord = Record<string, unknown>;
type PlanInputResult<T> = { ok: true; value: T } | { ok: false; refusal: EditRefusal; matchCount?: number };
type OptionalInputResult<T> = PlanInputResult<T | undefined>;

declare const process: {
  cwd(): string;
  stdin?: AsyncIterable<unknown>;
};

export function createEditCommandAdapter(options: CreateEditCommandAdapterOptions = {}) {
  return async function packageEditCommandAdapter(request: CommandAdapterRequest): Promise<CommandRouterResult> {
    const parsed = parseEditCommandArgs(request.args);
    if (!parsed.ok) return refusalResult(request, "error", parsed.refusal);
    const symbolPayload = symbolPayloadRequired(parsed.value);
    if (!symbolPayload.ok) return refusalResult(request, "error", symbolPayload.refusal);

    const payload = await loadPayload(parsed.value, options);
    if (!payload.ok) return refusalResult(request, "error", payload.refusal);

    if (parsed.value.command === "check") {
      const plan = parsePlanPayload(payload.value);
      if (!plan.ok) return refusalResult(request, "error", plan.refusal);
      return validatedPreviewPlanResult(request, parsed.value, plan.value, undefined, options);
    }
    if (parsed.value.command === "apply") {
      const plan = parsePlanPayload(payload.value);
      if (!plan.ok) return refusalResult(request, "error", plan.refusal);
      if (parsed.value.mode === "preview") {
        if (parsed.value.validationIntent === "check") {
          return validatedPreviewPlanResult(request, parsed.value, plan.value, undefined, options);
        }
        return previewPlanResult(request, parsed.value, plan.value, options);
      }
      return applyPlanResult(request, parsed.value, plan.value, undefined, options);
    }

    const planned = await planEditCommand(parsed.value, payload.value, options);
    if (!planned.ok) return refusalResult(request, "error", planned.refusal, planned.matchCount);
    if (parsed.value.mode === "apply") {
      return applyPlanResult(request, parsed.value, planned.plan, planned.matchCount, options);
    }
    if (parsed.value.validationIntent === "check") {
      return validatedPreviewPlanResult(request, parsed.value, planned.plan, planned.matchCount, options);
    }

    const workspace = await workspaceFor(parsed.value, planned.plan, options);
    if (!workspace.ok) return refusalResult(request, "error", workspace.refusal, planned.matchCount, planned.plan);
    const preview = await previewEditPlan(workspace.value, planned.plan);
    if (!preview.ok) return refusalResult(request, "error", preview.refusal, planned.matchCount);
    return okResult(request, planned.plan, editResultFromPreview(preview, planned.matchCount), "planned");
  };
}

export const editCommandAdapter = createEditCommandAdapter();

async function planEditCommand(
  parsed: ParsedEditCommand,
  payload: unknown,
  options: CreateEditCommandAdapterOptions
): Promise<EditPlannerResult> {
  const context = await planningContextFor(parsed, payload, options);
  if (!context.ok) return context;
  const workspace = await workspaceFromRoot(context.value.repoRoot);
  if (!workspace.ok) return workspace;
  const repo = context.value.repo;
  if (parsed.command === "exact") {
    const request = await exactRequest(parsed, payload, workspace.value, repo);
    if (!request.ok) return request;
    return createExactEditPlan(request.value);
  }
  if (parsed.command === "multi") {
    const request = await multiRequest(parsed, payload, workspace.value, repo);
    if (!request.ok) return request;
    return createMultiEditPlan(request.value);
  }
  if (parsed.command === "search-replace") {
    const request = await searchReplaceRequest(parsed, payload, workspace.value, repo);
    if (!request.ok) return request;
    return createSearchReplaceFilesEditPlan(request.value);
  }
  if (parsed.command === "patch") {
    const request = patchRequest(payload, repo);
    if (!request.ok) return request;
    return createPatchEditPlan(workspace.value, request.value);
  }
  if (parsed.command === "tree") {
    const request = treeRequest(parsed, payload, repo);
    if (!request.ok) return request;
    return createTreeEditPlan(workspace.value, request.value);
  }
  if (parsed.command === "rename" || parsed.command === "move" || parsed.command === "signature") {
    return planSymbolEditCommand(parsed, payload, workspace.value, repo, options.graphProviderClient);
  }
  return {
    ok: false,
    refusal: {
      category: "unsupported_change",
      message: `Unsupported edit command: ${parsed.command}`
    }
  };
}

async function exactRequest(
  parsed: ParsedEditCommand,
  payload: unknown,
  workspace: EditWorkspace,
  repo: RepoIdentity
): Promise<PlanInputResult<Parameters<typeof createExactEditPlan>[0]>> {
  const object = recordOrEmpty(payload);
  const path = requiredStringValue("path", false, parsed.operands.path, object.path);
  if (!path.ok) return path;
  const expectedText = requiredStringValue("expectedText", true, parsed.operands.expectedText, object.expectedText, object.expected);
  if (!expectedText.ok) return expectedText;
  const replacementText = requiredStringValue("replacementText", true, parsed.operands.replacementText, object.replacementText, object.replacement);
  if (!replacementText.ok) return replacementText;
  const inlineContent = optionalStringValue("content", true, object.content);
  if (!inlineContent.ok) return inlineContent;
  const content = inlineContent.value !== undefined ? { ok: true as const, value: inlineContent.value } : await readRepoFile(workspace, path.value);
  if (!content.ok) return content;
  const occurrence = optionalNonNegativeIntegerValue("occurrence", parsed.operands.occurrence, object.occurrence);
  if (!occurrence.ok) return occurrence;
  const checksumBefore = optionalStringValue("checksumBefore", false, parsed.operands.checksumBefore, object.checksumBefore);
  if (!checksumBefore.ok) return checksumBefore;
  const validation = validationOption(object);
  if (!validation.ok) return validation;
  return {
    ok: true,
    value: {
      repo: repoFromPayload(object, repo),
      path: path.value,
      content: content.value,
      expectedText: expectedText.value,
      replacementText: replacementText.value,
      occurrence: occurrence.value,
      checksumBefore: checksumBefore.value,
      validation: validation.value
    }
  };
}

async function multiRequest(
  parsed: ParsedEditCommand,
  payload: unknown,
  workspace: EditWorkspace,
  repo: RepoIdentity
): Promise<PlanInputResult<Parameters<typeof createMultiEditPlan>[0]>> {
  const object = recordOrEmpty(payload);
  if (!Array.isArray(object.files)) return plannerRefusal("unsupported_change", "Multi-edit request requires files");
  const files: MultiEditFileRequest[] = [];
  for (const rawFile of object.files) {
    const file = asRecord(rawFile);
    if (!file.ok) return file;
    const path = requiredStringValue("path", false, file.value.path);
    if (!path.ok) return path;
    const inlineContent = optionalStringValue(`files[${files.length}].content`, true, file.value.content);
    if (!inlineContent.ok) return inlineContent;
    const content = inlineContent.value !== undefined ? { ok: true as const, value: inlineContent.value } : await readRepoFile(workspace, path.value);
    if (!content.ok) return content;
    if (!Array.isArray(file.value.operations)) return plannerRefusal("unsupported_change", `Multi-edit file has no operations: ${path.value}`, path.value);
    const operations = [];
    for (const [index, operation] of file.value.operations.entries()) {
      const normalized = exactOperationFromPayload(operation, `files[${files.length}].operations[${index}]`);
      if (!normalized.ok) return normalized;
      operations.push(normalized.value);
    }
    const checksumBefore = optionalStringValue(`files[${files.length}].checksumBefore`, false, file.value.checksumBefore);
    if (!checksumBefore.ok) return checksumBefore;
    files.push({
      path: path.value,
      content: content.value,
      checksumBefore: checksumBefore.value,
      operations
    });
  }
  const validation = validationOption(object);
  if (!validation.ok) return validation;
  return {
    ok: true,
    value: {
      repo: repoFromPayload(object, repo),
      files,
      validation: validation.value
    }
  };
}

async function searchReplaceRequest(
  parsed: ParsedEditCommand,
  payload: unknown,
  workspace: EditWorkspace,
  repo: RepoIdentity
): Promise<PlanInputResult<Parameters<typeof createSearchReplaceFilesEditPlan>[0]>> {
  const object = recordOrEmpty(payload);
  if (object.files !== undefined && !Array.isArray(object.files)) {
    return plannerRefusal("unsupported_change", "Search-replace files must be an array when provided");
  }
  const rawFiles = object.files !== undefined
    ? object.files
    : [object.path ?? parsed.operands.path].filter((path) => path !== undefined);
  if (rawFiles.length === 0) return plannerRefusal("unsupported_change", "Search-replace request requires files or path");
  const files: SearchReplaceFileRequest[] = [];
  for (const rawFile of rawFiles) {
    const parsedFile = typeof rawFile === "string"
      ? {
          ok: true as const,
          value: {
            path: rawFile,
            checksumBefore: object.checksumBefore ?? parsed.operands.checksumBefore
          }
        }
      : asRecord(rawFile);
    const file = parsedFile.ok ? parsedFile.value : undefined;
    if (!file) return plannerRefusal("unsupported_change", "Search-replace file entries must be strings or objects");
    const path = requiredStringValue("path", false, file.path);
    if (!path.ok) return path;
    const inlineContent = optionalStringValue(`files[${files.length}].content`, true, file.content);
    if (!inlineContent.ok) return inlineContent;
    const content = inlineContent.value !== undefined ? { ok: true as const, value: inlineContent.value } : await readRepoFile(workspace, path.value);
    if (!content.ok) return content;
    const checksumBefore = optionalStringValue(`files[${files.length}].checksumBefore`, false, file.checksumBefore);
    if (!checksumBefore.ok) return checksumBefore;
    files.push({
      path: path.value,
      content: content.value,
      checksumBefore: checksumBefore.value
    });
  }

  if (object.operations !== undefined && !Array.isArray(object.operations)) {
    return plannerRefusal("unsupported_change", "Search-replace operations must be an array when provided");
  }
  const rawOperations = object.operations !== undefined ? object.operations : [singleSearchReplaceOperation(parsed, object)];
  const operations = [];
  for (const [index, operation] of rawOperations.entries()) {
    const normalized = searchOperationFromPayload(operation, `operations[${index}]`);
    if (!normalized.ok) return normalized;
    operations.push(normalized.value);
  }
  const fileContains = optionalStringValue("fileContains", false, parsed.operands.fileContains, object.fileContains, object.file_contains);
  if (!fileContains.ok) return fileContains;
  const validation = validationOption(object);
  if (!validation.ok) return validation;
  return {
    ok: true,
    value: {
      repo: repoFromPayload(object, repo),
      files,
      operations,
      fileContains: fileContains.value,
      validation: validation.value
    }
  };
}

function patchRequest(payload: unknown, repo: RepoIdentity): PlanInputResult<PatchEditPlanRequest> {
  if (typeof payload === "string") {
    if (payload.length === 0) return plannerRefusal("unsupported_change", "Patch request requires non-empty patch text");
    return { ok: true, value: { repo, patch: payload } };
  }
  const object = recordOrEmpty(payload);
  const patch = requiredStringValue("patch", false, object.patch);
  if (!patch.ok) return patch;
  const validation = validationOption(object);
  if (!validation.ok) return validation;
  return {
    ok: true,
    value: {
      repo: repoFromPayload(object, repo),
      patch: patch.value,
      validation: validation.value
    }
  };
}

function treeRequest(parsed: ParsedEditCommand, payload: unknown, repo: RepoIdentity): PlanInputResult<ApplyTreePlanRequest> {
  const object = recordOrEmpty(payload);
  if (!Array.isArray(object.files)) return plannerRefusal("unsupported_change", "Tree edit request requires files");
  const fileContains = optionalStringValue("fileContains", false, parsed.operands.fileContains, object.fileContains, object.file_contains);
  if (!fileContains.ok) return fileContains;
  const validation = validationOption(object);
  if (!validation.ok) return validation;
  return {
    ok: true,
    value: {
      repo: repoFromPayload(object, repo),
      validation: validation.value,
      fileContains: fileContains.value,
      files: object.files as ApplyTreePlanRequest["files"]
    }
  };
}

async function previewPlanResult(
  request: CommandAdapterRequest,
  parsed: ParsedEditCommand,
  plan: EditPlan,
  options: CreateEditCommandAdapterOptions
): Promise<CommandRouterResult> {
  const workspace = await workspaceFor(parsed, plan, options);
  if (!workspace.ok) return refusalResult(request, "error", workspace.refusal, undefined, plan);
  const preview = await previewEditPlan(workspace.value, plan);
  if (!preview.ok) return refusalResult(request, "error", preview.refusal);
  return okResult(request, plan, editResultFromPreview(preview), "checked");
}

async function applyPlanResult(
  request: CommandAdapterRequest,
  parsed: ParsedEditCommand,
  plan: EditPlan,
  matchCount: number | undefined,
  options: CreateEditCommandAdapterOptions
): Promise<CommandRouterResult> {
  const workspace = await workspaceFor(parsed, plan, options);
  if (!workspace.ok) return refusalResult(request, "error", workspace.refusal, matchCount, plan);
  const preview = await previewEditPlan(workspace.value, plan);
  if (!preview.ok) return refusalResult(request, "error", preview.refusal, matchCount);
  if (plan.changes.length === 0) {
    return okResult(request, plan, editResultFromPreview(preview, matchCount), "no-op");
  }
  const applied = await validateAndApplyEditPlan(workspace.value, plan, validationOptions(options));
  if (!applied.ok) {
    return refusalResult(request, "error", applied.refusal, matchCount, plan, applied.preview ?? preview, applied.rollback, applied.validation);
  }
  return okResult(request, plan, {
    ok: true,
    applied: true,
    appliedAt: applied.appliedAt,
    planId: applied.planId,
    planHash: applied.planHash,
    afterState: applied.afterState,
    validationRequest: applied.validationRequest,
    validation: applied.validation,
    matchCount
  }, "applied");
}

async function validatedPreviewPlanResult(
  request: CommandAdapterRequest,
  parsed: ParsedEditCommand,
  plan: EditPlan,
  matchCount: number | undefined,
  options: CreateEditCommandAdapterOptions
): Promise<CommandRouterResult> {
  const workspace = await workspaceFor(parsed, plan, options);
  if (!workspace.ok) return refusalResult(request, "error", workspace.refusal, matchCount, plan);
  const validated = await previewAndValidateEditPlan(workspace.value, plan, validationOptions(options));
  if (!validated.ok) {
    return refusalResult(request, "error", validated.refusal, matchCount, plan, validated.preview, undefined, validated.validation);
  }
  return okResult(request, plan, editResultFromPreview(validated.preview, matchCount, validated.validation), "checked");
}

function okResult(
  request: CommandAdapterRequest,
  plan: EditPlan,
  editResult: EditCommandResult,
  verb: "planned" | "checked" | "applied" | "no-op"
): CommandRouterResult {
  return createCommandRouterResult({
    bin: request.bin,
    argv: request.argv,
    canonicalCommand: request.canonicalCommand,
    owner: "edit",
    status: "ok",
    json: request.json,
    message: `${request.canonicalCommand.slice(0, 3).join(" ")} ${verb} ${plan.planId}`,
    editPlan: plan,
    editResult
  });
}

function refusalResult(
  request: CommandAdapterRequest,
  status: "error" | "not_implemented",
  refusal: EditRefusal,
  matchCount?: number,
  plan?: EditPlan,
  preview?: EditPlanPreviewSuccess,
  rollback?: EditCommandResult["rollback"],
  validation?: EditCommandResult["validation"]
): CommandRouterResult {
  return createCommandRouterResult({
    bin: request.bin,
    argv: request.argv,
    canonicalCommand: request.canonicalCommand,
    owner: "edit",
    status,
    json: request.json,
    message: refusal.message,
    editPlan: plan,
    editResult: {
      ok: false,
      applied: false,
      planId: plan?.planId,
      planHash: plan?.atomic.planHash,
      afterState: preview?.afterState,
      validationRequest: preview?.validationRequest,
      validation,
      matchCount,
      refusal,
      rollback
    }
  });
}

function editResultFromPreview(
  preview: EditPlanPreviewSuccess,
  matchCount?: number,
  validation?: EditCommandResult["validation"]
): EditCommandResult {
  return {
    ok: true,
    applied: false,
    planId: preview.planId,
    planHash: preview.planHash,
    afterState: preview.afterState,
    validationRequest: preview.validationRequest,
    validation,
    matchCount
  };
}

function validationOptions(options: CreateEditCommandAdapterOptions): EditValidationOptions {
  return {
    validationRunner: options.validationRunner,
    validationTimeoutMs: options.validationTimeoutMs,
    graphProviderClient: options.graphProviderClient
  };
}

async function workspaceFor(
  parsed: ParsedEditCommand,
  plan: EditPlan,
  options: CreateEditCommandAdapterOptions
): Promise<PlanInputResult<EditWorkspace>> {
  const root = await consistentRepoRoot([
    { label: "--repo", value: parsed.repoRoot },
    { label: "plan.repo.repoRoot", value: plan.repo.repoRoot },
    { label: "adapter repoRoot", value: options.repoRoot }
  ]);
  if (!root.ok) return root;
  return workspaceFromRoot(root.value);
}

async function readRepoFile(workspace: EditWorkspace, path: string): Promise<{ ok: true; value: string } | { ok: false; refusal: EditRefusal }> {
  const target = await validateExistingPathInsideRepo(workspace, path);
  if (!target.ok) return target;
  return { ok: true, value: await workspace.fileSystem.readFile(target.value.absolutePath, "utf8") };
}

async function loadPayload(
  parsed: ParsedEditCommand,
  options: CreateEditCommandAdapterOptions
): Promise<{ ok: true; value: unknown } | { ok: false; refusal: EditRefusal }> {
  const source = parsed.payloadSource;
  if (!source) return { ok: true, value: undefined };
  if (source.kind === "inline") return { ok: true, value: source.value };
  try {
    const raw = source.kind === "file"
      ? await (options.readFile ?? ((path: string) => readFile(path, "utf8")))(source.path)
      : await (options.readStdin ?? readProcessStdin)();
    if (parsed.command === "patch") return { ok: true, value: raw };
    return { ok: true, value: JSON.parse(raw) };
  } catch (error) {
    return {
      ok: false,
      refusal: {
        category: "unsupported_change",
        message: `Malformed edit request payload: ${errorMessage(error)}`
      }
    };
  }
}

async function readProcessStdin(): Promise<string> {
  if (!process.stdin) throw new Error("Process stdin is unavailable");
  let raw = "";
  for await (const chunk of process.stdin) raw += String(chunk);
  return raw;
}

function parsePlanPayload(payload: unknown): { ok: true; value: EditPlan } | { ok: false; refusal: EditRefusal } {
  const candidate = isRecord(payload) && isRecord(payload.plan) ? payload.plan : payload;
  try {
    return { ok: true, value: validateEditPlanPayload(candidate as EditPlan) };
  } catch (error) {
    return {
      ok: false,
      refusal: {
        category: "unsupported_change",
        message: `Invalid edit plan payload: ${errorMessage(error)}`
      }
    };
  }
}

async function planningContextFor(
  parsed: ParsedEditCommand,
  payload: unknown,
  options: CreateEditCommandAdapterOptions
): Promise<PlanInputResult<{ repoRoot: string; repo: RepoIdentity }>> {
  const object = recordOrEmpty(payload);
  const payloadRepo = repoPayload(object);
  if (!payloadRepo.ok) return payloadRepo;
  const root = await consistentRepoRoot([
    { label: "--repo", value: parsed.repoRoot },
    { label: "request.repo.repoRoot", value: payloadRepo.value?.repoRoot },
    { label: "adapter repoRoot", value: options.repoRoot }
  ]);
  if (!root.ok) return root;
  return {
    ok: true,
    value: {
      repoRoot: root.value,
      repo: payloadRepo.value ?? { repoRoot: parsed.repoRoot ?? options.repoRoot ?? root.value }
    }
  };
}

async function workspaceFromRoot(repoRoot: string): Promise<PlanInputResult<EditWorkspace>> {
  try {
    return { ok: true, value: await createNodeEditWorkspace({ repoRoot }) };
  } catch (error) {
    return plannerRefusal("unsafe_edit", `Edit repo root cannot be resolved: ${errorMessage(error)}`);
  }
}

function repoFromPayload(object: JsonRecord, fallback: RepoIdentity): RepoIdentity {
  return isRecord(object.repo) ? object.repo as RepoIdentity : fallback;
}

function repoPayload(object: JsonRecord): OptionalInputResult<RepoIdentity> {
  if (object.repo === undefined) return { ok: true, value: undefined };
  if (!isRecord(object.repo)) return plannerRefusal("unsupported_change", "Edit request repo must be an object when provided");
  const repo = object.repo as RepoIdentity;
  const repoRoot = optionalStringValue("repo.repoRoot", false, repo.repoRoot);
  if (!repoRoot.ok) return repoRoot;
  const repoId = optionalStringValue("repo.repoId", false, repo.repoId);
  if (!repoId.ok) return repoId;
  const remoteUrl = optionalStringValue("repo.remoteUrl", false, repo.remoteUrl);
  if (!remoteUrl.ok) return remoteUrl;
  const commitSha = optionalStringValue("repo.commitSha", false, repo.commitSha);
  if (!commitSha.ok) return commitSha;
  return { ok: true, value: repo };
}

async function consistentRepoRoot(candidates: readonly { label: string; value: unknown }[]): Promise<PlanInputResult<string>> {
  let selected: { label: string; input: string; resolved: string } | undefined;
  for (const candidate of candidates) {
    if (candidate.value === undefined) continue;
    if (typeof candidate.value !== "string" || candidate.value.length === 0) {
      return plannerRefusal("ambiguous_repo_identity", `${candidate.label} must be a non-empty string when provided`);
    }
    const resolved = await resolveExistingRepoRoot(candidate.label, candidate.value);
    if (!resolved.ok) return resolved;
    if (!selected) {
      selected = { label: candidate.label, input: candidate.value, resolved: resolved.value };
    } else if (selected.resolved !== resolved.value) {
      return plannerRefusal(
        "ambiguous_repo_identity",
        `Ambiguous edit repo identity: ${selected.label}=${selected.input} conflicts with ${candidate.label}=${candidate.value}`
      );
    }
  }
  return { ok: true, value: selected?.input ?? process.cwd() };
}

async function resolveExistingRepoRoot(label: string, value: string): Promise<PlanInputResult<string>> {
  try {
    return { ok: true, value: await realpath(resolve(value)) };
  } catch (error) {
    return plannerRefusal("ambiguous_repo_identity", `${label} cannot be resolved as a repo root: ${errorMessage(error)}`);
  }
}

function validationOption(object: JsonRecord): OptionalInputResult<{ required?: boolean }> {
  const validation = object.validation;
  if (validation === undefined) return { ok: true, value: undefined };
  if (!isRecord(validation)) return plannerRefusal("unsupported_change", "validation must be an object when provided");
  const required = optionalBooleanValue("validation.required", validation.required);
  if (!required.ok) return required;
  return { ok: true, value: required.value === undefined ? undefined : { required: required.value } };
}

function exactOperationFromPayload(payload: unknown, label: string): PlanInputResult<MultiEditFileRequest["operations"][number]> {
  const operation = asRecord(payload);
  if (!operation.ok) return operation;
  const expectedText = requiredStringValue(`${label}.expectedText`, true, operation.value.expectedText, operation.value.expected);
  if (!expectedText.ok) return expectedText;
  const replacementText = requiredStringValue(`${label}.replacementText`, true, operation.value.replacementText, operation.value.replacement);
  if (!replacementText.ok) return replacementText;
  const occurrence = optionalNonNegativeIntegerValue(`${label}.occurrence`, operation.value.occurrence);
  if (!occurrence.ok) return occurrence;
  const checksumBefore = optionalStringValue(`${label}.checksumBefore`, false, operation.value.checksumBefore);
  if (!checksumBefore.ok) return checksumBefore;
  const replaceAll = optionalBooleanValue(`${label}.replaceAll`, operation.value.replaceAll, operation.value.replace_all);
  if (!replaceAll.ok) return replaceAll;
  return {
    ok: true,
    value: {
      expectedText: expectedText.value,
      replacementText: replacementText.value,
      occurrence: occurrence.value,
      checksumBefore: checksumBefore.value,
      replaceAll: replaceAll.value
    }
  };
}

function singleSearchReplaceOperation(parsed: ParsedEditCommand, object: JsonRecord): JsonRecord {
  return {
    search: object.search ?? object.expectedText ?? object.expected ?? parsed.operands.expectedText,
    replace: object.replace ?? object.replacementText ?? object.replacement ?? parsed.operands.replacementText,
    regex: object.regex ?? parsed.operands.regex,
    caseInsensitive: object.caseInsensitive ?? object.case_insensitive ?? parsed.operands.caseInsensitive,
    multiline: object.multiline ?? parsed.operands.multiline,
    dotAll: object.dotAll ?? object.dot_all ?? parsed.operands.dotAll,
    replaceAll: object.replaceAll ?? object.replace_all ?? parsed.operands.replaceAll
  };
}

function searchOperationFromPayload(payload: unknown, label: string): PlanInputResult<Parameters<typeof createSearchReplaceFilesEditPlan>[0]["operations"][number]> {
  const operation = asRecord(payload);
  if (!operation.ok) return operation;
  const search = requiredStringValue(`${label}.search`, true, operation.value.search, operation.value.expectedText, operation.value.expected);
  if (!search.ok) return search;
  const replace = requiredStringValue(`${label}.replace`, true, operation.value.replace, operation.value.replacementText, operation.value.replacement);
  if (!replace.ok) return replace;
  const regex = optionalBooleanValue(`${label}.regex`, operation.value.regex);
  if (!regex.ok) return regex;
  const caseInsensitive = optionalBooleanValue(`${label}.caseInsensitive`, operation.value.caseInsensitive, operation.value.case_insensitive);
  if (!caseInsensitive.ok) return caseInsensitive;
  const multiline = optionalBooleanValue(`${label}.multiline`, operation.value.multiline);
  if (!multiline.ok) return multiline;
  const dotAll = optionalBooleanValue(`${label}.dotAll`, operation.value.dotAll, operation.value.dot_all);
  if (!dotAll.ok) return dotAll;
  const replaceAll = optionalBooleanValue(`${label}.replaceAll`, operation.value.replaceAll, operation.value.replace_all);
  if (!replaceAll.ok) return replaceAll;
  return {
    ok: true,
    value: {
      search: search.value,
      replace: replace.value,
      regex: regex.value,
      caseInsensitive: caseInsensitive.value,
      multiline: multiline.value,
      dotAll: dotAll.value,
      replaceAll: replaceAll.value
    }
  };
}

function requiredStringValue(
  label: string,
  allowEmpty: boolean,
  ...values: unknown[]
): { ok: true; value: string } | { ok: false; refusal: EditRefusal } {
  for (const value of values) {
    if (typeof value === "string" && (allowEmpty || value.length > 0)) return { ok: true, value };
  }
  return plannerRefusal("unsupported_change", `Edit request requires ${label}`);
}

function optionalStringValue(label: string, allowEmpty: boolean, ...values: unknown[]): OptionalInputResult<string> {
  let selected: string | undefined;
  for (const value of values) {
    if (value === undefined) continue;
    if (typeof value !== "string") return plannerRefusal("unsupported_change", `${label} must be a string when provided`);
    if (!allowEmpty && value.length === 0) return plannerRefusal("unsupported_change", `${label} must be non-empty when provided`);
    if (selected === undefined) selected = value;
    else if (selected !== value) return plannerRefusal("unsupported_change", `${label} aliases conflict`);
  }
  return { ok: true, value: selected };
}

function optionalNonNegativeIntegerValue(label: string, ...values: unknown[]): OptionalInputResult<number> {
  let selected: number | undefined;
  for (const value of values) {
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      return plannerRefusal("unsafe_edit", `${label} must be a non-negative integer when provided`);
    }
    if (selected === undefined) selected = value;
    else if (selected !== value) return plannerRefusal("unsafe_edit", `${label} aliases conflict`);
  }
  return { ok: true, value: selected };
}

function optionalBooleanValue(label: string, ...values: unknown[]): OptionalInputResult<boolean> {
  let selected: boolean | undefined;
  for (const value of values) {
    if (value === undefined) continue;
    if (typeof value !== "boolean") return plannerRefusal("unsupported_change", `${label} must be a boolean when provided`);
    if (selected === undefined) selected = value;
    else if (selected !== value) return plannerRefusal("unsupported_change", `${label} aliases conflict`);
  }
  return { ok: true, value: selected };
}

function recordOrEmpty(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function asRecord(value: unknown): { ok: true; value: JsonRecord } | { ok: false; refusal: EditRefusal } {
  if (isRecord(value)) return { ok: true, value };
  return plannerRefusal("unsupported_change", "Edit request payload entries must be objects");
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function plannerRefusal(category: EditRefusal["category"], message: string, path?: string): { ok: false; refusal: EditRefusal } {
  return {
    ok: false,
    refusal: {
      category,
      message,
      path
    }
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
