import { it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeValidationWorkspace, createValidationRunner } from "../packages/validation/dist/index.js";
import {
  RUST_CARGO_CHECK_ID,
  RUST_FUNCTION_METRICS_CHECK_ID,
  RUST_UNUSED_DEPS_CHECK_ID,
  createRustValidationChecks
} from "../packages/validation-rust/dist/index.js";
import { initializeGitSnapshot, request } from "./helpers/validation-rust-fixtures.mjs";

it("maps package scope through cargo metadata member identity and rejects unsupported members", async () => {
  const temp = mkdtempSync(join(tmpdir(), "lattice-validation-rust-package-scope-"));
  try {
    const fixture = writePackageScopeFixture(temp);
    const validationRunner = createValidationRunner({
      workspace: createNodeValidationWorkspace({ repoRoot: fixture.repo }),
      checks: createRustValidationChecks({ env: { ...process.env, PATH: fixture.bin } })
    });

    const byRoot = await validationRunner.runValidation(packageRequest(fixture.repo, "caller-alias", "crates/app"));
    const unsupported = await validationRunner.runValidation(packageRequest(fixture.repo, "missing", "crates/not-member"));

    assert.equal(byRoot.status, "passed", JSON.stringify(byRoot, null, 2));
    assert.match(readFileSync(fixture.logPath, "utf8"), /check -p real-app --message-format=json/);
    assert.equal(unsupported.status, "unsupported_request");
    assert.equal(unsupported.diagnostics.length, 0);
    assert.match(unsupported.manifest.runs[0].failureMessage, /Cargo workspace member/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

it("scopes unused-deps and function-metrics to the selected Cargo package member", async () => {
  const temp = mkdtempSync(join(tmpdir(), "lattice-validation-rust-retained-package-scope-"));
  try {
    const fixture = writePackageScopeFixture(temp);
    writeFileSync(
      join(fixture.bin, "rust-code-analysis-cli"),
      [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then printf "%s\\n" "rust-code-analysis-cli 0.0.25"; exit 0; fi',
        `printf '%s\\n' "$*" >> '${fixture.rcaLogPath}'`,
        "printf '%s\\n' '{\"spaces\":[]}'",
        ""
      ].join("\n")
    );
    chmodSync(join(fixture.bin, "rust-code-analysis-cli"), 0o755);
    writeFileSync(join(fixture.bin, "cargo-depgraph"), "#!/bin/sh\nprintf '%s\\n' 'cargo-depgraph 1.2.3'\n");
    chmodSync(join(fixture.bin, "cargo-depgraph"), 0o755);
    writeFileSync(join(fixture.bin, "rustdoc"), "#!/bin/sh\nprintf '%s\\n' 'rustdoc 1.93.0'\n");
    chmodSync(join(fixture.bin, "rustdoc"), 0o755);

    const validationRunner = createValidationRunner({
      workspace: createNodeValidationWorkspace({ repoRoot: fixture.repo }),
      checks: createRustValidationChecks({ env: { ...process.env, PATH: fixture.bin } })
    });

    const unusedDeps = await validationRunner.runValidation(
      packageRequest(fixture.repo, "caller-alias", "crates/app", [RUST_UNUSED_DEPS_CHECK_ID])
    );
    const functionMetrics = await validationRunner.runValidation(
      packageRequest(fixture.repo, "caller-alias", "crates/app", [RUST_FUNCTION_METRICS_CHECK_ID])
    );

    assert.equal(unusedDeps.status, "passed", JSON.stringify(unusedDeps, null, 2));
    assert.equal(functionMetrics.status, "passed", JSON.stringify(functionMetrics, null, 2));
    assert.match(readFileSync(fixture.logPath, "utf8"), /udeps -p real-app --all-targets --all-features/);
    assert.match(readFileSync(fixture.rcaLogPath, "utf8"), /crates\/app\/src\/lib\.rs/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

function packageRequest(repoRoot, packageName, packageRoot, checks = [RUST_CARGO_CHECK_ID]) {
  return request({
    repo: { repoRoot },
    checks,
    scope: { kind: "package", packageName, packageRoot }
  });
}

function writePackageScopeFixture(temp) {
  const bin = join(temp, "bin");
  const repo = join(temp, "repo");
  const logPath = join(temp, "cargo-args.log");
  const rcaLogPath = join(temp, "rca-args.log");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(repo, "crates/app/src"), { recursive: true });
  mkdirSync(join(repo, "crates/not-member/src"), { recursive: true });
  writeFileSync(join(repo, "Cargo.toml"), '[workspace]\nmembers = ["crates/app"]\nresolver = "2"\n');
  writeFileSync(join(repo, "crates/app/Cargo.toml"), packageManifest("real-app"));
  writeFileSync(join(repo, "crates/app/src/lib.rs"), "pub fn answer() -> i32 { 42 }\n");
  writeFileSync(join(repo, "crates/not-member/src/lib.rs"), "pub fn answer() -> i32 { 42 }\n");
  initializeGitSnapshot(repo, [
    "Cargo.toml",
    "crates/app/Cargo.toml",
    "crates/app/src/lib.rs",
    "crates/not-member/src/lib.rs"
  ]);
  writeCargoStub(join(bin, "cargo"), logPath);
  return { bin, repo, logPath, rcaLogPath };
}

function packageManifest(name) {
  return `[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2021"\n`;
}

function writeCargoStub(cargo, logPath) {
  writeFileSync(
    cargo,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> '${logPath}'`,
      'case "$1" in',
      "metadata)",
      `  printf '%s\\n' '${cargoMetadata()}'`,
      "  exit 0",
      "  ;;",
      "udeps)",
      "  if [ \"$2\" = \"--version\" ]; then",
      "    printf '%s\\n' 'cargo-udeps 0.1.61'",
      "    exit 0",
      "  fi",
      "  exit 0",
      "  ;;",
      "clippy)",
      "  if [ \"$2\" = \"--version\" ]; then",
      "    printf '%s\\n' 'clippy 0.1.93'",
      "    exit 0",
      "  fi",
      "  exit 0",
      "  ;;",
      "*)",
      "  exit 0",
      "  ;;",
      "esac",
      ""
    ].join("\n")
  );
  chmodSync(cargo, 0o755);
}

function cargoMetadata() {
  return JSON.stringify({
    packages: [
      {
        id: "real-app",
        name: "real-app",
        manifest_path: "crates/app/Cargo.toml",
        edition: "2021",
        targets: [{ name: "real-app", kind: ["lib"], src_path: "crates/app/src/lib.rs", edition: "2021" }]
      }
    ],
    workspace_members: ["real-app"],
    workspace_root: "."
  });
}
