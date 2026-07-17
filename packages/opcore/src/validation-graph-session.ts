import { createEphemeralGraphSnapshot } from "@the-open-engine/opcore-graph";
import {
  createStateAwareValidationGraphSessionFactory,
  createValidationExactGraphSnapshotFactory,
  type ValidationGraphProviderClient,
  type ValidationGraphSessionFactory
} from "@the-open-engine/opcore-validation";

export function createOpcoreGraphSessionFactory(
  persistentClient: ValidationGraphProviderClient
): ValidationGraphSessionFactory {
  return createStateAwareValidationGraphSessionFactory({
    persistentClient,
    exactSnapshotFactory: createValidationExactGraphSnapshotFactory(createEphemeralGraphSnapshot)
  });
}
