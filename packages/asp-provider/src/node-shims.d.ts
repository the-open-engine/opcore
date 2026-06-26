declare module "node:crypto" {
  export function createHash(algorithm: string): {
    update(data: string | Uint8Array, inputEncoding?: BufferEncoding): { digest(encoding: "hex"): string };
    digest(encoding: "hex"): string;
  };
}

declare module "node:fs" {
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string): Uint8Array;
  export function realpathSync(path: string): string;
  export function statSync(path: string): { isFile(): boolean };
}

declare module "node:fs/promises" {
  export function readFile(path: string, encoding: "utf8"): Promise<string>;
  export function chmod(path: string, mode: number): Promise<void>;
  export function mkdir(path: string, options: { recursive: true }): Promise<void>;
  export function writeFile(path: string, data: string): Promise<void>;
}

declare module "node:path" {
  export function dirname(path: string): string;
  export function join(...paths: string[]): string;
  export function resolve(...paths: string[]): string;
}

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
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

type BufferEncoding = "utf8" | "base64";

declare const Buffer: {
  from(value: string, encoding?: BufferEncoding): { toString(encoding: "utf8"): string };
};

declare const process: {
  argv: string[];
  cwd(): string;
  exitCode?: number;
  stdin: import("node:stream").Readable;
  stdout: import("node:stream").Writable;
  stderr: import("node:stream").Writable & { write(chunk: string): unknown };
};
