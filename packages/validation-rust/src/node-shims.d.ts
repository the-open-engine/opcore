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
  export function cpSync(
    source: string,
    destination: string,
    options?: {
      recursive?: boolean;
      force?: boolean;
      errorOnExist?: boolean;
      filter?: (source: string, destination: string) => boolean;
    }
  ): void;
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function mkdtempSync(prefix: string): string;
  export function realpathSync(path: string): string;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  export function statSync(path: string): { isDirectory(): boolean; isFile(): boolean };
  export function unlinkSync(path: string): void;
  export function writeFileSync(path: string, data: string): void;
}

declare module "node:fs/promises" {
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  export function rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  export function unlink(path: string): Promise<void>;
  export function writeFile(path: string, data: string): Promise<void>;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:path" {
  export function basename(path: string): string;
  export function dirname(path: string): string;
  export function isAbsolute(path: string): boolean;
  export function join(...paths: string[]): string;
  export function relative(from: string, to: string): string;
  export function resolve(...paths: string[]): string;
  export const sep: string;
}

type BufferEncoding = "utf8";

declare const Buffer: {
  from(input: string | Uint8Array): Buffer;
};

interface Buffer {
  toString(encoding?: BufferEncoding): string;
}

declare const process: {
  env: Record<string, string | undefined>;
  platform: string;
  arch: string;
};
