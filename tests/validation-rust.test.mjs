import { it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  calculateValidationFileChecksum,
  createNodeValidationWorkspace,
  createValidationCheckRegistry,
  createValidationRunner
} from "../packages/validation/dist/index.js";
import {
  RUST_CARGO_CHECK_ID,
  RUST_CLIPPY_CHECK_ID,
  RUST_DEAD_CODE_CHECK_ID,
  RUST_FILE_LENGTH_CHECK_ID,
  RUST_FMT_CHECK_ID,
  RUST_FUNCTION_METRICS_CHECK_ID,
  RUST_GRAPH_SIGNALS_CHECK_ID,
  RUST_IMPORT_GRAPH_CHECK_ID,
  RUST_RUSTDOC_CHECK_ID,
  RUST_SOURCE_HYGIENE_CHECK_ID,
  RUST_UNUSED_DEPS_CHECK_ID,
  createRustValidationAdapterStatus,
  createRustValidationChecks,
  isRustAdapterOwnedPath,
  rustRetainedCompatibilityCurrentUsage,
  validationRustAdapterName
} from "../packages/validation-rust/dist/index.js";
import { runTool } from "../packages/validation-rust/dist/process.js";
import {
  commitWorktreeFile,
  defaultCargoMetadata,
  fakeCargoScript,
  git,
  initializeGitSnapshot,
  request,
  runner,
  rustCrate,
  writeFakeRustToolchain
} from "./helpers/validation-rust-fixtures.mjs";

