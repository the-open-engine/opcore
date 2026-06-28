import type {
  CommandTiming,
  CommandTimingPhase,
  CommandTimingProcessState
} from "@the-open-engine/opcore-contracts";
import { validateCommandTiming } from "@the-open-engine/opcore-contracts";
import { materializeRenameSymbolEdit } from "@the-open-engine/opcore-edit";
import type {
  InitializedParams,
  InitializeParams,
  JsonRpcPeer
} from "@the-open-engine/opcore-asp-provider";
import {
  ASP_PROTOCOL_VERSION,
  evaluateChangeset,
  initializeResult,
  methodNotFoundError,
  providerNotInitializedError,
  throwRpc,
  unsupportedVersionError
} from "@the-open-engine/opcore-asp-provider";
import { resolveInspectReferences } from "../inspect-language-service.js";
import type { AspWarmLifecycle } from "./asp-warm-lifecycle.js";
import type { WarmProjectCheckout, WarmProjectRegistry } from "./warm-project-registry.js";

export interface AspWarmMethodHost {
  peer: JsonRpcPeer;
  repoRoot: string;
  registry: WarmProjectRegistry;
  lifecycle: AspWarmLifecycle;
  requestShutdown?: (reason: string) => void;
}

export class AspWarmMethods {
  private readonly peer: JsonRpcPeer;
  private readonly repoRoot: string;
  private readonly registry: WarmProjectRegistry;
  private readonly lifecycle: AspWarmLifecycle;
  private readonly requestShutdown: (reason: string) => void;
  private acceptedInitialize = false;
  private initialized = false;
  private initializeParams: InitializeParams | undefined;
  private initializedParams: InitializedParams = {};

  constructor(host: AspWarmMethodHost) {
    this.peer = host.peer;
    this.repoRoot = host.repoRoot;
    this.registry = host.registry;
    this.lifecycle = host.lifecycle;
    this.requestShutdown = host.requestShutdown ?? (() => {});
  }

  async onNotification(method: string, params: unknown): Promise<void> {
    if (method === "initialized" && this.acceptedInitialize) {
      this.initialized = true;
      this.initializedParams = normalizeInitializedParams(params);
    }
  }

  async onRequest(method: string, params: unknown): Promise<unknown> {
    if (method === "initialize") return this.handleInitialize(params);
    if (method === "inspect/references") return this.handleInspectReferences(params);
    if (method === "edit/rename") return this.handleEditRename(params);
    if (method === "check/evaluate") {
      this.requireInitialized();
      this.lifecycle.touch(method);
      return evaluateChangeset(this.peer, this.initializeParams as InitializeParams, this.initializedParams, params);
    }
    if (method === "session/shutdown") return this.handleShutdown();
    throwRpc(methodNotFoundError());
  }

  private handleInitialize(params: unknown): Record<string, unknown> {
    const normalized = normalizeInitializeParams(params);
    if (normalized.protocolVersion !== ASP_PROTOCOL_VERSION) {
      throwRpc(unsupportedVersionError(`Unsupported initialize protocolVersion: ${normalized.protocolVersion ?? "missing"}.`));
    }
    this.initializeParams = {
      ...normalized,
      workspace: {
        ...(normalized.workspace ?? {}),
        root: normalized.workspace?.root ?? this.repoRoot
      }
    };
    this.acceptedInitialize = true;
    const base = initializeResult(this.initializeParams);
    return {
      ...base,
      capabilityFamilies: ["check", "inspect", "edit", "session"],
      capabilities: {
        ...(record(base.capabilities)),
        inspect: {
          routes: ["references"],
          resolver: "language_service",
          warmProject: true
        },
        edit: {
          routes: ["rename"],
          preview: true,
          write: false
        },
        session: {
          methods: ["session/shutdown"],
          statePath: ".lattice/asp/session.json"
        }
      }
    };
  }

  private handleInspectReferences(params: unknown): Record<string, unknown> {
    this.requireInitialized();
    const request = normalizeInspectReferencesParams(params);
    const startedAt = Date.now();
    let checkout: WarmProjectCheckout | undefined;
    const resolution = this.registry.withProject({ preferredPath: request.path, scope: "whole_repo" }, (session) => {
      checkout = session;
      return resolveInspectReferences(this.repoRoot, {
        path: request.path,
        symbolName: request.symbolName,
        ...(request.line !== undefined ? { line: request.line } : {}),
        ...(request.column !== undefined ? { column: request.column } : {}),
        ...(request.limit !== undefined ? { limit: request.limit } : {}),
        allowGraphless: true,
        graphNodeIds: [],
        graphCandidates: []
      }, {
        project: session.project,
        projectScope: "whole_repo",
        snapshotProject: session.snapshotProject,
        revertProject: session.revertProject
      });
    });
    const processState = checkout?.processState ?? "warm";
    this.lifecycle.touch("inspect/references");
    return {
      provider: provider("inspect"),
      inspectResult: resolution.ok
        ? {
            route: "references",
            status: "ok",
            target: resolution.target,
            references: resolution.references
          }
        : {
            route: "references",
            status: "error",
            target: resolution.target,
            failure: {
              category: resolution.category,
              message: resolution.message,
              ...(resolution.candidates ? { candidates: resolution.candidates } : {})
            }
          },
      timing: commandTiming(startedAt, processState, "inspect_references")
    };
  }

