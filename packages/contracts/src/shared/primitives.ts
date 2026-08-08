function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((entry) => collectStrings(entry));
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap((entry) => collectStrings(entry));
}

export { collectStrings };

function includesString<const T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === "string" && values.includes(value);
}

export { includesString };

function sameStringArray(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

export { sameStringArray };

function withoutUndefinedProperties<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

export { withoutUndefinedProperties };

function validateOptional<T>(value: T | undefined, validator: (value: T) => void): void {
  if (value !== undefined) validator(value);
}

export { validateOptional };

function validateBoolean(value: unknown, label: string): asserts value is boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
}

export { validateBoolean };

function validateObject(value: unknown, label: string): asserts value is object {
  if (!value || typeof value !== "object") throw new Error(`${label} is required`);
}

export { validateObject };

function validateArray(value: unknown, label: string): asserts value is readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
}

export { validateArray };

function validateRequiredObject<T>(value: T, message: string): asserts value is T & object {
  if (!value || typeof value !== "object") throw new Error(message);
}

export { validateRequiredObject };

function validateExactValue<T>(value: T, expected: T, message: string): void {
  if (value !== expected) throw new Error(message);
}

export { validateExactValue };
