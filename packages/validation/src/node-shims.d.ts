declare module "node:crypto" {
  export function createHash(algorithm: string): {
    update(data: string | Uint8Array, inputEncoding?: string): {
      digest(encoding: "hex"): string;
    };
  };
}

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

declare module "node:fs/promises" {
  export function readFile(path: string, encoding: "utf8"): Promise<string>;
}

declare module "node:fs" {
  export interface Dirent {
    name: string;
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }
  export function readdirSync(path: string, options: { withFileTypes: true }): Dirent[];
}

declare module "node:path" {
  export const sep: string;
  export function relative(from: string, to: string): string;
  export function resolve(...parts: string[]): string;
}
