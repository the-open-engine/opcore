import type { EditRefusal } from "@the-open-engine/lattice-contracts";
import { normalizeEditRepoRelativePath } from "./path-policy.js";

export const implementedEditCommands = ["exact", "multi", "search-replace", "check", "apply", "patch", "tree", "rename", "move", "signature"] as const;
export type ImplementedEditCommand = (typeof implementedEditCommands)[number];
export type EditCommandName = ImplementedEditCommand;
export type EditCommandMode = "preview" | "apply";
export type EditValidationIntent = "plan" | "check" | "apply";
export type EditPayloadSource =
  | { kind: "inline"; value: unknown }
  | { kind: "file"; path: string }
  | { kind: "stdin" };

export interface ParsedEditCommand {
  command: EditCommandName;
  repoRoot?: string;
  mode: EditCommandMode;
  validationIntent: EditValidationIntent;
  payloadSource?: EditPayloadSource;
  operands: {
    path?: string;
    expectedText?: string;
    replacementText?: string;
    occurrence?: number;
    checksumBefore?: string;
    regex?: boolean;
    caseInsensitive?: boolean;
    multiline?: boolean;
    dotAll?: boolean;
    replaceAll?: boolean;
    fileContains?: string;
  };
}

export interface EditCommandParseRefusal {
  ok: false;
  refusal: EditRefusal;
}

export type EditCommandParseResult = { ok: true; value: ParsedEditCommand } | EditCommandParseRefusal;

const commands = new Set<string>(implementedEditCommands);
const valueFlags = new Set([
  "--repo",
  "--path",
  "--expected",
  "--replacement",
  "--occurrence",
  "--checksum-before",
  "--request-json",
  "--request-file",
  "--file-contains"
]);
const booleanFlags = new Set([
  "--stdin",
  "--check",
  "--apply",
  "--dry-run",
  "--regex",
  "--case-insensitive",
  "--multiline",
  "--dot-all",
  "--replace-all"
]);
const globalValueFlags = new Set(["--repo", "--request-json", "--request-file"]);
const payloadBooleanFlags = new Set(["--stdin"]);
const previewOrApplyModeFlags = new Set(["--check", "--apply", "--dry-run"]);
const previewOnlyModeFlags = new Set(["--check", "--dry-run"]);
const commandValueFlags: Record<EditCommandName, ReadonlySet<string>> = {
  exact: new Set([...globalValueFlags, "--path", "--expected", "--replacement", "--occurrence", "--checksum-before"]),
  multi: globalValueFlags,
  "search-replace": new Set([...globalValueFlags, "--path", "--expected", "--replacement", "--checksum-before", "--file-contains"]),
  check: globalValueFlags,
  apply: globalValueFlags,
  patch: globalValueFlags,
  tree: new Set([...globalValueFlags, "--file-contains"]),
  rename: globalValueFlags,
  move: globalValueFlags,
  signature: globalValueFlags
};
const commandBooleanFlags: Record<EditCommandName, ReadonlySet<string>> = {
  exact: new Set([...payloadBooleanFlags, ...previewOrApplyModeFlags]),
  multi: new Set([...payloadBooleanFlags, ...previewOrApplyModeFlags]),
  "search-replace": new Set([...payloadBooleanFlags, ...previewOrApplyModeFlags, "--regex", "--case-insensitive", "--multiline", "--dot-all", "--replace-all"]),
  check: new Set([...payloadBooleanFlags, ...previewOnlyModeFlags]),
  apply: new Set([...payloadBooleanFlags, ...previewOrApplyModeFlags]),
  patch: new Set([...payloadBooleanFlags, ...previewOrApplyModeFlags]),
  tree: new Set([...payloadBooleanFlags, ...previewOrApplyModeFlags]),
  rename: new Set([...payloadBooleanFlags, ...previewOrApplyModeFlags]),
  move: new Set([...payloadBooleanFlags, ...previewOrApplyModeFlags]),
  signature: new Set([...payloadBooleanFlags, ...previewOrApplyModeFlags])
};

