import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeValidationWorkspace, createValidationRunner } from "../packages/validation/dist/index.js";
import {
  RUST_FILE_LENGTH_CHECK_ID,
  createRustValidationChecks
} from "../packages/validation-rust/dist/index.js";
import {
  commitWorktreeFile,
  git,
  initializeGitSnapshot,
  request,
  runner,
  rustCrate
} from "./helpers/validation-rust-fixtures.mjs";

it("enforces default Rust file length and skips non-Rust input", async () => {
  const belowThreshold = await runner({
    files: rustCrate({ "crates/app/src/lib.rs": rustLines(500).replaceAll("\n", "\r\n") })
  }).runValidation(request({ checks: [RUST_FILE_LENGTH_CHECK_ID] }));
  const overThreshold = await runner({
    files: rustCrate({ "crates/app/src/lib.rs": rustLines(501) })
  }).runValidation(request({ checks: [RUST_FILE_LENGTH_CHECK_ID] }));
  const nonRust = await runner({
    files: { "src/index.ts": "export const value = 1;\n" }
  }).runValidation(
    request({
      checks: [RUST_FILE_LENGTH_CHECK_ID],
      scope: { kind: "files", files: ["src/index.ts"] }
    })
  );
  const cargoTomlOnly = await runner({
    files: { "Cargo.toml": "[workspace]\nmembers = []\n" }
  }).runValidation(
    request({
      checks: [RUST_FILE_LENGTH_CHECK_ID],
      scope: { kind: "files", files: ["Cargo.toml"] }
    })
  );

  assert.equal(belowThreshold.status, "passed", JSON.stringify(belowThreshold.diagnostics, null, 2));
  assert.equal(overThreshold.status, "policy_failure");
  assert.deepEqual(
    overThreshold.diagnostics.map((diagnostic) => diagnostic.code),
    ["RUST_FILE_LINES"]
  );
  assert.equal(overThreshold.diagnostics[0].path, "crates/app/src/lib.rs");
  assert.match(overThreshold.diagnostics[0].message, /501 lines; max is 500/);
  assert.equal(nonRust.status, "skipped");
  assert.equal(cargoTomlOnly.status, "skipped");
  assert.equal(cargoTomlOnly.manifest.runs[0].status, "skipped");
  assert.match(cargoTomlOnly.manifest.runs[0].failureMessage, /No Rust source/);
});

it("supports Orchestra and gateway Rust file-length threshold parity", async () => {
  const checks = createRustValidationChecks({ fileLength: { maxFileLines: 600 } });
  const pass = await inMemoryRustRunner({
    "crates/app/src/lib.rs": rustLines(600)
  }, checks).runValidation(request({ checks: [RUST_FILE_LENGTH_CHECK_ID] }));
  const fail = await inMemoryRustRunner({
    "crates/app/src/lib.rs": rustLines(601)
  }, checks).runValidation(request({ checks: [RUST_FILE_LENGTH_CHECK_ID] }));

  assert.equal(pass.status, "passed", JSON.stringify(pass.diagnostics, null, 2));
  assert.equal(fail.status, "policy_failure");
  assert.equal(fail.diagnostics[0].code, "RUST_FILE_LINES");
  assert.match(fail.diagnostics[0].message, /601 lines; max is 600/);
});

it("ignores Rust include files for file-length parity", async () => {
  const result = await inMemoryRustRunner({
    "src/lib.rs": "include!(\"generated.inc\");\n",
    "src/generated.inc": rustLines(501)
  }).runValidation(
    request({
      checks: [RUST_FILE_LENGTH_CHECK_ID],
      scope: { kind: "files", files: ["src/lib.rs", "src/generated.inc"] }
    })
  );

  assert.equal(result.status, "passed", JSON.stringify(result.diagnostics, null, 2));
});

it("runs Rust file length across files, changed, all, repo, and package scopes", async () => {
  const workspace = inMemoryRustRunner({
    "packages/app/src/lib.rs": rustLines(501),
    "packages/app/src/index.ts": "export const value = 1;\n"
  });
  const scopes = [
    { kind: "files", files: ["packages/app/src/lib.rs"] },
    { kind: "changed", baseRef: "HEAD" },
    { kind: "all" },
    { kind: "repo" },
    { kind: "package", packageName: "@the-open-engine/app", packageRoot: "packages/app" }
  ];

  for (const scope of scopes) {
    const result = await workspace.runValidation(
      request({
        checks: [RUST_FILE_LENGTH_CHECK_ID],
        scope
      })
    );
    assert.equal(result.status, "policy_failure", `${scope.kind}: ${JSON.stringify(result, null, 2)}`);
    assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), ["RUST_FILE_LINES"]);
  }
});

