export function isProtocolRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasExactProtocolKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return hasOnlyProtocolKeys(value, keys) && Object.keys(value).length === keys.length;
}

export function hasOnlyProtocolKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}
