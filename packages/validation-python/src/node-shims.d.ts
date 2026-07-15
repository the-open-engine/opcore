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

declare module "node:crypto" {
  interface Hash {
    update(data: string, inputEncoding?: BufferEncoding): Hash;
    digest(encoding: "hex"): string;
  }
  export function createHash(algorithm: string): Hash;
}

declare module "node:fs" {
  export function existsSync(path: string): boolean;
  export function realpathSync(path: string): string;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function mkdtempSync(prefix: string): string;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  export function writeFileSync(path: string, data: string): void;
}

declare module "node:fs/promises" {
  export function access(path: string): Promise<void>;
  export function copyFile(source: string, destination: string): Promise<void>;
  export function lstat(path: string): Promise<{ isFile(): boolean; isSymbolicLink(): boolean }>;
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  export function readFile(path: string, encoding: "utf8"): Promise<string>;
  export function readdir(path: string, options: { recursive: true }): Promise<readonly string[]>;
  export function realpath(path: string): Promise<string>;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:path" {
  export const delimiter: string;
  export function dirname(path: string): string;
  export function join(...paths: string[]): string;
  export function isAbsolute(path: string): boolean;
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
  platform: string;
};
