import { includesString } from "../shared/primitives.js";
import type {
  GraphReleaseSurfaceClassification} from "../release/graph-vocabulary-01.js";
import {
  graphReleaseSurfaceClassifications,
} from "../release/graph-vocabulary-01.js";
import type { CommandOwner, CommandRouteStatus} from "./vocabulary.js";
import { commandOwners, commandRouteStatuses } from "./vocabulary.js";

function validateCommandOwner(owner: unknown): CommandOwner {
  if (!includesString(commandOwners, owner)) {
    throw new Error(`Unknown command owner: ${String(owner)}`);
  }
  return owner;
}

export { validateCommandOwner };

function validateCommandRouteStatus(status: unknown): CommandRouteStatus {
  if (!includesString(commandRouteStatuses, status)) {
    throw new Error(`Unknown command route status: ${String(status)}`);
  }
  return status;
}

export { validateCommandRouteStatus };

function validateGraphReleaseSurfaceClassification(classification: unknown): GraphReleaseSurfaceClassification {
  if (!includesString(graphReleaseSurfaceClassifications, classification)) {
    throw new Error(`Unknown graph release surface classification: ${String(classification)}`);
  }
  return classification;
}

export { validateGraphReleaseSurfaceClassification };
