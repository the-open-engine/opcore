import { validateRequiredObject } from "../shared/validators-02.js";
import { validateNonEmptyString, validateStringArray } from "../shared/validators-01.js";
import type { CommandAdapterRequest } from "./router-contracts.js";
import { validateManifestGroups } from "./validators.js";

function validateCommandAdapterRequest(request: CommandAdapterRequest): CommandAdapterRequest {
  validateRequiredObject(request, "Command adapter request is required");
  if (request.schemaVersion !== 1) {
    throw new Error("Command adapter request schemaVersion must be 1");
  }
  validateNonEmptyString(request.bin, "Command adapter request bin");
  validateStringArray(request.argv, "Command adapter request argv", {
    allowEmpty: true,
    allowEmptyValues: true,
  });
  validateStringArray(request.args, "Command adapter request args", {
    allowEmpty: true,
    allowEmptyValues: true,
  });
  if (typeof request.json !== "boolean") {
    throw new Error("Command adapter request json must be boolean");
  }
  validateRequiredObject(request.group, "Command adapter request group is required");
  validateManifestGroups([request.group]);
  validateStringArray(request.canonicalCommand, "Command adapter request canonicalCommand", { allowEmpty: false });
  if (!request.group.canonicalCommand.every((part, index) => request.canonicalCommand[index] === part)) {
    throw new Error("Command adapter request canonicalCommand must start with the group canonicalCommand");
  }
  return request;
}

export { validateCommandAdapterRequest };