it("uses fileView overlays for Rust file length without mutating disk", async () => {
  const temp = mkdtempSync(join(tmpdir(), "lattice-validation-rust-file-length-overlay-"));
  try {
    mkdirSync(join(temp, "crates/app/src"), { recursive: true });
    writeFileSync(join(temp, "crates/app/src/lib.rs"), rustLines(500));
    const before = readFileSync(join(temp, "crates/app/src/lib.rs"), "utf8");

    const writeResult = await createValidationRunner({
      workspace: createNodeValidationWorkspace({ repoRoot: temp }),
      checks: createRustValidationChecks()
    }).runValidation(
      request({
        repo: { repoRoot: temp },
        checks: [RUST_FILE_LENGTH_CHECK_ID],
        scope: { kind: "files", files: ["crates/app/src/lib.rs"] },
        overlays: [{ path: "crates/app/src/lib.rs", action: "write", content: rustLines(501) }]
      })
    );
    const deleteResult = await createValidationRunner({
      workspace: createNodeValidationWorkspace({ repoRoot: temp }),
      checks: createRustValidationChecks()
    }).runValidation(
      request({
        repo: { repoRoot: temp },
        checks: [RUST_FILE_LENGTH_CHECK_ID],
        scope: { kind: "files", files: ["crates/app/src/lib.rs"] },
        overlays: [{ path: "crates/app/src/lib.rs", action: "delete" }]
      })
    );

    assert.equal(writeResult.status, "policy_failure");
    assert.equal(writeResult.diagnostics[0].code, "RUST_FILE_LINES");
    assert.equal(deleteResult.status, "passed", JSON.stringify(deleteResult.diagnostics, null, 2));
    assert.equal(readFileSync(join(temp, "crates/app/src/lib.rs"), "utf8"), before);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

it("uses committed tree content for Rust file length and ignores dirty worktree content", async () => {
  const temp = mkdtempSync(join(tmpdir(), "lattice-validation-rust-file-length-tree-"));
  try {
    mkdirSync(join(temp, "src"), { recursive: true });
    writeFileSync(join(temp, "src/lib.rs"), "pub fn base() {}\n");
    const baseCommit = initializeGitSnapshot(temp, ["src/lib.rs"]);
    writeFileSync(join(temp, "src/lib.rs"), rustLines(500));
    const treeCommit = commitWorktreeFile(temp, "src/lib.rs", "tree");
    writeFileSync(join(temp, "src/lib.rs"), rustLines(501));

    const result = await createValidationRunner({
      workspace: createNodeValidationWorkspace({ repoRoot: temp }),
      checks: createRustValidationChecks()
    }).runValidation(
      request({
        repo: { repoRoot: temp },
        checks: [RUST_FILE_LENGTH_CHECK_ID],
        scope: { kind: "tree", treeRef: treeCommit, changedFrom: baseCommit }
      })
    );

    assert.equal(result.status, "passed", JSON.stringify(result.diagnostics, null, 2));
    assert.equal(readFileSync(join(temp, "src/lib.rs"), "utf8"), rustLines(501));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

it("uses staged index content for Rust file length and ignores unstaged dirty files", async () => {
  const temp = mkdtempSync(join(tmpdir(), "lattice-validation-rust-file-length-staged-"));
  try {
    mkdirSync(join(temp, "src"), { recursive: true });
    writeFileSync(join(temp, "src/lib.rs"), "pub fn base() {}\n");
    initializeGitSnapshot(temp, ["src/lib.rs"]);

    writeFileSync(join(temp, "src/lib.rs"), rustLines(500));
    git(temp, ["add", "src/lib.rs"]);
    writeFileSync(join(temp, "src/lib.rs"), rustLines(501));

    const result = await createValidationRunner({
      workspace: createNodeValidationWorkspace({ repoRoot: temp }),
      checks: createRustValidationChecks()
    }).runValidation(
      request({
        repo: { repoRoot: temp },
        checks: [RUST_FILE_LENGTH_CHECK_ID],
        scope: { kind: "staged" }
      })
    );

    assert.equal(result.status, "passed", JSON.stringify(result.diagnostics, null, 2));
    assert.equal(readFileSync(join(temp, "src/lib.rs"), "utf8"), rustLines(501));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

function rustLines(count) {
  if (count === 0) return "";
  return Array.from({ length: count }, (_value, index) => `pub const LINE_${index}: usize = ${index};`).join("\n") + "\n";
}

function inMemoryRustRunner(files, checks = createRustValidationChecks()) {
  const content = new Map(Object.entries(files));
  return createValidationRunner({
    workspace: {
      readFile: (path) => (content.has(path) ? { status: "found", content: content.get(path) } : { status: "missing" }),
      listChangedFiles: () => ({ files: [...content.keys()] }),
      listStagedFiles: () => ({ files: [...content.keys()] }),
      listRepoFiles: () => ({ files: [...content.keys()] }),
      listTreeFiles: () => ({ files: [...content.keys()] }),
      listPackageFiles: (_name, root) => ({
        files: [...content.keys()].filter((path) => path === root || path.startsWith(`${root}/`))
      })
    },
    checks
  });
}
