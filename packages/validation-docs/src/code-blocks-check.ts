import type { ValidationDiagnostic } from "@the-open-engine/opcore-contracts";
import type { ValidationCheckDefinition } from "@the-open-engine/opcore-validation";
import { DOCS_CODE_BLOCKS_CHECK_ID } from "./check-ids.js";
import { diagnostic } from "./diagnostics.js";
import { createDocsDocumentCheck } from "./document-check.js";
import {
  type DocsDocument,
  type DocsPolicyOptions
} from "./snapshot.js";

export function createDocsCodeBlocksCheck(
  options: DocsPolicyOptions = {}
): ValidationCheckDefinition {
  return createDocsDocumentCheck(
    DOCS_CODE_BLOCKS_CHECK_ID,
    "error",
    options,
    codeBlockDiagnostics
  );
}

function codeBlockDiagnostics(
  doc: DocsDocument
): readonly ValidationDiagnostic[] {
  if (!isMarkdownLike(doc.path)) return [];
  let openFenceLine: number | undefined;
  doc.content.split(/\r?\n/u).forEach((line, index) => {
    if (!line.trimStart().startsWith("```")) return;
    openFenceLine = openFenceLine === undefined ? index + 1 : undefined;
  });
  return openFenceLine === undefined
    ? []
    : [
        diagnostic({
          path: doc.path,
          code: "DOCS_CODE_BLOCK_UNCLOSED",
          message:
            `Markdown code block opened on line ${openFenceLine} ` +
            "is not closed."
        })
      ];
}

function isMarkdownLike(path: string): boolean {
  const lower = path.toLowerCase();
  return [".md", ".mdx", ".rst", ".adoc"].some((extension) =>
    lower.endsWith(extension)
  );
}
