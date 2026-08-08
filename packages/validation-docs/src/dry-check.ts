import type { ValidationDiagnostic } from "@the-open-engine/opcore-contracts";
import type { ValidationCheckDefinition } from "@the-open-engine/opcore-validation";
import { DOCS_DRY_CHECK_ID } from "./check-ids.js";
import { diagnostic } from "./diagnostics.js";
import { createDocsSnapshotCheck } from "./document-check.js";
import {
  type DocsDocument,
  type DocsPolicyOptions
} from "./snapshot.js";

export function createDocsDryCheck(
  options: DocsPolicyOptions = {}
): ValidationCheckDefinition {
  return createDocsSnapshotCheck(
    DOCS_DRY_CHECK_ID,
    "warning",
    options,
    (snapshot) => duplicateParagraphDiagnostics(snapshot.docs)
  );
}

function duplicateParagraphDiagnostics(
  docs: readonly DocsDocument[]
): readonly ValidationDiagnostic[] {
  const seen = new Map<string, string>();
  const diagnostics: ValidationDiagnostic[] = [];
  for (const doc of docs) {
    const duplicate = firstDuplicateParagraph(doc, seen);
    if (duplicate === undefined) continue;
    diagnostics.push(
      diagnostic({
        severity: "warning",
        path: doc.path,
        code: "DOCS_DRY_DUPLICATE_PARAGRAPH",
        message:
          "Documentation repeats a long paragraph already present in " +
          `${duplicate}.`
      })
    );
  }
  return diagnostics;
}

function firstDuplicateParagraph(
  doc: DocsDocument,
  seen: Map<string, string>
): string | undefined {
  for (const paragraph of normalizedParagraphs(doc.content)) {
    const existing = seen.get(paragraph);
    if (existing !== undefined && existing !== doc.path) return existing;
    seen.set(paragraph, doc.path);
  }
  return undefined;
}

function normalizedParagraphs(content: string): readonly string[] {
  return content
    .split(/\n\s*\n/u)
    .map((paragraph) => paragraph.replace(/\s+/gu, " ").trim())
    .filter(
      (paragraph) =>
        paragraph.length >= 80 && !paragraph.startsWith("```")
    );
}
