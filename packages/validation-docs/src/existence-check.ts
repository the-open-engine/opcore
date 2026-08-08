import type { ValidationCheckDefinition } from "@the-open-engine/opcore-validation";
import { repoWideDocsValidationScopes } from "./check-constants.js";
import { DOCS_EXISTENCE_CHECK_ID } from "./check-ids.js";
import { docsCheck } from "./check-definition.js";
import { diagnostic } from "./diagnostics.js";
import {
  materializeDocsSnapshot,
  type DocsPolicyOptions
} from "./snapshot.js";

export function createDocsExistenceCheck(
  options: DocsPolicyOptions = {}
): ValidationCheckDefinition {
  return docsCheck(
    DOCS_EXISTENCE_CHECK_ID,
    "error",
    repoWideDocsValidationScopes,
    async (context) => {
      const snapshot = await materializeDocsSnapshot(context, options);
      const diagnostics = snapshot.requiredLocations
        .filter((location) => location.found.length === 0)
        .map((location) =>
          diagnostic({
            path: location.root === "." ? undefined : location.root,
            code: "DOCS_REQUIRED_CONTEXT_DOC_MISSING",
            message:
              `Required context doc is missing at ${location.root}: expected ` +
              `${snapshot.policy.filenames.join(" or ")}.`
          })
        );
      return { diagnostics };
    }
  );
}
