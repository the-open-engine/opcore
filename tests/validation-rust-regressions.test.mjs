import { it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RUST_CLIPPY_CHECK_ID,
  RUST_SOURCE_HYGIENE_CHECK_ID
} from "../packages/validation-rust/dist/index.js";
import { fakeCargoScript, request, runner, rustCrate } from "./helpers/validation-rust-fixtures.mjs";

it("rejects nested allow(dead_code) source-hygiene suppressions", async () => {
  const result = await runner({
    files: rustCrate({
      "crates/app/src/lib.rs": [
        "#[cfg_attr(not(test), allow(dead_code))]",
        "pub fn schema_only() {}",
        ""
      ].join("\n")
    })
  }).runValidation(request({ checks: [RUST_SOURCE_HYGIENE_CHECK_ID] }));

  assert.equal(result.status, "policy_failure");
  assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), ["RUST_SOURCE_ALLOW_DEAD_CODE"]);
});

it("treats owned clippy warning diagnostics as blocking policy failures", async () => {
  const temp = mkdtempSync(join(tmpdir(), "lattice-validation-rust-clippy-warning-"));
  try {
    const bin = join(temp, "bin");
    mkdirSync(bin, { recursive: true });
    const cargo = join(bin, "cargo");
    writeFileSync(cargo, fakeCargoScript({ clippyStdout: `${JSON.stringify(clippyWarning())}\n`, clippyStatus: 0 }));
    chmodSync(cargo, 0o755);

    const result = await runner({
      env: {
        ...process.env,
        PATH: bin
      }
    }).runValidation(request({ checks: [RUST_CLIPPY_CHECK_ID] }));

    assert.equal(result.status, "policy_failure");
    assert.equal(result.diagnostics[0]?.code, "clippy::unwrap_used");
    assert.equal(result.diagnostics[0]?.severity, "error");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

function clippyWarning() {
  return {
    reason: "compiler-message",
    message: {
      level: "warning",
      message: "used unwrap on an Option value",
      code: { code: "clippy::unwrap_used" },
      spans: [{ file_name: "crates/app/src/lib.rs", is_primary: true }]
    }
  };
}
