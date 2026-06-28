declare module "node:child_process" {
  export interface SpawnSyncReturns<T> {
    status: number | null;
    stdout: T;
    stderr: T;
    error?: Error;
  }

  export function spawnSync(
    command: string,
    args?: readonly string[],
    options?: {
      cwd?: string;
      env?: Record<string, string | undefined>;
      encoding?: BufferEncoding;
      stdio?: "ignore" | "pipe" | readonly unknown[];
    }
  ): SpawnSyncReturns<string>;
}
