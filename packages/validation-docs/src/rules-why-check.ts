import type { ValidationDiagnostic } from "@the-open-engine/opcore-contracts";
import type { ValidationCheckDefinition } from "@the-open-engine/opcore-validation";
import { DOCS_RULES_WHY_CHECK_ID } from "./check-ids.js";
import { diagnostic } from "./diagnostics.js";
import { createDocsDocumentCheck } from "./document-check.js";
import {
  type DocsDocument,
  type DocsPolicyOptions
} from "./snapshot.js";

export function createDocsRulesWhyCheck(
  options: DocsPolicyOptions = {}
): ValidationCheckDefinition {
  return createDocsDocumentCheck(
    DOCS_RULES_WHY_CHECK_ID,
    "error",
    options,
    ruleWhyDiagnostics
  );
}

function ruleWhyDiagnostics(
  doc: DocsDocument
): readonly ValidationDiagnostic[] {
  if (!doc.requiredContext) return [];
  const diagnostics: ValidationDiagnostic[] = [];
  doc.content.split(/\r?\n/u).forEach((line, index) => {
    const trimmed = line.trim();
    if (!/^(?:[-*]\s*)?(ALWAYS|NEVER|MUST|SHOULD)\b/u.test(trimmed)) return;
    if (/\bWHY:/u.test(trimmed) || /\bbecause\b/iu.test(trimmed)) return;
    diagnostics.push(
      diagnostic({
        path: doc.path,
        code: "DOCS_RULE_WITHOUT_WHY",
        message:
          `Context-doc rule on line ${index + 1} ` +
          "is missing a WHY rationale."
      })
    );
  });
  return diagnostics;
}
