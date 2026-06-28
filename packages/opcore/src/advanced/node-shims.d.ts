declare module "node:child_process" {
  export interface SpawnSyncReturns {
    status: number | null;
    stdout: string;
    stderr: string;
    error?: Error;
  }

  export function spawnSync(
    command: string,
    args?: readonly string[],
    options?: {
      cwd?: string;
      encoding?: "utf8";
      stdio?: readonly ("ignore" | "pipe")[];
    }
  ): SpawnSyncReturns;
}

declare module "node:fs" {
  export interface Dirent {
    name: string;
    isDirectory(): boolean;
    isFile(): boolean;
  }

  export interface Stats {
    size: number;
    isDirectory(): boolean;
    isFile(): boolean;
  }

  export function existsSync(path: string): boolean;
  export function appendFileSync(path: string, data: string): void;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function realpathSync(path: string): string;
  export function readdirSync(path: string, options: { withFileTypes: true }): Dirent[];
  export function renameSync(oldPath: string, newPath: string): void;
  export function statSync(path: string): Stats;
  export function writeFileSync(path: string, data: string): void;
}

declare module "node:path" {
  export function basename(path: string): string;
  export function dirname(path: string): string;
  export function extname(path: string): string;
  export function isAbsolute(path: string): boolean;
  export function join(...parts: string[]): string;
  export function relative(from: string, to: string): string;
  export function resolve(...parts: string[]): string;
  export const sep: string;
}

declare module "node:stream" {
  export class Readable {
    setEncoding(encoding: string): void;
    on(event: "data", listener: (chunk: string | Uint8Array) => void): this;
    on(event: "close", listener: () => void): this;
    on(event: "error", listener: (error: Error) => void): this;
  }

  export class Writable {
    write(chunk: string): unknown;
  }
}
