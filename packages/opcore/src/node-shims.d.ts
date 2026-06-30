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
      env?: Record<string, string | undefined>;
      encoding?: "utf8";
      input?: string;
      stdio?: readonly ("ignore" | "pipe" | number)[];
      timeout?: number;
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
    isSymbolicLink(): boolean;
  }

  export function appendFileSync(path: string, data: string): void;
  export function chmodSync(path: string, mode: number): void;
  export function closeSync(fd: number): void;
  export function existsSync(path: string): boolean;
  export function lstatSync(path: string): Stats;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function mkdtempSync(prefix: string): string;
  export function openSync(path: string, flags: string): number;
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function realpathSync(path: string): string;
  export function readdirSync(path: string): string[];
  export function readdirSync(path: string, options: { withFileTypes: true }): Dirent[];
  export function renameSync(oldPath: string, newPath: string): void;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  export function statSync(path: string): Stats;
  export function writeFileSync(path: string, data: string, encoding?: "utf8"): void;
}

declare module "node:fs/promises" {
  import type { Dirent } from "node:fs";

  export function appendFile(path: string, data: string): Promise<void>;
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  export function readFile(path: string, encoding: "utf8"): Promise<string>;
  export function readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>;
  export function writeFile(path: string, data: string): Promise<void>;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:readline/promises" {
  export interface Interface {
    question(query: string): Promise<string>;
    close(): void;
  }

  export function createInterface(options: { input: unknown; output: unknown }): Interface;
}

declare module "node:module" {
  export function createRequire(url: string): {
    (specifier: string): unknown;
    resolve(specifier: string): string;
  };
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

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
}
