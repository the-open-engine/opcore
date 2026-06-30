import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatScanPlate, formatCheckStamp } from "../packages/opcore/dist/plate.js";
import { runOpcoreCli } from "../packages/opcore/dist/index.js";

const ESC = "[";
const RUST = "[38;2;194;36;12m";

const repoState = {
  repo: { root: "/work/acme-web" },
  graph: { state: "available" },
  activation: { level: "ready", summary: "graph fresh" },
  validation: { degradedToolchains: [] },
  coverage: {
    totalFiles: 100,
    languages: [
      { language: "typescript", files: 60 },
      { language: "rust", files: 20 },
      { language: "python", files: 8 }
    ],
    graph: { supportedFiles: 60 },
    validation: { supportedFiles: 70, retainedFiles: 5 },
    unsupported: { stacks: [{ language: "go", count: 3 }] }
  }
};

const failing = {
  status: "failed",
  diagnostics: [
    { category: "typescript.types", message: "Type mismatch", path: "src/a.ts", severity: "error", code: "TS2345" }
  ],
  manifest: {
    runs: [
      { checkId: "typescript.syntax", status: "passed" },
      { checkId: "typescript.types", status: "failed" }
    ]
  }
};

const passing = {
  status: "passed",
  diagnostics: [],
  manifest: { runs: [{ checkId: "typescript.syntax", status: "passed" }] }
};

describe("opcore constraint plate", () => {
  it("renders the scan plate coverage-before-findings without color when color is off", () => {
    const plate = formatScanPlate(repoState, failing, { color: false });
    assert.match(plate, /┌─ OPCORE/);
    assert.match(plate, /LAYER 02 · CONSTRAINTS/);
    assert.equal(plate.indexOf("COVERAGE") < plate.indexOf("FINDINGS"), true);
    assert.match(plate, /next {2}opcore check --changed --json/);
    assert.equal(plate.includes(ESC), false, "plain plate must contain no ANSI escapes");
  });

  it("colorizes the scan plate with the single rust accent when color is on", () => {
    const plate = formatScanPlate(repoState, failing, { color: true });
    assert.equal(plate.includes(RUST), true, "color plate uses the rust accent");
    // Alignment invariant: stripping ANSI leaves the same plain layout.
    const stripped = plate.replace(/\[[0-9;]*m/g, "");
    assert.equal(stripped, formatScanPlate(repoState, failing, { color: false }));
  });

  it("stamps a blocked changed-file gate with exit 1", () => {
    const stamp = formatCheckStamp({ validationResult: failing, scope: "CHANGED", base: "HEAD", color: false });
    assert.match(stamp, /┌─ OPCORE · CHANGED/);
    assert.match(stamp, /vs HEAD/);
    assert.match(stamp, /BLOCKED {2}✗/);
    assert.match(stamp, /out of tolerance · 1 findings · exit 1/);
  });

  it("stamps a cleared changed-file gate with exit 0", () => {
    const stamp = formatCheckStamp({ validationResult: passing, scope: "CHANGED", base: "HEAD", color: false });
    assert.match(stamp, /CLEARED {2}◦/);
    assert.match(stamp, /within tolerance · 0 findings · exit 0/);
    assert.equal(stamp.includes(ESC), false);
  });

  it("uses the plain Coverage contract for non-TTY scans and the plate for TTY scans", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opcore-plate-"));
    try {
      writeFileSync(join(dir, "index.ts"), "export const greet = (name: string): string => `hi ${name}`;\n");

      let plain = "";
      await runOpcoreCli({
        argv: ["--repo", dir],
        stdout: (text) => (plain += text),
        stderr: () => {},
        stdoutIsTTY: false
      });
      assert.equal(plain.startsWith("Coverage:"), true, "non-TTY scan keeps the stable text contract");

      let fancy = "";
      await runOpcoreCli({
        argv: ["--repo", dir],
        stdout: (text) => (fancy += text),
        stderr: () => {},
        stdoutIsTTY: true
      });
      assert.match(fancy, /┌─ OPCORE/);
      assert.equal(fancy.indexOf("COVERAGE") < fancy.indexOf("FINDINGS"), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
