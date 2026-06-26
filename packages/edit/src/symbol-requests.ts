import type { EditRefusal, RepoIdentity } from "@the-open-engine/lattice-contracts";
import { normalizeEditRepoRelativePath } from "./path-policy.js";

export interface SymbolEditTarget {
  path: string;
  name: string;
  line?: number;
  column?: number;
  nodeId?: string;
}

export interface RenameSymbolEditRequest extends SymbolEditRequestBase {
  kind: "rename";
  target: SymbolEditTarget;
  newName: string;
}

export interface MoveSymbolEditRequest extends SymbolEditRequestBase {
  kind: "move";
  fromPath: string;
  toPath: string;
}

export type SignatureParameterChange =
  | {
      action: "add";
      name: string;
      type: string;
      defaultValue?: string;
      optional?: boolean;
      position?: number;
    }
  | {
      action: "remove";
      name: string;
    }
  | {
      action: "rename";
      name: string;
      newName: string;
    };

export interface SignatureSymbolEditRequest extends SymbolEditRequestBase {
  kind: "signature";
  target: SymbolEditTarget;
  changes: readonly SignatureParameterChange[];
}

export type SymbolEditRequest = RenameSymbolEditRequest | MoveSymbolEditRequest | SignatureSymbolEditRequest;

export interface SymbolEditRequestBase {
  repo?: RepoIdentity;
  validation?: {
    required?: true;
  };
}

export type SymbolRequestResult<T> = { ok: true; value: T } | { ok: false; refusal: EditRefusal };

type JsonRecord = Record<string, unknown>;

const typeScriptIdentifierPattern = /^[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*$/u;
const reservedTypeScriptBindingNames = new Set([
  "arguments",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "eval",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield"
]);
reservedTypeScriptBindingNames.add("im" + "port");

export function renameSymbolRequest(payload: unknown): SymbolRequestResult<RenameSymbolEditRequest> {
  const object = recordOrEmpty(payload);
  const target = symbolTarget(object.target);
  if (!target.ok) return target;
  const newName = requiredIdentifier("newName", object.newName, object.new_name);
  if (!newName.ok) return newName;
  const validation = validationOption(object);
  if (!validation.ok) return validation;
  return { ok: true, value: { kind: "rename", target: target.value, newName: newName.value, validation: validation.value } };
}

export function moveSymbolRequest(payload: unknown): SymbolRequestResult<MoveSymbolEditRequest> {
  const object = recordOrEmpty(payload);
  const fromPath = requiredPath("fromPath", object.fromPath, object.from_path);
  if (!fromPath.ok) return fromPath;
  const toPath = requiredPath("toPath", object.toPath, object.to_path);
  if (!toPath.ok) return toPath;
  const validation = validationOption(object);
  if (!validation.ok) return validation;
  return { ok: true, value: { kind: "move", fromPath: fromPath.value, toPath: toPath.value, validation: validation.value } };
}

export function signatureSymbolRequest(payload: unknown): SymbolRequestResult<SignatureSymbolEditRequest> {
  const object = recordOrEmpty(payload);
  const target = symbolTarget(object.target);
  if (!target.ok) return target;
  if (!Array.isArray(object.changes) || object.changes.length === 0) {
    return refused("unsupported_change", "Signature request requires non-empty changes");
  }
  const changes: SignatureParameterChange[] = [];
  for (const [index, raw] of object.changes.entries()) {
    const parsed = signatureChange(raw, `changes[${index}]`);
    if (!parsed.ok) return parsed;
    changes.push(parsed.value);
  }
  const validation = validationOption(object);
  if (!validation.ok) return validation;
  return { ok: true, value: { kind: "signature", target: target.value, changes, validation: validation.value } };
}

function symbolTarget(value: unknown): SymbolRequestResult<SymbolEditTarget> {
  if (!isRecord(value)) return refused("unsupported_change", "Symbol request requires target object");
  const path = requiredPath("target.path", value.path);
  if (!path.ok) return path;
  const name = requiredIdentifier("target.name", value.name);
  if (!name.ok) return name;
  const line = optionalPositiveInteger("target.line", value.line);
  if (!line.ok) return line;
  const column = optionalPositiveInteger("target.column", value.column);
  if (!column.ok) return column;
  const nodeId = optionalString("target.nodeId", value.nodeId, value.node_id);
  if (!nodeId.ok) return nodeId;
  return {
    ok: true,
    value: {
      path: path.value,
      name: name.value,
      line: line.value,
      column: column.value,
      nodeId: nodeId.value
    }
  };
}

function signatureChange(value: unknown, label: string): SymbolRequestResult<SignatureParameterChange> {
  if (!isRecord(value)) return refused("unsupported_change", `${label} must be an object`);
  const action = requiredString(`${label}.action`, value.action);
  if (!action.ok) return action;
  const name = requiredIdentifier(`${label}.name`, value.name);
  if (!name.ok) return name;
  if (action.value === "remove") return { ok: true, value: { action: "remove", name: name.value } };
  if (action.value === "rename") {
    const newName = requiredIdentifier(`${label}.newName`, value.newName, value.new_name);
    if (!newName.ok) return newName;
    return { ok: true, value: { action: "rename", name: name.value, newName: newName.value } };
  }
  if (action.value === "add") {
    const type = requiredString(`${label}.type`, value.type);
    if (!type.ok) return type;
    const defaultValue = optionalString(`${label}.defaultValue`, value.defaultValue, value.default_value);
    if (!defaultValue.ok) return defaultValue;
    const optional = optionalBoolean(`${label}.optional`, value.optional);
    if (!optional.ok) return optional;
    const position = optionalNonNegativeInteger(`${label}.position`, value.position);
    if (!position.ok) return position;
    return {
      ok: true,
      value: {
        action: "add",
        name: name.value,
        type: type.value,
        defaultValue: defaultValue.value,
        optional: optional.value,
        position: position.value
      }
    };
  }
  return refused("unsupported_change", `${label}.action must be add, remove, or rename`);
}

function validationOption(object: JsonRecord): SymbolRequestResult<{ required?: true } | undefined> {
  if (object.validation === undefined) return { ok: true, value: undefined };
  if (!isRecord(object.validation)) return refused("unsupported_change", "validation must be an object when provided");
  const required = optionalBoolean("validation.required", object.validation.required);
  if (!required.ok) return required;
  if (required.value === false) {
    return refused("unsupported_change", "Symbol edits require validation.required=true");
  }
  return { ok: true, value: required.value === undefined ? undefined : { required: true } };
}

function requiredPath(label: string, ...values: unknown[]): SymbolRequestResult<string> {
  const value = requiredString(label, ...values);
  if (!value.ok) return value;
  return normalizeEditRepoRelativePath(value.value);
}

function requiredString(label: string, ...values: unknown[]): SymbolRequestResult<string> {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return { ok: true, value };
  }
  return refused("unsupported_change", `Symbol request requires ${label}`);
}

