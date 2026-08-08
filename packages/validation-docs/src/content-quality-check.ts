import type { ValidationDiagnostic } from "@the-open-engine/opcore-contracts";
import type { ValidationCheckDefinition } from "@the-open-engine/opcore-validation";
import { DOCS_CONTENT_QUALITY_CHECK_ID } from "./check-ids.js";
import { diagnostic } from "./diagnostics.js";
import { createDocsDocumentCheck } from "./document-check.js";
import {
  type DocsDocument,
  type DocsPolicyOptions
} from "./snapshot.js";

export function createDocsContentQualityCheck(
  options: DocsPolicyOptions = {}
): ValidationCheckDefinition {
  return createDocsDocumentCheck(
    DOCS_CONTENT_QUALITY_CHECK_ID,
    "error",
    options,
    contentQualityDiagnostics
  );
}

function contentQualityDiagnostics(
  doc: DocsDocument
): readonly ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = [];
  doc.content.split(/\r?\n/u).forEach((line, index) => {
    if (/\b(TODO|TBD|FIXME|placeholder|lorem ipsum)\b/iu.test(line)) {
      diagnostics.push(
        diagnostic({
          path: doc.path,
          code: "DOCS_CONTENT_PLACEHOLDER",
          message: `Documentation contains placeholder text on line ${index + 1}.`
        })
      );
    }
    if (/^(<{7}|={7}|>{7})/u.test(line)) {
      diagnostics.push(
        diagnostic({
          path: doc.path,
          code: "DOCS_CONTENT_CONFLICT_MARKER",
          message:
            "Documentation contains an unresolved conflict marker on line " +
            `${index + 1}.`
        })
      );
    }
  });
  return diagnostics;
}
