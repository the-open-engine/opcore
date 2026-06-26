#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ASP_PROTOCOL_VERSION, type InitializedParams, type InitializeParams } from "./protocol.js";
import { evaluateChangeset, initializeResult } from "./mapping.js";
import {
  JsonRpcPeer,
  methodNotFoundError,
  providerNotInitializedError,
  throwRpc,
  unsupportedVersionError
} from "./json-rpc.js";
export { createOpcoreAspProviderManifest } from "./manifest.js";
export { evaluateChangeset, initializeResult } from "./mapping.js";
export { JsonRpcPeer } from "./json-rpc.js";

export function runAspProviderStdio(): JsonRpcPeer {
  let acceptedInitialize = false;
  let initialized = false;
  let initializeParams: InitializeParams | undefined;
  let initializedParams: InitializedParams = {};
  let peer: JsonRpcPeer;

  peer = new JsonRpcPeer({
    input: process.stdin,
    output: process.stdout,
    onNotification: async (method, params) => {
      if (method === "initialized" && acceptedInitialize) {
        initialized = true;
        initializedParams = normalizeInitializedParams(params);
        return;
      }
    },
    onRequest: async (method, params) => {
      if (method === "initialize") {
        const normalized = normalizeInitializeParams(params);
        if (normalized.protocolVersion !== ASP_PROTOCOL_VERSION) {
          throwRpc(unsupportedVersionError(`Unsupported initialize protocolVersion: ${normalized.protocolVersion ?? "missing"}.`));
        }
        initializeParams = normalized;
        acceptedInitialize = true;
        return initializeResult(normalized);
      }
      if (method === "check/evaluate") {
        if (!initialized || initializeParams === undefined) throwRpc(providerNotInitializedError());
        return evaluateChangeset(peer, initializeParams, initializedParams, params);
      }
      throwRpc(methodNotFoundError());
    }
  }).start();
  return peer;
}

function normalizeInitializeParams(value: unknown): InitializeParams {
  return value && typeof value === "object" ? (value as InitializeParams) : {};
}

function normalizeInitializedParams(value: unknown): InitializedParams {
  return value && typeof value === "object" ? (value as InitializedParams) : {};
}

function isDirectExecution(scriptPath: string | undefined): boolean {
  if (!scriptPath) return false;
  try {
    return realpathSync(scriptPath) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isDirectExecution(process.argv[1])) {
  if (!process.argv.includes("--stdio")) {
    process.stderr.write("Usage: opcore-asp-provider --stdio\n");
    process.exitCode = 64;
  } else {
    runAspProviderStdio();
  }
}
