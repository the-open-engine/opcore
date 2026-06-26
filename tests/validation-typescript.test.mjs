import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createValidationCheckRegistry, createValidationRunner } from "../packages/validation/dist/index.js";
import {
  TYPE_SCRIPT_DEAD_CODE_CHECK_ID,
  TYPE_SCRIPT_IMPORT_GRAPH_CHECK_ID,
  TYPE_SCRIPT_RELEVANT_TESTS_CHECK_ID,
  TYPE_SCRIPT_SYNTAX_CHECK_ID,
  TYPE_SCRIPT_TYPES_CHECK_ID,
  createTypeScriptValidationChecks,
  validationTypeScriptAdapterName
} from "../packages/validation-typescript/dist/index.js";

describe("validation-typescript adapter", () => {
  it("exports stable public check definitions", () => {
    const checks = createTypeScriptValidationChecks();
    const registry = createValidationCheckRegistry(checks);

    assert.equal(validationTypeScriptAdapterName, "typescript");
    assert.deepEqual(
      checks.map((check) => check.id),
      [
        TYPE_SCRIPT_SYNTAX_CHECK_ID,
        TYPE_SCRIPT_TYPES_CHECK_ID,
        TYPE_SCRIPT_IMPORT_GRAPH_CHECK_ID,
        TYPE_SCRIPT_DEAD_CODE_CHECK_ID,
        TYPE_SCRIPT_RELEVANT_TESTS_CHECK_ID
      ]
    );
    assert.equal(registry.byId.get(TYPE_SCRIPT_SYNTAX_CHECK_ID)?.requiresGraph, false);
    assert.equal(registry.byId.get(TYPE_SCRIPT_IMPORT_GRAPH_CHECK_ID)?.requiresGraph, true);
  });

  it("reports syntax diagnostics from overlay after-state content", async () => {
    const result = await runner({
      files: {
        "src/index.ts": "export const value = 1;"
      }
    }).runValidation(
      request({
        checks: [TYPE_SCRIPT_SYNTAX_CHECK_ID],
        overlays: [
          {
            path: "src/index.ts",
            action: "write",
            content: "export const value = ;"
          }
        ]
      })
    );

    assert.equal(result.status, "policy_failure");
    assert.equal(result.diagnostics[0].category, "syntax");
    assert.equal(result.diagnostics[0].severity, "error");
    assert.equal(result.diagnostics[0].path, "src/index.ts");
    assert.match(result.diagnostics[0].code, /^\d+$/);
  });

  it("reports type diagnostics from overlay after-state content", async () => {
    const result = await runner({
      files: {
        "src/index.ts": "export const value = 1;"
      }
    }).runValidation(
      request({
        checks: [TYPE_SCRIPT_TYPES_CHECK_ID],
        overlays: [
          {
            path: "src/index.ts",
            action: "write",
            content: "export const value: string = 1;"
          }
        ]
      })
    );

    assert.equal(result.status, "policy_failure");
    assert.equal(result.diagnostics[0].category, "types");
    assert.equal(result.diagnostics[0].path, "src/index.ts");
    assert.equal(result.diagnostics[0].code, "2322");
  });

  it("resolves imported repo files through fileView instead of stale disk content", async () => {
    const result = await runner({
      files: {
        "src/index.ts": "import { value } from './dep';\nconst label: string = value;\nexport { label };\n",
        "src/dep.ts": "export const value = 'disk';"
      }
    }).runValidation(
      request({
        checks: [TYPE_SCRIPT_TYPES_CHECK_ID],
        overlays: [
          {
            path: "src/dep.ts",
            action: "write",
            content: "export const value = 1;"
          }
        ]
      })
    );

    assert.equal(result.status, "policy_failure");
    assert.equal(result.diagnostics[0].category, "types");
    assert.equal(result.diagnostics[0].path, "src/index.ts");
    assert.equal(result.diagnostics[0].code, "2322");
  });

  it("prefers TypeScript extension substitution for explicit js imports", async () => {
    const result = await runner({
      files: {
        "src/index.ts": "import { value } from './dep.js';\nconst label: string = value;\nexport { label };\n",
        "src/dep.ts": "export const value = 1;\n",
        "src/dep.js": "export const value = 'stale-js';\n"
      }
    }).runValidation(
      request({
        checks: [TYPE_SCRIPT_TYPES_CHECK_ID]
      })
    );

    assert.equal(result.status, "policy_failure", JSON.stringify(result.diagnostics, null, 2));
    assert.equal(result.diagnostics[0].category, "types");
    assert.equal(result.diagnostics[0].path, "src/index.ts");
    assert.equal(result.diagnostics[0].code, "2322");
  });

  it("resolves tsconfig path-alias imports through fileView", async () => {
    const result = await runner({
      files: {
        "tsconfig.json": JSON.stringify({
          compilerOptions: {
            baseUrl: ".",
            paths: {
              "@/*": ["src/*"]
            }
          }
        }),
        "src/index.ts": "import { value } from '@/dep';\nconst label: string = value;\nexport { label };\n",
        "src/dep.ts": "export const value = 'alias';\n"
      }
    }).runValidation(
      request({
        checks: [TYPE_SCRIPT_TYPES_CHECK_ID]
      })
    );

    assert.equal(result.status, "passed", JSON.stringify(result.diagnostics, null, 2));
  });

  it("resolves JSON module imports through fileView", async () => {
    const result = await runner({
      files: {
        "src/index.ts": "import data from './data.json';\nconst label: string = data.label;\nexport { label };\n",
        "src/data.json": JSON.stringify({ label: "json" })
      }
    }).runValidation(
      request({
        checks: [TYPE_SCRIPT_TYPES_CHECK_ID]
      })
    );

    assert.equal(result.status, "passed", JSON.stringify(result.diagnostics, null, 2));
  });

  it("resolves overlaid JSON module imports through fileView", async () => {
    const result = await runner({
      files: {
        "src/index.ts": "import data from './data.json';\nconst count: number = data.count;\nexport { count };\n",
        "src/data.json": JSON.stringify({ count: "stale" })
      }
    }).runValidation(
      request({
        checks: [TYPE_SCRIPT_TYPES_CHECK_ID],
        overlays: [
          {
            path: "src/data.json",
            action: "write",
            content: JSON.stringify({ count: 1 })
          }
        ]
      })
    );

    assert.equal(result.status, "passed", JSON.stringify(result.diagnostics, null, 2));
  });

  it("resolves package imports through deterministic node_modules resolution", async () => {
    const result = await createValidationRunner({
      workspace: repoWorkspace(),
      checks: createTypeScriptValidationChecks()
    }).runValidation(
      request({
        repo: {
          repoRoot: process.cwd()
        },
        scope: {
          kind: "package",
          packageName: "@the-open-engine/lattice-validation-typescript",
          packageRoot: "packages/validation-typescript"
        },
        checks: [TYPE_SCRIPT_TYPES_CHECK_ID]
      })
    );

    assert.equal(result.status, "passed", JSON.stringify(result.diagnostics, null, 2));
  });

  it("supports package scope file resolution", async () => {
    const result = await runner({
      files: {
        "packages/app/src/index.ts": "export const value = ;",
        "src/outside.ts": "export const value = ;"
      },
      packageFiles: {
        "packages/app": ["packages/app/src/index.ts"]
      }
    }).runValidation(
      request({
        checks: [TYPE_SCRIPT_SYNTAX_CHECK_ID],
        scope: {
          kind: "package",
          packageName: "@covibes/app",
          packageRoot: "packages/app"
        }
      })
    );

    assert.equal(result.status, "policy_failure");
    assert.equal(result.diagnostics[0].path, "packages/app/src/index.ts");
  });

  it("skips graph checks in optional unavailable graph mode while running TypeScript checks", async () => {
    const result = await runner({
      files: {
        "src/index.ts": "export const value = 1;"
      }
    }).runValidation(request({ checks: undefined }));

    assert.equal(result.status, "passed");
    assert.deepEqual(
      result.manifest.runs.map((run) => run.checkId),
      [TYPE_SCRIPT_SYNTAX_CHECK_ID, TYPE_SCRIPT_TYPES_CHECK_ID]
    );
    assert.deepEqual(
      result.manifest.skippedChecks.map((skip) => skip.checkId),
      [TYPE_SCRIPT_IMPORT_GRAPH_CHECK_ID, TYPE_SCRIPT_DEAD_CODE_CHECK_ID, TYPE_SCRIPT_RELEVANT_TESTS_CHECK_ID]
    );
  });

  it("fails closed for required graph provider failure states", async () => {
    for (const status of [
      graphFailure("required_missing", "provider_missing", "required"),
      graphFailure("stale", "stale_snapshot", "required"),
      graphFailure("schema_mismatch", "schema_mismatch", "required"),
      graphFailure("daemon_unavailable", "daemon_unavailable", "required"),
      graphFailure("error", "incompatible_provider", "required"),
      graphFailure("error", "provider_error", "required")
    ]) {
      const result = await runner({
        graphProviderClient: graphClient({
          status: () => status
        })
      }).runValidation(
        request({
          checks: [TYPE_SCRIPT_IMPORT_GRAPH_CHECK_ID],
          graph: {
            mode: "required",
            provider: "lattice-graph"
          }
        })
      );

      assert.equal(result.status, "provider_failure", status.state);
      assert.equal(result.graphStatus.state, status.state);
    }
  });

  it("treats empty graph facts as absent evidence", async () => {
    const result = await runner({
      files: {
        "src/index.ts": "import { value } from './dep';\nexport const label = value;\n",
        "src/dep.ts": "export const value = 1;"
      },
      graphProviderClient: graphClient({
        factQuery: (query) => availableFactResult(query, [], [])
      })
    }).runValidation(
      request({
        checks: [TYPE_SCRIPT_IMPORT_GRAPH_CHECK_ID, TYPE_SCRIPT_DEAD_CODE_CHECK_ID, TYPE_SCRIPT_RELEVANT_TESTS_CHECK_ID]
      })
    );

    assert.equal(result.status, "passed");
    assert.deepEqual(new Set(result.diagnostics.map((diagnostic) => diagnostic.code)), new Set([
      "TS_IMPORT_GRAPH_MISSING_EDGE",
      "TS_DEAD_CODE_UNSUPPORTED",
      "TS_RELEVANT_TESTS_ABSENT"
    ]));
  });

  it("treats empty CALLS rows as zero incoming calls for callable exports when snapshot metadata has no CALLS rows", async () => {
    const result = await runner({
      files: {
        "src/index.ts": "export function value() { return 1; }"
      },
      graphProviderClient: graphClient({
        status: (validationRequest) => ({
          ...availableStatus(validationRequest.graph.mode, validationRequest.repo),
          handshake: graphHandshake()
        }),
        factQuery: (query) =>
          availableFactResult(
            query,
            query.selector.kind === "symbols"
              ? [
                  {
                    id: "function:src/index.ts#value",
                    kind: "Function",
                    path: "src/index.ts",
                    name: "value",
                    attributes: {
                      exported: true
                    }
                  }
                ]
              : [],
            [],
            {
              edgeKinds: []
            }
          )
      })
    }).runValidation(
      request({
        checks: [TYPE_SCRIPT_DEAD_CODE_CHECK_ID]
      })
    );

    assert.equal(result.status, "passed");
    assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), ["TS_DEAD_CODE_UNUSED_EXPORT"]);
  });

  it("reports unsupported dead-code coverage when the provider capability handshake omits CALLS", async () => {
    const result = await runner({
      files: {
        "src/index.ts": "export const value = 1;"
      },
      graphProviderClient: graphClient({
        status: (validationRequest) => ({
          ...availableStatus(validationRequest.graph.mode, validationRequest.repo),
          handshake: graphHandshake({
            edgeKinds: ["CONTAINS", "IMPORTS_FROM", "TESTED_BY"]
          })
        }),
        factQuery: (query) =>
          availableFactResult(
            query,
            query.selector.kind === "symbols"
              ? [
                  {
                    id: "variable:src/index.ts#value",
                    kind: "Variable",
                    path: "src/index.ts",
                    name: "value",
                    attributes: {
                      exported: true
                    }
                  }
                ]
              : [],
            []
          )
      })
    }).runValidation(
      request({
        checks: [TYPE_SCRIPT_DEAD_CODE_CHECK_ID]
      })
    );

    assert.equal(result.status, "passed");
    assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), ["TS_DEAD_CODE_UNSUPPORTED"]);
  });

  it("treats scoped non-exported symbol metadata as zero dead exports, not unsupported coverage", async () => {
    const result = await runner({
      files: {
        "src/index.ts": "const value = 1;"
      },
      graphProviderClient: graphClient({
        factQuery: (query) =>
          availableFactResult(
            query,
            query.selector.kind === "symbols"
              ? [
                  {
                    id: "variable:src/index.ts#value",
                    kind: "Variable",
                    path: "src/index.ts",
                    name: "value",
                    attributes: {
                      exported: false
                    }
                  }
                ]
              : [],
            []
          )
      })
    }).runValidation(
      request({
        checks: [TYPE_SCRIPT_DEAD_CODE_CHECK_ID]
      })
    );

    assert.equal(result.status, "passed");
    assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), []);
  });

  it("reports unsupported dead-code coverage for exported variables without reference usage edges", async () => {
    const result = await runner({
      files: {
        "src/index.ts": "export const value = 1;"
      },
      graphProviderClient: graphClient({
        factQuery: (query) =>
          availableFactResult(
            query,
            query.selector.kind === "symbols"
              ? [
                  {
                    id: "variable:src/index.ts#value",
                    kind: "Variable",
                    path: "src/index.ts",
                    name: "value",
                    attributes: {
                      exported: true,
                      exportKind: "named",
                      exportName: "value"
                    }
                  }
                ]
              : [],
            []
          )
      })
    }).runValidation(
      request({
        checks: [TYPE_SCRIPT_DEAD_CODE_CHECK_ID]
      })
    );

    assert.equal(result.status, "passed");
    assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), ["TS_DEAD_CODE_UNSUPPORTED"]);
  });

  it("reports exported callable symbols without incoming CALLS as unused exports", async () => {
    const result = await runner({
      files: {
        "src/index.ts": "export function value() { return 1; }"
      },
      graphProviderClient: graphClient({
        factQuery: (query) =>
          availableFactResult(
            query,
            query.selector.kind === "symbols"
              ? [
                  {
                    id: "function:src/index.ts#value",
                    kind: "Function",
                    path: "src/index.ts",
                    name: "value",
                    attributes: {
                      exported: true,
                      exportKind: "named",
                      exportName: "value"
                    }
                  }
                ]
              : [],
            []
          )
      })
    }).runValidation(
      request({
        checks: [TYPE_SCRIPT_DEAD_CODE_CHECK_ID]
      })
    );

    assert.equal(result.status, "passed");
    assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), ["TS_DEAD_CODE_UNUSED_EXPORT"]);
  });

  it("reports unsupported coverage, not unused exports, for real graph-provider type-only exports", () => {
    const repo = mkdtempSync(join(tmpdir(), "lattice-dead-code-real-provider-"));
    try {
      mkdirSync(join(repo, "src"), { recursive: true });
      writeFileSync(
        join(repo, "tsconfig.json"),
        `${JSON.stringify(
          {
            compilerOptions: {
              target: "ES2022",
              module: "ESNext",
              moduleResolution: "Bundler",
              strict: true
            },
            include: ["src/**/*.ts"]
          },
          null,
          2
        )}\n`
      );
      writeFileSync(
        join(repo, "src/types.ts"),
        "export interface Shape { width: number; }\nexport type Payload = Shape & { id: string };\n"
      );
      writeFileSync(
        join(repo, "src/index.ts"),
        "import type { Payload, Shape } from './types';\nfunction describe(shape: Shape, payload: Payload) { return `${payload.id}:${shape.width}`; }\nvoid describe;\n"
      );

      const graphBuild = spawnSync(process.execPath, ["packages/cli/dist/index.js", "graph", "build", "--repo", repo, "--json"], {
        cwd: process.cwd(),
        encoding: "utf8"
      });
      assert.equal(graphBuild.status, 0, graphBuild.stderr || graphBuild.stdout);

      const check = spawnSync(
        process.execPath,
        [
          "packages/cli/dist/index.js",
          "check",
          "files",
          "src/types.ts",
          "src/index.ts",
          "--repo",
          repo,
          "--checks",
          TYPE_SCRIPT_DEAD_CODE_CHECK_ID,
          "--graph-mode",
          "required",
          "--json"
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8"
        }
      );
      assert.equal(check.status, 0, check.stderr || check.stdout);
      const payload = JSON.parse(check.stdout);
      const diagnosticCodes = payload.validationResult.diagnostics.map((diagnostic) => diagnostic.code);
      assert.deepEqual(diagnosticCodes, ["TS_DEAD_CODE_UNSUPPORTED"]);
      assert.equal(
        payload.validationResult.diagnostics.some(
          (diagnostic) => diagnostic.code === "TS_DEAD_CODE_UNUSED_EXPORT" && /Shape|Payload/.test(diagnostic.message)
        ),
        false
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("reports unsupported coverage for unresolved local exports with the real graph provider", () => {
    const repo = mkdtempSync(join(tmpdir(), "lattice-dead-code-unresolved-export-"));
    try {
      mkdirSync(join(repo, "src"), { recursive: true });
      writeFileSync(
        join(repo, "tsconfig.json"),
        `${JSON.stringify(
          {
            compilerOptions: {
              target: "ES2022",
              module: "ESNext",
              moduleResolution: "Bundler",
              strict: true
            },
            include: ["src/**/*.ts"]
          },
          null,
          2
        )}\n`
      );
      writeFileSync(join(repo, "src/index.ts"), "export { missing as renamed };\nfunction internal(){return 1;}\n");

      const graphBuild = spawnSync(process.execPath, ["packages/cli/dist/index.js", "graph", "build", "--repo", repo, "--json"], {
        cwd: process.cwd(),
        encoding: "utf8"
      });
      assert.equal(graphBuild.status, 0, graphBuild.stderr || graphBuild.stdout);

      const nodeQuery = spawnSync(
        process.execPath,
        ["packages/cli/dist/index.js", "graph", "query", "--repo", repo, "--kind", "nodes", "--json"],
        {
          cwd: process.cwd(),
          encoding: "utf8"
        }
      );
      assert.equal(nodeQuery.status, 0, nodeQuery.stderr || nodeQuery.stdout);
      const nodes = JSON.parse(nodeQuery.stdout).graphQuery.nodes;
      const fileNode = nodes.find((node) => node.id === "file:src/index.ts");
      assert.deepEqual(fileNode?.attributes?.exports, [
        {
          kind: "named",
          local: "missing",
          exported: "renamed",
          source: null,
          supportedSymbol: false
        }
      ]);

      const check = spawnSync(
        process.execPath,
        [
          "packages/cli/dist/index.js",
          "check",
          "files",
          "src/index.ts",
          "--repo",
          repo,
          "--checks",
          TYPE_SCRIPT_DEAD_CODE_CHECK_ID,
          "--graph-mode",
          "required",
          "--json"
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8"
        }
      );
      assert.equal(check.status, 0, check.stderr || check.stdout);
      const payload = JSON.parse(check.stdout);
      const diagnosticCodes = payload.validationResult.diagnostics.map((diagnostic) => diagnostic.code);
      assert.deepEqual(diagnosticCodes, ["TS_DEAD_CODE_UNSUPPORTED"]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("reports unsupported coverage for nested local exports with the real graph provider", () => {
    const repo = mkdtempSync(join(tmpdir(), "lattice-dead-code-nested-export-"));
    try {
      mkdirSync(join(repo, "src"), { recursive: true });
      writeFileSync(
        join(repo, "tsconfig.json"),
        `${JSON.stringify(
          {
            compilerOptions: {
              target: "ES2022",
              module: "ESNext",
              moduleResolution: "Bundler",
              strict: true
            },
            include: ["src/**/*.ts"]
          },
          null,
          2
        )}\n`
      );
      writeFileSync(
        join(repo, "src/index.ts"),
        "export { laterNested as exportedLaterNested };\nfunction container(){ function laterNested(){ return 1; } return laterNested(); }\n"
      );

      const graphBuild = spawnSync(process.execPath, ["packages/cli/dist/index.js", "graph", "build", "--repo", repo, "--json"], {
        cwd: process.cwd(),
        encoding: "utf8"
      });
      assert.equal(graphBuild.status, 0, graphBuild.stderr || graphBuild.stdout);

      const nodeQuery = spawnSync(
        process.execPath,
        ["packages/cli/dist/index.js", "graph", "query", "--repo", repo, "--kind", "nodes", "--json"],
        {
          cwd: process.cwd(),
          encoding: "utf8"
        }
      );
      assert.equal(nodeQuery.status, 0, nodeQuery.stderr || nodeQuery.stdout);
      const nodes = JSON.parse(nodeQuery.stdout).graphQuery.nodes;
      const fileNode = nodes.find((node) => node.id === "file:src/index.ts");
      assert.deepEqual(fileNode?.attributes?.exports, [
        {
          kind: "named",
          local: "laterNested",
          exported: "exportedLaterNested",
          source: null,
          supportedSymbol: false
        }
      ]);
      const nestedNode = nodes.find((node) => node.id === "function:src/index.ts#laterNested");
      assert.equal(nestedNode?.attributes?.exported, false);

      const check = spawnSync(
        process.execPath,
        [
          "packages/cli/dist/index.js",
          "check",
          "files",
          "src/index.ts",
          "--repo",
          repo,
          "--checks",
          TYPE_SCRIPT_DEAD_CODE_CHECK_ID,
          "--graph-mode",
          "required",
          "--json"
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8"
        }
      );
      assert.equal(check.status, 0, check.stderr || check.stdout);
      const payload = JSON.parse(check.stdout);
      const diagnosticCodes = payload.validationResult.diagnostics.map((diagnostic) => diagnostic.code);
      assert.deepEqual(diagnosticCodes, ["TS_DEAD_CODE_UNSUPPORTED"]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("does not report used default callable imports as dead exports with the real graph provider", () => {
    const repo = mkdtempSync(join(tmpdir(), "lattice-dead-code-default-import-"));
    try {
      mkdirSync(join(repo, "src"), { recursive: true });
      writeFileSync(
        join(repo, "tsconfig.json"),
        `${JSON.stringify(
          {
            compilerOptions: {
              target: "ES2022",
              module: "ESNext",
              moduleResolution: "Bundler",
              strict: true
            },
            include: ["src/**/*.ts"]
          },
          null,
          2
        )}\n`
      );
      writeFileSync(join(repo, "src/dep.ts"), "export default function usedDefault() { return 1; }\n");
      writeFileSync(
        join(repo, "src/index.ts"),
        "import usedDefault from './dep';\nfunction run() { return usedDefault(); }\nrun();\n"
      );

      const graphBuild = spawnSync(process.execPath, ["packages/cli/dist/index.js", "graph", "build", "--repo", repo, "--json"], {
        cwd: process.cwd(),
        encoding: "utf8"
      });
      assert.equal(graphBuild.status, 0, graphBuild.stderr || graphBuild.stdout);

      const edgeQuery = spawnSync(
        process.execPath,
        ["packages/cli/dist/index.js", "graph", "query", "--repo", repo, "--kind", "edges", "--json"],
        {
          cwd: process.cwd(),
          encoding: "utf8"
        }
      );
      assert.equal(edgeQuery.status, 0, edgeQuery.stderr || edgeQuery.stdout);
      const edges = JSON.parse(edgeQuery.stdout).graphQuery.edges;
      assert.equal(
        edges.some(
          (edge) =>
            edge.kind === "CALLS" &&
            edge.from === "function:src/index.ts#run" &&
            edge.to === "function:src/dep.ts#usedDefault"
        ),
        true
      );

      const check = spawnSync(
        process.execPath,
        [
          "packages/cli/dist/index.js",
          "check",
          "files",
          "src/dep.ts",
          "src/index.ts",
          "--repo",
          repo,
          "--checks",
          TYPE_SCRIPT_DEAD_CODE_CHECK_ID,
          "--graph-mode",
          "required",
          "--json"
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8"
        }
      );
      assert.equal(check.status, 0, check.stderr || check.stdout);
      const payload = JSON.parse(check.stdout);
      const unusedMessages = payload.validationResult.diagnostics
        .filter((diagnostic) => diagnostic.code === "TS_DEAD_CODE_UNUSED_EXPORT")
        .map((diagnostic) => diagnostic.message);
      assert.deepEqual(unusedMessages, []);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("does not report used renamed callable exports as dead exports with the real graph provider", () => {
    const repo = mkdtempSync(join(tmpdir(), "lattice-dead-code-renamed-export-"));
    try {
      mkdirSync(join(repo, "src"), { recursive: true });
      writeFileSync(
        join(repo, "tsconfig.json"),
        `${JSON.stringify(
          {
            compilerOptions: {
              target: "ES2022",
              module: "ESNext",
              moduleResolution: "Bundler",
              strict: true
            },
            include: ["src/**/*.ts"]
          },
          null,
          2
        )}\n`
      );
      writeFileSync(join(repo, "src/dep.ts"), "function localName() { return 1; }\nexport { localName as publicName };\n");
      writeFileSync(
        join(repo, "src/index.ts"),
        "import { publicName } from './dep';\nfunction run() { return publicName(); }\nrun();\n"
      );

      const graphBuild = spawnSync(process.execPath, ["packages/cli/dist/index.js", "graph", "build", "--repo", repo, "--json"], {
        cwd: process.cwd(),
        encoding: "utf8"
      });
      assert.equal(graphBuild.status, 0, graphBuild.stderr || graphBuild.stdout);

      const edgeQuery = spawnSync(
        process.execPath,
        ["packages/cli/dist/index.js", "graph", "query", "--repo", repo, "--kind", "edges", "--json"],
        {
          cwd: process.cwd(),
          encoding: "utf8"
        }
      );
      assert.equal(edgeQuery.status, 0, edgeQuery.stderr || edgeQuery.stdout);
      const edges = JSON.parse(edgeQuery.stdout).graphQuery.edges;
      assert.equal(
        edges.some(
          (edge) =>
            edge.kind === "CALLS" &&
            edge.from === "function:src/index.ts#run" &&
            edge.to === "function:src/dep.ts#localName"
        ),
        true
      );

      const check = spawnSync(
        process.execPath,
        [
          "packages/cli/dist/index.js",
          "check",
          "files",
          "src/dep.ts",
          "src/index.ts",
          "--repo",
          repo,
          "--checks",
          TYPE_SCRIPT_DEAD_CODE_CHECK_ID,
          "--graph-mode",
          "required",
          "--json"
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8"
        }
      );
      assert.equal(check.status, 0, check.stderr || check.stdout);
      const payload = JSON.parse(check.stdout);
      const unusedMessages = payload.validationResult.diagnostics
        .filter((diagnostic) => diagnostic.code === "TS_DEAD_CODE_UNUSED_EXPORT")
        .map((diagnostic) => diagnostic.message);
      assert.deepEqual(unusedMessages, []);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("does not report used direct re-exported callables as dead exports with the real graph provider", () => {
    const repo = mkdtempSync(join(tmpdir(), "lattice-dead-code-reexport-"));
    try {
      mkdirSync(join(repo, "src"), { recursive: true });
      writeFileSync(
        join(repo, "tsconfig.json"),
        `${JSON.stringify(
          {
            compilerOptions: {
              target: "ES2022",
              module: "ESNext",
              moduleResolution: "Bundler",
              strict: true
            },
            include: ["src/**/*.ts"]
          },
          null,
          2
        )}\n`
      );
      writeFileSync(join(repo, "src/source.ts"), "export function add() { return 1; }\n");
      writeFileSync(join(repo, "src/barrel.ts"), "export { add as addFromBarrel } from './source';\n");
      writeFileSync(
        join(repo, "src/index.ts"),
        "import { addFromBarrel } from './barrel';\nfunction run() { return addFromBarrel(); }\nrun();\n"
      );

      const graphBuild = spawnSync(process.execPath, ["packages/cli/dist/index.js", "graph", "build", "--repo", repo, "--json"], {
        cwd: process.cwd(),
        encoding: "utf8"
      });
      assert.equal(graphBuild.status, 0, graphBuild.stderr || graphBuild.stdout);

      const edgeQuery = spawnSync(
        process.execPath,
        ["packages/cli/dist/index.js", "graph", "query", "--repo", repo, "--kind", "edges", "--json"],
        {
          cwd: process.cwd(),
          encoding: "utf8"
        }
      );
      assert.equal(edgeQuery.status, 0, edgeQuery.stderr || edgeQuery.stdout);
      const edges = JSON.parse(edgeQuery.stdout).graphQuery.edges;
      assert.equal(
        edges.some(
          (edge) =>
            edge.kind === "CALLS" && edge.from === "function:src/index.ts#run" && edge.to === "function:src/source.ts#add"
        ),
        true
      );

      const nodeQuery = spawnSync(
        process.execPath,
        ["packages/cli/dist/index.js", "graph", "query", "--repo", repo, "--kind", "nodes", "--json"],
        {
          cwd: process.cwd(),
          encoding: "utf8"
        }
      );
      assert.equal(nodeQuery.status, 0, nodeQuery.stderr || nodeQuery.stdout);
      const fileNode = JSON.parse(nodeQuery.stdout).graphQuery.nodes.find((node) => node.id === "file:src/barrel.ts");
      assert.deepEqual(fileNode?.attributes?.exports, [
        {
          kind: "named",
          local: "add",
          exported: "addFromBarrel",
          source: "./source",
          imported: "add",
          supportedSymbol: true
        }
      ]);

      const check = spawnSync(
        process.execPath,
        [
          "packages/cli/dist/index.js",
          "check",
          "files",
          "src/source.ts",
          "src/barrel.ts",
          "src/index.ts",
          "--repo",
          repo,
          "--checks",
          TYPE_SCRIPT_DEAD_CODE_CHECK_ID,
          "--graph-mode",
          "required",
          "--json"
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8"
        }
      );
      assert.equal(check.status, 0, check.stderr || check.stdout);
      const payload = JSON.parse(check.stdout);
      assert.deepEqual(
        payload.validationResult.diagnostics.map((diagnostic) => diagnostic.code),
        []
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("finds relevant tests from symbol TESTED_BY endpoints", async () => {
    const result = await runner({
      files: {
        "src/index.ts": "export const value = 1;"
      },
      graphProviderClient: graphClient({
        factQuery: (query) =>
          availableFactResult(
            query,
            [],
            query.selector.kind === "edges" && query.selector.edgeKinds?.includes("TESTED_BY")
              ? [
                  {
                    kind: "TESTED_BY",
                    from: "function:src/index.ts#value",
                    to: "test:src/index.test.ts#covers value"
                  }
                ]
              : []
          )
      })
    }).runValidation(
      request({
        checks: [TYPE_SCRIPT_RELEVANT_TESTS_CHECK_ID]
      })
    );

    assert.equal(result.status, "passed");
    assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), ["TS_RELEVANT_TESTS_FOUND"]);
  });

  it("maps graph query failures to runner provider_failure", async () => {
    const result = await runner({
      graphProviderClient: graphClient({
        status: (validationRequest) => availableStatus(validationRequest.graph.mode, validationRequest.repo),
        factQuery: () => ({
          status: graphFailure("error", "query_failed", "required")
        })
      })
    }).runValidation(
      request({
        checks: [TYPE_SCRIPT_IMPORT_GRAPH_CHECK_ID],
        graph: {
          mode: "required",
          provider: "lattice-graph"
        }
      })
    );

    assert.equal(result.status, "provider_failure");
    assert.equal(result.failure.category, "provider_failure");
  });

  it("batches graph requirements without per-file provider calls", async () => {
    const factQueries = [];
    const files = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [
        `src/file-${String(index).padStart(3, "0")}.ts`,
        `export const value${index} = ${index};`
      ])
    );
    const result = await runner({
      files,
      graphProviderClient: graphClient({
        factQuery: (query) => {
          factQueries.push(query);
          return availableFactResult(query, [], []);
        }
      })
    }).runValidation(
      request({
        checks: [TYPE_SCRIPT_IMPORT_GRAPH_CHECK_ID],
        scope: {
          kind: "repo"
        }
      })
    );

    assert.equal(result.status, "passed");
    assert.equal(factQueries.length, 2);
    assert.deepEqual(factQueries[0].selector, {
      kind: "edges",
      edgeKinds: ["IMPORTS_FROM"]
    });
    assert.equal(factQueries[1].selector.ids.length, 100);
  });
});

function runner(options = {}) {
  return createValidationRunner({
    workspace: workspace(options),
    checks: createTypeScriptValidationChecks(),
    graphProviderClient: options.graphProviderClient
  });
}

function request(overrides = {}) {
  return {
    requestId: "validation-typescript-1",
    repo: {
      repoId: "lattice"
    },
    scope: {
      kind: "files",
      files: ["src/index.ts"]
    },
    graph: {
      mode: "optional",
      provider: "lattice-graph"
    },
    overlays: [],
    checks: [TYPE_SCRIPT_SYNTAX_CHECK_ID],
    ...overrides
  };
}

function workspace(options = {}) {
  const files = new Map(Object.entries(options.files ?? { "src/index.ts": "export const value = 1;" }));
  const packageFiles = options.packageFiles ?? {};
  return {
    readFile: (path) => (files.has(path) ? { status: "found", content: files.get(path) } : { status: "missing" }),
    listChangedFiles: () => ({ files: [...files.keys()] }),
    listStagedFiles: () => ({ files: [...files.keys()] }),
    listRepoFiles: () => ({ files: [...files.keys()] }),
    listPackageFiles: (_packageName, packageRoot) => ({
      files: packageFiles[packageRoot] ?? [...files.keys()].filter((path) => path.startsWith(`${packageRoot}/`))
    }),
    resolvePackageRoot: (packageName) => (packageName === "@covibes/app" ? "packages/app" : undefined)
  };
}

function repoWorkspace() {
  return {
    readFile: (path) => {
      const absolutePath = join(process.cwd(), path);
      return existsSync(absolutePath) && statSync(absolutePath).isFile()
        ? { status: "found", content: readFileSync(absolutePath, "utf8") }
        : { status: "missing" };
    },
    listPackageFiles: (_packageName, packageRoot) => ({
      files: listRepoFiles(`${packageRoot}/src`).filter((path) => path.endsWith(".ts"))
    }),
    resolvePackageRoot: (packageName) =>
      packageName === "@the-open-engine/lattice-validation-typescript" ? "packages/validation-typescript" : undefined
  };
}

function listRepoFiles(root) {
  const rootPath = join(process.cwd(), root);
  return readdirSync(rootPath, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = join(rootPath, entry.name);
    if (entry.isDirectory()) return listRepoFiles(relative(process.cwd(), absolutePath));
    return relative(process.cwd(), absolutePath).replaceAll("\\", "/");
  });
}

function graphClient(overrides = {}) {
  return {
    status: (validationRequest) => availableStatus(validationRequest.graph.mode, validationRequest.repo),
    factQuery: (query) => availableFactResult(query, [], []),
    namedQuery: () => {
      throw new Error("unexpected namedQuery");
    },
    impact: () => {
      throw new Error("unexpected impact");
    },
    reviewContext: () => {
      throw new Error("unexpected reviewContext");
    },
    detectChanges: () => {
      throw new Error("unexpected detectChanges");
    },
    ...overrides
  };
}

function availableStatus(mode = "optional", repo = { repoId: "lattice" }) {
  return {
    state: "available",
    mode,
    provider: "lattice-graph",
    schemaVersion: 1,
    repo,
    freshness: freshness()
  };
}

function graphHandshake(overrides = {}) {
  return {
    provider: "lattice-graph",
    graphSchemaVersion: 1,
    artifactName: "lattice-graph-core",
    artifactVersion: "0.1.0-alpha.0",
    targetPlatform: "test",
    supportedOperations: ["build", "update", "watch", "status", "query", "ping", "health", "shutdown"],
    nodeKinds: ["File", "Function", "Variable"],
    edgeKinds: ["CONTAINS", "IMPORTS_FROM", "CALLS", "TESTED_BY"],
    queryKinds: [
      "nodes",
      "edges",
      "neighbors",
      "symbols",
      "impact",
      "callers_of",
      "callees_of",
      "importers_of",
      "imports_of",
      "tests_for",
      "children_of",
      "file_summary",
      "review_context",
      "detect_changes",
      "search"
    ],
    artifact: {
      artifactName: "lattice-graph-core",
      artifactVersion: "0.1.0-alpha.0",
      targetPlatform: "test",
      binaryPath: "dist/native/test/lattice-graph-core",
      checksumPath: "dist/native/test/lattice-graph-core.sha256",
      checksumSha256: "0".repeat(64),
      buildProfile: "test"
    },
    ...overrides
  };
}

function graphFailure(state, category, mode = "optional") {
  const status = {
    state,
    mode,
    provider: "lattice-graph",
    schemaVersion: 1,
    failure: {
      category,
      message: `${state} failure`
    }
  };
  if (state === "stale" || state === "schema_mismatch" || state === "daemon_unavailable") {
    status.repo = {
      repoId: "lattice"
    };
    status.freshness = freshness({ stale: true });
  }
  if (state === "schema_mismatch") {
    status.expectedSchemaVersion = 1;
    status.actualSchemaVersion = 2;
  }
  return status;
}

function availableFactResult(query, nodes, edges, metadataOverrides = {}) {
  return {
    requestId: query.requestId,
    status: availableStatus(query.mode, query.repo),
    metadata: {
      schemaVersion: 1,
      provider: "lattice-graph",
      repo: query.repo,
      generatedAt: "2026-06-05T00:00:00.000Z",
      freshness: freshness(),
      nodeKinds: ["File", "file", "symbol"],
      edgeKinds: ["IMPORTS_FROM", "CALLS", "TESTED_BY"],
      ...metadataOverrides
    },
    nodes,
    edges
  };
}

function freshness(overrides = {}) {
  return {
    generatedAt: "2026-06-05T00:00:00.000Z",
    ageMs: 0,
    stale: false,
    ...overrides
  };
}
