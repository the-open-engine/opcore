import type { EditCommandResult, EditPlan } from "../edit/contracts.js";
import type { GraphPipelineResult, GraphServeTransportStatus } from "../graph/pipeline-contracts.js";
import type { GraphProviderStatus } from "../graph/provider-contracts-02.js";
import type { GraphFactQueryResult, GraphNamedQueryResult } from "../graph/query-contracts-01.js";
import type {
  GraphDetectChangesResult,
  GraphImpactResult,
  GraphReviewContextResult,
} from "../graph/query-contracts-02.js";
import type { GraphSearchResult } from "../graph/search-contracts.js";
import type { InspectRouteResult } from "../inspect/contracts-02.js";
import type { OpcoreInitPlanPayload } from "../product/init-contracts.js";
import type { CommandTiming } from "../product/latency-contracts.js";
import type { OpcoreMeasureDelta } from "../product/metrics-contracts-01.js";
import type { OpcoreTryPayload } from "../product/metrics-contracts-02.js";
import type {
  OpcoreDoctorPayload,
  OpcoreRepoStatePayload,
  OpcoreRuntimeInfoPayload,
} from "../product/status-contracts.js";
import type { ValidationResult } from "../validation/capability-contracts.js";
import type { PreWriteValidationReceipt, ValidationStatusPayload } from "../validation/status-contracts.js";
import type { CommandGroupContract } from "./contracts.js";
import type { CommandOwner, CommandRouteStatus } from "./vocabulary.js";

interface CommandRouterContext {
  bin: string;
  argv: readonly string[];
  canonicalCommand: readonly string[];
  owner: CommandOwner;
  status: CommandRouteStatus;
  message: string;
  json: boolean;
}

export type { CommandRouterContext };

interface CommandRouterGraphPayloads {
  providerStatus?: GraphProviderStatus;
  graphPipeline?: GraphPipelineResult;
  graphQuery?: GraphFactQueryResult | GraphNamedQueryResult;
  graphSearch?: GraphSearchResult;
  inspectResult?: InspectRouteResult;
  graphImpact?: GraphImpactResult;
  graphReviewContext?: GraphReviewContextResult;
  graphChanges?: GraphDetectChangesResult;
  graphServe?: GraphServeTransportStatus;
}

export type { CommandRouterGraphPayloads };

interface CommandRouterActionPayloads {
  validationResult?: ValidationResult;
  validationStatus?: ValidationStatusPayload;
  receipt?: PreWriteValidationReceipt;
  editPlan?: EditPlan;
  editResult?: EditCommandResult;
}

export type { CommandRouterActionPayloads };

interface CommandRouterProductPayloads {
  repoState?: OpcoreRepoStatePayload;
  runtimeInfo?: OpcoreRuntimeInfoPayload;
  opcoreDoctor?: OpcoreDoctorPayload;
  opcoreInit?: OpcoreInitPlanPayload;
  opcoreMeasure?: OpcoreMeasureDelta;
  opcoreTry?: OpcoreTryPayload;
  timing?: CommandTiming;
}

export type { CommandRouterProductPayloads };

interface CommandRouterResult
  extends CommandRouterContext,
    CommandRouterGraphPayloads,
    CommandRouterActionPayloads,
    CommandRouterProductPayloads {
  schemaVersion: 1;
  exitCode: number;
}

export type { CommandRouterResult };

interface ParsedCommandArgv {
  args: readonly string[];
  json: boolean;
}

export type { ParsedCommandArgv };

interface CommandRouterResultInput
  extends CommandRouterContext,
    CommandRouterGraphPayloads,
    CommandRouterActionPayloads,
    CommandRouterProductPayloads {}

export type { CommandRouterResultInput };

interface CommandAdapterRequest {
  schemaVersion: 1;
  bin: string;
  argv: readonly string[];
  args: readonly string[];
  json: boolean;
  group: CommandGroupContract;
  canonicalCommand: readonly string[];
}

export type { CommandAdapterRequest };

type CommandAdapter = (request: CommandAdapterRequest) => CommandRouterResult | Promise<CommandRouterResult>;

export type { CommandAdapter };

type CommandRouterWriter = (text: string) => void;

export type { CommandRouterWriter };

interface RouteCommandAdapterOptions {
  bin: string;
  argv: readonly string[];
  groupName: string;
  adapter: CommandAdapter;
  args?: readonly string[];
  json?: boolean;
  showHelpOnEmpty?: boolean;
  validateFirstRouteArg?: boolean;
}

export type { RouteCommandAdapterOptions };

interface RunCommandAdapterCliOptions extends Omit<RouteCommandAdapterOptions, "argv"> {
  argv?: readonly string[];
  stdout?: CommandRouterWriter;
  stderr?: CommandRouterWriter;
}

export type { RunCommandAdapterCliOptions };
