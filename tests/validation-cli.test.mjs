import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { routeCommand } from "../packages/opcore/dist/advanced/index.js";
import { routeOpcoreCommand } from "../packages/opcore/dist/index.js";
import { fakeCargoScript, writeFakeRustToolchain } from "./helpers/validation-rust-fixtures.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const opcoreBin = fileURLToPath(new URL("../packages/opcore/dist/index.js", import.meta.url));
const latticeBin = fileURLToPath(new URL("../packages/opcore/dist/advanced/index.js", import.meta.url));
const typeScriptCheckIds = [
  "typescript.syntax",
  "typescript.types",
  "typescript.lint",
  "typescript.import-graph",
  "typescript.dead-code",
  "typescript.function-metrics",
  "typescript.relevant-tests",
  "typescript.file-length"
];
const rustCheckIds = [
  "rust.source-hygiene",
  "rust.fmt",
  "rust.cargo-check",
  "rust.clippy",
  "rust.rustdoc",
  "rust.import-graph",
  "rust.dead-code",
  "rust.graph-signals",
  "rust.unused-deps",
  "rust.file-length",
  "rust.function-metrics"
];
const pythonCheckIds = [
  "python.syntax",
  "python.source-hygiene",
  "python.types",
  "python.import-graph",
  "python.dead-code",
  "python.relevant-tests"
];
const optInPythonCheckIds = ["python.ruff-lint", "python.ruff-format"];
const docsCheckIds = [
  "docs.existence",
  "docs.staleness",
  "docs.freshness",
  "docs.length",
  "docs.dry",
  "docs.content-quality",
  "docs.code-blocks",
  "docs.rules-why",
  "docs.hub-coverage",
  "docs.subtree-coverage"
];
const cloneCheckIds = ["clone.duplication"];
const typeScriptExecutableDefaultCheckIds = typeScriptCheckIds.filter((checkId) => checkId !== "typescript.lint");
const executableDefaultCheckIds = [...typeScriptExecutableDefaultCheckIds, ...rustCheckIds, ...pythonCheckIds, ...cloneCheckIds];
const defaultCheckIds = [...typeScriptCheckIds, ...rustCheckIds, ...pythonCheckIds, ...docsCheckIds, ...cloneCheckIds];
const availableCheckIds = [
  ...typeScriptCheckIds,
  ...rustCheckIds,
  pythonCheckIds[0],
  pythonCheckIds[1],
  ...optInPythonCheckIds,
  ...pythonCheckIds.slice(2),
  ...docsCheckIds,
  ...cloneCheckIds
];

