declare module "node:child_process" {
  import type { Readable, Writable } from "node:stream";

  export interface SpawnSyncReturns {
    status: number | null;
    stdout: string;
    stderr: string;
    error?: Error;
  }
  export interface ChildProcessWithoutNullStreams {
    pid?: number;
    stdin: Writable;
    stdout: Readable;
    stderr: Readable;
    kill(signal?: string): boolean;
    unref(): void;
    on(event: "error", listener: (error: Error) => void): this;
    on(event: "exit" | "close", listener: (code: number | null, signal: string | null) => void): this;
  }
  export function spawnSync(
    command: string,
    args?: readonly string[],
    options?: {
      cwd?: string;
      encoding?: string;
      input?: string;
      stdio?: readonly (string | number)[];
      timeout?: number;
    }
  ): SpawnSyncReturns;
  export function spawn(
    command: string,
    args?: readonly string[],
    options?: {
      detached?: boolean;
      stdio?: "ignore" | readonly string[];
    }
  ): ChildProcessWithoutNullStreams;
}

declare module "node:stream" {
  export interface Readable {
    on(event: "data", listener: (chunk: { toString(encoding?: string): string } | string) => void): this;
    on(event: "end", listener: () => void): this;
    on(event: "error", listener: (error: Error) => void): this;
  }
  export interface Writable {
    write(chunk: string): boolean;
    end(): void;
    on(event: "error", listener: (error: Error) => void): this;
  }
}

declare module "node:crypto" {
  export function createHash(algorithm: string): {
    update(data: string | Uint8Array): {
      digest(encoding: "hex"): string;
    };
  };
}

declare module "node:fs" {
  export function closeSync(fd: number): void;
  export function existsSync(path: string): boolean;
  export function mkdtempSync(prefix: string): string;
  export function openSync(path: string, flags: string): number;
  export function readFileSync(path: string): Uint8Array;
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:module" {
  export function createRequire(url: string): {
    resolve(specifier: string): string;
  };
}

declare module "node:path" {
  export function dirname(path: string): string;
  export function isAbsolute(path: string): boolean;
  export function join(...parts: string[]): string;
  export function normalize(path: string): string;
  export function resolve(...parts: string[]): string;
}

declare module "node:url" {
  export function fileURLToPath(url: string): string;
}