  private handleEditRename(params: unknown): Record<string, unknown> {
    this.requireInitialized();
    const request = normalizeEditRenameParams(params);
    const startedAt = Date.now();
    let checkout: WarmProjectCheckout | undefined;
    const materialized = this.registry.withProject({ preferredPath: request.target.path, scope: "whole_repo" }, (session) => {
      checkout = session;
      return materializeRenameSymbolEdit(this.repoRoot, {
        kind: "rename",
        target: request.target,
        newName: request.newName
      }, {
        project: session.project,
        projectScope: "import_closure",
        snapshotProject: session.snapshotProject,
        revertProject: session.revertProject
      });
    });
    const processState = checkout?.processState ?? "warm";
    this.lifecycle.touch("edit/rename");
    return {
      provider: provider("edit"),
      editResult: materialized.ok
        ? {
            route: "rename",
            status: "preview",
            changes: materialized.changes,
            affectedChecksums: materialized.affectedChecksums
          }
        : {
            route: "rename",
            status: "refused",
            refusal: materialized.refusal
          },
      timing: commandTiming(startedAt, processState, "edit_rename_preview")
    };
  }

  private handleShutdown(): Record<string, unknown> {
    this.requireInitialized();
    const startedAt = Date.now();
    this.lifecycle.shutdown("session/shutdown");
    this.requestShutdown("session/shutdown");
    return {
      provider: provider("session"),
      session: {
        state: "shutdown"
      },
      timing: commandTiming(startedAt, "warm", "session_shutdown")
    };
  }

  private requireInitialized(): void {
    if (!this.initialized || this.initializeParams === undefined) throwRpc(providerNotInitializedError());
  }
}

function normalizeInitializeParams(value: unknown): InitializeParams {
  return value && typeof value === "object" ? (value as InitializeParams) : {};
}

function normalizeInitializedParams(value: unknown): InitializedParams {
  return value && typeof value === "object" ? (value as InitializedParams) : {};
}

function normalizeInspectReferencesParams(value: unknown): {
  path: string;
  symbolName: string;
  line?: number;
  column?: number;
  limit?: number;
} {
  const object = requiredRecord(value, "inspect/references params");
  const path = requiredString(object.path, "inspect/references path");
  const symbolName = requiredString(object.symbolName ?? object.symbol_name, "inspect/references symbolName");
  return {
    path,
    symbolName,
    ...(optionalNumber(object.line, "inspect/references line") !== undefined ? { line: optionalNumber(object.line, "inspect/references line") } : {}),
    ...(optionalNumber(object.column, "inspect/references column") !== undefined ? { column: optionalNumber(object.column, "inspect/references column") } : {}),
    ...(optionalNumber(object.limit, "inspect/references limit") !== undefined ? { limit: optionalNumber(object.limit, "inspect/references limit") } : {})
  };
}

function normalizeEditRenameParams(value: unknown): {
  target: {
    path: string;
    name: string;
    line?: number;
    column?: number;
    nodeId?: string;
  };
  newName: string;
} {
  const object = requiredRecord(value, "edit/rename params");
  const target = requiredRecord(object.target, "edit/rename target");
  const nodeId = optionalString(target.nodeId ?? target.node_id, "edit/rename target.nodeId");
  return {
    target: {
      path: requiredString(target.path, "edit/rename target.path"),
      name: requiredString(target.name, "edit/rename target.name"),
      ...(optionalNumber(target.line, "edit/rename target.line") !== undefined ? { line: optionalNumber(target.line, "edit/rename target.line") } : {}),
      ...(optionalNumber(target.column, "edit/rename target.column") !== undefined ? { column: optionalNumber(target.column, "edit/rename target.column") } : {}),
      ...(nodeId !== undefined ? { nodeId } : {})
    },
    newName: requiredString(object.newName ?? object.new_name, "edit/rename newName")
  };
}

function commandTiming(startedAt: number, processState: CommandTimingProcessState, phase: string): CommandTiming {
  const durationMs = elapsedMs(startedAt, processState);
  const phases: CommandTimingPhase[] = [{ phase, durationMs }];
  return validateCommandTiming({
    durationMs,
    phases,
    processState
  });
}

function elapsedMs(startedAt: number, processState: CommandTimingProcessState): number {
  const durationMs = Math.max(0, Date.now() - startedAt);
  return processState === "cold" ? Math.max(1, durationMs) : durationMs;
}

function provider(capabilityFamily: string): Record<string, unknown> {
  return {
    id: "opcore",
    capabilityFamily
  };
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function optionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
  return value;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
