import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  ASP_PROTOCOL_VERSION,
  OPCORE_PROVIDER_ID,
  OPCORE_PROVIDER_PACKAGE,
  OPCORE_PROVIDER_VERSION
} from "./protocol.js";
import { defaultAspProviderValidationCheckIds } from "./validation-composition.js";

export type OpcoreAspServerManifest = {
  $schema: "https://covibes.dev/asp/schemas/server-manifest.schema.json";
  manifestVersion: "asp-server/0.1";
  server: {
    id: typeof OPCORE_PROVIDER_ID;
    name: "Opcore";
    version: typeof OPCORE_PROVIDER_VERSION;
  };
  protocolVersions: readonly [typeof ASP_PROTOCOL_VERSION];
  capabilities: readonly ["check"];
  entrypoint: {
    transport: "stdio";
    bin: "opcore-asp-provider";
    args: readonly ["--stdio"];
  };
  artifact: {
    fingerprint: string;
    checksums: readonly [
      {
        path: "dist/index.js";
        sha256: string;
      }
    ];
  };
  provenance: {
    publisher: "The Open Engine";
    source: "https://github.com/the-open-engine/opcore";
    license: "MIT";
  };
  accessExpectations: {
    filesystem: {
      read: readonly ["**/*"];
      write: readonly [];
    };
    network: {
      outbound: false;
      allowlist: readonly [];
    };
    secrets: {
      names: readonly [];
    };
    environment: {
      inherit: false;
      variables: readonly [];
    };
    dataClasses: readonly ["source-code"];
  };
};

export type OpcoreAspProviderManifest = {
  schemaVersion: 1;
  kind: "opcore-asp-provider-provisional-manifest";
  provisional: true;
  providerId: string;
  version: string;
  packageName: string;
  protocolVersion: string;
  capabilityFamilies: readonly ["check"];
  checks: readonly string[];
  executable: {
    packageName: string;
    bin: "opcore-asp-provider";
    args: readonly ["--stdio"];
  };
  permissions: {
    read: readonly ["**/*"];
    write: false;
    network: false;
  };
  checksums: {
    "dist/index.js": {
      algorithm: "sha256";
      sha256: string;
    };
  };
  noAuthority: true;
  noTrust: true;
  noGateGrant: true;
  note: string;
};

export function createOpcoreAspProviderManifest(options: { packageRoot?: string; indexSha256?: string } = {}): OpcoreAspProviderManifest {
  const indexSha256 = resolveIndexSha256(options);
  return {
    schemaVersion: 1,
    kind: "opcore-asp-provider-provisional-manifest",
    provisional: true,
    providerId: OPCORE_PROVIDER_ID,
    version: OPCORE_PROVIDER_VERSION,
    packageName: OPCORE_PROVIDER_PACKAGE,
    protocolVersion: ASP_PROTOCOL_VERSION,
    capabilityFamilies: ["check"],
    checks: defaultAspProviderValidationCheckIds,
    executable: {
      packageName: OPCORE_PROVIDER_PACKAGE,
      bin: "opcore-asp-provider",
      args: ["--stdio"]
    },
    permissions: {
      read: ["**/*"],
      write: false,
      network: false
    },
    checksums: {
      "dist/index.js": {
        algorithm: "sha256",
        sha256: indexSha256
      }
    },
    noAuthority: true,
    noTrust: true,
    noGateGrant: true,
    note: "Install metadata only. This manifest does not grant authority, trust, policy gate permission, or host apply permission."
  };
}

export function createOpcoreAspServerManifest(options: { packageRoot?: string; indexSha256?: string } = {}): OpcoreAspServerManifest {
  const indexSha256 = resolveIndexSha256(options);
  return {
    $schema: "https://covibes.dev/asp/schemas/server-manifest.schema.json",
    manifestVersion: "asp-server/0.1",
    server: {
      id: OPCORE_PROVIDER_ID,
      name: "Opcore",
      version: OPCORE_PROVIDER_VERSION
    },
    protocolVersions: [ASP_PROTOCOL_VERSION],
    capabilities: ["check"],
    entrypoint: {
      transport: "stdio",
      bin: "opcore-asp-provider",
      args: ["--stdio"]
    },
    artifact: {
      fingerprint: `sha256:${indexSha256}`,
      checksums: [
        {
          path: "dist/index.js",
          sha256: indexSha256
        }
      ]
    },
    provenance: {
      publisher: "The Open Engine",
      source: "https://github.com/the-open-engine/opcore",
      license: "MIT"
    },
    accessExpectations: {
      filesystem: {
        read: ["**/*"],
        write: []
      },
      network: {
        outbound: false,
        allowlist: []
      },
      secrets: {
        names: []
      },
      environment: {
        inherit: false,
        variables: []
      },
      dataClasses: ["source-code"]
    }
  };
}

function resolveIndexSha256(options: { packageRoot?: string; indexSha256?: string }): string {
  const packageRoot = options.packageRoot ?? process.cwd();
  return options.indexSha256 ?? sha256File(join(packageRoot, "dist/index.js"));
}

function sha256File(path: string): string {
  if (!existsSync(path)) throw new Error(`Missing checksum target: ${path}`);
  if (!statSync(path).isFile()) throw new Error(`Checksum target is not a file: ${path}`);
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
