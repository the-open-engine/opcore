import type { ValidationDiagnostic } from "@the-open-engine/opcore-contracts";
import type {
  ValidationCheckContext,
  ValidationCheckDefinition,
  ValidationCheckResult
} from "@the-open-engine/opcore-validation";
import { supportedDocsValidationScopes } from "./check-constants.js";
import { docsCheck } from "./check-definition.js";
import { skippedDocsResult } from "./check-results.js";
import { sortDiagnostics } from "./diagnostics.js";
import {
  materializeDocsSnapshot,
  type DocsDocument,
  type DocsPolicyOptions,
  type DocsSnapshot
} from "./snapshot.js";

type SnapshotCollector = (
  snapshot: DocsSnapshot
) => Promise<readonly ValidationDiagnostic[]> | readonly ValidationDiagnostic[];

export function createDocsDocumentCheck(
  id: string,
  severity: ValidationDiagnostic["severity"],
  options: DocsPolicyOptions,
  collect: (doc: DocsDocument, snapshot: DocsSnapshot) => readonly ValidationDiagnostic[]
): ValidationCheckDefinition {
  return createDocsSnapshotCheck(id, severity, options, (snapshot) =>
    snapshot.docs.flatMap((doc) => collect(doc, snapshot))
  );
}

export function createDocsSnapshotCheck(
  id: string,
  severity: ValidationDiagnostic["severity"],
  options: DocsPolicyOptions,
  collect: SnapshotCollector
): ValidationCheckDefinition {
  return docsCheck(
    id,
    severity,
    supportedDocsValidationScopes,
    (context) => withSelectedDocs(context, options, collect)
  );
}

export async function withSelectedDocs(
  context: ValidationCheckContext,
  options: DocsPolicyOptions,
  collect: SnapshotCollector
): Promise<ValidationCheckResult> {
  const snapshot = await materializeDocsSnapshot(context, options);
  if (snapshot.docs.length === 0) {
    return skippedDocsResult("No documentation files were selected.");
  }
  return { diagnostics: sortDiagnostics(await collect(snapshot)) };
}
