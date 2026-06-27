import { createEditCommandAdapter, type EditGraphProviderClient } from "@the-open-engine/opcore-edit";
import {
  cliGraphDetectChanges,
  cliGraphFactQuery,
  cliGraphNamedQuery,
  cliGraphReviewContext,
  cliGraphSearch,
  cliGraphStatus
} from "./graph-provider-client.js";
import { editValidationRunner } from "./validation-composition.js";

export const editCommandAdapter = createEditCommandAdapter({
  validationRunner: editValidationRunner,
  graphProviderClient: createCliEditGraphProviderClient()
});

function createCliEditGraphProviderClient(): EditGraphProviderClient {
  return {
    status: (request) => cliGraphStatus(request.repo, request.mode),
    factQuery: cliGraphFactQuery,
    namedQuery: cliGraphNamedQuery,
    search: cliGraphSearch,
    reviewContext: cliGraphReviewContext,
    detectChanges: cliGraphDetectChanges
  };
}
