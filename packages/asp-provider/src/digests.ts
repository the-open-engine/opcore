import { createHash } from "node:crypto";
import type { ChangeSet } from "./protocol.js";

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function digestJson(value: unknown): string {
  return sha256Digest(canonicalJson(value));
}

export function sha256Digest(input: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`;
}

export function changesetDigest(changeset: ChangeSet | unknown): string {
  return digestJson(changeset);
}

export function diagnosticFingerprint(value: {
  providerId: string;
  source: string;
  code: string;
  path?: string;
  range?: unknown;
  severity: string;
  message: string;
  changesetDigest: string;
}): string {
  return digestJson(value);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => [key, canonicalize(record[key])])
  );
}
