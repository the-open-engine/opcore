import type { Node as JsonNode } from "jsonc-parser";

export function duplicateJsonObjectKey(node: JsonNode): string | undefined {
  return node.type === "object"
    ? duplicateObjectKey(node.children ?? [])
    : duplicateNestedKey(node.children ?? []);
}

function duplicateObjectKey(properties: readonly JsonNode[]): string | undefined {
  const keys = new Set<string>();
  for (const property of properties) {
    const key = property.children?.[0]?.value;
    if (typeof key === "string" && keys.has(key)) return key;
    if (typeof key === "string") keys.add(key);
    const value = property.children?.[1];
    const duplicate = duplicateNestedKey(value === undefined ? [] : [value]);
    if (duplicate !== undefined) return duplicate;
  }
  return undefined;
}

function duplicateNestedKey(children: readonly JsonNode[]): string | undefined {
  for (const child of children) {
    const duplicate = duplicateJsonObjectKey(child);
    if (duplicate !== undefined) return duplicate;
  }
  return undefined;
}
