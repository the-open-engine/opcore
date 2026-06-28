import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CLONE_PROTOCOL,
  validateCloneAnalysisRequest,
  validateCloneAnalysisResult
} from "../packages/contracts/dist/index.js";

const contractSchema = JSON.parse(
  readFileSync(new URL("../packages/contracts/schemas/opcore-contracts.schema.json", import.meta.url), "utf8")
);
const scalarConstraintPredicates = [
  matchesConstConstraint,
  matchesEnumConstraint,
  matchesTypeConstraint,
  matchesMinLengthConstraint,
  matchesMinItemsConstraint,
  matchesMinimumConstraint,
  matchesPatternConstraint
];

describe("clone analysis contracts", () => {
  it("validates clone request and result payloads", () => {
    const request = cloneRequest();
    const result = cloneResult();

    assert.equal(validateCloneAnalysisRequest(request).protocol, CLONE_PROTOCOL);
    assert.equal(validateCloneAnalysisResult(result).findings[0].cloneClassId, "clone-0123456789abcdef");

    assert.throws(
      () => validateCloneAnalysisRequest({ ...request, protocol: "opcore.graph.daemon" }),
      /protocol/
    );
    assert.throws(
      () => validateCloneAnalysisRequest({ ...request, reportMode: "security" }),
      /reportMode/
    );
    assert.throws(
      () => validateCloneAnalysisRequest({ ...request, overlays: [{ path: "../escape.ts", action: "delete" }] }),
      /repository/
    );
    assert.throws(
      () =>
        validateCloneAnalysisResult({
          ...result,
          findings: [{ ...result.findings[0], path: "src/a.ts", peerPath: "src/a.ts" }]
        }),
      /distinct/
    );
    assert.throws(
      () =>
        validateCloneAnalysisResult({
          ...result,
          findings: [{ ...result.findings[0], line: 7 }]
        }),
      /line/
    );
  });

  it("keeps clone request and result in the checked-in JSON schema", () => {
    assert.equal(isValidDefinition("CloneAnalysisRequest", cloneRequest()), true);
    assert.equal(isValidDefinition("CloneAnalysisRequest", { ...cloneRequest(), reportMode: "all" }), true);
    assert.equal(isValidDefinition("CloneAnalysisRequest", { ...cloneRequest(), reportMode: "audit" }), false);
    assert.equal(isValidDefinition("CloneAnalysisResult", cloneResult()), true);
    assert.equal(
      isValidDefinition("CloneAnalysisResult", {
        ...cloneResult(),
        findings: [{ ...cloneResult().findings[0], startLine: 12 }]
      }),
      false
    );
  });
});

function cloneRequest(overrides = {}) {
  return {
    protocol: CLONE_PROTOCOL,
    requestId: "clone-1",
    schemaVersion: 1,
    repo: {
      repoRoot: "/tmp/opcore-clone-fixture"
    },
    reportMode: "introduced",
    paths: ["src/a.ts"],
    overlays: [
      {
        path: "src/a.ts",
        action: "write",
        content: "export const value = 1;\n"
      }
    ],
    minLines: 5,
    minTokens: 20,
    ...overrides
  };
}

function cloneResult(overrides = {}) {
  return {
    protocol: CLONE_PROTOCOL,
    requestId: "clone-1",
    schemaVersion: 1,
    repo: {
      repoRoot: "/tmp/opcore-clone-fixture"
    },
    reportMode: "introduced",
    status: "passed",
    persisted: false,
    findings: [
      {
        cloneClassId: "clone-0123456789abcdef",
        contentHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        path: "src/a.ts",
        peerPath: "src/b.ts",
        paths: ["src/a.ts", "src/b.ts"],
        lineCount: 6,
        tokenCount: 24,
        introduced: true
      }
    ],
    summary: {
      analyzedFiles: 2,
      cloneClassCount: 1,
      findingCount: 1,
      overlayCount: 1
    },
    ...overrides
  };
}

function isValidDefinition(definitionName, value) {
  return isValid({ $ref: `#/$defs/${definitionName}` }, value);
}

function isValid(schemaNode, value) {
  const node = resolveRef(schemaNode);
  return (
    matchesCombinators(node, value) &&
    matchesScalarConstraints(node, value) &&
    matchesObjectShape(node, value) &&
    matchesArrayItems(node, value)
  );
}

function matchesCombinators(node, value) {
  if (node.allOf && !node.allOf.every((child) => isValid(child, value))) return false;
  if (node.anyOf && !node.anyOf.some((child) => isValid(child, value))) return false;
  if (node.oneOf && node.oneOf.filter((child) => isValid(child, value)).length !== 1) return false;
  return !(node.not && isValid(node.not, value));
}

function matchesScalarConstraints(node, value) {
  return scalarConstraintPredicates.every((predicate) => predicate(node, value));
}

function matchesConstConstraint(node, value) {
  return node.const === undefined || Object.is(value, node.const);
}

function matchesEnumConstraint(node, value) {
  return !node.enum || node.enum.some((entry) => Object.is(entry, value));
}

function matchesTypeConstraint(node, value) {
  return !node.type || matchesType(node.type, value);
}

function matchesMinLengthConstraint(node, value) {
  return node.minLength === undefined || typeof value !== "string" || value.length >= node.minLength;
}

function matchesMinItemsConstraint(node, value) {
  return node.minItems === undefined || !Array.isArray(value) || value.length >= node.minItems;
}

function matchesMinimumConstraint(node, value) {
  return node.minimum === undefined || typeof value !== "number" || value >= node.minimum;
}

function matchesPatternConstraint(node, value) {
  return !node.pattern || typeof value !== "string" || new RegExp(node.pattern).test(value);
}

function matchesObjectShape(node, value) {
  if (node.required && !hasRequiredKeys(value, node.required)) return false;
  if (node.properties && !matchesProperties(node.properties, value)) return false;
  return node.additionalProperties !== false || hasOnlyKnownKeys(value, node.properties ?? {});
}

function hasRequiredKeys(value, required) {
  if (!isPlainObject(value)) return false;
  return required.every((key) => Object.hasOwn(value, key));
}

function matchesProperties(properties, value) {
  if (!isPlainObject(value)) return true;
  return Object.entries(properties).every(([key, child]) => !Object.hasOwn(value, key) || isValid(child, value[key]));
}

function hasOnlyKnownKeys(value, properties) {
  if (!isPlainObject(value)) return true;
  const knownKeys = new Set(Object.keys(properties));
  return Object.keys(value).every((key) => knownKeys.has(key));
}

function matchesArrayItems(node, value) {
  if (!Object.hasOwn(node, "items") || !Array.isArray(value)) return true;
  return value.every((item) => isValid(node.items, item));
}

function resolveRef(schemaNode) {
  if (!schemaNode.$ref) return schemaNode;
  const path = schemaNode.$ref.split("/").slice(1);
  let current = contractSchema;
  for (const rawPart of path) {
    current = current[rawPart.replaceAll("~1", "/").replaceAll("~0", "~")];
  }
  return current;
}

function matchesType(type, value) {
  if (type === "object") return isPlainObject(value);
  if (type === "array") return Array.isArray(value);
  if (type === "string") return typeof value === "string";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "boolean") return typeof value === "boolean";
  return true;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
