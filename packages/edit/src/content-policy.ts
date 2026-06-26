import type { EditRefusal } from "@the-open-engine/opcore-contracts";
import { calculateEditChecksum } from "./hash.js";

export type TextLineEnding = "lf" | "crlf" | "mixed" | "none";

export interface TextContent {
  content: string;
  checksum: string;
  hasBom: boolean;
  lineEnding: TextLineEnding;
  hasFinalNewline: boolean;
}

export type TextContentResult = { ok: true; value: TextContent } | { ok: false; refusal: EditRefusal };

const allowedControls = new Set([0x09, 0x0a, 0x0c, 0x0d]);

export function decodeTextContent(bytes: Uint8Array, path: string, label = "content"): TextContentResult {
  const binary = binaryBytesReason(bytes);
  if (binary) return refusal("unsupported_change", `${label} for ${path} is binary or control-heavy: ${binary}`, path);
  try {
    return validateTextContentString(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes), path, label);
  } catch (error) {
    return refusal("unsupported_change", `${label} for ${path} is not valid UTF-8 text: ${errorMessage(error)}`, path);
  }
}

export function validateTextContentString(content: string, path: string, label = "content"): TextContentResult {
  const binary = binaryStringReason(content);
  if (binary) return refusal("unsupported_change", `${label} for ${path} is binary or control-heavy: ${binary}`, path);
  return {
    ok: true,
    value: {
      content,
      checksum: calculateEditChecksum(content),
      hasBom: content.startsWith("\uFEFF"),
      lineEnding: detectLineEnding(content),
      hasFinalNewline: content.endsWith("\n") || content.endsWith("\r")
    }
  };
}

export function isProbablyBinaryBytes(bytes: Uint8Array): boolean {
  return binaryBytesReason(bytes) !== undefined;
}

function binaryBytesReason(bytes: Uint8Array): string | undefined {
  let controlCount = 0;
  for (const byte of bytes) {
    if (byte === 0) return "NUL byte";
    if (byte < 0x20 && !allowedControls.has(byte)) controlCount += 1;
  }
  if (controlCount >= 8 && controlCount / Math.max(bytes.length, 1) > 0.05) {
    return `${controlCount} control bytes in ${bytes.length} bytes`;
  }
  return undefined;
}

function binaryStringReason(content: string): string | undefined {
  let controlCount = 0;
  for (let index = 0; index < content.length; index += 1) {
    const code = content.charCodeAt(index);
    if (code === 0) return "NUL character";
    if (code < 0x20 && !allowedControls.has(code)) controlCount += 1;
  }
  if (controlCount >= 8 && controlCount / Math.max(content.length, 1) > 0.05) {
    return `${controlCount} control characters in ${content.length} characters`;
  }
  return undefined;
}

function detectLineEnding(content: string): TextLineEnding {
  const hasCrLf = /\r\n/.test(content);
  const withoutCrLf = content.replaceAll("\r\n", "");
  const hasLf = withoutCrLf.includes("\n");
  const hasCr = withoutCrLf.includes("\r");
  if ((hasCrLf && (hasLf || hasCr)) || (hasLf && hasCr)) return "mixed";
  if (hasCrLf) return "crlf";
  if (hasLf || hasCr) return "lf";
  return "none";
}

function refusal(category: EditRefusal["category"], message: string, path?: string): TextContentResult {
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