const rustCheckIds = [
  RUST_SOURCE_HYGIENE_CHECK_ID,
  RUST_FMT_CHECK_ID,
  RUST_CARGO_CHECK_ID,
  RUST_CLIPPY_CHECK_ID,
  RUST_RUSTDOC_CHECK_ID,
  RUST_IMPORT_GRAPH_CHECK_ID,
  RUST_DEAD_CODE_CHECK_ID,
  RUST_GRAPH_SIGNALS_CHECK_ID,
  RUST_UNUSED_DEPS_CHECK_ID,
  RUST_FILE_LENGTH_CHECK_ID,
  RUST_FUNCTION_METRICS_CHECK_ID
];

  it("exports stable Rust check ids, definitions, and runtime status", () => {
    const checks = createRustValidationChecks();
    const registry = createValidationCheckRegistry(checks);
    const status = createRustValidationAdapterStatus();

    assert.equal(validationRustAdapterName, "rust");
    assert.deepEqual(checks.map((check) => check.id), rustCheckIds);
    assert.equal(registry.byId.get(RUST_SOURCE_HYGIENE_CHECK_ID)?.adapter, "rust");
    assert.equal(registry.byId.get(RUST_IMPORT_GRAPH_CHECK_ID)?.requiresGraph, false);
    assert.equal(registry.byId.get(RUST_GRAPH_SIGNALS_CHECK_ID)?.requiresGraph, true);
    assert.equal(status.adapter, "rust");
    assert.deepEqual(status.checkIds, rustCheckIds);
    assert.equal(status.tempWorkspaceRequired, true);
    assert.equal(status.toolchain.some((tool) => tool.tool === "cargo"), true);
    assert.equal(status.degradedChecks.every((entry) => entry.requiredTool !== undefined), true);
    assert.equal(status.degradedChecks.some((entry) => entry.checkId === RUST_DEAD_CODE_CHECK_ID), false);
    assert.equal(status.degradedChecks.every((entry) => entry.retainedCompatibility === true), true);
    assert.deepEqual(
      rustRetainedCompatibilityCurrentUsage.rustdoc,
      { opcore: false, orchestra: true, covibes: false, gateway: true }
    );
  });

  it("classifies Rust-owned paths and explicitly retains Cargo.lock compatibility", () => {
    assert.equal(isRustAdapterOwnedPath("crates/app/src/lib.rs"), true);
    assert.equal(isRustAdapterOwnedPath("crates/app/src/generated.inc"), true);
    assert.equal(isRustAdapterOwnedPath("crates/app/Cargo.toml"), true);
    assert.equal(isRustAdapterOwnedPath("Cargo.lock"), false);
    assert.equal(isRustAdapterOwnedPath("src/index.ts"), false);
  });

  it("reports source-hygiene policy diagnostics from overlay after-state content", async () => {
    const result = await runner({
      files: {
        "crates/app/src/lib.rs": "pub fn safe() {}\n"
      }
    }).runValidation(
      request({
        checks: [RUST_SOURCE_HYGIENE_CHECK_ID],
        overlays: [
          {
            path: "crates/app/src/lib.rs",
            action: "write",
            content: [
              "#[allow(dead_code)]",
              "#[rustfmt::skip]",
              "mod generated { include!(\"generated.inc\"); }",
              ""
            ].join("\n")
          }
        ]
      })
    );

    assert.equal(result.status, "policy_failure");
    assert.equal(result.diagnostics.every((diagnostic) => diagnostic.category === "policy"), true);
    assert.deepEqual(
      result.diagnostics.map((diagnostic) => diagnostic.code),
      ["RUST_SOURCE_ALLOW_DEAD_CODE", "RUST_SOURCE_INCLUDE_MACRO", "RUST_SOURCE_RUSTFMT_SKIP"]
    );
  });

  it("reports crate-level and comma-list Rust lint suppressions from overlays", async () => {
    const result = await runner({
      files: {
        "crates/app/src/lib.rs": "pub fn safe() {}\n"
      }
    }).runValidation(
      request({
        checks: [RUST_SOURCE_HYGIENE_CHECK_ID],
        overlays: [
          {
            path: "crates/app/src/lib.rs",
            action: "write",
            content: [
              "#![allow(dead_code)]",
              "#[allow(dead_code, clippy::unwrap_used)]",
              "pub fn unsafe_suppressed() {}",
              ""
            ].join("\n")
          }
        ]
      })
    );

    assert.equal(result.status, "policy_failure");
    assert.deepEqual(
      result.diagnostics.map((diagnostic) => diagnostic.code),
      ["RUST_SOURCE_ALLOW_DEAD_CODE", "RUST_SOURCE_ALLOW_DEAD_CODE", "RUST_SOURCE_BROAD_SUPPRESSION"]
    );
  });

  it("treats Cargo.toml-only changes as Rust validation input and Cargo.lock-only changes as skipped retained compatibility", async () => {
    const cargoToml = await runner({
      files: {
        "Cargo.toml": "[workspace]\nmembers = []\n"
      }
    }).runValidation(
      request({
        checks: [RUST_SOURCE_HYGIENE_CHECK_ID],
        scope: { kind: "files", files: ["Cargo.toml"] },
        overlays: [{ path: "Cargo.toml", action: "write", content: "[workspace]\nmembers = [\"crates/app\"]\n" }]
      })
    );
    const cargoLock = await runner({
      files: {
        "Cargo.lock": "# lockfile\n"
      }
    }).runValidation(
      request({
        checks: [RUST_SOURCE_HYGIENE_CHECK_ID],
        scope: { kind: "files", files: ["Cargo.lock"] },
        overlays: [{ path: "Cargo.lock", action: "write", content: "# changed\n" }]
      })
    );

    assert.equal(cargoToml.manifest.runs[0].status, "passed");
    assert.equal(cargoLock.status, "skipped");
    assert.equal(cargoLock.manifest.runs[0].status, "skipped");
    assert.match(cargoLock.manifest.runs[0].failureMessage, /Cargo\.lock/);
  });

  it("uses fileView overlays for created, deleted, and renamed Rust source paths without mutating disk", async () => {
    const temp = mkdtempSync(join(tmpdir(), "lattice-validation-rust-overlay-"));
    try {
      mkdirSync(join(temp, "crates/app/src"), { recursive: true });
      writeFileSync(join(temp, "crates/app/src/lib.rs"), "mod old;\npub fn keep() {}\n");
      writeFileSync(join(temp, "crates/app/src/old.rs"), "pub fn old_name() {}\n");
      const before = readFileSync(join(temp, "crates/app/src/lib.rs"), "utf8");
      const result = await createValidationRunner({
        workspace: createNodeValidationWorkspace({ repoRoot: temp }),
        checks: createRustValidationChecks()
      }).runValidation(
        request({
          repo: { repoRoot: temp },
          checks: [RUST_SOURCE_HYGIENE_CHECK_ID],
          scope: { kind: "files", files: ["crates/app/src/lib.rs", "crates/app/src/old.rs", "crates/app/src/new.rs"] },
          overlays: [
            { path: "crates/app/src/old.rs", action: "delete" },
            { path: "crates/app/src/new.rs", action: "write", content: "#[allow(dead_code)]\npub fn new_name() {}\n" }
          ]
        })
      );

      assert.equal(result.status, "policy_failure");
      assert.equal(result.diagnostics[0].path, "crates/app/src/new.rs");
      assert.equal(readFileSync(join(temp, "crates/app/src/lib.rs"), "utf8"), before);
      assert.equal(readFileSync(join(temp, "crates/app/src/old.rs"), "utf8"), "pub fn old_name() {}\n");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("refuses checksumBefore conflicts before Rust checks run", async () => {
    const result = await runner({
      files: {
        "crates/app/src/lib.rs": "pub fn safe() {}\n"
      }
    }).runValidation(
      request({
        checks: [RUST_SOURCE_HYGIENE_CHECK_ID],
        overlays: [
          {
            path: "crates/app/src/lib.rs",
            action: "write",
            checksumBefore: "sha256:stale",
            content: "#[allow(dead_code)]\npub fn unsafe_suppressed() {}\n"
          }
        ]
      })
    );

    assert.equal(result.status, "refused");
    assert.equal((result.manifest.runs ?? []).length, 0);
  });

  it("uses committed tree content for tree scope and ignores dirty worktree content", async () => {
      const temp = mkdtempSync(join(tmpdir(), "lattice-validation-rust-tree-"));
      try {
        mkdirSync(join(temp, "crates/app/src"), { recursive: true });
      writeFileSync(join(temp, "crates/app/src/lib.rs"), "pub fn base() {}\n");
      const baseCommit = initializeGitSnapshot(temp, ["crates/app/src/lib.rs"]);
      writeFileSync(join(temp, "crates/app/src/lib.rs"), "pub fn clean() {}\n");
      const treeCommit = commitWorktreeFile(temp, "crates/app/src/lib.rs", "tree");
      writeFileSync(join(temp, "crates/app/src/lib.rs"), "#[allow(dead_code)]\npub fn dirty() {}\n");

      const result = await createValidationRunner({
        workspace: createNodeValidationWorkspace({ repoRoot: temp }),
        checks: createRustValidationChecks()
      }).runValidation(
        request({
          repo: { repoRoot: temp },
          checks: [RUST_SOURCE_HYGIENE_CHECK_ID],
          scope: { kind: "tree", treeRef: treeCommit, changedFrom: baseCommit }
        })
      );

      assert.equal(result.status, "passed", JSON.stringify(result.diagnostics, null, 2));
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("maps missing Rust toolchain commands to typed non-policy failures", async () => {
    const result = await runner({
      files: rustCrate(),
      env: {
        ...process.env,
        PATH: ""
      }
    }).runValidation(
      request({
        checks: [RUST_CARGO_CHECK_ID]
      })
    );

    assert.equal(result.status, "infrastructure_failure");
    assert.equal(result.manifest.runs[0].status, "infrastructure_failure");
    assert.match(result.manifest.runs[0].failureMessage, /cargo/);
    assert.equal(result.diagnostics.length, 0);
  });

  it("enforces Rust command timeouts as infrastructure failures", () => {
    const result = runTool(process.execPath, ["-e", "setTimeout(() => {}, 250)"], { timeoutMs: 1 });

    assert.equal(result.ok, false);
    assert.equal(result.timedOut, true);
    assert.match(result.failureMessage ?? "", /timed out/);
  });

  it("maps timed-out Rust tool invocations to infrastructure_failure", async () => {
    const temp = mkdtempSync(join(tmpdir(), "lattice-validation-rust-timeout-"));
    try {
      const bin = join(temp, "bin");
      mkdirSync(bin, { recursive: true });
      const cargo = join(bin, "cargo");
      writeFileSync(cargo, "#!/bin/sh\nsleep 1\n");
      chmodSync(cargo, 0o755);

      const result = await runner({
        files: rustCrate(),
        env: {
          ...process.env,
          PATH: bin
        },
        timeoutMs: 1
      }).runValidation(request({ checks: [RUST_CARGO_CHECK_ID] }));

      assert.equal(result.status, "infrastructure_failure");
      assert.equal(result.manifest.runs[0].status, "infrastructure_failure");
      assert.match(result.manifest.runs[0].failureMessage ?? "", /timed out/);
      assert.equal(result.diagnostics.length, 0);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("maps malformed cargo JSON output to infrastructure_failure", async () => {
    const temp = mkdtempSync(join(tmpdir(), "lattice-validation-rust-invalid-json-"));
    try {
      const bin = join(temp, "bin");
      mkdirSync(bin, { recursive: true });
      const cargo = join(bin, "cargo");
      writeFileSync(cargo, fakeCargoScript({ checkStdout: "not-json-from-cargo-check\n", checkStatus: 0 }));
      chmodSync(cargo, 0o755);

      const result = await runner({
        files: rustCrate(),
        env: {
          ...process.env,
          PATH: bin
        }
      }).runValidation(request({ checks: [RUST_CARGO_CHECK_ID] }));

      assert.equal(result.status, "infrastructure_failure");
      assert.equal(result.manifest.runs[0].status, "infrastructure_failure");
      assert.match(result.manifest.runs[0].failureMessage ?? "", /invalid JSON/i);
      assert.equal(result.diagnostics.length, 0);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("maps missing cargo fmt and clippy subcommands to non-policy failures", async () => {
    const temp = mkdtempSync(join(tmpdir(), "lattice-validation-rust-missing-subcommands-"));
    try {
      const bin = join(temp, "bin");
      mkdirSync(bin, { recursive: true });
      const cargo = join(bin, "cargo");
      writeFileSync(
        cargo,
        fakeCargoScript({
          fmtStderr: "error: no such command: `fmt`\n",
          fmtStatus: 1,
          clippyStderr: "error: no such command: `clippy`\n",
          clippyStatus: 101
        })
      );
      chmodSync(cargo, 0o755);
      const workspace = runner({
        files: rustCrate(),
        env: {
          ...process.env,
          PATH: bin
        }
      });

      for (const checkId of [RUST_FMT_CHECK_ID, RUST_CLIPPY_CHECK_ID]) {
        const result = await workspace.runValidation(request({ checks: [checkId], scope: { kind: "all" } }));
        assert.match(["infrastructure_failure", "unsupported_request"].join(","), new RegExp(result.status), checkId);
        assert.equal(result.diagnostics.length, 0, checkId);
      }
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("uses staged index content for staged Rust checks and ignores unstaged dirty files", async () => {
    const temp = mkdtempSync(join(tmpdir(), "lattice-validation-rust-staged-"));
    try {
      mkdirSync(join(temp, "src"), { recursive: true });
      writeFileSync(
        join(temp, "Cargo.toml"),
        ['[package]', 'name = "staged-dirty"', 'version = "0.1.0"', 'edition = "2021"', ""].join("\n")
      );
      writeFileSync(join(temp, "src/lib.rs"), "mod other;\npub fn value() -> i32 { other::value() }\n");
      writeFileSync(join(temp, "src/other.rs"), "pub fn value() -> i32 { 1 }\n");
      initializeGitSnapshot(temp, ["Cargo.toml", "src/lib.rs", "src/other.rs"]);

      writeFileSync(join(temp, "src/lib.rs"), "mod other;\npub fn value() -> i32 { other::value() + 1 }\n");
      git(temp, ["add", "src/lib.rs"]);
      writeFileSync(join(temp, "src/lib.rs"), "#[allow(dead_code)]\nmod other;\npub fn dirty() -> i32 { other::value() }\n");
      writeFileSync(join(temp, "src/other.rs"), "pub fn value() -> i32 { \"wrong\" }\n");

      const result = await createValidationRunner({
        workspace: createNodeValidationWorkspace({ repoRoot: temp }),
        checks: createRustValidationChecks()
      }).runValidation(
        request({
          repo: { repoRoot: temp },
          checks: [RUST_SOURCE_HYGIENE_CHECK_ID, RUST_CARGO_CHECK_ID],
          scope: { kind: "staged" }
        })
      );

      assert.equal(result.status, "passed", JSON.stringify(result.diagnostics, null, 2));
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("loads crate module roots before flagging selected files as import-graph orphans", async () => {
    const temp = mkdtempSync(join(tmpdir(), "lattice-validation-rust-import-context-"));
    try {
      mkdirSync(join(temp, "src"), { recursive: true });
      writeFileSync(
        join(temp, "Cargo.toml"),
        ['[package]', 'name = "import-context"', 'version = "0.1.0"', 'edition = "2021"', ""].join("\n")
      );
      writeFileSync(join(temp, "src/lib.rs"), "pub mod store;\n");
      writeFileSync(join(temp, "src/store.rs"), "pub fn value() -> i32 { 1 }\n");

      const result = await createValidationRunner({
        workspace: createNodeValidationWorkspace({ repoRoot: temp }),
        checks: createRustValidationChecks()
      }).runValidation(
        request({
          repo: { repoRoot: temp },
          checks: [RUST_IMPORT_GRAPH_CHECK_ID],
          scope: { kind: "files", files: ["src/store.rs"] }
        })
      );

      assert.equal(result.status, "passed", JSON.stringify(result.diagnostics, null, 2));
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("reports Rust graph-backed untested and dead public export signals", async () => {
    const result = await rustGraphRunner({
      files: rustCrate({
        "crates/app/src/lib.rs": "pub fn untested_dead() {}\npub fn covered_used() {}\n"
      }),
      graphProviderClient: graphClient({
        factQuery: (query) =>
          availableFactResult(
            query,
            graphNodesForSelector(query, [
              fileNode("crates/app/src/lib.rs"),
              rustSymbol("module:crates/app/src/lib.rs#crate", "Module", "crates/app/src/lib.rs", "crate", { exported: true }),
              rustSymbol("function:crates/app/src/lib.rs#untested_dead", "Function", "crates/app/src/lib.rs", "untested_dead", {
                exported: true
              }),
              rustSymbol("function:crates/app/src/lib.rs#covered_used", "Function", "crates/app/src/lib.rs", "covered_used", {
                exported: true
              })
            ]),
            graphEdgesForSelector(query, [
              {
                kind: "CALLS",
                from: "function:crates/app/src/lib.rs#caller",
                to: "function:crates/app/src/lib.rs#covered_used"
              },
              {
                kind: "TESTED_BY",
                from: "function:crates/app/src/lib.rs#covered_used",
                to: "test:crates/app/src/lib.rs#tests::covered_used"
              }
            ])
          )
      })
    }).runValidation(
      request({
        checks: [RUST_GRAPH_SIGNALS_CHECK_ID],
        scope: {
          kind: "files",
          files: ["Cargo.toml", "crates/app/Cargo.toml", "crates/app/src/lib.rs"]
        }
      })
    );

    assert.equal(result.status, "passed", JSON.stringify(result, null, 2));
    assert.deepEqual(
      result.diagnostics.map((diagnostic) => diagnostic.code).sort(),
      ["RUST_GRAPH_DEAD_PUB_EXPORT", "RUST_GRAPH_UNTESTED_SURFACE"]
    );
  });

  it("reports Rust graph-backed module orphans and cycles from graph file edges", async () => {
    const sourceFiles = [
      "crates/app/src/lib.rs",
      "crates/app/src/used.rs",
      "crates/app/src/orphan.rs",
      "crates/app/src/a.rs",
      "crates/app/src/b.rs"
    ];
    const result = await rustGraphRunner({
      files: rustCrate({
        "crates/app/src/lib.rs": "pub mod used;\n",
        "crates/app/src/used.rs": "pub fn used() {}\n",
        "crates/app/src/orphan.rs": "pub fn orphan() {}\n",
        "crates/app/src/a.rs": "pub mod b;\n",
        "crates/app/src/b.rs": "pub mod a;\n"
      }),
      graphProviderClient: graphClient({
        factQuery: (query) =>
          availableFactResult(
            query,
            graphNodesForSelector(query, [
              ...sourceFiles.map(fileNode),
              rustSymbol("module:crates/app/src/lib.rs#crate", "Module", "crates/app/src/lib.rs", "crate", { exported: true })
            ]),
            graphEdgesForSelector(query, [
              {
                kind: "IMPORTS_FROM",
                from: "file:crates/app/src/lib.rs",
                to: "file:crates/app/src/used.rs"
              },
              {
                kind: "IMPORTS_FROM",
                from: "file:crates/app/src/a.rs",
                to: "file:crates/app/src/b.rs"
              },
              {
                kind: "IMPORTS_FROM",
                from: "file:crates/app/src/b.rs",
                to: "file:crates/app/src/a.rs"
              }
            ])
          )
      })
    }).runValidation(
      request({
        checks: [RUST_GRAPH_SIGNALS_CHECK_ID],
        scope: {
          kind: "files",
          files: ["Cargo.toml", "crates/app/Cargo.toml", ...sourceFiles]
        }
      })
    );

    assert.equal(result.status, "passed", JSON.stringify(result, null, 2));
    assert.deepEqual(
      result.diagnostics.map((diagnostic) => diagnostic.code).sort(),
      ["RUST_GRAPH_MODULE_CYCLE", "RUST_GRAPH_MODULE_ORPHAN"]
    );
    assert.equal(result.diagnostics.some((diagnostic) => diagnostic.path === "crates/app/src/orphan.rs"), true);
  });

  it("resolves cfg-gated and path-qualified Rust module declarations without false import failures", async () => {
    const temp = mkdtempSync(join(tmpdir(), "lattice-validation-rust-import-path-"));
    try {
      const { env } = writeFakeRustToolchain(join(temp, "bin"));
      const result = await runner({
        files: rustCrate({
          "crates/app/src/lib.rs": [
            '#[cfg(feature="optional")]',
            "mod optional;",
            '#[path="custom_child.rs"]',
            "mod child;",
            "use crate::child::value;",
            ""
          ].join("\n"),
          "crates/app/src/custom_child.rs": "pub fn value() -> i32 { 1 }\n"
        }),
        env
      }).runValidation(
        request({
          checks: [RUST_IMPORT_GRAPH_CHECK_ID],
          scope: {
            kind: "files",
            files: ["Cargo.toml", "crates/app/Cargo.toml", "crates/app/src/lib.rs", "crates/app/src/custom_child.rs"]
          }
        })
      );

      assert.equal(result.status, "passed", JSON.stringify(result, null, 2));
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("ignores cfg-gated Rust use paths when resolving import graphs", async () => {
    const result = await runner({
      files: rustCrate({
        "crates/app/src/lib.rs": [
          '#[cfg(feature="optional")]',
          "use crate::optional::Thing;",
          "pub fn value() -> i32 { 1 }",
          ""
        ].join("\n")
      })
    }).runValidation(
      request({
        checks: [RUST_IMPORT_GRAPH_CHECK_ID],
        scope: { kind: "files", files: ["Cargo.toml", "crates/app/Cargo.toml", "crates/app/src/lib.rs"] }
      })
    );

    assert.equal(result.status, "passed", JSON.stringify(result, null, 2));
  });

  it("does not treat non-cfg cfg_attr Rust uses or modules as cfg-gated", async () => {
    const result = await runner({
      files: rustCrate({
        "crates/app/src/lib.rs": [
          '#[cfg_attr(not(target_os = "linux"), allow(unused_imports))]',
          "use crate::missing::Thing;",
          '#[cfg_attr(not(target_os = "linux"), allow(dead_code))]',
          "mod missing_module;",
          "pub fn value() -> i32 { 1 }",
          ""
        ].join("\n")
      })
    }).runValidation(
      request({
        checks: [RUST_IMPORT_GRAPH_CHECK_ID],
        scope: { kind: "files", files: ["Cargo.toml", "crates/app/Cargo.toml", "crates/app/src/lib.rs"] }
      })
    );

    assert.equal(result.status, "policy_failure", JSON.stringify(result, null, 2));
    assert.deepEqual(
      result.diagnostics.map((diagnostic) => diagnostic.code),
      ["RUST_IMPORT_UNRESOLVED_MODULE", "RUST_IMPORT_UNRESOLVED_USE"]
    );
  });

  it("resolves path-qualified Rust module declarations relative to non-mod source files", async () => {
    const temp = mkdtempSync(join(tmpdir(), "lattice-validation-rust-import-path-parent-"));
    try {
      const { env } = writeFakeRustToolchain(join(temp, "bin"));
      const result = await runner({
        files: rustCrate({
          "crates/app/src/lib.rs": "mod parent;\n",
          "crates/app/src/parent.rs": ['#[path="custom_child.rs"]', "mod child;", "use self::child::value;", ""].join("\n"),
          "crates/app/src/custom_child.rs": "pub fn value() -> i32 { 1 }\n"
        }),
        env
      }).runValidation(
        request({
          checks: [RUST_IMPORT_GRAPH_CHECK_ID],
          scope: {
            kind: "files",
            files: [
              "Cargo.toml",
              "crates/app/Cargo.toml",
              "crates/app/src/lib.rs",
              "crates/app/src/parent.rs",
              "crates/app/src/custom_child.rs"
            ]
          }
        })
      );

      assert.equal(result.status, "passed", JSON.stringify(result, null, 2));
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("resolves crate-qualified Rust use paths from the current Cargo target root", async () => {
    const temp = mkdtempSync(join(tmpdir(), "lattice-validation-rust-import-crate-root-"));
    try {
      const { env } = writeFakeRustToolchain(join(temp, "bin"), {
        cargo: {
          metadata: defaultCargoMetadata({
            packages: [
              {
                id: "app",
                name: "app",
                manifest_path: "crates/app/Cargo.toml",
                edition: "2021",
                targets: [
                  {
                    name: "app",
                    kind: ["lib"],
                    src_path: "crates/app/src/lib.rs",
                    edition: "2021"
                  },
                  {
                    name: "app-bin",
                    kind: ["bin"],
                    src_path: "crates/app/src/main.rs",
                    edition: "2021"
                  }
                ]
              }
            ]
          })
        }
      });
      const result = await runner({
        files: rustCrate({
          "crates/app/src/lib.rs": "pub mod foo;\n",
          "crates/app/src/foo.rs": "pub struct Thing;\n",
          "crates/app/src/main.rs": "use crate::foo::Thing;\nfn main() {}\n"
        }),
        env
      }).runValidation(
        request({
          checks: [RUST_IMPORT_GRAPH_CHECK_ID],
          scope: {
            kind: "files",
            files: [
              "Cargo.toml",
              "crates/app/Cargo.toml",
              "crates/app/src/lib.rs",
              "crates/app/src/foo.rs",
              "crates/app/src/main.rs"
            ]
          }
        })
      );

      assert.equal(result.status, "policy_failure", JSON.stringify(result, null, 2));
      assert.deepEqual(
        result.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.message]),
        [["RUST_IMPORT_UNRESOLVED_USE", "Rust use path cannot be resolved: crate::foo::Thing"]]
      );
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("allows crate and super use paths that target Rust items instead of modules", async () => {
    const result = await runner({
      files: rustCrate({
        "crates/app/src/lib.rs": [
          "pub const VALUE: i32 = 42;",
          "pub struct Thing;",
          "pub mod inline { pub const INLINE: i32 = 1; }",
          "mod child;",
          "use crate::VALUE;",
          "use crate::Thing;",
          "pub use crate::inline::INLINE;",
          ""
        ].join("\n"),
        "crates/app/src/child.rs": ["use super::VALUE;", "pub fn child() -> i32 { VALUE }", ""].join("\n")
      })
    }).runValidation(
      request({
        checks: [RUST_IMPORT_GRAPH_CHECK_ID],
        scope: { kind: "files", files: ["Cargo.toml", "crates/app/Cargo.toml", "crates/app/src/lib.rs", "crates/app/src/child.rs"] }
      })
    );

    assert.equal(result.status, "passed", JSON.stringify(result, null, 2));
  });

  it("allows crate use paths that target enum variants", async () => {
    const result = await runner({
      files: rustCrate({
        "crates/app/src/lib.rs": ["pub enum E { V, W(i32), X { value: i32 } }", "use crate::E::V;", ""].join("\n")
      })
    }).runValidation(
      request({
        checks: [RUST_IMPORT_GRAPH_CHECK_ID],
        scope: { kind: "files", files: ["Cargo.toml", "crates/app/Cargo.toml", "crates/app/src/lib.rs"] }
      })
    );

    assert.equal(result.status, "passed", JSON.stringify(result, null, 2));
  });

  it("allows crate use paths that target re-exported enum variants", async () => {
    const result = await runner({
      files: rustCrate({
        "crates/app/src/lib.rs": ["mod foo;", "pub use foo::E;", "use crate::E::V;", ""].join("\n"),
        "crates/app/src/foo.rs": "pub enum E { V }\n"
      })
    }).runValidation(
      request({
        checks: [RUST_IMPORT_GRAPH_CHECK_ID],
        scope: {
          kind: "files",
          files: ["Cargo.toml", "crates/app/Cargo.toml", "crates/app/src/lib.rs", "crates/app/src/foo.rs"]
        }
      })
    );

    assert.equal(result.status, "passed", JSON.stringify(result, null, 2));
  });

  it("allows crate use paths that target glob re-exported module items", async () => {
    const result = await runner({
      files: rustCrate({
        "crates/app/src/lib.rs": "pub mod protocol;\nmod daemon;\n",
        "crates/app/src/protocol.rs": ["mod provider;", "pub use provider::*;", ""].join("\n"),
        "crates/app/src/protocol/provider.rs": "pub fn available_status() {}\npub struct GraphProviderStatus;\n",
        "crates/app/src/daemon.rs": [
          "use crate::protocol::{available_status, GraphProviderStatus};",
          "pub fn daemon() {",
          "  let _ = GraphProviderStatus;",
          "  available_status();",
          "}",
          ""
        ].join("\n")
      })
    }).runValidation(
      request({
        checks: [RUST_IMPORT_GRAPH_CHECK_ID],
        scope: {
          kind: "files",
          files: [
            "Cargo.toml",
            "crates/app/Cargo.toml",
            "crates/app/src/lib.rs",
            "crates/app/src/protocol.rs",
            "crates/app/src/protocol/provider.rs",
            "crates/app/src/daemon.rs"
          ]
        }
      })
    );

    assert.equal(result.status, "passed", JSON.stringify(result, null, 2));
  });

  it("reports unresolved deep Rust use paths under existing modules", async () => {
    const result = await runner({
      files: rustCrate({
        "crates/app/src/lib.rs": ["pub mod present;", "use crate::present::Missing;", ""].join("\n"),
        "crates/app/src/present.rs": "pub fn present() {}\n"
      })
    }).runValidation(
      request({
        checks: [RUST_IMPORT_GRAPH_CHECK_ID],
        scope: {
          kind: "files",
          files: ["Cargo.toml", "crates/app/Cargo.toml", "crates/app/src/lib.rs", "crates/app/src/present.rs"]
        }
      })
    );

    assert.equal(result.status, "policy_failure", JSON.stringify(result, null, 2));
    assert.deepEqual(
      result.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.message]),
      [["RUST_IMPORT_UNRESOLVED_USE", "Rust use path cannot be resolved: crate::present::Missing"]]
    );
  });

  it("reports unresolved block-scoped Rust use paths", async () => {
    const result = await runner({
      files: rustCrate({
        "crates/app/src/lib.rs": ["pub fn f() {", "  use crate::missing::Thing;", "}", ""].join("\n")
      })
    }).runValidation(
      request({
        checks: [RUST_IMPORT_GRAPH_CHECK_ID],
        scope: { kind: "files", files: ["Cargo.toml", "crates/app/Cargo.toml", "crates/app/src/lib.rs"] }
      })
    );

    assert.equal(result.status, "policy_failure", JSON.stringify(result, null, 2));
    assert.deepEqual(
      result.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.message]),
      [["RUST_IMPORT_UNRESOLVED_USE", "Rust use path cannot be resolved: crate::missing::Thing"]]
    );
  });

  it("reports unresolved nested grouped Rust use paths inside blocks", async () => {
    const result = await runner({
      files: rustCrate({
        "crates/app/src/lib.rs": ["pub mod present;", "pub fn f() {", "  use crate::{present::{Missing}};", "}", ""].join("\n"),
        "crates/app/src/present.rs": "pub fn present() {}\n"
      })
    }).runValidation(
      request({
        checks: [RUST_IMPORT_GRAPH_CHECK_ID],
        scope: {
          kind: "files",
          files: ["Cargo.toml", "crates/app/Cargo.toml", "crates/app/src/lib.rs", "crates/app/src/present.rs"]
        }
      })
    );

    assert.equal(result.status, "policy_failure", JSON.stringify(result, null, 2));
    assert.deepEqual(
      result.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.message]),
      [["RUST_IMPORT_UNRESOLVED_USE", "Rust use path cannot be resolved: crate::present::Missing"]]
    );
  });

  it("ignores Rust use tokens inside unexpanded macro token trees", async () => {
    const result = await runner({
      files: rustCrate({
        "crates/app/src/lib.rs": [
          "macro_rules! maybe_use {",
          "  () => { use crate::missing::Thing; };",
          "}",
          "macro_rules! discard_tokens {",
          "  ($($tokens:tt)*) => {};",
          "}",
          "pub fn f() {",
          "  discard_tokens! { use crate::also_missing::Thing; }",
          "}",
          ""
        ].join("\n")
      })
    }).runValidation(
      request({
        checks: [RUST_IMPORT_GRAPH_CHECK_ID],
        scope: { kind: "files", files: ["Cargo.toml", "crates/app/Cargo.toml", "crates/app/src/lib.rs"] }
      })
    );

    assert.equal(result.status, "passed", JSON.stringify(result, null, 2));
  });

  it("ignores Rust mod tokens inside unexpanded macro token trees", async () => {
    const result = await runner({
      files: rustCrate({
        "crates/app/src/lib.rs": [
          "macro_rules! discard_tokens {",
          "  ($($tokens:tt)*) => {};",
          "}",
          "discard_tokens!(mod ghost;);",
          ""
        ].join("\n")
      })
    }).runValidation(
      request({
        checks: [RUST_IMPORT_GRAPH_CHECK_ID],
        scope: { kind: "files", files: ["Cargo.toml", "crates/app/Cargo.toml", "crates/app/src/lib.rs"] }
      })
    );

    assert.equal(result.status, "passed", JSON.stringify(result, null, 2));
  });

  it("reports unresolved nested grouped Rust use paths", async () => {
    const result = await runner({
      files: rustCrate({
        "crates/app/src/lib.rs": ["pub mod foo;", "use crate::{foo::{Missing}};", ""].join("\n"),
        "crates/app/src/foo.rs": "pub fn present() {}\n"
      })
    }).runValidation(
      request({
        checks: [RUST_IMPORT_GRAPH_CHECK_ID],
        scope: {
          kind: "files",
          files: ["Cargo.toml", "crates/app/Cargo.toml", "crates/app/src/lib.rs", "crates/app/src/foo.rs"]
        }
      })
    );

    assert.equal(result.status, "policy_failure", JSON.stringify(result, null, 2));
    assert.deepEqual(
      result.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.message]),
      [["RUST_IMPORT_UNRESOLVED_USE", "Rust use path cannot be resolved: crate::foo::Missing"]]
    );
  });

  it("reports unresolved multiline grouped Rust use paths", async () => {
    const result = await runner({
      files: rustCrate({
        "crates/app/src/lib.rs": ["pub mod foo;", "use crate::{", "  foo::{Missing}", "};", ""].join("\n"),
        "crates/app/src/foo.rs": "pub fn present() {}\n"
      })
    }).runValidation(
      request({
        checks: [RUST_IMPORT_GRAPH_CHECK_ID],
        scope: {
          kind: "files",
          files: ["Cargo.toml", "crates/app/Cargo.toml", "crates/app/src/lib.rs", "crates/app/src/foo.rs"]
        }
      })
    );

    assert.equal(result.status, "policy_failure", JSON.stringify(result, null, 2));
    assert.deepEqual(
      result.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.message]),
      [["RUST_IMPORT_UNRESOLVED_USE", "Rust use path cannot be resolved: crate::foo::Missing"]]
    );
  });

  it("resolves super use paths inside inline module namespaces", async () => {
    const result = await runner({
      files: rustCrate({
        "crates/app/src/lib.rs": [
          "pub const ROOT: i32 = 1;",
          "mod child {",
          "  use super::ROOT;",
          "  pub fn child() -> i32 { ROOT }",
          "}",
          ""
        ].join("\n")
      })
    }).runValidation(
      request({
        checks: [RUST_IMPORT_GRAPH_CHECK_ID],
        scope: { kind: "files", files: ["Cargo.toml", "crates/app/Cargo.toml", "crates/app/src/lib.rs"] }
      })
    );

    assert.equal(result.status, "passed", JSON.stringify(result, null, 2));
  });

  it("resolves file modules declared inside inline module namespaces", async () => {
    const result = await runner({
      files: rustCrate({
        "crates/app/src/lib.rs": ["mod outer {", "  mod child;", "}", ""].join("\n"),
        "crates/app/src/outer/child.rs": "pub fn child() {}\n"
      })
    }).runValidation(
      request({
        checks: [RUST_IMPORT_GRAPH_CHECK_ID],
        scope: {
          kind: "files",
          files: ["Cargo.toml", "crates/app/Cargo.toml", "crates/app/src/lib.rs", "crates/app/src/outer/child.rs"]
        }
      })
    );

    assert.equal(result.status, "passed", JSON.stringify(result, null, 2));
  });

  it("treats visibility-qualified Rust module declarations as module edges", async () => {
    const result = await runner({
      files: rustCrate({
        "crates/app/src/lib.rs": "pub(crate) mod child;\n",
        "crates/app/src/child.rs": "pub fn child() {}\n"
      })
    }).runValidation(
      request({
        checks: [RUST_IMPORT_GRAPH_CHECK_ID],
        scope: {
          kind: "files",
          files: ["Cargo.toml", "crates/app/Cargo.toml", "crates/app/src/lib.rs", "crates/app/src/child.rs"]
        }
      })
    );

    assert.equal(result.status, "passed", JSON.stringify(result, null, 2));
  });

  it("resolves super use paths against the parent module namespace", async () => {
    const result = await runner({
      files: rustCrate({
        "crates/app/src/lib.rs": "mod child;\n",
        "crates/app/src/child.rs": ["const LOCAL: i32 = 1;", "use super::LOCAL;", ""].join("\n")
      })
    }).runValidation(
      request({
        checks: [RUST_IMPORT_GRAPH_CHECK_ID],
        scope: {
          kind: "files",
          files: ["Cargo.toml", "crates/app/Cargo.toml", "crates/app/src/lib.rs", "crates/app/src/child.rs"]
        }
      })
    );

    assert.equal(result.status, "policy_failure", JSON.stringify(result, null, 2));
    assert.deepEqual(
      result.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.message]),
      [["RUST_IMPORT_UNRESOLVED_USE", "Rust use path cannot be resolved: super::LOCAL"]]
    );
  });

  it("resolves super use paths that target parent imported bindings", async () => {
    const result = await runner({
      files: rustCrate({
        "crates/app/src/lib.rs": "mod store;\npub mod search;\n",
        "crates/app/src/search.rs": "pub fn create_search_schema() {}\n",
        "crates/app/src/store.rs": "use crate::search;\nmod schema;\n",
        "crates/app/src/store/schema.rs": "use super::search;\npub fn init() { search::create_search_schema(); }\n"
      })
    }).runValidation(
      request({
        checks: [RUST_IMPORT_GRAPH_CHECK_ID],
        scope: {
          kind: "files",
          files: [
            "Cargo.toml",
            "crates/app/Cargo.toml",
            "crates/app/src/lib.rs",
            "crates/app/src/search.rs",
            "crates/app/src/store.rs",
            "crates/app/src/store/schema.rs"
          ]
        }
      })
    );

    assert.equal(result.status, "passed", JSON.stringify(result, null, 2));
  });

  it("resolves repeated super use paths against ancestor module namespaces", async () => {
    const result = await runner({
      files: rustCrate({
        "crates/app/src/lib.rs": "pub const ROOT: i32 = 1;\nmod parent;\n",
        "crates/app/src/parent.rs": "mod child;\n",
        "crates/app/src/parent/child.rs": "use super::super::ROOT;\npub fn child() -> i32 { ROOT }\n"
      })
    }).runValidation(
      request({
        checks: [RUST_IMPORT_GRAPH_CHECK_ID],
        scope: {
          kind: "files",
          files: [
            "Cargo.toml",
            "crates/app/Cargo.toml",
            "crates/app/src/lib.rs",
            "crates/app/src/parent.rs",
            "crates/app/src/parent/child.rs"
          ]
        }
      })
    );

    assert.equal(result.status, "passed", JSON.stringify(result, null, 2));
  });

  it("resolves nested grouped re-export bindings in parent namespaces", async () => {
    const result = await runner({
      files: rustCrate({
        "crates/app/src/lib.rs": ["pub mod foo;", "mod child;", "pub use crate::{foo::{Present}};", ""].join("\n"),
        "crates/app/src/foo.rs": "pub const Present: i32 = 1;\n",
        "crates/app/src/child.rs": "use super::Present;\npub fn child() -> i32 { Present }\n"
      })
    }).runValidation(
      request({
        checks: [RUST_IMPORT_GRAPH_CHECK_ID],
        scope: {
          kind: "files",
          files: [
            "Cargo.toml",
            "crates/app/Cargo.toml",
            "crates/app/src/lib.rs",
            "crates/app/src/foo.rs",
            "crates/app/src/child.rs"
          ]
        }
      })
    );

    assert.equal(result.status, "passed", JSON.stringify(result, null, 2));
  });

  it("reports retained Rust rows as native when all supporting tools are available", () => {
    const temp = mkdtempSync(join(tmpdir(), "lattice-validation-rust-full-toolchain-"));
    try {
      const { env } = writeFakeRustToolchain(join(temp, "bin"));
      const status = createRustValidationAdapterStatus({ env });

      assert.equal(status.status, "available", JSON.stringify(status, null, 2));
      assert.deepEqual(status.degradedChecks, []);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("keeps missing retained Rust tools visible without generic retained dead-code status", () => {
    const temp = mkdtempSync(join(tmpdir(), "lattice-validation-rust-missing-retained-tools-"));
    try {
      const bin = join(temp, "bin");
      mkdirSync(bin, { recursive: true });
      const cargo = join(bin, "cargo");
      writeFileSync(cargo, fakeCargoScript({ udepsVersionStatus: 101, udepsStderr: "error: no such command: `udeps`\n" }));
      chmodSync(cargo, 0o755);
      const rustfmt = join(bin, "rustfmt");
      writeFileSync(rustfmt, "#!/bin/sh\nprintf '%s\\n' 'rustfmt 1.8.0'\n");
      chmodSync(rustfmt, 0o755);

      const status = createRustValidationAdapterStatus({ env: { ...process.env, PATH: bin } });

      assert.equal(status.status, "degraded");
      assert.deepEqual(
        status.degradedChecks.map((entry) => [entry.checkId, entry.requiredTool, entry.reason]),
        [
          [RUST_RUSTDOC_CHECK_ID, "rustdoc", "required_tool_unavailable"],
          [RUST_IMPORT_GRAPH_CHECK_ID, "cargo-depgraph", "optional_tool_unavailable"],
          [RUST_UNUSED_DEPS_CHECK_ID, "cargo-udeps", "required_tool_unavailable"],
          [RUST_FUNCTION_METRICS_CHECK_ID, "rust-code-analysis-cli", "required_tool_unavailable"]
        ]
      );
      assert.equal(status.degradedChecks.some((entry) => entry.checkId === RUST_DEAD_CODE_CHECK_ID), false);
      assert.equal(status.degradedChecks.every((entry) => entry.currentUsage !== undefined), true);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("checks rustdoc policy failures through cargo doc with typed missing rustdoc fallback", async () => {
    const temp = mkdtempSync(join(tmpdir(), "lattice-validation-rust-rustdoc-"));
    try {
      const rustdocBin = join(temp, "with-rustdoc");
      writeFakeRustToolchain(rustdocBin, {
        cargo: {
          docStdout: `${JSON.stringify(cargoMessage("warning", "broken intra-doc link", "rustdoc::broken_intra_doc_links"))}\n`,
          docStatus: 101
        }
      });
      const policy = await runner({
        files: rustCrate(),
        env: { ...process.env, PATH: rustdocBin }
      }).runValidation(request({ checks: [RUST_RUSTDOC_CHECK_ID] }));

      assert.equal(policy.status, "policy_failure", JSON.stringify(policy, null, 2));
      assert.equal(policy.diagnostics[0].code, "rustdoc::broken_intra_doc_links");
      assert.equal(policy.diagnostics[0].path, "crates/app/src/lib.rs");

      const missingBin = join(temp, "missing-rustdoc");
      mkdirSync(missingBin, { recursive: true });
      const cargo = join(missingBin, "cargo");
      writeFileSync(cargo, fakeCargoScript());
      chmodSync(cargo, 0o755);
      const missing = await runner({
        files: rustCrate(),
        env: { ...process.env, PATH: missingBin }
      }).runValidation(request({ checks: [RUST_RUSTDOC_CHECK_ID] }));

      assert.equal(missing.status, "unsupported_request");
      assert.match(missing.manifest.runs[0].failureMessage, /rustdoc/);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("detects Rust import unresolved modules, unresolved use paths, orphans, cycles, and overlay deletes", async () => {
    const result = await runner({
      files: rustCrate({
        "crates/app/src/lib.rs": ["mod present;", "mod missing;", "use crate::absent::Thing;", ""].join("\n"),
        "crates/app/src/present.rs": "mod looped;\npub fn present() {}\n",
        "crates/app/src/present/looped.rs": "mod back;\npub fn looped() {}\n",
        "crates/app/src/present/looped/back.rs": "mod looped;\npub fn back() {}\n",
        "crates/app/src/orphan.rs": "pub fn orphan() {}\n"
      }),
      env: process.env
    }).runValidation(
      request({
        checks: [RUST_IMPORT_GRAPH_CHECK_ID],
        scope: {
          kind: "files",
          files: [
            "Cargo.toml",
            "crates/app/Cargo.toml",
            "crates/app/src/lib.rs",
            "crates/app/src/present.rs",
            "crates/app/src/present/looped.rs",
            "crates/app/src/present/looped/back.rs",
            "crates/app/src/orphan.rs"
          ]
        },
        overlays: [{ path: "crates/app/src/present/looped/back/looped.rs", action: "delete" }]
      })
    );

    assert.equal(result.status, "policy_failure", JSON.stringify(result, null, 2));
    assert.deepEqual(
      result.diagnostics.map((diagnostic) => diagnostic.code),
      [
        "RUST_IMPORT_UNRESOLVED_MODULE",
        "RUST_IMPORT_UNRESOLVED_USE",
        "RUST_IMPORT_ORPHAN_SOURCE",
        "RUST_IMPORT_UNRESOLVED_MODULE",
      ]
    );
  });

  it("combines cargo dead_code diagnostics with native orphan-source dead-code evidence", async () => {
    const temp = mkdtempSync(join(tmpdir(), "lattice-validation-rust-dead-code-"));
    try {
      const logPath = join(temp, "cargo.log");
      const { env } = writeFakeRustToolchain(join(temp, "bin"), {
        cargo: {
          logPath,
          logEnvKeys: ["RUSTFLAGS"],
          checkStdout: `${JSON.stringify(cargoMessage("warning", "function `unused_private` is never used", "dead_code"))}\n`,
          checkStatus: 101
        }
      });
      env.RUSTFLAGS = "explicit-flag";
      const result = await runner({
        files: rustCrate({
          "crates/app/src/lib.rs": "pub fn answer() -> i32 { 42 }\n",
          "crates/app/src/orphan.rs": "fn unused_orphan() {}\n"
        }),
        env
      }).runValidation(
        request({
          checks: [RUST_DEAD_CODE_CHECK_ID],
          scope: {
            kind: "files",
            files: ["Cargo.toml", "crates/app/Cargo.toml", "crates/app/src/lib.rs", "crates/app/src/orphan.rs"]
          }
        })
      );

      assert.equal(result.status, "policy_failure", JSON.stringify(result, null, 2));
      assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), ["dead_code", "RUST_DEAD_ORPHAN_SOURCE"]);
      const cargoCheckLog = readFileSync(logPath, "utf8")
        .split(/\r?\n/)
        .find((line) => line.startsWith("check --message-format=json"));
      assert.equal(
        cargoCheckLog,
        "check --message-format=json --all-targets --all-features\tRUSTFLAGS=explicit-flag -Ddead_code"
      );
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("runs rust.dead-code with process env PATH and appends RUSTFLAGS when no env option is supplied", async () => {
    const temp = mkdtempSync(join(tmpdir(), "lattice-validation-rust-dead-code-env-"));
    const originalPath = process.env.PATH;
    const originalRustflags = process.env.RUSTFLAGS;
    try {
      const logPath = join(temp, "cargo.log");
      const { bin } = writeFakeRustToolchain(join(temp, "bin"), {
        cargo: {
          logPath,
          logEnvKeys: ["PATH", "RUSTFLAGS"]
        }
      });
      process.env.PATH = bin;
      process.env.RUSTFLAGS = "process-flag";
      const files = rustCrate();
      const content = new Map(Object.entries(files));
      const result = await createValidationRunner({
        workspace: {
          readFile: (path) => (content.has(path) ? { status: "found", content: content.get(path) } : { status: "missing" }),
          listChangedFiles: () => ({ files: [...content.keys()] }),
          listStagedFiles: () => ({ files: [...content.keys()] }),
          listRepoFiles: () => ({ files: [...content.keys()] }),
          listTreeFiles: () => ({ files: [...content.keys()] }),
          listPackageFiles: (_name, root) => ({ files: [...content.keys()].filter((path) => path.startsWith(`${root}/`)) })
        },
        checks: createRustValidationChecks()
      }).runValidation(request({ checks: [RUST_DEAD_CODE_CHECK_ID] }));

      assert.equal(result.status, "passed", JSON.stringify(result, null, 2));
      const cargoCheckLog = readFileSync(logPath, "utf8")
        .split(/\r?\n/)
        .find((line) => line.startsWith("check --message-format=json"));
      assert.equal(
        cargoCheckLog,
        `check --message-format=json --all-targets --all-features\tPATH=${bin}\tRUSTFLAGS=process-flag -Ddead_code`
      );
    } finally {
      restoreProcessEnv("PATH", originalPath);
      restoreProcessEnv("RUSTFLAGS", originalRustflags);
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("parses cargo-udeps output into deterministic unused dependency diagnostics", async () => {
    const temp = mkdtempSync(join(tmpdir(), "lattice-validation-rust-udeps-"));
    try {
      const { env } = writeFakeRustToolchain(join(temp, "bin"), {
        cargo: {
          udepsStderr: ["unused dependencies:", "`serde_json`", "unused dependency: anyhow", ""].join("\n"),
          udepsStatus: 1
        }
      });
      const result = await runner({ files: rustCrate(), env }).runValidation(request({ checks: [RUST_UNUSED_DEPS_CHECK_ID] }));

      assert.equal(result.status, "policy_failure", JSON.stringify(result, null, 2));
      assert.deepEqual(
        result.diagnostics.map((diagnostic) => `${diagnostic.code}:${diagnostic.message}`),
        [
          "RUST_UNUSED_DEPENDENCY:Rust dependency is unused: anyhow.",
          "RUST_UNUSED_DEPENDENCY:Rust dependency is unused: serde_json."
        ]
      );
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("runs cargo-udeps through an available nightly toolchain", async () => {
    const temp = mkdtempSync(join(tmpdir(), "lattice-validation-rust-udeps-nightly-run-"));
    try {
      const logPath = join(temp, "cargo.log");
      const { env } = writeFakeRustToolchain(join(temp, "bin"), {
        cargo: {
          logPath
        }
      });
      const result = await runner({ files: rustCrate(), env }).runValidation(request({ checks: [RUST_UNUSED_DEPS_CHECK_ID] }));

      assert.equal(result.status, "passed", JSON.stringify(result, null, 2));
      assert.match(readFileSync(logPath, "utf8"), /\+nightly udeps --workspace --all-targets --all-features/);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("classifies cargo-udeps nightly toolchain failures as unsupported instead of unused dependencies", async () => {
    const temp = mkdtempSync(join(tmpdir(), "lattice-validation-rust-udeps-nightly-"));
    try {
      const nightlyFailure = [
        "error: the option `Z` is only accepted on the nightly compiler",
        "",
        "help: consider switching to a nightly toolchain: `rustup default nightly`",
        "",
        "error: 1 nightly option were parsed",
        ""
      ].join("\n");
      const { env } = writeFakeRustToolchain(join(temp, "bin"), {
        cargo: {
          udepsStderr: nightlyFailure,
          udepsStatus: 101
        }
      });
      const result = await runner({ files: rustCrate(), env }).runValidation(request({ checks: [RUST_UNUSED_DEPS_CHECK_ID] }));

      assert.equal(result.status, "unsupported_request", JSON.stringify(result, null, 2));
      assert.equal(result.diagnostics.length, 0);
      assert.match(result.manifest.runs[0].failureMessage, /nightly compiler/);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("parses rust-code-analysis array/object metrics and enforces thresholds", async () => {
    const temp = mkdtempSync(join(tmpdir(), "lattice-validation-rust-function-metrics-"));
    try {
      const { env } = writeFakeRustToolchain(join(temp, "bin"), {
        rustCodeAnalysis: {
          stdout: JSON.stringify([
            {
              kind: "unit",
              name: "crates/app/src/lib.rs",
              start_line: 1,
              end_line: 200,
              metrics: {
                cyclomatic: { sum: 200 },
                nargs: { total: 50 },
                loc: { sloc: 200 }
              },
              spaces: [
                {
                  kind: "impl",
                  name: "Thing",
                  start_line: 1,
                  end_line: 120,
                  metrics: {
                    cyclomatic: { sum: 120 },
                    nargs: { total: 20 },
                    loc: { sloc: 120 }
                  },
                  spaces: []
                },
                {
                  kind: "function",
                  name: "too_much",
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
      const result = await createValidationRunner({
        workspace: {
          readFile: (path) => {
            const files = rustCrate();
            return path in files ? { status: "found", content: files[path] } : { status: "missing" };
          },
          listChangedFiles: () => ({ files: ["crates/app/src/lib.rs"] }),
          listStagedFiles: () => ({ files: ["crates/app/src/lib.rs"] }),
          listRepoFiles: () => ({ files: ["crates/app/src/lib.rs"] }),
          listTreeFiles: () => ({ files: ["crates/app/src/lib.rs"] }),
          listPackageFiles: () => ({ files: ["crates/app/src/lib.rs"] })
        },
        checks: createRustValidationChecks({
          env,
          functionMetrics: { maxFunctionLines: 5, maxComplexity: 3, maxParams: 4 }
        })
      }).runValidation(request({ checks: [RUST_FUNCTION_METRICS_CHECK_ID], scope: { kind: "repo" } }));

      assert.equal(result.status, "policy_failure", JSON.stringify(result, null, 2));
      assert.deepEqual(
        result.diagnostics.map((diagnostic) => diagnostic.code),
        ["RUST_FUNCTION_COMPLEXITY", "RUST_FUNCTION_LINES", "RUST_FUNCTION_PARAMS"]
      );
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("skips function metrics for deleted overlay Rust source files", async () => {
    const temp = mkdtempSync(join(tmpdir(), "lattice-validation-rust-function-metrics-delete-"));
    try {
      const bin = join(temp, "bin");
      const { env } = writeFakeRustToolchain(bin);
      const rca = join(bin, "rust-code-analysis-cli");
      writeFileSync(
        rca,
        [
          "#!/bin/sh",
          'if [ "$1" = "--version" ]; then printf "%s\\n" "rust-code-analysis-cli 0.0.25"; exit 0; fi',
          'path=""',
          'while [ "$#" -gt 0 ]; do',
          '  if [ "$1" = "-p" ]; then shift; path="$1"; fi',
          "  shift",
          "done",
          'if [ ! -f "$path" ]; then printf "%s\\n" "missing $path" >&2; exit 2; fi',
          "printf '%s\\n' '{\"spaces\":[]}'",
          ""
        ].join("\n")
      );
      chmodSync(rca, 0o755);

      const result = await runner({
        files: rustCrate({ "crates/app/src/delete_me.rs": "pub fn deleted() {}\n" }),
        env
      }).runValidation(
        request({
          checks: [RUST_FUNCTION_METRICS_CHECK_ID],
          scope: {
            kind: "files",
            files: ["Cargo.toml", "crates/app/Cargo.toml", "crates/app/src/delete_me.rs"]
          },
          overlays: [{ path: "crates/app/src/delete_me.rs", action: "delete" }]
        })
      );

      assert.equal(result.status, "passed", JSON.stringify(result, null, 2));
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("maps cargo compiler, rustfmt, clippy, import, dead-code, unused-deps, rustdoc, and function-metric failures deterministically", async () => {
    const workspace = runner({
      files: rustCrate({
        "crates/app/src/lib.rs": [
          "mod orphan;",
          "#[allow(dead_code)]",
          "fn unused_private() {}",
          "pub fn bad_format( ) {",
          "    let value: i32 = \"wrong\";",
          "    let values = vec![1];",
          "    let _first = values[1];",
          "}",
          ""
        ].join("\n"),
        "crates/app/src/orphan.rs": "pub fn orphan() {}\n"
      })
    });
    const checks = [
      RUST_CARGO_CHECK_ID,
      RUST_FMT_CHECK_ID,
      RUST_CLIPPY_CHECK_ID,
      RUST_IMPORT_GRAPH_CHECK_ID,
      RUST_DEAD_CODE_CHECK_ID,
      RUST_RUSTDOC_CHECK_ID,
      RUST_UNUSED_DEPS_CHECK_ID,
      RUST_FILE_LENGTH_CHECK_ID,
      RUST_FUNCTION_METRICS_CHECK_ID
    ];

    for (const checkId of checks) {
      const result = await workspace.runValidation(request({ checks: [checkId] }));
      assert.notEqual(result.status, "invalid_payload", checkId);
      assert.equal(result.manifest.runs[0].checkId, checkId);
      assert.match(["passed", "policy_failure", "infrastructure_failure", "unsupported_request"].join(","), new RegExp(result.status));
      if (result.status === "policy_failure") {
        assert.equal(result.diagnostics.every((diagnostic) => typeof diagnostic.path === "string"), true, checkId);
      }
    }
  });

function cargoMessage(level, message, code) {
  return {
    reason: "compiler-message",
    message: {
      level,
      message,
      code: { code },
      spans: [{ file_name: "crates/app/src/lib.rs", is_primary: true }]
    }
  };
}

function restoreProcessEnv(key, value) {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

function rustGraphRunner(options = {}) {
  const content = new Map(Object.entries(options.files ?? rustCrate()));
  return createValidationRunner({
    workspace: {
      readFile: (path) => (content.has(path) ? { status: "found", content: content.get(path) } : { status: "missing" }),
      listChangedFiles: () => ({ files: [...content.keys()] }),
      listStagedFiles: () => ({ files: [...content.keys()] }),
      listRepoFiles: () => ({ files: [...content.keys()] }),
      listTreeFiles: () => ({ files: [...content.keys()] }),
      listPackageFiles: (_name, root) => ({ files: [...content.keys()].filter((path) => path.startsWith(`${root}/`)) })
    },
    checks: options.checks ?? createRustValidationChecks({ env: options.env, timeoutMs: options.timeoutMs }),
    graphProviderClient: options.graphProviderClient
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

function availableStatus(mode = "optional", repo = { repoId: "lattice-rust-test" }) {
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
      nodeKinds: ["File", "Module", "Function", "Method"],
      edgeKinds: ["CONTAINS", "IMPORTS_FROM", "CALLS", "TESTED_BY"],
      ...metadataOverrides
    },
    nodes,
    edges
  };
}

function graphNodesForSelector(query, nodes) {
  if (query.selector.kind === "symbols") return nodes.filter((node) => node.kind !== "File" && node.kind !== "file");
  if (query.selector.kind !== "nodes") return [];
  const ids = new Set(query.selector.ids ?? []);
  const kinds = new Set(query.selector.nodeKinds ?? []);
  return nodes.filter((node) => (ids.size === 0 || ids.has(node.id)) && (kinds.size === 0 || kinds.has(node.kind)));
}

function graphEdgesForSelector(query, edges) {
  if (query.selector.kind !== "edges") return [];
  const edgeKinds = new Set(query.selector.edgeKinds ?? []);
  return edges.filter((edge) => edgeKinds.size === 0 || edgeKinds.has(edge.kind));
}

function fileNode(path) {
  return {
    id: `file:${path}`,
    kind: "File",
    path,
    attributes: {
      language: "rust"
    }
  };
}

function rustSymbol(id, kind, path, name, attributes = {}) {
  return {
    id,
    kind,
    path,
    name,
    attributes: {
      language: "rust",
      ...attributes
    }
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
