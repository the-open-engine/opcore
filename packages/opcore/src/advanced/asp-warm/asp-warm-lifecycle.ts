import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface AspWarmLifecycle {
  acquire(options: AspWarmAcquireOptions): AspWarmAcquireResult;
  touch(method?: string): void;
  shouldShutdownForIdle(): boolean;
  shutdown(reason: string): void;
  state(): AspWarmLifecycleState;
}

export interface AspWarmLifecycleOptions {
  repoRoot: string;
  pid?: number;
  now?: () => number;
  isProcessAlive?: (pid: number) => boolean;
}

export interface AspWarmAcquireOptions {
  idleTimeoutMs: number;
}

export type AspWarmAcquireResult =
  | { ok: true; state: AspWarmLifecycleState }
  | { ok: false; reason: "singleton_active"; state: AspWarmLifecycleState };

export interface AspWarmLifecycleState {
  schemaVersion: 1;
  state: "running" | "shutdown";
  sessionId: string;
  repoRoot: string;
  pid: number;
  startedAt: number;
  lastActiveAt: number;
  idleTimeoutMs: number;
  method?: string;
  reason?: string;
}

declare const process: {
  pid: number;
  kill(pid: number, signal: 0): boolean;
};

export function createAspWarmLifecycle(options: AspWarmLifecycleOptions): AspWarmLifecycle {
  return new DefaultAspWarmLifecycle(options);
}

class DefaultAspWarmLifecycle implements AspWarmLifecycle {
  private readonly repoRoot: string;
  private readonly statePath: string;
  private readonly pid: number;
  private readonly now: () => number;
  private readonly isProcessAlive: (pid: number) => boolean;
  private current: AspWarmLifecycleState | undefined;

  constructor(options: AspWarmLifecycleOptions) {
    this.repoRoot = resolve(options.repoRoot);
    this.statePath = join(this.repoRoot, ".lattice/asp/session.json");
    this.pid = options.pid ?? process.pid;
    this.now = options.now ?? (() => Date.now());
    this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  }

  acquire(options: AspWarmAcquireOptions): AspWarmAcquireResult {
    const existing = this.readState();
    if (existing?.state === "running" && existing.pid !== this.pid && this.isProcessAlive(existing.pid)) {
      this.current = existing;
      return { ok: false, reason: "singleton_active", state: existing };
    }
    const now = this.now();
    this.current = {
      schemaVersion: 1,
      state: "running",
      sessionId: `${this.pid}-${now}`,
      repoRoot: this.repoRoot,
      pid: this.pid,
      startedAt: existing?.pid === this.pid && existing.state === "running" ? existing.startedAt : now,
      lastActiveAt: now,
      idleTimeoutMs: options.idleTimeoutMs
    };
    this.writeState(this.current);
    return { ok: true, state: this.current };
  }

  touch(method?: string): void {
    const current = this.state();
    if (current.state !== "running") return;
    this.current = {
      ...current,
      lastActiveAt: this.now(),
      ...(method ? { method } : {})
    };
    this.writeState(this.current);
  }

  shouldShutdownForIdle(): boolean {
    const current = this.state();
    return current.state === "running" && this.now() - current.lastActiveAt >= current.idleTimeoutMs;
  }

  shutdown(reason: string): void {
    const current = this.state();
    this.current = {
      ...current,
      state: "shutdown",
      lastActiveAt: this.now(),
      reason
    };
    this.writeState(this.current);
  }

  state(): AspWarmLifecycleState {
    return this.current ?? this.readState() ?? {
      schemaVersion: 1,
      state: "shutdown",
      sessionId: `${this.pid}-unacquired`,
      repoRoot: this.repoRoot,
      pid: this.pid,
      startedAt: this.now(),
      lastActiveAt: this.now(),
      idleTimeoutMs: 0,
      reason: "not-acquired"
    };
  }

  private readState(): AspWarmLifecycleState | undefined {
    if (!existsSync(this.statePath)) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, "utf8")) as Partial<AspWarmLifecycleState>;
      if (parsed.schemaVersion !== 1 || typeof parsed.pid !== "number" || typeof parsed.sessionId !== "string") return undefined;
      if (parsed.state !== "running" && parsed.state !== "shutdown") return undefined;
      return parsed as AspWarmLifecycleState;
    } catch {
      return undefined;
    }
  }

  private writeState(state: AspWarmLifecycleState): void {
    mkdirSync(join(this.repoRoot, ".lattice/asp"), { recursive: true });
    writeFileSync(this.statePath, `${JSON.stringify(state, null, 2)}\n`);
  }
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
