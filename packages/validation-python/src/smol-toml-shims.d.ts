declare module "smol-toml" {
  export type TomlTable = Record<string, unknown>;

  export interface ParseOptions {
    maxDepth?: number;
    integersAsBigInt?: boolean | "bigint";
  }

  export function parse(toml: string, options?: ParseOptions): TomlTable;
  export function stringify(table: TomlTable): string;
}
