declare module "node:fs" {
  export function existsSync(path: string): boolean;
  export function readdirSync(path: string, options?: { withFileTypes?: false }): string[];
  export function realpathSync(path: string): string;
  export function statSync(path: string): {
    isDirectory(): boolean;
    isFile(): boolean;
    mtimeMs: number;
  };
}

declare module "node:module" {
  interface NodeRequire {
    (specifier: string): unknown;
    resolve(specifier: string): string;
    cache: Record<string, unknown>;
  }

  export function createRequire(path: string): NodeRequire;
}

declare module "node:path" {
  export function isAbsolute(path: string): boolean;
  export function join(...paths: string[]): string;
  export function relative(from: string, to: string): string;
  export function resolve(...paths: string[]): string;
}