describe("validation CLI", () => {
  it("keeps opcore status separate from validation execution results", async () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-validation-status-"));
    try {
      mkdirSync(join(temp, "src"), { recursive: true });
      writeFileSync(join(temp, "src/index.ts"), "export const value = 1;\n");

      const result = await routeOpcoreCommand(["status", "--repo", temp, "--json"]);

      assert.equal(result.status, "ok");
      assert.deepEqual(result.canonicalCommand, ["opcore", "status"]);
      assert.equal(result.repoState.validation.checkCount, availableCheckIds.length);
      assert.equal(result.repoState.validation.policy.state, "missing");
      assert.deepEqual(result.repoState.validation.policy.configuredChecks, executableDefaultCheckIds);
      assert.equal(Object.hasOwn(result, "validationResult"), false);
      assert.equal(Object.hasOwn(result, "validationStatus"), false);
      assertCommandTiming(result);

      const compatible = run(["status", "--json"]);
      assert.deepEqual(compatible.canonicalCommand, ["opcore", "status"]);
      assert.equal(compatible.validationStatus.adapterRegistry.checkIds.length, availableCheckIds.length);
      assert.deepEqual(compatible.validationStatus.adapterRegistry.checkIds, availableCheckIds);
      assert.equal(Object.hasOwn(compatible, "repoState"), false);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("reports native validation policy readiness in status and doctor", async () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-validation-policy-status-"));
    try {
      mkdirSync(join(temp, "src"), { recursive: true });
      mkdirSync(join(temp, "checks"), { recursive: true });
      writeFileSync(join(temp, "src/index.ts"), "export const value = 1;\n");
      writeCheckPack(temp, join(temp, "checks/policy.cjs"), "example.policy");
      writeRepoConfigObject(temp, {
        schemaVersion: 1,
        kind: "opcore_init_config",
        validation: {
          checks: {
            packs: ["./checks/policy.cjs"],
            disabled: ["typescript.types"],
            defaults: ["docs.existence"]
          }
        }
      });

      const status = await routeOpcoreCommand(["status", "--repo", temp, "--json"]);
      assert.equal(status.status, "ok");
      assert.equal(status.repoState.validation.policy.state, "loaded");
      assert.deepEqual(status.repoState.validation.policy.adapters, []);
      assert.deepEqual(status.repoState.validation.policy.packs, ["./checks/policy.cjs"]);
      assert.deepEqual(status.repoState.validation.policy.disabledChecks, ["typescript.types"]);
      assert.deepEqual(status.repoState.validation.policy.defaultChecks, ["docs.existence"]);
      assert.equal(status.repoState.validation.policy.configuredChecks.includes("typescript.types"), false);
      assert.equal(status.repoState.validation.policy.configuredChecks.includes("example.policy"), true);

      const doctor = await routeOpcoreCommand(["doctor", "--repo", temp, "--json"]);
      assert.equal(doctor.status, "ok");
      assert.deepEqual(doctor.opcoreDoctor.policy, status.repoState.validation.policy);
      assert.equal(doctor.opcoreDoctor.checks.ids.includes("example.policy"), true);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("runs check files routes and returns typed validation results", () => {
    for (const args of [
      ["check", "--files", "packages/contracts/src/index.ts", "--json"],
      ["check", "files", "--files", "packages/contracts/src/index.ts", "--json"]
    ]) {
      const result = run(args, [0, 1]);
      assert.equal(result.owner, "validation");
      assert.equal(result.exitCode === 0 || result.exitCode === 1, true);
      assert.deepEqual(result.validationResult.manifest.checks, executableDefaultCheckIds);
      assert.equal(Object.hasOwn(result.validationResult.manifest, "entries"), false);
      assert.equal(Object.hasOwn(result.validationResult.manifest, "runs"), false);
      assert.equal(Object.hasOwn(result.validationResult.manifest, "skippedChecks"), false);
      assert.equal(result.timing.phases.some((phase) => phase.phase === "validation_typescript_syntax"), true);
    }
  });

  it("runs staged, changed, tree, and all scopes", () => {
    const staged = run(["check", "staged", "--check", "typescript.syntax", "--json"], [0, 1]);
    const changed = run(["check", "changed", "--base", "HEAD", "--check", "typescript.syntax", "--json"], [0, 1]);
    const tree = run(["check", "tree", "--tree", "HEAD", "--changed-from", "HEAD", "--check", "typescript.syntax", "--json"]);
    const all = run(["check", "all", "--check", "typescript.syntax", "--json"], [0, 1]);

    assert.equal(staged.owner, "validation");
    assert.equal(changed.owner, "validation");
    assert.equal(tree.owner, "validation");
    assert.equal(all.owner, "validation");
    assert.equal(staged.validationResult.manifest.checks[0], "typescript.syntax");
    assert.equal(changed.validationResult.manifest.checks[0], "typescript.syntax");
    assert.equal(tree.validationResult.manifest.checks[0], "typescript.syntax");
    assert.equal(all.validationResult.manifest.checks[0], "typescript.syntax");
  });

  it("keeps validation stream stdout parseable when --json is omitted", () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-validation-stream-"));
    try {
      mkdirSync(join(temp, "src"));
      writeFileSync(join(temp, "src/index.ts"), "export const value = 1;\n");

      for (const streamFlag of ["--stream", "--ndjson"]) {
        const result = runRaw([
          "check",
          "files",
          "--files",
          "src/index.ts",
          "--repo",
          temp,
          "--check",
          "typescript.syntax",
          streamFlag
        ]);
        assert.equal(result.stderr, "");
        assert.equal(result.stdout.split(/\r?\n/).includes("opcore validation complete."), false);
        const records = parseNdjson(result.stdout);
        assert.equal(records.length >= 2, true, result.stdout);
        assert.equal(records[0].kind, "validation.check");
        const finalRecord = records.at(-1);
        assert.equal(finalRecord.owner, "validation");
        assert.deepEqual(finalRecord.canonicalCommand.slice(0, 3), ["opcore", "check", "files"]);
        assert.equal(finalRecord.validationResult.status, "passed");
      }
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("suppresses pre-existing oversized TypeScript files on public changed checks", async () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-validation-cli-file-length-"));
    try {
      mkdirSync(join(temp, "src"), { recursive: true });
      writeFileSync(join(temp, "src/large.ts"), numberedTypeScriptLines(301));
      initializeGitSnapshot(temp, ["src/large.ts"]);
      writeFileSync(join(temp, "src/large.ts"), numberedTypeScriptLines(302));

      const result = await routeOpcoreCommand([
        "check",
        "--changed",
        "--repo",
        temp,
        "--check",
        "typescript.file-length",
        "--json"
      ]);

      assert.equal(result.status, "ok");
      assert.equal(result.exitCode, 0);
      assert.equal(result.validationResult.status, "passed", JSON.stringify(result.validationResult.diagnostics, null, 2));
      assert.deepEqual(result.validationResult.diagnostics, []);
      assert.deepEqual(result.validationResult.manifest.checks, ["typescript.file-length"]);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("checks committed tree content instead of dirty worktree content", () => {
    const temp = mkdtempSync(join(tmpdir(), "lattice-validation-cli-tree-"));
    try {
      mkdirSync(join(temp, "src"));
      writeFileSync(join(temp, "src/tree.ts"), "export const value: string = 'base';\n");
      const baseCommit = initializeGitSnapshot(temp, ["src/tree.ts"]);
      writeFileSync(join(temp, "src/tree.ts"), "export const value: string = 'tree';\n");
      const treeCommit = commitWorktreeFile(temp, "src/tree.ts", "tree");
      writeFileSync(join(temp, "src/tree.ts"), "export const value: string = 1;\n");

      const result = run([
        "check",
        "tree",
        "--tree",
        treeCommit,
        "--changed-from",
        baseCommit,
        "--repo",
        temp,
        "--check",
        "typescript.types",
        "--json"
      ]);

      assert.equal(result.validationResult.status, "passed", JSON.stringify(result.validationResult, null, 2));
      assert.equal(readFileSync(join(temp, "src/tree.ts"), "utf8"), "export const value: string = 1;\n");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("returns check and validate manifests with stable TypeScript, Rust, and Python check ids", () => {
    for (const args of [
      ["check", "manifest", "--json"],
      ["validate", "manifest", "--json"]
    ]) {
      const result = run(args);
      assert.equal(result.status, "ok");
      assert.deepEqual(
        result.validationResult.manifest.entries.map((entry) => entry.checkId),
        availableCheckIds
      );
      for (const checkId of ["rust.fmt", "rust.cargo-check", "rust.clippy"]) {
        assert.equal(result.validationResult.manifest.checks.includes(checkId), true, checkId);
      }
      assert.equal(result.validationResult.manifest.checks.includes("rust.file-length"), true);
      assert.equal(result.validationResult.manifest.checks.includes("python.syntax"), true);
      assert.equal(result.validationResult.manifest.checks.includes("python.import-graph"), true);
      assert.equal(result.validationResult.manifest.checks.includes("docs.existence"), true);
    }
  });

  it("loads repo configured validation check packs", () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-check-pack-"));
    try {
      writeRepoConfig(temp, ["./checks/example-check-pack.cjs"]);
      writeCheckPack(temp, join(temp, "checks/example-check-pack.cjs"), "example.policy");

      const manifest = JSON.parse(runRaw(["check", "manifest", "--repo", temp, "--json"]).stdout);
      assert.equal(manifest.validationResult.manifest.checks.includes("example.policy"), true);
      const equalsManifest = JSON.parse(runRaw(["check", "manifest", `--repo=${temp}`, "--json"]).stdout);
      assert.equal(equalsManifest.validationResult.manifest.checks.includes("example.policy"), true);
      const relativeManifest = JSON.parse(runRaw(["check", "manifest", "--repo", ".", "--json"], [0], { cwd: temp }).stdout);
      assert.equal(relativeManifest.validationResult.manifest.checks.includes("example.policy"), true);
      const relativeEqualsManifest = JSON.parse(runRaw(["check", "manifest", "--repo=.", "--json"], [0], { cwd: temp }).stdout);
      assert.equal(relativeEqualsManifest.validationResult.manifest.checks.includes("example.policy"), true);
      const advancedRelativeManifest = run(["check", "manifest", "--repo", ".", "--json"], [0], { cwd: temp });
      assert.equal(advancedRelativeManifest.validationResult.manifest.checks.includes("example.policy"), true);
      const advancedValidateManifest = run(["validate", "manifest", "--repo=.", "--json"], [0], { cwd: temp });
      assert.equal(advancedValidateManifest.validationResult.manifest.checks.includes("example.policy"), true);
      const validateManifest = run(["validate", "manifest", "--repo", temp, "--json"]);
      assert.equal(validateManifest.validationResult.manifest.checks.includes("example.policy"), true);

      const result = JSON.parse(
        runRaw(
          ["check", "files", "--files", "src/index.ts", "--repo", temp, "--checks", "example.policy", "--json"],
          [1]
        ).stdout
      );
      assert.equal(result.validationResult.status, "policy_failure");
      assert.equal(result.validationResult.diagnostics[0].code, "example.policy");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("normalizes repo validation config", async () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-validation-config-"));
    try {
      writeRepoConfigObject(temp, {
        schemaVersion: 1,
        kind: "opcore_init_config",
        onboarding: {
          scan: {
            totalFiles: 1
          }
        },
        validation: {
          adapters: ["typescript", "rust", "docs", "clone"],
          timeoutMs: 120000,
          pathPolicy: {
            include: ["packages/", "scripts/"],
            exclude: ["dist/**", ".ace"]
          },
          checks: {
            packs: ["./checks/policy.cjs"],
            disabled: ["typescript.types"],
            defaults: ["docs.existence", "docs.freshness"],
            typescript: {
              fileLength: {
                maxFileLines: 600
              },
              functionMetrics: {
                maxFunctionLines: 120,
                maxComplexity: 10,
                maxParams: 4
              },
              lint: {
                repoPlugin: "./eslint-local-rules/index.js",
                cacheDependencyGlobs: ["CLAUDE.md", "**/CLAUDE.md"]
              },
              importGraph: {
                ignoreTypeOnlyImports: true,
                layerRules: [
                  {
                    name: "no-client-to-server",
                    from: "%/client/src/%",
                    to: "%/server/%"
                  }
                ]
              },
              deadCode: {
                entrypoints: ["scripts/build-package.mjs"]
              }
            },
            rust: {
              fileLength: {
                maxFileLines: 500
              },
              functionMetrics: {
                maxFunctionLines: 80,
                maxComplexity: 10,
                maxParams: 4
              },
              commandGates: [
                {
                  id: "rust-gate.test",
                  command: "cargo",
                  args: ["test"],
                  cwd: ".",
                  timeoutMs: 120000
                }
              ]
            },
            docs: {
              enabled: {
                existence: true,
                freshness: true,
                staleness: false,
                length: true,
                hubCoverage: true,
                subtreeCoverage: true
              },
              policy: {
                filenames: ["CLAUDE.md", "AGENTS.md"],
                requiredPaths: ["."],
                requireRoot: true,
                minimumContentLength: 1,
                maxLines: 220,
                maxSectionLines: 80
              },
              history: {
                maxStaleDays: 90
              },
              hubCoverage: {
                minFanIn: 5,
                minFanOut: 5,
                requireExplicitMention: true
              },
              subtreeCoverage: {
                minLoc: 20000
              }
            },
            clone: {
              windowSize: 16,
              minLines: 16,
              threshold: 5,
              partitions: [["server", "shared"], ["client"], ["platform-cli"]],
              exclude: ["docs/**"],
              modes: ["staged", "changed", "files"]
            }
          }
        }
      });

      const { readOpcoreRepoConfig } = await import("../packages/opcore/dist/repo-validation-config.js");
      const config = readOpcoreRepoConfig(temp);

      assert.deepEqual(config.validation.adapters, ["typescript", "rust", "docs", "clone"]);
      assert.equal(config.validation.timeoutMs, 120000);
      assert.deepEqual(config.validation.pathPolicy, {
        include: ["packages/", "scripts/"],
        exclude: ["dist/**", ".ace"]
      });
      assert.deepEqual(config.validation.checks.packs, ["./checks/policy.cjs"]);
      assert.deepEqual(config.validation.checks.disabled, ["typescript.types"]);
      assert.deepEqual(config.validation.checks.defaults, ["docs.existence", "docs.freshness"]);
      assert.equal(config.validation.checks.typescript.fileLength.maxFileLines, 600);
      assert.equal(config.validation.checks.typescript.functionMetrics.maxFunctionLines, 120);
      assert.equal(config.validation.checks.typescript.importGraph.ignoreTypeOnlyImports, true);
      assert.deepEqual(config.validation.checks.typescript.importGraph.layerRules, [
        {
          name: "no-client-to-server",
          from: "%/client/src/%",
          to: "%/server/%"
        }
      ]);
      assert.deepEqual(config.validation.checks.typescript.deadCode.entrypoints, ["scripts/build-package.mjs"]);
      assert.equal(config.validation.checks.rust.fileLength.maxFileLines, 500);
      assert.equal(config.validation.checks.rust.commandGates[0].id, "rust-gate.test");
      assert.equal(config.validation.checks.docs.policy.maxLines, 220);
      assert.equal(config.validation.checks.docs.hubCoverage.minFanOut, 5);
      assert.equal(config.validation.checks.docs.subtreeCoverage.minLoc, 20000);
      assert.deepEqual(config.validation.checks.clone.partitions, [["server", "shared"], ["client"], ["platform-cli"]]);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("normalizes native check pack config into repo validation config", async () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-validation-config-packs-"));
    try {
      writeRepoConfig(temp, ["./checks/policy.cjs"]);

      const { readOpcoreRepoConfig } = await import("../packages/opcore/dist/repo-validation-config.js");
      const config = readOpcoreRepoConfig(temp);

      assert.deepEqual(config.validation.checks.packs, ["./checks/policy.cjs"]);
      assert.deepEqual(config.validation.checks.disabled, []);
      assert.deepEqual(config.validation.checks.defaults, []);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("rejects invalid repo validation config", async () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-validation-config-invalid-"));
    try {
      const { readOpcoreRepoConfig } = await import("../packages/opcore/dist/repo-validation-config.js");

      writeRepoConfigObject(temp, {
        schemaVersion: 1,
        kind: "opcore_init_config",
        validation: {
          adapters: ["typescript", "unknown"]
        }
      });
      assert.throws(() => readOpcoreRepoConfig(temp), /validation\.adapters\[1\]/);

      writeRepoConfigObject(temp, {
        schemaVersion: 1,
        kind: "opcore_init_config",
        validation: {
          timeoutMs: 0
        }
      });
      assert.throws(() => readOpcoreRepoConfig(temp), /validation\.timeoutMs/);

      writeRepoConfigObject(temp, {
        schemaVersion: 1,
        kind: "opcore_init_config",
        validation: {
          checks: {
            disabled: ["typescript.syntax", "  "]
          }
        }
      });
      assert.throws(() => readOpcoreRepoConfig(temp), /validation\.checks\.disabled\[1\]/);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("applies repo path policy include and exclude patterns", async () => {
    const { pathPolicyIncludes } = await import("../packages/opcore/dist/path-policy.js");
    const policy = {
      include: ["packages/", "scripts/"],
      exclude: ["dist/**", ".ace", ".agents", "packages/generated/**"]
    };

    assert.equal(pathPolicyIncludes("packages/opcore/src/index.ts", policy), true);
    assert.equal(pathPolicyIncludes("scripts/build.mjs", policy), true);
    assert.equal(pathPolicyIncludes("docs/notes.ts", policy), false);
    assert.equal(pathPolicyIncludes("dist/index.js", policy), false);
    assert.equal(pathPolicyIncludes(".ace/runtime/tool.json", policy), false);
    assert.equal(pathPolicyIncludes(".agents/skills/opcore/SKILL.md", policy), false);
    assert.equal(pathPolicyIncludes("packages/generated/output.ts", policy), false);
    assert.equal(pathPolicyIncludes("../outside.ts", policy), false);
    assert.equal(pathPolicyIncludes("/tmp/outside.ts", policy), false);
  });

  it("filters validation file view collections through repo path policy", async () => {
    const { withFilteredFileView } = await import("../packages/opcore/dist/path-policy.js");
    let listVisibleFileCalls = 0;
    const context = {
      fileView: {
        scopeFiles: ["packages/src/index.ts", "docs/notes.ts", "dist/index.js"],
        listVisibleFiles: async () => {
          listVisibleFileCalls += 1;
          return ["packages/src/index.ts", "scripts/build.mjs", "docs/notes.ts", ".ace/runtime.json"];
        },
        overlays: [
          { path: "packages/src/index.ts", action: "write", content: "export const value = 1;\n" },
          { path: "docs/notes.ts", action: "write", content: "export const value = 2;\n" },
          { path: ".agents/skill.ts", action: "write", content: "export const value = 3;\n" }
        ],
        readAfter: async (path) => ({ status: "found", content: path, sourceMetadata: { source: "workspace" } }),
        readBefore: async (path) => ({ status: "found", content: path, sourceMetadata: { source: "workspace" } }),
        overlayFor(path) {
          return this.overlays.find((overlay) => overlay.path === path);
        }
      }
    };

    const filtered = withFilteredFileView(context, {
      include: ["packages/", "scripts/"],
      exclude: ["dist/**", ".ace", ".agents"]
    });
    assert.equal(listVisibleFileCalls, 0);

    assert.deepEqual(filtered.fileView.scopeFiles, ["packages/src/index.ts"]);
    assert.deepEqual(await filtered.fileView.listVisibleFiles(), ["packages/src/index.ts", "scripts/build.mjs"]);
    assert.deepEqual(await filtered.fileView.listVisibleFiles(), ["packages/src/index.ts", "scripts/build.mjs"]);
    assert.equal(listVisibleFileCalls, 1);
    assert.deepEqual(filtered.fileView.overlays.map((overlay) => overlay.path), ["packages/src/index.ts"]);
    assert.equal(filtered.fileView.overlayFor("docs/notes.ts"), undefined);
    assert.equal(filtered.fileView.overlayFor("packages/src/index.ts")?.content, "export const value = 1;\n");
  });

  it("honors repo configured built-in thresholds and disabled checks", () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-check-config-policy-"));
    try {
      mkdirSync(join(temp, "src"), { recursive: true });
      writeFileSync(join(temp, "src/index.ts"), "const value: string = 1;\nexport { value };\nexport const extra = 2;\n");
      writeRepoConfigObject(temp, {
        schemaVersion: 1,
        kind: "opcore_init_config",
        validation: {
          checks: {
            disabled: ["typescript.types"],
            typescript: {
              fileLength: {
                maxFileLines: 2
              }
            }
          }
        }
      });

      const result = JSON.parse(runRaw(["check", "files", "--files", "src/index.ts", "--repo", temp, "--json"], [1]).stdout);

      assert.equal(result.validationResult.manifest.checks.includes("typescript.types"), false);
      assert.equal(result.validationResult.diagnostics.some((diagnostic) => diagnostic.code === "TS2322"), false);
      assert.deepEqual(
        result.validationResult.diagnostics
          .filter((diagnostic) => diagnostic.code === "TS_FILE_LINES")
          .map((diagnostic) => diagnostic.message),
        ["TypeScript file has 3 lines; max is 2."]
      );
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("applies configured TypeScript dead-code entrypoints", () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-configured-typescript-entrypoints-"));
    try {
      mkdirSync(join(temp, "src"), { recursive: true });
      writeFileSync(
        join(temp, "tsconfig.json"),
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
      writeFileSync(join(temp, "src/main.ts"), "export function main() { return 1; }\nvoid main;\n");

      const graphBuild = run(["graph", "build", "--repo", temp, "--json"]);
      assert.equal(graphBuild.status, "ok");

      const baseline = JSON.parse(
        runRaw([
          "check",
          "files",
          "--files",
          "src/main.ts",
          "--repo",
          temp,
          "--check",
          "typescript.dead-code",
          "--graph-mode",
          "required",
          "--json"
        ]).stdout
      );
      assert.equal(
        baseline.validationResult.diagnostics.some((diagnostic) => diagnostic.code === "TS_DEAD_CODE_UNUSED_FILE"),
        true,
        JSON.stringify(baseline.validationResult.diagnostics, null, 2)
      );

      writeRepoConfigObject(temp, {
        schemaVersion: 1,
        kind: "opcore_init_config",
        validation: {
          checks: {
            typescript: {
              deadCode: {
                entrypoints: ["src/main.ts"]
              }
            }
          }
        }
      });

      const configured = JSON.parse(
        runRaw([
          "check",
          "files",
          "--files",
          "src/main.ts",
          "--repo",
          temp,
          "--check",
          "typescript.dead-code",
          "--graph-mode",
          "required",
          "--json"
        ]).stdout
      );

      assert.equal(configured.validationResult.status, "passed", JSON.stringify(configured.validationResult, null, 2));
      assert.equal(
        configured.validationResult.diagnostics.some((diagnostic) => diagnostic.code === "TS_DEAD_CODE_UNUSED_FILE"),
        false,
        JSON.stringify(configured.validationResult.diagnostics, null, 2)
      );
      assert.equal(
        configured.validationResult.diagnostics.some((diagnostic) => diagnostic.code === "TS_DEAD_CODE_UNUSED_EXPORT"),
        false,
        JSON.stringify(configured.validationResult.diagnostics, null, 2)
      );
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("applies configured TypeScript repo lint plugin", () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-configured-typescript-lint-plugin-"));
    try {
      mkdirSync(join(temp, "src"), { recursive: true });
      mkdirSync(join(temp, "eslint-local-rules"), { recursive: true });
      writeFileSync(join(temp, "src/index.ts"), "const forbidden = 1;\nvoid forbidden;\n");
      writeFileSync(
        join(temp, "eslint-local-rules/index.cjs"),
        `
          module.exports = {
            rules: {
              "no-forbidden-ident": {
                run({ traverse, report }) {
                  traverse((node) => {
                    if (node.type === "Identifier" && node.name === "forbidden") {
                      report({ node, message: "Forbidden identifier is not allowed." });
                    }
                  });
                }
              }
            }
          };
        `
      );
      writeFileSync(join(temp, "AGENTS.md"), "policy dependencies\n");
      writeRepoConfigObject(temp, {
        schemaVersion: 1,
        kind: "opcore_init_config",
        validation: {
          checks: {
            typescript: {
              lint: {
                repoPlugin: "./eslint-local-rules/index.cjs",
                cacheDependencyGlobs: ["AGENTS.md", "eslint-local-rules/**/*.cjs"]
              }
            }
          }
        }
      });

      const result = JSON.parse(
        runRaw([
          "check",
          "files",
          "--files",
          "src/index.ts",
          "--repo",
          temp,
          "--check",
          "typescript.lint-plugin",
          "--json"
        ], [1]).stdout
      );

      assert.equal(result.validationResult.status, "policy_failure", JSON.stringify(result.validationResult, null, 2));
      assert.deepEqual(
        result.validationResult.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.path, diagnostic.message]),
        [
          ["TS_LINT_PLUGIN_NO_FORBIDDEN_IDENT", "src/index.ts", "Forbidden identifier is not allowed."],
          ["TS_LINT_PLUGIN_NO_FORBIDDEN_IDENT", "src/index.ts", "Forbidden identifier is not allowed."]
        ]
      );
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("uses repo validation policy for advanced check routes", () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-check-config-advanced-"));
    try {
      mkdirSync(join(temp, "src"), { recursive: true });
      writeFileSync(join(temp, "src/index.ts"), "export const value = 1;\n");
      initializeGitSnapshot(temp, ["src/index.ts"]);
      writeRepoConfigObject(temp, {
        schemaVersion: 1,
        kind: "opcore_init_config",
        validation: {
          checks: {
            disabled: ["typescript.types"],
            defaults: ["docs.existence"]
          }
        }
      });

      const result = run(["check", "all", "--repo", temp, "--json"], [1]);

      assert.equal(result.validationResult.manifest.checks.includes("typescript.types"), false);
      assert.equal(result.validationResult.manifest.checks.includes("docs.existence"), true);
      assert.equal(result.validationResult.diagnostics.some((diagnostic) => diagnostic.code === "DOCS_REQUIRED_CONTEXT_DOC_MISSING"), true);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("uses repo validation policy for opcore scan", async () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-scan-config-policy-"));
    try {
      mkdirSync(join(temp, "src"), { recursive: true });
      writeFileSync(join(temp, "src/index.ts"), "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n");
      writeRepoConfigObject(temp, {
        schemaVersion: 1,
        kind: "opcore_init_config",
        validation: {
          checks: {
            typescript: {
              fileLength: {
                maxFileLines: 2
              }
            }
          }
        }
      });

      const result = await routeOpcoreCommand(["--repo", temp, "--json"]);

      assert.equal(result.status, "ok");
      assert.equal(
        result.validationResult.diagnostics.some(
          (diagnostic) => diagnostic.code === "TS_FILE_LINES" && diagnostic.message === "TypeScript file has 3 lines; max is 2."
        ),
        true,
        JSON.stringify(result.validationResult.diagnostics, null, 2)
      );
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("uses native disabled check ids without root-level checks translation", () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-native-disabled-checks-"));
    try {
      writeRepoConfigObject(temp, {
        schemaVersion: 1,
        kind: "opcore_init_config",
        checks: {
          semanticDiagnostics: false
        },
        validation: {
          checks: {
            disabled: [
              "typescript.types",
              "typescript.lint",
              "typescript.dead-code",
              "rust.dead-code",
              "python.dead-code",
              "typescript.import-graph",
              "rust.import-graph",
              "python.import-graph"
            ]
          }
        }
      });

      const result = JSON.parse(runRaw(["check", "manifest", "--repo", temp, "--json"], [0]).stdout);
      for (const checkId of [
        "typescript.types",
        "typescript.lint",
        "typescript.dead-code",
        "rust.dead-code",
        "python.dead-code",
        "typescript.import-graph",
        "rust.import-graph",
        "python.import-graph"
      ]) {
        assert.equal(result.validationResult.manifest.checks.includes(checkId), false, checkId);
      }
      assert.equal(result.validationResult.manifest.checks.includes("typescript.syntax"), true);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("uses native docs enabled flags for default docs checks", () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-native-default-docs-checks-"));
    try {
      mkdirSync(join(temp, "src"), { recursive: true });
      writeFileSync(join(temp, "src/index.ts"), "export const value = 1;\n");
      initializeGitSnapshot(temp, ["src/index.ts"]);
      writeRepoConfigObject(temp, {
        schemaVersion: 1,
        kind: "opcore_init_config",
        checks: {
          contextDocs: {
            existence: false
          }
        },
        validation: {
          checks: {
            docs: {
              enabled: {
                existence: true,
                freshness: true,
                staleness: false,
                length: true
              }
            }
          }
        }
      });

      const result = run(["check", "all", "--repo", temp, "--json"], [1]);

      assert.equal(result.validationResult.manifest.checks.includes("docs.existence"), true);
      assert.equal(result.validationResult.manifest.checks.includes("docs.freshness"), true);
      assert.equal(result.validationResult.manifest.checks.includes("docs.length"), true);
      assert.equal(result.validationResult.manifest.checks.includes("docs.staleness"), false);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("rejects unknown check id configuration", () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-unknown-check-id-"));
    try {
      writeRepoConfigObject(temp, {
        schemaVersion: 1,
        kind: "opcore_init_config",
        validation: {
          checks: {
            disabled: ["missing.check"]
          }
        }
      });

      const result = JSON.parse(runRaw(["check", "manifest", "--repo", temp, "--json"], [1]).stdout);

      assert.equal(result.status, "error");
      assert.equal(result.message, "Invalid Opcore config .opcore/config: unknown check id missing.check");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("applies configured TypeScript thresholds", () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-configured-typescript-thresholds-"));
    try {
      mkdirSync(join(temp, "src"), { recursive: true });
      writeFileSync(
        join(temp, "src/metrics.ts"),
        [
          "export function configured(a: number, b: number) {",
          "  if (a > b) {",
          "    return a;",
          "  }",
          "  return b;",
          "}"
        ].join("\n") + "\n"
      );
      writeRepoConfigObject(temp, {
        schemaVersion: 1,
        kind: "opcore_init_config",
        validation: {
          checks: {
            typescript: {
              fileLength: {
                maxFileLines: 2
              },
              functionMetrics: {
                maxFunctionLines: 2,
                maxComplexity: 1,
                maxParams: 1
              }
            }
          }
        }
      });

      const result = JSON.parse(
        runRaw([
          "check",
          "files",
          "--files",
          "src/metrics.ts",
          "--repo",
          temp,
          "--checks",
          "typescript.file-length,typescript.function-metrics",
          "--json"
        ], [1]).stdout
      );

      assert.deepEqual(
        result.validationResult.diagnostics.map((diagnostic) => diagnostic.message).sort(),
        [
          "TypeScript file has 6 lines; max is 2.",
          "TypeScript function configured has 2 parameters; max is 1.",
          "TypeScript function configured has 6 lines; max is 2.",
          "TypeScript function configured has cyclomatic complexity 2; max is 1."
        ].sort()
      );
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("applies configured Rust thresholds", () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-configured-rust-thresholds-"));
    try {
      mkdirSync(join(temp, "crates/app/src"), { recursive: true });
      writeFileSync(join(temp, "Cargo.toml"), '[workspace]\nmembers = ["crates/app"]\nresolver = "2"\n');
      writeFileSync(join(temp, "crates/app/Cargo.toml"), '[package]\nname = "app"\nversion = "0.2.1"\nedition = "2021"\n');
      writeFileSync(
        join(temp, "crates/app/src/lib.rs"),
        "pub fn configured(a: i32, b: i32) -> i32 {\n  if a > b { a } else { b }\n}\n"
      );
      writeRepoConfigObject(temp, {
        schemaVersion: 1,
        kind: "opcore_init_config",
        validation: {
          checks: {
            rust: {
              fileLength: {
                maxFileLines: 2
              },
              functionMetrics: {
                maxFunctionLines: 5,
                maxComplexity: 3,
                maxParams: 4
              }
            }
          }
        }
      });
      const { env } = writeFakeRustToolchain(join(temp, "bin"), {
        rustCodeAnalysis: {
          stdout: JSON.stringify([
            {
              kind: "unit",
              name: "crates/app/src/lib.rs",
              start_line: 1,
              end_line: 9,
              metrics: {
                cyclomatic: { sum: 7 },
                nargs: { total: 5 },
                loc: { sloc: 9 }
              },
              spaces: [
                {
                  kind: "function",
                  name: "configured",
                  start_line: 1,
                  end_line: 9,
                  metrics: {
                    cyclomatic: { max: 7 },
                    nargs: { functions_max: 5 },
                    loc: { sloc: 9 }
                  }
                }
              ]
            }
          ])
        }
      });

      const result = JSON.parse(
        runRaw([
          "check",
          "files",
          "--files",
          "crates/app/src/lib.rs",
          "--repo",
          temp,
          "--checks",
          "rust.file-length,rust.function-metrics",
          "--json"
        ], [1], { env }).stdout
      );

      assert.deepEqual(
        result.validationResult.diagnostics.map((diagnostic) => diagnostic.message).sort(),
        [
          "Rust file has 3 lines; max is 2.",
          "Rust function configured has 5 parameters; max is 4.",
          "Rust function configured has 9 lines; max is 5.",
          "Rust function configured has cyclomatic complexity 7; max is 3."
        ].sort()
      );
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("applies configured Rust command gates", () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-configured-rust-command-gates-"));
    try {
      mkdirSync(join(temp, "crates/app/src"), { recursive: true });
      mkdirSync(join(temp, "scripts"), { recursive: true });
      writeFileSync(join(temp, "crates/app/src/lib.rs"), "pub fn safe() {}\n");
      const gateScript = join(temp, "scripts/gate.sh");
      writeFileSync(gateScript, "#!/bin/sh\nprintf 'gate ok\\n'\n");
      chmodAll([gateScript]);
      writeRepoConfigObject(temp, {
        schemaVersion: 1,
        kind: "opcore_init_config",
        validation: {
          checks: {
            rust: {
              commandGates: [
                {
                  id: "rust-gate.local",
                  command: "./scripts/gate.sh",
                  cwd: ".",
                  timeoutMs: 30000
                }
              ]
            }
          }
        }
      });

      const result = JSON.parse(
        runRaw([
          "check",
          "files",
          "--files",
          "crates/app/src/lib.rs",
          "--repo",
          temp,
          "--check",
          "rust-gate.local",
          "--json"
        ]).stdout
      );

      assert.equal(result.validationResult.status, "passed", JSON.stringify(result.validationResult, null, 2));
      assert.deepEqual(result.validationResult.diagnostics, []);
      assert.deepEqual(result.validationResult.manifest.checks, ["rust-gate.local"]);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("resolves package check packs from target repo", () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-check-pack-package-"));
    try {
      writeRepoConfig(temp, ["@example/opcore-checks"]);
      writeCheckPack(temp, join(temp, "node_modules/@example/opcore-checks/index.cjs"), "example.package-policy");
      writeFileSync(
        join(temp, "node_modules/@example/opcore-checks/package.json"),
        `${JSON.stringify({ name: "@example/opcore-checks", main: "index.cjs" })}\n`
      );

      const manifest = JSON.parse(runRaw(["check", "manifest", "--repo", temp, "--json"]).stdout);
      assert.equal(manifest.validationResult.manifest.checks.includes("example.package-policy"), true);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("reports invalid check pack config and missing packs without crashing", () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-check-pack-invalid-"));
    try {
      writeRepoConfig(temp, [42]);
      const result = JSON.parse(runRaw(["check", "manifest", "--repo", temp, "--json"], [1]).stdout);
      assert.equal(result.status, "error");
      assert.match(result.message, /checks\.packs\[0\]/);

      writeRepoConfig(temp, ["./checks/missing.cjs"]);
      const missing = JSON.parse(runRaw(["check", "manifest", "--repo", temp, "--json"], [1]).stdout);
      assert.equal(missing.status, "error");
      assert.match(missing.message, /Failed to load Opcore check pack \.\/checks\/missing\.cjs/);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("reports invalid check pack config from status without crashing", () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-check-pack-status-invalid-"));
    try {
      writeRepoConfig(temp, [42]);
      const result = JSON.parse(runRaw(["status", "--repo", temp, "--json"], [1]).stdout);
      assert.equal(result.status, "error");
      assert.match(result.message, /checks\.packs\[0\]/);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("rejects malformed and duplicate check packs", () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-check-pack-bad-"));
    try {
      writeRepoConfig(temp, ["./checks/malformed.cjs"]);
      mkdirSync(join(temp, "checks"), { recursive: true });
      writeFileSync(
        join(temp, "checks/malformed.cjs"),
        "module.exports = { id: \"malformed\", checks: [{ id: \"example.bad\" }] };\n"
      );
      const malformed = JSON.parse(runRaw(["check", "manifest", "--repo", temp, "--json"], [1]).stdout);
      assert.equal(malformed.status, "error");
      assert.match(malformed.message, /Validation check owner|required|run must be a function/);

      writeRepoConfig(temp, ["./checks/duplicate.cjs"]);
      writeCheckPack(temp, join(temp, "checks/duplicate.cjs"), "typescript.syntax");
      const duplicate = JSON.parse(runRaw(["check", "manifest", "--repo", temp, "--json"], [1]).stdout);
      assert.equal(duplicate.status, "error");
      assert.match(duplicate.message, /Duplicate validation check id: typescript\.syntax/);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("rejects execution-only flags on manifest routes", () => {
    const checkManifest = run(["check", "manifest", "--files", "packages/contracts/src/index.ts", "--json"], [1]);
    const validateManifest = run(["validate", "manifest", "--request-file", "does-not-exist.json", "--json"], [1]);

    assert.equal(checkManifest.status, "error");
    assert.equal(checkManifest.validationResult.status, "invalid_payload");
    assert.match(checkManifest.validationResult.failure.cause, /manifest.*--files/);
    assert.equal(validateManifest.status, "error");
    assert.equal(validateManifest.validationResult.status, "invalid_payload");
    assert.match(validateManifest.validationResult.failure.cause, /manifest.*--request-file/);
  });

  it("validates request files and hypothetical overlays without disk writes", () => {
    const temp = mkdtempSync(join(tmpdir(), "lattice-validation-cli-"));
    try {
      mkdirSync(join(temp, "src"));
      const sourcePath = join(temp, "src/index.ts");
      writeFileSync(sourcePath, "export const value = 1;\n");
      const requestPath = join(temp, "request.json");
      writeFileSync(requestPath, JSON.stringify(validRequest(temp)));
      const valid = run(["validate", "--request-file", requestPath, "--json"]);
      assert.equal(valid.validationResult.status, "passed");

      const hypotheticalPath = join(temp, "hypothetical.json");
      writeFileSync(
        hypotheticalPath,
        JSON.stringify({
          ...validRequest(temp),
          overlays: [{ path: "src/index.ts", action: "write", content: "export const value = ;\n" }]
        })
      );
      const hypothetical = run(["validate", "hypothetical", "--request-file", hypotheticalPath, "--json"], [1]);
      assert.equal(hypothetical.validationResult.status, "policy_failure");
      assert.equal(hypothetical.validationResult.diagnostics[0].path, "src/index.ts");
      assert.equal(readFileSync(sourcePath, "utf8"), "export const value = 1;\n");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("validates pre-write request overlays through fileView without disk writes", () => {
    const temp = mkdtempSync(join(tmpdir(), "lattice-validation-cli-pre-write-"));
    try {
      mkdirSync(join(temp, "src"));
      const sourcePath = join(temp, "src/index.ts");
      writeFileSync(sourcePath, "export const value = ;\n");
      const requestPath = join(temp, "pre-write.json");
      writeFileSync(
        requestPath,
        JSON.stringify({
          ...validRequest(temp),
          requestId: "cli-pre-write-1",
          overlays: [{ path: "src/index.ts", action: "write", content: "export const value = 1;\n" }]
        })
      );

      const result = run(["validate", "pre-write", "--request-file", requestPath, "--timeout-ms", "30000", "--json"]);

      assert.equal(result.validationResult.status, "passed");
      assert.equal(result.receipt.ok, true);
      assert.equal(result.receipt.requestId, "cli-pre-write-1");
      assert.equal(result.receipt.timeoutMs, 30000);
      assert.deepEqual(result.receipt.overlays, {
        count: 1,
        writeCount: 1,
        deleteCount: 0,
        paths: ["src/index.ts"]
      });
      assert.equal(readFileSync(sourcePath, "utf8"), "export const value = ;\n");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("emits Rust pre-write receipts for selected Rust checks without disk writes", () => {
    const temp = mkdtempSync(join(tmpdir(), "lattice-validation-cli-rust-pre-write-"));
    try {
      mkdirSync(join(temp, "crates/app/src"), { recursive: true });
      writeFileSync(join(temp, "Cargo.toml"), '[workspace]\nmembers = ["crates/app"]\nresolver = "2"\n');
      writeFileSync(join(temp, "crates/app/Cargo.toml"), '[package]\nname = "app"\nversion = "0.2.1"\nedition = "2021"\n');
      const sourcePath = join(temp, "crates/app/src/lib.rs");
      writeFileSync(sourcePath, "pub fn safe() {}\n");
      const requestPath = join(temp, "rust-pre-write.json");
      writeFileSync(
        requestPath,
        JSON.stringify({
          requestId: "cli-rust-pre-write-1",
          repo: { repoRoot: temp },
          scope: { kind: "files", files: ["crates/app/src/lib.rs"] },
          graph: { mode: "optional", provider: "opcore-graph" },
          overlays: [
            {
              path: "crates/app/src/lib.rs",
              action: "write",
              content: "pub fn safer() {}\n"
            }
          ],
          checks: ["rust.source-hygiene"]
        })
      );

      const result = run(["validate", "pre-write", "--request-file", requestPath, "--timeout-ms", "30000", "--json"]);

      assert.equal(result.validationResult.status, "passed", JSON.stringify(result.validationResult, null, 2));
      assert.equal(result.receipt.ok, true);
      assert.deepEqual(result.receipt.checks, ["rust.source-hygiene"]);
      assert.deepEqual(result.receipt.overlays.paths, ["crates/app/src/lib.rs"]);
      assert.equal(readFileSync(sourcePath, "utf8"), "pub fn safe() {}\n");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("applies validate --repo before resolving request file content", () => {
    const repoA = mkdtempSync(join(tmpdir(), "lattice-validation-cli-repo-a-"));
    const repoB = mkdtempSync(join(tmpdir(), "lattice-validation-cli-repo-b-"));
    try {
      mkdirSync(join(repoA, "src"), { recursive: true });
      mkdirSync(join(repoB, "src"), { recursive: true });
      writeFileSync(join(repoA, "src/index.ts"), "export const value = ;\n");
      writeFileSync(join(repoB, "src/index.ts"), "export const value = 1;\n");
      const requestPath = join(repoA, "request.json");
      writeFileSync(requestPath, JSON.stringify(validRequest(repoA)));

      const result = run([
        "validate",
        "--request-file",
        requestPath,
        "--repo",
        repoB,
        "--check",
        "typescript.syntax",
        "--json"
      ]);

      assert.equal(result.validationResult.status, "passed");
    } finally {
      rmSync(repoA, { recursive: true, force: true });
      rmSync(repoB, { recursive: true, force: true });
    }
  });

  it("returns invalid_payload for malformed validate request payloads", () => {
    const temp = mkdtempSync(join(tmpdir(), "lattice-validation-cli-bad-"));
    try {
      const requestPath = join(temp, "bad.json");
      writeFileSync(requestPath, "{");
      const result = run(["validate", "--request-file", requestPath, "--json"], [1]);
      assert.equal(result.status, "error");
      assert.equal(result.validationResult.status, "invalid_payload");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("includes typed validation status payloads on runtime status and doctor", () => {
    const temp = mkdtempSync(join(tmpdir(), "lattice-validation-cli-status-tools-"));
    const full = writeFakeRustToolchain(join(temp, "full"));
    for (const command of ["status", "doctor"]) {
      const result = run([command, "--json"], [0], { env: full.env });
      assert.equal(result.owner, "runtime");
      assert.equal(result.validationStatus.ready, true);
      assert.deepEqual(result.validationStatus.adapterRegistry.checkIds, availableCheckIds);
      assert.equal(result.validationStatus.adapterRegistry.checkIds.includes("rust.file-length"), true);
      const rustAdapter = result.validationStatus.adapterRegistry.adapters.find((adapter) => adapter.adapter === "rust");
      const pythonAdapter = result.validationStatus.adapterRegistry.adapters.find((adapter) => adapter.adapter === "python");
      assert.ok(rustAdapter);
      assert.ok(pythonAdapter);
      assert.equal(rustAdapter.status, "available");
      assert.equal(rustAdapter.checkIds.includes("rust.file-length"), true);
      assert.equal(pythonAdapter.checkIds.includes("python.syntax"), true);
      assert.equal(pythonAdapter.checkIds.includes("python.import-graph"), true);
      assert.deepEqual(rustAdapter.degradedChecks, []);
      assert.equal(typeof result.validationStatus.graph.status.state, "string");
    }
    rmSync(temp, { recursive: true, force: true });
  });

  it("includes requiredTool retained guidance for missing Rust optional parity tools", () => {
    const temp = mkdtempSync(join(tmpdir(), "lattice-validation-cli-missing-tools-"));
    try {
      const bin = join(temp, "bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "cargo"), fakeCargoScript({ udepsVersionStatus: 101, udepsStderr: "error: no such command: `udeps`\n" }));
      writeFileSync(join(bin, "rustfmt"), "#!/bin/sh\nprintf '%s\\n' 'rustfmt 1.8.0'\n");
      chmodAll([join(bin, "cargo"), join(bin, "rustfmt")]);

      for (const command of ["status", "doctor"]) {
        const result = run([command, "--json"], [0], { env: { ...process.env, PATH: bin } });
        const rustAdapter = result.validationStatus.adapterRegistry.adapters.find((adapter) => adapter.adapter === "rust");
        assert.equal(rustAdapter.status, "degraded");
        assert.deepEqual(
          rustAdapter.degradedChecks.map((entry) => [entry.checkId, entry.requiredTool, entry.reason]),
          [
            ["rust.rustdoc", "rustdoc", "required_tool_unavailable"],
            ["rust.import-graph", "cargo-depgraph", "optional_tool_unavailable"],
            ["rust.unused-deps", "cargo-udeps", "required_tool_unavailable"],
            ["rust.function-metrics", "rust-code-analysis-cli", "required_tool_unavailable"]
          ]
        );
        assert.equal(rustAdapter.degradedChecks.some((entry) => entry.checkId === "rust.dead-code"), false);
        assert.equal(rustAdapter.degradedChecks.every((entry) => entry.retainedCompatibility === true), true);
        assert.equal(rustAdapter.degradedChecks.every((entry) => entry.currentUsage !== undefined), true);
      }
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});

function validRequest(repoRootPath) {
  return {
    repo: { repoRoot: repoRootPath },
    scope: { kind: "files", files: ["src/index.ts"] },
    graph: { mode: "optional", provider: "opcore-graph" },
    overlays: [],
    checks: ["typescript.syntax"]
  };
}

function writeRepoConfig(repoRootPath, packs) {
  writeRepoConfigObject(repoRootPath, {
    schemaVersion: 1,
    kind: "opcore_init_config",
    validation: {
      checks: { packs }
    }
  });
}

function writeRepoConfigObject(repoRootPath, config) {
  mkdirSync(join(repoRootPath, ".opcore"), { recursive: true });
  writeFileSync(
    join(repoRootPath, ".opcore/config"),
    `${JSON.stringify(config)}\n`
  );
}

function writeCheckPack(repoRootPath, path, checkId) {
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(join(repoRootPath, "src"), { recursive: true });
  writeFileSync(join(repoRootPath, "src/index.ts"), "export const value = 1;\n");
  writeFileSync(
    path,
    `
module.exports = {
  id: "example-policy",
  version: "1.0.0",
  checks: [
    {
      id: ${JSON.stringify(checkId)},
      owner: "example",
      adapter: "example-check-pack",
      defaultSeverity: "error",
      supportedScopes: ["files", "changed", "staged", "all", "tree"],
      run() {
        return {
          diagnostics: [
            {
              category: "policy",
              severity: "error",
              path: "src/index.ts",
              code: ${JSON.stringify(checkId)},
              message: "Example repo policy failed"
            }
          ]
        };
      }
    }
  ]
};
`
  );
}

function run(args, expectedExitCodes = [0], options = {}) {
  const result = spawnSync(process.execPath, [latticeBin, ...args], {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (!expectedExitCodes.includes(result.status)) {
    throw new Error(
      [
        `Command failed: lattice ${args.join(" ")}`,
        `status: ${result.status}`,
        `stdout:\n${result.stdout}`,
        `stderr:\n${result.stderr}`
      ].join("\n")
    );
  }
  assert.equal(result.stderr, "");
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.exitCode, result.status);
  assertCommandTiming(parsed);
  return parsed;
}

function runRaw(args, expectedExitCodes = [0], options = {}) {
  const result = spawnSync(process.execPath, [opcoreBin, ...args], {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (!expectedExitCodes.includes(result.status)) {
    throw new Error(
      [
        `Command failed: opcore ${args.join(" ")}`,
        `status: ${result.status}`,
        `stdout:\n${result.stdout}`,
        `stderr:\n${result.stderr}`
      ].join("\n")
    );
  }
  return result;
}

function parseNdjson(stdout) {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  return lines.map((line) => JSON.parse(line));
}

function assertCommandTiming(result) {
  assert.equal(typeof result.timing?.durationMs, "number");
  assert.equal(result.timing.durationMs >= 0, true);
  assert.equal(Array.isArray(result.timing.phases), true);
  assert.equal(["cold", "warm"].includes(result.timing.processState), true);
}

function chmodAll(paths) {
  for (const path of paths) {
    spawnSync("chmod", ["755", path]);
  }
}

function numberedTypeScriptLines(count) {
  return Array.from({ length: count }, (_entry, index) => `export const value${index} = ${index};`).join("\n") + "\n";
}

function initializeGitSnapshot(repoRootPath, files) {
  git(repoRootPath, ["init", "-q"]);
  git(repoRootPath, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  for (const file of files) {
    const object = git(repoRootPath, ["hash-object", "-w", file]).stdout.trim();
    git(repoRootPath, ["update-index", "--add", "--cacheinfo", "100644", object, file]);
  }
  const tree = git(repoRootPath, ["write-tree"]).stdout.trim();
  const commit = git(repoRootPath, ["commit-tree", tree, "-m", "initial"], gitEnv("2026-06-05T00:00:00Z")).stdout.trim();
  git(repoRootPath, ["update-ref", "refs/heads/main", commit]);
  return commit;
}

function commitWorktreeFile(repoRootPath, file, message) {
  const object = git(repoRootPath, ["hash-object", "-w", file]).stdout.trim();
  git(repoRootPath, ["update-index", "--add", "--cacheinfo", "100644", object, file]);
  const tree = git(repoRootPath, ["write-tree"]).stdout.trim();
  const commit = git(repoRootPath, ["commit-tree", tree, "-p", "HEAD", "-m", message], gitEnv("2026-06-05T00:01:00Z")).stdout.trim();
  git(repoRootPath, ["update-ref", "refs/heads/main", commit]);
  return commit;
}

function gitEnv(date) {
  return {
    GIT_AUTHOR_NAME: "Opcore",
    GIT_AUTHOR_EMAIL: "lattice@example.invalid",
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: "Opcore",
    GIT_COMMITTER_EMAIL: "lattice@example.invalid",
    GIT_COMMITTER_DATE: date
  };
}

function git(cwd, args, env = {}) {
  const result = spawnSync("git", args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) {
    throw new Error([`git ${args.join(" ")} failed`, result.stdout, result.stderr].join("\n"));
  }
  return result;
}
