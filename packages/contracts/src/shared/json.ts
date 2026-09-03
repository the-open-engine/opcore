type JsonPrimitive = string | number | boolean | null;

export type { JsonPrimitive };

type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type { JsonValue };
