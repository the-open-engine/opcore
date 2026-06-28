import type { Readable, Writable } from "node:stream";
import { JsonRpcPeer } from "@the-open-engine/opcore-asp-provider";
import { createAspWarmLifecycle, type AspWarmLifecycle } from "./asp-warm-lifecycle.js";
import { AspWarmMethods } from "./asp-warm-methods.js";
import { createWarmProjectRegistry, type WarmProjectRegistry } from "./warm-project-registry.js";

export interface AspWarmServerOptions {
  repoRoot: string;
  input: Readable;
  output: Writable;
  lifecycle?: AspWarmLifecycle;
  registry?: WarmProjectRegistry;
  idleTimeoutMs: number;
  onShutdown?: (reason: string) => void;
}

export function runAspWarmServer(options: AspWarmServerOptions): JsonRpcPeer {
  const lifecycle = options.lifecycle ?? createAspWarmLifecycle({ repoRoot: options.repoRoot });
  const registry = options.registry ?? createWarmProjectRegistry({ repoRoot: options.repoRoot });
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let methods: AspWarmMethods;
  const scheduleIdleShutdown = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!lifecycle.shouldShutdownForIdle()) {
        scheduleIdleShutdown();
        return;
      }
      lifecycle.shutdown("idle-timeout");
      options.onShutdown?.("idle-timeout");
    }, Math.max(1, options.idleTimeoutMs));
  };
  const peer = new JsonRpcPeer({
    input: options.input,
    output: options.output,
    onRequest: async (method, params) => {
      lifecycle.touch(method);
      const result = await methods.onRequest(method, params);
      if (method !== "session/shutdown") scheduleIdleShutdown();
      return result;
    },
    onNotification: (method, params) => methods.onNotification(method, params)
  });
  methods = new AspWarmMethods({
    peer,
    repoRoot: options.repoRoot,
    registry,
    lifecycle,
    requestShutdown: (reason) => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      setTimeout(() => options.onShutdown?.(reason), 0);
    }
  });
  scheduleIdleShutdown();
  return peer.start();
}
