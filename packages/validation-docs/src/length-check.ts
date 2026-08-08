import type {
  RequiredContextDocPolicy,
  ValidationDiagnostic
} from "@the-open-engine/opcore-contracts";
import type { ValidationCheckDefinition } from "@the-open-engine/opcore-validation";
import {
  countPhysicalLines,
  splitPhysicalLines
} from "@the-open-engine/opcore-validation";
import { DOCS_LENGTH_CHECK_ID } from "./check-ids.js";
import { diagnostic } from "./diagnostics.js";
import { createDocsDocumentCheck } from "./document-check.js";
import {
  type DocsDocument,
  type DocsPolicyOptions
} from "./snapshot.js";

export function createDocsLengthCheck(
  options: DocsPolicyOptions = {}
): ValidationCheckDefinition {
  return createDocsDocumentCheck(
    DOCS_LENGTH_CHECK_ID,
    "error",
    options,
    (doc, snapshot) => lengthDiagnostics(doc, snapshot.policy)
  );
}

function lengthDiagnostics(
  doc: DocsDocument,
  policy: RequiredContextDocPolicy
): readonly ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = [];
  if (doc.content.trim().length < policy.minimumContentLength) {
    diagnostics.push(
      diagnostic({
        path: doc.path,
        code: "DOCS_TOO_SHORT",
        message:
          "Documentation content is shorter than the " +
          `${policy.minimumContentLength}-character require-context-doc policy minimum.`
      })
    );
  }
  const lines = splitPhysicalLines(doc.content);
  const totalLines = countPhysicalLines(doc.content);
  if (policy.maxLines !== undefined && totalLines > policy.maxLines) {
    diagnostics.push(
      diagnostic({
        path: doc.path,
        code: "DOCS_TOO_LONG",
        message: `Documentation has ${totalLines} lines; max is ${policy.maxLines}.`
      })
    );
  }
  const sectionLines = longestSectionLineCount(lines);
  if (
    policy.maxSectionLines !== undefined &&
    sectionLines > policy.maxSectionLines
  ) {
    diagnostics.push(
      diagnostic({
        path: doc.path,
        code: "DOCS_SECTION_TOO_LONG",
        message:
          `Documentation section has ${sectionLines} lines; ` +
          `max is ${policy.maxSectionLines}.`
      })
    );
  }
  return diagnostics;
}

function longestSectionLineCount(lines: readonly string[]): number {
  let current = 0;
  let longest = 0;
  for (const line of lines) {
    if (/^\s*#{1,6}\s+/u.test(line)) {
      longest = Math.max(longest, current);
      current = 1;
    } else {
      current += 1;
    }
  }
  return Math.max(longest, current);
}
