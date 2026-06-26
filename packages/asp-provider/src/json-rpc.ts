import type { Readable, Writable } from "node:stream";
import type { JsonObject, JsonRpcErrorObject, JsonRpcPending, JsonRpcRequest, RpcThrowable } from "./protocol.js";

export const JSON_RPC_VERSION = "2.0";
export const RPC_PROVIDER_NOT_INITIALIZED = -32010;
export const RPC_UNSUPPORTED_VERSION = -32014;
export const RPC_METHOD_NOT_FOUND = -32601;

export type JsonRpcPeerOptions = {
  input: Readable;
  output: Writable;
  onRequest?: (method: string, params: unknown, message: JsonRpcRequest) => Promise<unknown> | unknown;
  onNotification?: (method: string, params: unknown, message: JsonRpcRequest) => Promise<void> | void;
};

export class JsonRpcTimeoutError extends Error {
  readonly method: string;
  readonly timeoutMs: number;

  constructor(method: string, timeoutMs: number) {
    super(`JSON-RPC request timed out: ${method} after ${timeoutMs}ms`);
    this.name = "JsonRpcTimeoutError";
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

export function jsonRpcError(code: number, message: string, data?: JsonObject): JsonRpcErrorObject {
  return { code, message, ...(data ? { data } : {}) };
}

export function providerNotInitializedError(): JsonRpcErrorObject {
  return jsonRpcError(RPC_PROVIDER_NOT_INITIALIZED, "provider-not-initialized", {
    failClass: "health",
    retryable: true,
    detail: "check/evaluate received before initialized grant."
  });
}

export function unsupportedVersionError(detail = "Unsupported protocol version."): JsonRpcErrorObject {
  return jsonRpcError(RPC_UNSUPPORTED_VERSION, "unsupported-version", {
    failClass: "contract",
    detail
  });
}

export function methodNotFoundError(): JsonRpcErrorObject {
  return jsonRpcError(RPC_METHOD_NOT_FOUND, "method-not-found");
}

export function throwRpc(error: JsonRpcErrorObject): never {
  const err = new Error(error.message) as RpcThrowable;
  err.rpcError = error;
  throw err;
}

export class JsonRpcPeer {
  readonly input: Readable;
  readonly output: Writable;
  readonly onRequest: NonNullable<JsonRpcPeerOptions["onRequest"]>;
  readonly onNotification: NonNullable<JsonRpcPeerOptions["onNotification"]>;
  nextId = 1;
  pending = new Map<string | number, JsonRpcPending>();
  buffer = "";
  started = false;

  constructor({ input, output, onRequest, onNotification }: JsonRpcPeerOptions) {
    this.input = input;
    this.output = output;
    this.onRequest =
      onRequest ??
      (async () => {
        throwRpc(methodNotFoundError());
      });
    this.onNotification = onNotification ?? (async () => {});
  }

  start(): this {
    if (this.started) return this;
    this.started = true;
    this.input.setEncoding("utf8");
    this.input.on("data", (chunk: string | Uint8Array) => this.onData(chunk));
    this.input.on("close", () => this.closePending(new Error("JSON-RPC peer closed")));
    this.input.on("error", (error: Error) => this.closePending(error));
    return this;
  }

  request(method: string, params: unknown = {}, { timeoutMs = 30000 }: { timeoutMs?: number } = {}): Promise<unknown> {
    const id = this.nextId++;
    this.write({ jsonrpc: JSON_RPC_VERSION, id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new JsonRpcTimeoutError(method, timeoutMs));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  }

  notify(method: string, params: unknown = {}): void {
    this.write({ jsonrpc: JSON_RPC_VERSION, method, params });
  }

  private onData(chunk: string | Uint8Array): void {
    this.buffer += String(chunk);
    while (this.buffer.includes("\n")) {
      const index = this.buffer.indexOf("\n");
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line.length === 0) continue;
      this.handleLine(line).catch((error: unknown) => {
        this.closePending(error instanceof Error ? error : new Error(String(error)));
      });
    }
  }

  private async handleLine(line: string): Promise<void> {
    let message: JsonRpcRequest & { result?: unknown; error?: JsonRpcErrorObject };
    try {
      message = JSON.parse(line) as JsonRpcRequest & { result?: unknown; error?: JsonRpcErrorObject };
    } catch (error) {
      this.write({
        jsonrpc: JSON_RPC_VERSION,
        id: null,
        error: jsonRpcError(-32700, "parse-error", {
          failClass: "contract",
          detail: error instanceof Error ? error.message : String(error)
        })
      });
      return;
    }
    if (this.handleResponse(message)) return;
    if (message.method && Object.prototype.hasOwnProperty.call(message, "id")) {
      await this.handleRequest(message);
      return;
    }
    if (message.method) await this.onNotification(message.method, message.params ?? {}, message);
  }

  private handleResponse(message: JsonRpcRequest & { result?: unknown; error?: JsonRpcErrorObject }): boolean {
    if (!isResponseMessage(message)) return false;
    const id = message.id as string | number;
    const pending = this.pending.get(id);
    if (pending === undefined) return true;
    this.pending.delete(id);
    if (message.error) {
      const error = new Error(message.error.message) as RpcThrowable;
      error.rpc = message.error;
      pending.reject(error);
    } else {
      pending.resolve(message.result);
    }
    return true;
  }

  private async handleRequest(message: JsonRpcRequest): Promise<void> {
    try {
      const result = await this.onRequest(message.method, message.params ?? {}, message);
      this.write({ jsonrpc: JSON_RPC_VERSION, id: message.id, result });
    } catch (error) {
      this.write({ jsonrpc: JSON_RPC_VERSION, id: message.id, error: rpcErrorFromThrown(error) });
    }
  }

  private write(message: Record<string, unknown>): void {
    this.output.write(`${JSON.stringify(message)}\n`);
  }

  private closePending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

function rpcErrorFromThrown(error: unknown): JsonRpcErrorObject {
  const thrown = error as Partial<RpcThrowable> | null | undefined;
  if (thrown?.rpcError) return thrown.rpcError;
  if (thrown?.rpc) return thrown.rpc;
  return jsonRpcError(-32603, "internal-error", {
    failClass: "health",
    detail: error instanceof Error ? error.message : String(error)
  });
}

function isResponseMessage(message: JsonRpcRequest & { result?: unknown; error?: JsonRpcErrorObject }): boolean {
  return (
    Object.prototype.hasOwnProperty.call(message, "id") &&
    (Object.prototype.hasOwnProperty.call(message, "result") || Object.prototype.hasOwnProperty.call(message, "error")) &&
    !message.method
  );
}
