import { createHash } from "node:crypto";

export function calculateEditChecksum(content: string): string {
  if (typeof content !== "string") {
    throw new Error("Edit checksum content must be a string");
  }
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

export function calculatePlanHash(planInput: unknown): string {
  return calculateEditChecksum(stableStringify(planInput));
}

export function createPlanId(planHash: string): string {
  if (!planHash.startsWith("sha256:")) {
    throw new Error(`Plan hash must use sha256 prefix: ${planHash}`);
  }
  return `edit-${planHash.slice("sha256:".length, "sha256:".length + 24)}`;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stableValue(entry));
  }
  if (value && typeof value === "object") {
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      if (input[key] !== undefined) output[key] = stableValue(input[key]);
    }
    return output;
  }
  return value;
}