export function parseEditCommandArgs(args: readonly string[]): EditCommandParseResult {
  const [command, ...rest] = args;
  if (!commands.has(command)) return refused("unsupported_change", `Unsupported lattice edit command: ${command ?? "(missing)"}`);
  const editCommand = command as EditCommandName;

  const parsed: ParsedEditCommand = {
    command: editCommand,
    mode: command === "apply" ? "apply" : "preview",
    validationIntent: command === "check" ? "check" : command === "apply" ? "apply" : "plan",
    operands: {}
  };
  const seen = new Set<string>();
  let payloadSeen = false;
  let modeSeen = false;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (valueFlags.has(arg)) {
      if (!commandValueFlags[editCommand].has(arg)) {
        return refused("unsupported_change", `Unsupported edit flag for ${editCommand}: ${arg}`);
      }
      if (seen.has(arg)) return refused("unsupported_change", `Duplicate edit flag: ${arg}`);
      seen.add(arg);
      const value = rest[index + 1];
      if (value === undefined || value.startsWith("--")) return refused("unsupported_change", `Missing value for edit flag: ${arg}`);
      index += 1;
      const applied = setValueFlag(parsed, arg, value);
      if (!applied.ok) return applied;
      if (arg === "--request-json" || arg === "--request-file") {
        if (payloadSeen) return refused("unsupported_change", "Edit command accepts exactly one request payload source");
        payloadSeen = true;
      }
      continue;
    }

    if (booleanFlags.has(arg)) {
      if (!commandBooleanFlags[editCommand].has(arg)) {
        return refused("unsupported_change", `Unsupported edit flag for ${editCommand}: ${arg}`);
      }
      if (seen.has(arg)) return refused("unsupported_change", `Duplicate edit flag: ${arg}`);
      seen.add(arg);
      if (arg === "--stdin") {
        if (payloadSeen) return refused("unsupported_change", "Edit command accepts exactly one request payload source");
        payloadSeen = true;
        parsed.payloadSource = { kind: "stdin" };
      } else if (arg === "--apply" || arg === "--check" || arg === "--dry-run") {
        const mode = arg === "--apply" ? "apply" : "preview";
        const validationIntent = arg === "--apply" ? "apply" : arg === "--check" ? "check" : "plan";
        if (modeSeen && (parsed.mode !== mode || parsed.validationIntent !== validationIntent)) {
          return refused("unsupported_change", "Edit command mode is ambiguous");
        }
        modeSeen = true;
        parsed.mode = mode;
        parsed.validationIntent = validationIntent;
      } else {
        setBooleanFlag(parsed, arg);
      }
      continue;
    }

    if (arg.startsWith("--")) return refused("unsupported_change", `Unsupported edit flag: ${arg}`);
    if (payloadSeen) return refused("unsupported_change", `Unexpected edit operand: ${arg}`);
    try {
      parsed.payloadSource = { kind: "inline", value: JSON.parse(arg) };
      payloadSeen = true;
    } catch {
      return refused("unsupported_change", `Unexpected edit operand: ${arg}`);
    }
  }

  return { ok: true, value: parsed };
}

function setValueFlag(parsed: ParsedEditCommand, flag: string, value: string): EditCommandParseResult {
  if (flag === "--repo") {
    parsed.repoRoot = value;
    return { ok: true, value: parsed };
  }
  if (flag === "--path") {
    const path = normalizeEditRepoRelativePath(value);
    if (!path.ok) return path;
    parsed.operands.path = path.value;
    return { ok: true, value: parsed };
  }
  if (flag === "--expected") {
    parsed.operands.expectedText = value;
    return { ok: true, value: parsed };
  }
  if (flag === "--replacement") {
    parsed.operands.replacementText = value;
    return { ok: true, value: parsed };
  }
  if (flag === "--occurrence") {
    const occurrence = Number(value);
    if (!Number.isInteger(occurrence) || occurrence < 0) {
      return refused("unsafe_edit", "Edit occurrence must be a non-negative integer");
    }
    parsed.operands.occurrence = occurrence;
    return { ok: true, value: parsed };
  }
  if (flag === "--checksum-before") {
    parsed.operands.checksumBefore = value;
    return { ok: true, value: parsed };
  }
  if (flag === "--request-json") {
    try {
      parsed.payloadSource = { kind: "inline", value: JSON.parse(value) };
      return { ok: true, value: parsed };
    } catch (error) {
      return refused("unsupported_change", `Malformed edit request JSON: ${errorMessage(error)}`);
    }
  }
  if (flag === "--request-file") {
    parsed.payloadSource = { kind: "file", path: value };
    return { ok: true, value: parsed };
  }
  if (flag === "--file-contains") {
    if (value.length === 0) return refused("unsupported_change", "fileContains must be non-empty");
    parsed.operands.fileContains = value;
    return { ok: true, value: parsed };
  }
  return refused("unsupported_change", `Unsupported edit flag: ${flag}`);
}

function setBooleanFlag(parsed: ParsedEditCommand, flag: string): void {
  if (flag === "--regex") parsed.operands.regex = true;
  else if (flag === "--case-insensitive") parsed.operands.caseInsensitive = true;
  else if (flag === "--multiline") parsed.operands.multiline = true;
  else if (flag === "--dot-all") parsed.operands.dotAll = true;
  else if (flag === "--replace-all") parsed.operands.replaceAll = true;
}

function refused(category: EditRefusal["category"], message: string, path?: string): EditCommandParseRefusal {
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