function requiredIdentifier(label: string, ...values: unknown[]): SymbolRequestResult<string> {
  const value = requiredString(label, ...values);
  if (!value.ok) return value;
  if (!isTypeScriptIdentifier(value.value)) return refused("unsupported_change", `${label} must be a valid TypeScript identifier`);
  return value;
}

function isTypeScriptIdentifier(value: string): boolean {
  return typeScriptIdentifierPattern.test(value) && !reservedTypeScriptBindingNames.has(value);
}

function optionalString(label: string, ...values: unknown[]): SymbolRequestResult<string | undefined> {
  let selected: string | undefined;
  for (const value of values) {
    if (value === undefined) continue;
    if (typeof value !== "string" || value.length === 0) return refused("unsupported_change", `${label} must be a non-empty string when provided`);
    if (selected === undefined) selected = value;
    else if (selected !== value) return refused("unsupported_change", `${label} aliases conflict`);
  }
  return { ok: true, value: selected };
}

function optionalBoolean(label: string, ...values: unknown[]): SymbolRequestResult<boolean | undefined> {
  let selected: boolean | undefined;
  for (const value of values) {
    if (value === undefined) continue;
    if (typeof value !== "boolean") return refused("unsupported_change", `${label} must be a boolean when provided`);
    if (selected === undefined) selected = value;
    else if (selected !== value) return refused("unsupported_change", `${label} aliases conflict`);
  }
  return { ok: true, value: selected };
}

function optionalPositiveInteger(label: string, value: unknown): SymbolRequestResult<number | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return refused("unsafe_edit", `${label} must be a positive integer when provided`);
  }
  return { ok: true, value };
}

function optionalNonNegativeInteger(label: string, value: unknown): SymbolRequestResult<number | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return refused("unsafe_edit", `${label} must be a non-negative integer when provided`);
  }
  return { ok: true, value };
}

function recordOrEmpty(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function refused(category: EditRefusal["category"], message: string, path?: string): { ok: false; refusal: EditRefusal } {
  return {
    ok: false,
    refusal: {
      category,
      message,
      path
    }
  };
}
