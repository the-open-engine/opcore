declare module "node:fs" {
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string, encoding: "utf8"): string;
}

declare module "node:module" {
  export function createRequire(path: string): (specifier: string) => unknown;
}

declare module "node:path" {
  export function isAbsolute(path: string): boolean;
  export function join(...paths: string[]): string;
  export function resolve(...paths: string[]): string;
}
