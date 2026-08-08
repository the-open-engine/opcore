import type {
  CommandRouterResult,
  OpcoreInitPlanPayload
} from "@the-open-engine/opcore-contracts";
import { createCommandRouterResult } from "@the-open-engine/opcore-contracts";

export interface InitRouterResultInput {
  argv: readonly string[];
  json: boolean;
  status: "ok" | "error";
  message: string;
  canonicalCommand?: readonly string[];
  opcoreInit?: OpcoreInitPlanPayload;
}

export function createInitRouterResult(input: InitRouterResultInput): CommandRouterResult {
  return createCommandRouterResult({
    bin: "opcore",
    argv: input.argv,
    canonicalCommand: input.canonicalCommand ?? ["opcore", "init"],
    owner: "runtime",
    status: input.status,
    json: input.json,
    message: input.message,
    opcoreInit: input.opcoreInit
  });
}
