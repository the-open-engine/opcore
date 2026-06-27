import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { routeCommand } from "../packages/opcore/dist/lattice/index.js";
import { routeOpcoreCommand } from "../packages/opcore/dist/index.js";
import { fakeCargoScript, writeFakeRustToolchain } from "./helpers/validation-rust-fixtures.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const latticeBin = fileURLToPath(new URL("../packages/opcore/dist/lattice/index.js", import.meta.url));
const typeScriptCheckIds = [
  "typescript.syntax",
  "typescript.types",
  "typescript.import-graph",
  "typescript.dead-code",
  "typescript.relevant-tests"
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
const defaultCheckIds = [...typeScriptCheckIds, ...rustCheckIds, ...pythonCheckIds];

describe("validation CLI", () => {
  it("keeps opcore status separate from validation execution results", async () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-validation-status-"));
    try {
      mkdirSync(join(temp, "src"), { recursive: true });
      writeFileSync(join(temp, "src/index.ts"), "export const value = 1;\n");

      const result = await routeOpcoreCommand(["status", "--repo", temp, "--json"]);

      assert.equal(result.status, "ok");
      assert.deepEqual(result.canonicalCommand, ["opcore", "status"]);
      assert.equal(result.repoState.validation.checkCount, defaultCheckIds.length);
      assert.equal(Object.hasOwn(result, "validationResult"), false);
      assert.equal(Object.hasOwn(result, "validationStatus"), false);
      assertCommandTiming(result);

      const compatible = run(["status", "--json"]);
      assert.deepEqual(compatible.canonicalCommand, ["lattice", "status"]);
      assert.equal(compatible.validationStatus.adapterRegistry.checkIds.length, defaultCheckIds.length);
      assert.equal(Object.hasOwn(compatible, "repoState"), false);
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
      assert.equal(result.validationResult.manifest.entries.length, defaultCheckIds.length);
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
        defaultCheckIds
      );
      for (const checkId of ["rust.fmt", "rust.cargo-check", "rust.clippy"]) {
        assert.equal(result.validationResult.manifest.checks.includes(checkId), true, checkId);
      }
      assert.equal(result.validationResult.manifest.checks.includes("rust.file-length"), true);
      assert.equal(result.validationResult.manifest.checks.includes("python.syntax"), true);
      assert.equal(result.validationResult.manifest.checks.includes("python.import-graph"), true);
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
      writeFileSync(join(temp, "crates/app/Cargo.toml"), '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n');
      const sourcePath = join(temp, "crates/app/src/lib.rs");
      writeFileSync(sourcePath, "pub fn safe() {}\n");
      const requestPath = join(temp, "rust-pre-write.json");
      writeFileSync(
        requestPath,
        JSON.stringify({
          requestId: "cli-rust-pre-write-1",
          repo: { repoRoot: temp },
          scope: { kind: "files", files: ["crates/app/src/lib.rs"] },
          graph: { mode: "optional", provider: "lattice-graph" },
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
      assert.deepEqual(result.validationStatus.adapterRegistry.checkIds, defaultCheckIds);
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
    graph: { mode: "optional", provider: "lattice-graph" },
    overlays: [],
    checks: ["typescript.syntax"]
  };
}

function run(args, expectedExitCodes = [0], options = {}) {
  const result = spawnSync(process.execPath, [latticeBin, ...args], {
    cwd: repoRoot,
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
    GIT_AUTHOR_NAME: "Lattice",
    GIT_AUTHOR_EMAIL: "lattice@example.invalid",
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: "Lattice",
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
