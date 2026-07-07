import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import ts from "typescript";
import { createNodeValidationWorkspace, createValidationCheckRegistry, createValidationRunner } from "../packages/validation/dist/index.js";
import {
  TYPE_SCRIPT_DEAD_CODE_CHECK_ID,
  TYPE_SCRIPT_FUNCTION_METRICS_CHECK_ID,
  TYPE_SCRIPT_FILE_LENGTH_CHECK_ID,
  TYPE_SCRIPT_IMPORT_GRAPH_CHECK_ID,
  TYPE_SCRIPT_LINT_CHECK_ID,
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
        TYPE_SCRIPT_LINT_CHECK_ID,
        TYPE_SCRIPT_IMPORT_GRAPH_CHECK_ID,
        TYPE_SCRIPT_DEAD_CODE_CHECK_ID,
        TYPE_SCRIPT_FUNCTION_METRICS_CHECK_ID,
        TYPE_SCRIPT_RELEVANT_TESTS_CHECK_ID,
        TYPE_SCRIPT_FILE_LENGTH_CHECK_ID
      ]
    );
    assert.equal(registry.byId.get(TYPE_SCRIPT_SYNTAX_CHECK_ID)?.requiresGraph, false);
    assert.equal(registry.byId.get(TYPE_SCRIPT_LINT_CHECK_ID)?.requiresGraph, false);
    assert.equal(registry.byId.get(TYPE_SCRIPT_IMPORT_GRAPH_CHECK_ID)?.requiresGraph, false);
    assert.equal(registry.byId.get(TYPE_SCRIPT_FUNCTION_METRICS_CHECK_ID)?.requiresGraph, false);
    assert.equal(registry.byId.get(TYPE_SCRIPT_FILE_LENGTH_CHECK_ID)?.requiresGraph, false);
  });

  it("reports syntactic TypeScript lint diagnostics for dangerous patterns", async () => {
    const result = await runner({
      files: {
        "package.json": JSON.stringify({
          optionalDependencies: {
            "optional-feature": "1.0.0"
          }
        }),
        "src/index.ts": `
          import optionalFeature from "optional-feature";
          import { exec, spawn } from "node:child_process";
          import axios from "axios";

          promise.catch(() => {});
          const apiKey = process.env.API_KEY || "default-key";
          exec(\`git clone \${url}\`);
          spawn(command, args, { shell: true });
          app.listen(3000);
          await fetch(url);
          await axios.get(url);
          await Promise.all(items.map(async (item) => processItem(item)));
          const casted = payload as unknown as DangerousType;
          const mod = await import("./plugins/" + pluginName);
          throw new Error("Failed");
          void optionalFeature;
          void apiKey;
          void casted;
          void mod;
        `
      }
    }).runValidation(
      request({
        checks: [TYPE_SCRIPT_LINT_CHECK_ID]
      })
    );

    assert.equal(result.status, "policy_failure", JSON.stringify(result.diagnostics, null, 2));
    assert.deepEqual(
      new Set(result.diagnostics.map((diagnostic) => diagnostic.code)),
      new Set([
        "TS_LINT_NO_EMPTY_CATCH",
        "TS_LINT_NO_DANGEROUS_SPAWN",
        "TS_LINT_NO_DANGEROUS_FALLBACKS",
        "TS_LINT_NO_HARDCODED_PORTS",
        "TS_LINT_NO_RAW_NETWORK_WITHOUT_TIMEOUT",
        "TS_LINT_NO_UNBOUNDED_PROMISE_ALL_MAP",
        "TS_LINT_NO_UNSAFE_TYPE_ASSERTION",
        "TS_LINT_NO_DYNAMIC_IMPORT_CONCAT",
        "TS_LINT_REQUIRE_ERROR_CONTEXT",
        "TS_LINT_NO_STATIC_OPTIONAL_IMPORT"
      ])
    );
    assert.equal(result.diagnostics.every((diagnostic) => diagnostic.category === "lint"), true);
    assert.equal(result.diagnostics.every((diagnostic) => diagnostic.path === "src/index.ts"), true);
  });

  it("limits dangerous spawn lint to child process execution calls", async () => {
    const result = await runner({
      files: {
        "src/index.ts": `
          import { exec as childExec, execSync, spawn as childSpawn } from "node:child_process";
          import * as child_process from "node:child_process";
          import * as childProcess from "child_process";

          const rx = /ready/;
          const db = { exec: (_sql: string) => 1 };
          const matcher = { exec: (_value: string) => true };
          rx.exec(input);
          db.exec("select 1");
          matcher.exec(input);
          child_process.exec("git status");
          childProcess.spawn(command, args, { shell: true });
          childExec("git status");
          childSpawn("git", ["status"], { shell: true });
          execSync("git status");
        `,
        "src/required-child-process.ts": `
          const cp = require("child_process");
          const { exec: requiredExec, spawn, spawn: requiredSpawn } = require("node:child_process");
          cp.exec("git status");
          spawn("git", ["status"], { shell: true });
          requiredExec("git status");
          requiredSpawn("git", ["status"], { shell: true });
          require("child_process").exec("git status");
        `,
        "src/local-child-process.ts": `
          const childProcess = {
            exec: (_command: string) => undefined,
            spawn: (_command: string, _args: readonly string[], _options: { shell: boolean }) => undefined
          };
          const child_process = {
            exec: (_command: string) => undefined,
            spawn: (_command: string, _args: readonly string[], _options: { shell: boolean }) => undefined
          };
          childProcess.exec("select 1");
          childProcess.spawn("tool", [], { shell: true });
          child_process.exec("select 1");
          child_process.spawn("tool", [], { shell: true });
        `
      }
    }).runValidation(
      request({
        checks: [TYPE_SCRIPT_LINT_CHECK_ID],
        scope: {
          kind: "files",
          files: ["src/index.ts", "src/required-child-process.ts", "src/local-child-process.ts"]
        }
      })
    );

    const dangerousSpawnDiagnostics = result.diagnostics.filter(
      (diagnostic) => diagnostic.code === "TS_LINT_NO_DANGEROUS_SPAWN"
    );
    assert.equal(result.status, "policy_failure", JSON.stringify(result.diagnostics, null, 2));
    assert.equal(dangerousSpawnDiagnostics.length, 10, JSON.stringify(result.diagnostics, null, 2));
    assert.equal(result.diagnostics.length, 10, JSON.stringify(result.diagnostics, null, 2));
  });

  it("filters TypeScript lint diagnostics through introduced report mode", async () => {
    const result = await runner({
      files: {
        "src/index.ts": `
          promise.catch(() => {});
          await fetch(url, { signal });
        `
      }
    }).runValidation(
      request({
        checks: [TYPE_SCRIPT_LINT_CHECK_ID],
        reportMode: "introduced",
        overlays: [
          {
            path: "src/index.ts",
            action: "write",
            content: `
              promise.catch(() => {});
              await fetch(url);
            `
          }
        ]
      })
    );

    assert.equal(result.status, "policy_failure", JSON.stringify(result.diagnostics, null, 2));
    assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), ["TS_LINT_NO_RAW_NETWORK_WITHOUT_TIMEOUT"]);
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

  it("uses imported support files without widening scoped type diagnostics", async () => {
    const result = await runner({
      files: {
        "src/index.ts": `
          import { value } from "./support";
          export const selected: string = String(value);
        `,
        "src/support.ts": `
          export const value = 1;
          const broken: string = 1;
        `
      }
    }).runValidation(
      request({
        checks: [TYPE_SCRIPT_TYPES_CHECK_ID],
        scope: { kind: "files", files: ["src/index.ts"] }
      })
    );

    assert.equal(result.status, "passed", JSON.stringify(result.diagnostics, null, 2));
    assert.deepEqual(result.diagnostics, []);
  });

  it("reports file-length diagnostics from overlay after-state content", async () => {
    const result = await runner({
      files: {
        "src/index.ts": "export const value = 1;\n"
      }
    }).runValidation(
      request({
        checks: [TYPE_SCRIPT_FILE_LENGTH_CHECK_ID],
        overlays: [
          {
            path: "src/index.ts",
            action: "write",
            content: numberedTypeScriptLines(301)
          }
        ]
      })
    );

    assert.equal(result.status, "policy_failure");
    assert.deepEqual(result.diagnostics, [
      {
        category: "policy",
        severity: "error",
        path: "src/index.ts",
        code: "TS_FILE_LINES",
        message: "TypeScript file has 301 lines; max is 300."
      }
    ]);
    assert.equal(Object.hasOwn(result.diagnostics[0], "line"), false);
    assert.equal(Object.hasOwn(result.diagnostics[0], "column"), false);
  });

  it("suppresses pre-existing file-length diagnostics in introduced report mode", async () => {
    const result = await runner({
      files: {
        "src/index.ts": numberedTypeScriptLines(301)
      }
    }).runValidation(
      request({
        checks: [TYPE_SCRIPT_FILE_LENGTH_CHECK_ID],
        reportMode: "introduced",
        overlays: [
          {
            path: "src/index.ts",
            action: "write",
            content: numberedTypeScriptLines(302)
          }
        ]
      })
    );

    assert.equal(result.status, "passed", JSON.stringify(result.diagnostics, null, 2));
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.manifest.runs[0].status, "passed");
    assert.equal(result.manifest.runs[0].diagnosticCount, 0);
  });

  it("reports file-length diagnostics newly crossing the threshold in introduced report mode", async () => {
    const result = await runner({
      files: {
        "src/index.ts": numberedTypeScriptLines(300)
      }
    }).runValidation(
      request({
        checks: [TYPE_SCRIPT_FILE_LENGTH_CHECK_ID],
        reportMode: "introduced",
        overlays: [
          {
            path: "src/index.ts",
            action: "write",
            content: numberedTypeScriptLines(301)
          }
        ]
      })
    );

    assert.equal(result.status, "policy_failure");
    assert.deepEqual(
      result.diagnostics.map((diagnostic) => [diagnostic.path, diagnostic.code, diagnostic.message]),
      [["src/index.ts", "TS_FILE_LINES", "TypeScript file has 301 lines; max is 300."]]
    );
    assert.equal(result.manifest.runs[0].diagnosticCount, 1);
  });

  it("uses configured TypeScript file-length thresholds and deterministic diagnostic ordering", async () => {
    const validation = createValidationRunner({
      workspace: workspace({
        files: {
          "src/z.ts": numberedTypeScriptLines(4),
          "src/a.ts": numberedTypeScriptLines(3),
          "src/ok.ts": numberedTypeScriptLines(2)
        }
      }),
      checks: createTypeScriptValidationChecks({
        fileLength: {
          maxFileLines: 2
        }
      })
    });

    const result = await validation.runValidation(
      request({
        checks: [TYPE_SCRIPT_FILE_LENGTH_CHECK_ID],
        scope: {
          kind: "files",
          files: ["src/z.ts", "src/a.ts", "src/ok.ts"]
        }
      })
    );

    assert.equal(result.status, "policy_failure");
    assert.deepEqual(
      result.diagnostics.map((diagnostic) => [diagnostic.path, diagnostic.code, diagnostic.message]),
      [
        ["src/a.ts", "TS_FILE_LINES", "TypeScript file has 3 lines; max is 2."],
        ["src/z.ts", "TS_FILE_LINES", "TypeScript file has 4 lines; max is 2."]
      ]
    );
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

  it("resolves solution-style tsconfig references for scoped path aliases", async () => {
    const result = await runner({
      files: {
        "tsconfig.json": JSON.stringify({
          files: [],
          references: [{ path: "./tsconfig.app.json" }]
        }),
        "tsconfig.app.json": JSON.stringify({
          compilerOptions: {
            baseUrl: "./src",
            paths: {
              "@/*": ["*"]
            }
          },
          include: ["src"]
        }),
        "src/a.ts": "export const a = 1;\n",
        "src/b.ts": "import { a } from '@/a';\nexport const b: number = a;\n"
      }
    }).runValidation(
      request({
        checks: [TYPE_SCRIPT_TYPES_CHECK_ID],
        scope: {
          kind: "files",
          files: ["src/b.ts"]
        }
      })
    );

    assert.equal(result.status, "passed", JSON.stringify(result.diagnostics, null, 2));
  });

  it("uses nearest nested tsconfig options for full-repo TypeScript validation", async () => {
    const result = await runner({
      files: {
        "apps/web/tsconfig.json": JSON.stringify({
          compilerOptions: {
            baseUrl: ".",
            paths: {
              "@/*": ["src/*"]
            }
          }
        }),
        "apps/web/src/index.ts": "import { value } from '@/dep';\nconst label: string = value;\nexport { label };\n",
        "apps/web/src/dep.ts": "export const value = 'web';\n",
        "packages/api/tsconfig.json": JSON.stringify({
          compilerOptions: {
            baseUrl: ".",
            paths: {
              "#/*": ["source/*"]
            }
          }
        }),
        "packages/api/source/index.ts": "import { count } from '#/dep';\nconst total: number = count;\nexport { total };\n",
        "packages/api/source/dep.ts": "export const count = 1;\n"
      }
    }).runValidation(
      request({
        checks: [TYPE_SCRIPT_TYPES_CHECK_ID],
        scope: {
          kind: "all"
        }
      })
    );

    assert.equal(result.status, "passed", JSON.stringify(result.diagnostics, null, 2));
  });

  it("shares one TypeScript program per project across syntax and type checks in one validation request", async () => {
    const libraryReads = new Map();
    const originalReadFile = ts.sys.readFile;
    ts.sys.readFile = (path, encoding) => {
      const normalized = path.replaceAll("\\", "/");
      if (normalized.endsWith("/node_modules/typescript/lib/lib.es2022.full.d.ts")) {
        libraryReads.set(normalized, (libraryReads.get(normalized) ?? 0) + 1);
      }
      return originalReadFile(path, encoding);
    };

    try {
      const result = await runner({
        files: {
          "apps/web/tsconfig.json": JSON.stringify({
            compilerOptions: {
              baseUrl: ".",
              paths: {
                "@/*": ["src/*"]
              }
            }
          }),
          "apps/web/src/index.ts": "import { value } from '@/dep';\nexport const label: string = value;\n",
          "apps/web/src/dep.ts": "export const value = 'web';\n",
          "packages/api/tsconfig.json": JSON.stringify({
            compilerOptions: {
              baseUrl: ".",
              paths: {
                "#/*": ["source/*"]
              }
            }
          }),
          "packages/api/source/index.ts": "import { count } from '#/dep';\nexport const total: number = count;\n",
          "packages/api/source/dep.ts": "export const count = 1;\n"
        }
      }).runValidation(
        request({
          checks: [TYPE_SCRIPT_SYNTAX_CHECK_ID, TYPE_SCRIPT_TYPES_CHECK_ID],
          scope: {
            kind: "all"
          }
        })
      );

      const defaultLibReadCount = [...libraryReads.values()].reduce((sum, count) => sum + count, 0);
      assert.equal(result.status, "passed", JSON.stringify(result.diagnostics, null, 2));
      assert.equal(defaultLibReadCount, 2);
    } finally {
      ts.sys.readFile = originalReadFile;
    }
  });

  it("persists and reads TypeScript build info for repeated on-disk validations", async () => {
    const repo = mkdtempSync(join(tmpdir(), "opcore-validation-ts-build-info-"));
    try {
      mkdirSync(join(repo, "src"), { recursive: true });
      writeFileSync(
        join(repo, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            target: "ES2022"
          },
          include: ["src/**/*.ts"]
        })
      );
      writeFileSync(join(repo, "src/dep.ts"), "export const value = 'disk';\n");
      writeFileSync(join(repo, "src/index.ts"), "import { value } from './dep';\nexport const label: string = value;\n");

      const validation = createValidationRunner({
        workspace: createNodeValidationWorkspace({ repoRoot: repo }),
        checks: createTypeScriptValidationChecks()
      });
      const validationRequest = request({
        repo: { repoRoot: repo },
        checks: [TYPE_SCRIPT_SYNTAX_CHECK_ID, TYPE_SCRIPT_TYPES_CHECK_ID],
        scope: {
          kind: "files",
          files: ["src/index.ts"]
        }
      });

      const first = await validation.runValidation(validationRequest);
      assert.equal(first.status, "passed", JSON.stringify(first.diagnostics, null, 2));
      assert.equal(listTypeScriptBuildInfoFiles(repo).length, 1);

      let buildInfoReads = 0;
      const originalReadFile = ts.sys.readFile;
      ts.sys.readFile = (path, encoding) => {
        const normalized = path.replaceAll("\\", "/");
        if (normalized.includes("/.opcore/typescript-build-info/") && normalized.endsWith(".tsbuildinfo")) {
          buildInfoReads += 1;
        }
        return originalReadFile(path, encoding);
      };
      try {
        const second = await validation.runValidation(validationRequest);
        assert.equal(second.status, "passed", JSON.stringify(second.diagnostics, null, 2));
      } finally {
        ts.sys.readFile = originalReadFile;
      }

      assert.ok(buildInfoReads > 0);
      assert.equal(listTypeScriptBuildInfoFiles(repo).length, 1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("honors runtime policy when persistent TypeScript build info is disabled", async () => {
    const repo = mkdtempSync(join(tmpdir(), "opcore-validation-ts-build-info-disabled-"));
    try {
      mkdirSync(join(repo, "src"), { recursive: true });
      writeFileSync(
        join(repo, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            target: "ES2022"
          },
          include: ["src/**/*.ts"]
        })
      );
      writeFileSync(join(repo, "src/index.ts"), "export const value: string = 'disk';\n");

      const validation = createValidationRunner({
        workspace: createNodeValidationWorkspace({ repoRoot: repo }),
        checks: createTypeScriptValidationChecks(),
        runtime: {
          persistentCaches: "disabled"
        }
      });

      const result = await validation.runValidation(
        request({
          repo: { repoRoot: repo },
          checks: [TYPE_SCRIPT_SYNTAX_CHECK_ID, TYPE_SCRIPT_TYPES_CHECK_ID],
          scope: {
            kind: "files",
            files: ["src/index.ts"]
          }
        })
      );

      assert.equal(result.status, "passed", JSON.stringify(result.diagnostics, null, 2));
      assert.deepEqual(listTypeScriptBuildInfoFiles(repo), []);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("keeps overlay TypeScript programs in memory without writing build info", async () => {
    const repo = mkdtempSync(join(tmpdir(), "opcore-validation-ts-overlay-"));
    try {
      mkdirSync(join(repo, "src"), { recursive: true });
      writeFileSync(
        join(repo, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            target: "ES2022"
          },
          include: ["src/**/*.ts"]
        })
      );
      const sourcePath = join(repo, "src/index.ts");
      const source = "export const value: string = 'disk';\n";
      writeFileSync(sourcePath, source);

      const result = await createValidationRunner({
        workspace: createNodeValidationWorkspace({ repoRoot: repo }),
        checks: createTypeScriptValidationChecks()
      }).runValidation(
        request({
          repo: { repoRoot: repo },
          checks: [TYPE_SCRIPT_SYNTAX_CHECK_ID, TYPE_SCRIPT_TYPES_CHECK_ID],
          scope: {
            kind: "files",
            files: ["src/index.ts"]
          },
          overlays: [
            {
              path: "src/index.ts",
              action: "write",
              content: "export const value: string = 1;\n"
            }
          ]
        })
      );

      assert.equal(result.status, "policy_failure");
      assert.equal(result.diagnostics.find((diagnostic) => diagnostic.category === "types")?.code, "2322");
      assert.equal(readFileSync(sourcePath, "utf8"), source);
      assert.deepEqual(listTypeScriptBuildInfoFiles(repo), []);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("loads project ambient declarations for scoped TypeScript type checks", async () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-validation-ts-ambient-"));
    try {
      mkdirSync(join(temp, "packages/app/src"), { recursive: true });
      writeFileSync(
        join(temp, "packages/app/tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            target: "ES2022"
          },
          include: ["src/**/*.ts"]
        })
      );
      writeFileSync(
        join(temp, "packages/app/src/node-shims.d.ts"),
        'declare module "node:fs" { export function readFileSync(path: string, encoding: "utf8"): string; }\n'
      );
      writeFileSync(
        join(temp, "packages/app/src/index.ts"),
        'import { readFileSync } from "node:fs";\nexport const content: string = readFileSync("file.txt", "utf8");\n'
      );

      const result = await createValidationRunner({
        workspace: createNodeValidationWorkspace({ repoRoot: temp }),
        checks: createTypeScriptValidationChecks()
      }).runValidation(
        request({
          repo: { repoRoot: temp },
          checks: [TYPE_SCRIPT_TYPES_CHECK_ID],
          scope: {
            kind: "files",
            files: ["packages/app/src/index.ts"]
          }
        })
      );

      assert.equal(result.status, "passed", JSON.stringify(result.diagnostics, null, 2));
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("honors project compiler options instead of forcing strict JavaScript checking", async () => {
    const result = await runner({
      files: {
        "tsconfig.json": JSON.stringify({
          compilerOptions: {
            allowJs: true,
            checkJs: false,
            strict: false
          },
          include: ["src/**/*"]
        }),
        "src/index.js": "/** @type {number} */\nexport const count = 'wrong';\n",
        "src/typed.ts": "export const label: string = null;\n"
      }
    }).runValidation(
      request({
        checks: [TYPE_SCRIPT_TYPES_CHECK_ID],
        scope: {
          kind: "all"
        }
      })
    );

    assert.equal(result.status, "passed", JSON.stringify(result.diagnostics, null, 2));
  });

  it("keeps semantic diagnostics explicit for full-repo default validation", async () => {
    const validation = runner({
      files: {
        "src/index.ts": "export const count: number = 'wrong';\n"
      }
    });
    const defaultAll = await validation.runValidation(
      request({
        checks: undefined,
        scope: {
          kind: "all"
        }
      })
    );
    const explicitAll = await validation.runValidation(
      request({
        checks: [TYPE_SCRIPT_TYPES_CHECK_ID],
        scope: {
          kind: "all"
        }
      })
    );

    assert.equal(defaultAll.manifest.checks.includes(TYPE_SCRIPT_TYPES_CHECK_ID), false);
    assert.equal(defaultAll.diagnostics.some((diagnostic) => diagnostic.code === "2322"), false);
    assert.equal(explicitAll.status, "policy_failure");
    assert.equal(explicitAll.diagnostics.some((diagnostic) => diagnostic.code === "2322"), true);
  });

  it("reports TypeScript function metric threshold diagnostics from overlay after-state content", async () => {
    const complexBranches = Array.from({ length: 11 }, (_, index) => `  if (first.length > ${index}) { return ${index}; }`);
    const fillerLines = Array.from({ length: 69 }, (_, index) => `  const filler${index} = ${index};`);
    const oversizedFunction = [
      "export function oversized(first: string, second: string, third: string, fourth: string, fifth: string) {",
      ...complexBranches,
      ...fillerLines,
      "  return second.length + third.length + fourth.length + fifth.length;",
      "}"
    ].join("\n");

    const result = await runner({
      files: {
        "src/index.ts": "export function oversized() { return 1; }\n"
      }
    }).runValidation(
      request({
        checks: [TYPE_SCRIPT_FUNCTION_METRICS_CHECK_ID],
        overlays: [
          {
            path: "src/index.ts",
            action: "write",
            content: `${oversizedFunction}\n`
          }
        ]
      })
    );

    assert.equal(result.status, "passed", JSON.stringify(result.diagnostics, null, 2));
    assert.deepEqual(
      result.diagnostics.map((diagnostic) => ({
        category: diagnostic.category,
        severity: diagnostic.severity,
        path: diagnostic.path,
        code: diagnostic.code,
        message: diagnostic.message
      })),
      [
        {
          category: "policy",
          severity: "warning",
          path: "src/index.ts",
          code: "TS_FUNCTION_COMPLEXITY",
          message: "TypeScript function oversized has cyclomatic complexity 12; max is 10."
        },
        {
          category: "policy",
          severity: "warning",
          path: "src/index.ts",
          code: "TS_FUNCTION_LINES",
          message: "TypeScript function oversized has 83 lines; max is 80."
        },
        {
          category: "policy",
          severity: "warning",
          path: "src/index.ts",
          code: "TS_FUNCTION_PARAMS",
          message: "TypeScript function oversized has 5 parameters; max is 4."
        }
      ]
    );
  });

  it("does not count nested function branches toward the outer TypeScript function", async () => {
    const nestedBranches = Array.from({ length: 11 }, (_, index) => `    if (value > ${index}) { return ${index}; }`);
    const result = await runner({
      files: {
        "src/index.ts": [
          "export function outer(value: number) {",
          "  function inner() {",
          ...nestedBranches,
          "    return value;",
          "  }",
          "  return inner();",
          "}"
        ].join("\n")
      }
    }).runValidation(
      request({
        checks: [TYPE_SCRIPT_FUNCTION_METRICS_CHECK_ID]
      })
    );

    assert.equal(result.status, "passed", JSON.stringify(result.diagnostics, null, 2));
    assert.deepEqual(
      result.diagnostics.map((diagnostic) => ({
        code: diagnostic.code,
        message: diagnostic.message
      })),
      [
        {
          code: "TS_FUNCTION_COMPLEXITY",
          message: "TypeScript function inner has cyclomatic complexity 12; max is 10."
        }
      ]
    );
  });

  it("collects per-file semantic diagnostics without aborting when the TypeScript compiler fails on one file", async () => {
    const { collectTypeScriptSemanticDiagnostics } = await import("../packages/validation-typescript/dist/type-check.js");
    const repoRoot = "/repo";
    const crashedSource = ts.createSourceFile(
      `${repoRoot}/src/compiler-crash.ts`,
      "export const crashed: string = 'still checked';\n",
      ts.ScriptTarget.ES2022,
      true
    );
    const typeErrorSource = ts.createSourceFile(
      `${repoRoot}/src/type-error.ts`,
      "export const count: number = 'wrong';\n",
      ts.ScriptTarget.ES2022,
      true
    );

    const diagnostics = collectTypeScriptSemanticDiagnostics({
      repoRoot,
      sourceFiles: [crashedSource, typeErrorSource],
      getSemanticDiagnostics: (sourceFile) => {
        if (sourceFile.fileName.endsWith("/src/compiler-crash.ts")) {
          throw new RangeError("synthetic compiler stack overflow");
        }
        return [
          {
            category: ts.DiagnosticCategory.Error,
            code: 2322,
            file: typeErrorSource,
            start: 0,
            length: 1,
            messageText: "Type 'string' is not assignable to type 'number'."
          }
        ];
      }
    });

    assert.equal(diagnostics.some((diagnostic) => diagnostic.code === "2322"), true);
    assert.deepEqual(
      diagnostics.find((diagnostic) => diagnostic.code === "TS_SEMANTIC_DIAGNOSTICS_FAILED"),
      {
        category: "types",
        severity: "error",
        path: "src/compiler-crash.ts",
        code: "TS_SEMANTIC_DIAGNOSTICS_FAILED",
        message: "TypeScript semantic diagnostics failed for src/compiler-crash.ts: synthetic compiler stack overflow"
      }
    );
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
          packageName: "@the-open-engine/opcore-validation-typescript",
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
      [
        TYPE_SCRIPT_SYNTAX_CHECK_ID,
        TYPE_SCRIPT_TYPES_CHECK_ID,
        TYPE_SCRIPT_IMPORT_GRAPH_CHECK_ID,
        TYPE_SCRIPT_FUNCTION_METRICS_CHECK_ID,
        TYPE_SCRIPT_FILE_LENGTH_CHECK_ID
      ]
    );
    assert.deepEqual(
      result.manifest.skippedChecks.map((skip) => skip.checkId),
      [TYPE_SCRIPT_DEAD_CODE_CHECK_ID, TYPE_SCRIPT_RELEVANT_TESTS_CHECK_ID]
    );
  });

  it("reports one canonical TypeScript relative import cycle without a graph provider", async () => {
    const result = await runner({
      files: {
        "src/a.ts": "import { b } from './b';\nexport const a = b;\n",
        "src/b.ts": "import { a } from './a';\nexport const b = a;\n",
        "src/index.ts": "import { a } from './a';\nexport const value = a;\n"
      }
    }).runValidation(
      request({
        checks: [TYPE_SCRIPT_IMPORT_GRAPH_CHECK_ID]
      })
    );

    assert.equal(result.status, "passed", JSON.stringify(result.diagnostics, null, 2));
    assert.deepEqual(result.diagnostics, [
      {
        category: "graph",
        severity: "warning",
        path: "src/a.ts",
        code: "TS_IMPORT_GRAPH_CYCLE",
        message: "TypeScript import cycle detected: src/a.ts -> src/b.ts -> src/a.ts"
      }
    ]);
  });

  it("does not report TypeScript import cycles for an acyclic relative import graph", async () => {
    const result = await runner({
      files: {
        "src/a.ts": "import { b } from './b';\nexport const a = b;\n",
        "src/b.ts": "export const b = 1;\n",
        "src/index.ts": "import { a } from './a';\nexport const value = a;\n"
      }
    }).runValidation(
      request({
        checks: [TYPE_SCRIPT_IMPORT_GRAPH_CHECK_ID]
      })
    );

    assert.equal(result.status, "passed", JSON.stringify(result.diagnostics, null, 2));
    assert.deepEqual(result.diagnostics, []);
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
            provider: "opcore-graph"
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

  it("reports unreferenced source files and unused exported types from graph facts", async () => {
    const nodes = [
      {
        id: "file:src/index.ts",
        kind: "File",
        path: "src/index.ts",
        attributes: {
          language: "typescript"
        }
      },
      {
        id: "file:src/used.ts",
        kind: "File",
        path: "src/used.ts",
        attributes: {
          language: "typescript"
        }
      },
      {
        id: "file:src/orphan.ts",
        kind: "File",
        path: "src/orphan.ts",
        attributes: {
          language: "typescript"
        }
      },
      {
        id: "type:src/orphan.ts#ReferencedShape",
        kind: "Type",
        path: "src/orphan.ts",
        name: "ReferencedShape",
        attributes: {
          exported: true,
          exportKind: "named",
          exportName: "ReferencedShape"
        }
      },
      {
        id: "type:src/orphan.ts#LocalExtension",
        kind: "Type",
        path: "src/orphan.ts",
        name: "LocalExtension",
        attributes: {
          exported: false
        }
      },
      {
        id: "type:src/orphan.ts#UnusedShape",
        kind: "Type",
        path: "src/orphan.ts",
        name: "UnusedShape",
        attributes: {
          exported: true,
          exportKind: "named",
          exportName: "UnusedShape"
        }
      },
      {
        id: "variable:src/used.ts#used",
        kind: "Variable",
        path: "src/used.ts",
        name: "used",
        attributes: {
          exported: false
        }
      }
    ];
    const edges = [
      {
        kind: "IMPORTS_FROM",
        from: "file:src/index.ts",
        to: "file:src/used.ts"
      },
      {
        kind: "CONTAINS",
        from: "file:src/used.ts",
        to: "variable:src/used.ts#used"
      },
      {
        kind: "CONTAINS",
        from: "file:src/orphan.ts",
        to: "type:src/orphan.ts#ReferencedShape"
      },
      {
        kind: "CONTAINS",
        from: "file:src/orphan.ts",
        to: "type:src/orphan.ts#LocalExtension"
      },
      {
        kind: "CONTAINS",
        from: "file:src/orphan.ts",
        to: "type:src/orphan.ts#UnusedShape"
      },
      {
        kind: "INHERITS",
        from: "type:src/orphan.ts#LocalExtension",
        to: "type:src/orphan.ts#ReferencedShape"
      }
    ];

    const result = await runner({
      files: {
        "src/index.ts": "import './used';\n",
        "src/used.ts": "const used = 1;\nvoid used;\n",
        "src/orphan.ts":
          "export interface ReferencedShape { width: number; }\ninterface LocalExtension extends ReferencedShape { height: number; }\nexport interface UnusedShape { depth: number; }\n"
      },
      graphProviderClient: graphClient({
        status: (validationRequest) => ({
          ...availableStatus(validationRequest.graph.mode, validationRequest.repo),
          handshake: graphHandshake()
        }),
        factQuery: (query) =>
          availableFactResult(query, nodes, edges, {
            edgeKinds: ["CALLS", "CONTAINS", "IMPORTS_FROM", "INHERITS", "IMPLEMENTS", "TESTED_BY"]
          })
      })
    }).runValidation(
      request({
        checks: [TYPE_SCRIPT_DEAD_CODE_CHECK_ID],
        scope: {
          kind: "files",
          files: ["src/index.ts", "src/used.ts", "src/orphan.ts"]
        }
      })
    );

    assert.equal(result.status, "passed");
    assert.deepEqual(
      result.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.path, diagnostic.message]),
      [
        ["TS_DEAD_CODE_UNUSED_EXPORT", "src/orphan.ts", "Exported type has no incoming graph reference evidence: UnusedShape"],
        ["TS_DEAD_CODE_UNUSED_FILE", "src/orphan.ts", "Source file has no incoming IMPORTS_FROM graph evidence: src/orphan.ts"]
      ]
    );
  });

  it("reports unreferenced source files that import dependencies", async () => {
    const nodes = [
      {
        id: "file:src/dead-entry.ts",
        kind: "File",
        path: "src/dead-entry.ts",
        attributes: {
          language: "typescript"
        }
      },
      {
        id: "file:src/helper.ts",
        kind: "File",
        path: "src/helper.ts",
        attributes: {
          language: "typescript"
        }
      },
      {
        id: "function:src/dead-entry.ts#runDead",
        kind: "Function",
        path: "src/dead-entry.ts",
        name: "runDead",
        attributes: {
          exported: false
        }
      },
      {
        id: "function:src/helper.ts#helper",
        kind: "Function",
        path: "src/helper.ts",
        name: "helper",
        attributes: {
          exported: false
        }
      }
    ];
    const edges = [
      {
        kind: "CONTAINS",
        from: "file:src/dead-entry.ts",
        to: "function:src/dead-entry.ts#runDead"
      },
      {
        kind: "CONTAINS",
        from: "file:src/helper.ts",
        to: "function:src/helper.ts#helper"
      },
      {
        kind: "IMPORTS_FROM",
        from: "file:src/dead-entry.ts",
        to: "file:src/helper.ts"
      }
    ];

    const result = await runner({
      files: {
        "src/dead-entry.ts": "import { helper } from './helper';\nfunction runDead() { return helper(); }\nvoid runDead;\n",
        "src/helper.ts": "export function helper() { return 1; }\n"
      },
      graphProviderClient: graphClient({
        status: (validationRequest) => ({
          ...availableStatus(validationRequest.graph.mode, validationRequest.repo),
          handshake: graphHandshake()
        }),
        factQuery: (query) =>
          availableFactResult(query, nodes, edges, {
            edgeKinds: ["CALLS", "CONTAINS", "IMPORTS_FROM", "TESTED_BY"]
          })
      })
    }).runValidation(
      request({
        checks: [TYPE_SCRIPT_DEAD_CODE_CHECK_ID],
        scope: {
          kind: "files",
          files: ["src/dead-entry.ts", "src/helper.ts"]
        }
      })
    );

    assert.equal(result.status, "passed");
    assert.deepEqual(
      result.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.path, diagnostic.message]),
      [["TS_DEAD_CODE_UNUSED_FILE", "src/dead-entry.ts", "Source file has no incoming IMPORTS_FROM graph evidence: src/dead-entry.ts"]]
    );
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

      const graphBuild = spawnSync(process.execPath, ["packages/opcore/dist/advanced/index.js", "graph", "build", "--repo", repo, "--json"], {
        cwd: process.cwd(),
        encoding: "utf8"
      });
      assert.equal(graphBuild.status, 0, graphBuild.stderr || graphBuild.stdout);

      const check = spawnSync(
        process.execPath,
        [
          "packages/opcore/dist/advanced/index.js",
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
      assert.deepEqual(
        payload.validationResult.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.path]),
        [
          ["TS_DEAD_CODE_UNSUPPORTED", undefined],
          ["TS_DEAD_CODE_UNUSED_FILE", "src/index.ts"]
        ]
      );
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

      const graphBuild = spawnSync(process.execPath, ["packages/opcore/dist/advanced/index.js", "graph", "build", "--repo", repo, "--json"], {
        cwd: process.cwd(),
        encoding: "utf8"
      });
      assert.equal(graphBuild.status, 0, graphBuild.stderr || graphBuild.stdout);

      const nodeQuery = spawnSync(
        process.execPath,
        ["packages/opcore/dist/advanced/index.js", "graph", "query", "--repo", repo, "--kind", "nodes", "--json"],
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
          "packages/opcore/dist/advanced/index.js",
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

      const graphBuild = spawnSync(process.execPath, ["packages/opcore/dist/advanced/index.js", "graph", "build", "--repo", repo, "--json"], {
        cwd: process.cwd(),
        encoding: "utf8"
      });
      assert.equal(graphBuild.status, 0, graphBuild.stderr || graphBuild.stdout);

      const nodeQuery = spawnSync(
        process.execPath,
        ["packages/opcore/dist/advanced/index.js", "graph", "query", "--repo", repo, "--kind", "nodes", "--json"],
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
          "packages/opcore/dist/advanced/index.js",
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

      const graphBuild = spawnSync(process.execPath, ["packages/opcore/dist/advanced/index.js", "graph", "build", "--repo", repo, "--json"], {
        cwd: process.cwd(),
        encoding: "utf8"
      });
      assert.equal(graphBuild.status, 0, graphBuild.stderr || graphBuild.stdout);

      const edgeQuery = spawnSync(
        process.execPath,
        ["packages/opcore/dist/advanced/index.js", "graph", "query", "--repo", repo, "--kind", "edges", "--json"],
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
          "packages/opcore/dist/advanced/index.js",
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

      const graphBuild = spawnSync(process.execPath, ["packages/opcore/dist/advanced/index.js", "graph", "build", "--repo", repo, "--json"], {
        cwd: process.cwd(),
        encoding: "utf8"
      });
      assert.equal(graphBuild.status, 0, graphBuild.stderr || graphBuild.stdout);

      const edgeQuery = spawnSync(
        process.execPath,
        ["packages/opcore/dist/advanced/index.js", "graph", "query", "--repo", repo, "--kind", "edges", "--json"],
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
          "packages/opcore/dist/advanced/index.js",
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

      const graphBuild = spawnSync(process.execPath, ["packages/opcore/dist/advanced/index.js", "graph", "build", "--repo", repo, "--json"], {
        cwd: process.cwd(),
        encoding: "utf8"
      });
      assert.equal(graphBuild.status, 0, graphBuild.stderr || graphBuild.stdout);

      const edgeQuery = spawnSync(
        process.execPath,
        ["packages/opcore/dist/advanced/index.js", "graph", "query", "--repo", repo, "--kind", "edges", "--json"],
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
        ["packages/opcore/dist/advanced/index.js", "graph", "query", "--repo", repo, "--kind", "nodes", "--json"],
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
          "packages/opcore/dist/advanced/index.js",
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
        ["TS_DEAD_CODE_UNUSED_FILE"]
      );
      assert.equal(
        payload.validationResult.diagnostics.some((diagnostic) => diagnostic.code === "TS_DEAD_CODE_UNUSED_EXPORT"),
        false
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
        checks: [TYPE_SCRIPT_DEAD_CODE_CHECK_ID],
        graph: {
          mode: "required",
          provider: "opcore-graph"
        }
      })
    );

    assert.equal(result.status, "provider_failure");
    assert.equal(result.failure.category, "provider_failure");
  });

  it("maps required TypeScript import-graph query failures to runner provider_failure", async () => {
    const result = await runner({
      files: {
        "src/a.ts": "import { b } from './b';\nexport const a = b;\n",
        "src/b.ts": "export const b = 1;\n"
      },
      graphProviderClient: graphClient({
        status: (validationRequest) => availableStatus(validationRequest.graph.mode, validationRequest.repo),
        factQuery: () => ({
          status: graphFailure("error", "query_failed", "required")
        })
      })
    }).runValidation(
      request({
        checks: [TYPE_SCRIPT_IMPORT_GRAPH_CHECK_ID],
        scope: {
          kind: "files",
          files: ["src/a.ts", "src/b.ts"]
        },
        graph: {
          mode: "required",
          provider: "opcore-graph"
        }
      })
    );

    assert.equal(result.status, "provider_failure");
    assert.equal(result.failure.category, "provider_failure");
  });

  it("queries retained TypeScript import graph edges once without per-file provider calls", async () => {
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
    assert.equal(factQueries.length, 1);
    assert.deepEqual(factQueries[0].selector, {
      kind: "edges",
      edgeKinds: ["IMPORTS_FROM"]
    });
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
      repoId: "opcore"
    },
    scope: {
      kind: "files",
      files: ["src/index.ts"]
    },
    graph: {
      mode: "optional",
      provider: "opcore-graph"
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
      packageName === "@the-open-engine/opcore-validation-typescript" ? "packages/validation-typescript" : undefined
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

function numberedTypeScriptLines(count) {
  return Array.from({ length: count }, (_entry, index) => `export const value${index} = ${index};`).join("\n") + "\n";
}

function listTypeScriptBuildInfoFiles(repo) {
  const directory = join(repo, ".opcore/typescript-build-info");
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((entry) => entry.endsWith(".tsbuildinfo"))
    .sort();
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

function availableStatus(mode = "optional", repo = { repoId: "opcore" }) {
  return {
    state: "available",
    mode,
    provider: "opcore-graph",
    schemaVersion: 1,
    repo,
    freshness: freshness(),
    nodes_by_kind: {},
    edges_by_kind: {}
  };
}

function graphHandshake(overrides = {}) {
  return {
    provider: "opcore-graph",
    graphSchemaVersion: 1,
    artifactName: "opcore-graph-core",
    artifactVersion: "0.1.0",
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
      "inheritors_of",
      "children_of",
      "file_summary",
      "review_context",
      "detect_changes",
      "search"
    ],
    artifact: {
      artifactName: "opcore-graph-core",
      artifactVersion: "0.1.0",
      targetPlatform: "test",
      binaryPath: "dist/native/test/opcore-graph-core",
      checksumPath: "dist/native/test/opcore-graph-core.sha256",
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
    provider: "opcore-graph",
    schemaVersion: 1,
    failure: {
      category,
      message: `${state} failure`
    }
  };
  if (state === "stale" || state === "schema_mismatch" || state === "daemon_unavailable") {
    status.repo = {
      repoId: "opcore"
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
      provider: "opcore-graph",
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
