import type { CommandOwner } from "./vocabulary.js";

interface CommandExitSemantics {
  ok: 0;
  error: 1;
  notImplemented: 2;
  unsupported: 64;
  jsonStable: boolean;
}

export type { CommandExitSemantics };

interface CommandGroupContract {
  name: string;
  owner: CommandOwner;
  canonicalCommand: readonly string[];
  commands: readonly string[];
  summary: string;
}

export type { CommandGroupContract };

interface CommandRouterManifest {
  schemaVersion: 1;
  packageName: "opcore" | (string & {});
  bins: readonly string[];
  exitSemantics: CommandExitSemantics;
  ownershipBoundaries: readonly {
    owner: CommandOwner;
    summary: string;
  }[];
  commandGroups: readonly CommandGroupContract[];
}

export type { CommandRouterManifest };
