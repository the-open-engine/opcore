declare module "node:child_process" {
  export interface SpawnSyncReturns<T> {
    status: number | null;
    signal: string | null;
    error?: Error;
    stdout: T;
    stderr: T;
  }
  export function spawnSync(
    command: string,
    args?: readonly string[],
    options?: {
      cwd?: string;
      env?: Record<string, string | undefined>;
      encoding?: BufferEncoding;
      input?: string | Buffer;
      maxBuffer?: number;
      stdio?: readonly unknown[] | string;
      timeout?: number;
    }
  ): SpawnSyncReturns<string>;
}

declare module "node:fs" {
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function mkdtempSync(prefix: string): string;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  export function writeFileSync(path: string, data: string): void;
}

declare module "node:fs/promises" {
  export function copyFile(source: string, destination: string): Promise<void>;
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:path" {
  export function dirname(path: string): string;
  export function join(...paths: string[]): string;
  export function relative(from: string, to: string): string;
  export function resolve(...paths: string[]): string;
  export const sep: string;
}

type BufferEncoding = "utf8";

interface Buffer {
  toString(encoding?: BufferEncoding): string;
}

declare const process: {
  env: Record<string, string | undefined>;
  cwd(): string;
};
