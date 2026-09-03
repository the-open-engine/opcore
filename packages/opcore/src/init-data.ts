export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function trimRightPreserve(text: string): string {
  return text.replace(/\s+$/u, "");
}

export function trimLeftPreserve(text: string): string {
  return text.replace(/^\s+/u, "");
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
