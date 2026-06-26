import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PRE_WRITE_TIMEOUT_MS,
  parseCheckCommandOptions,
  parseValidateCommandOptions,
  ValidationCommandOptionsError
} from "../packages/validation/dist/index.js";

describe("validation command options", () => {
  it("parses validate pre-write with default and explicit timeouts", () => {
    assert.deepEqual(parseValidateCommandOptions(["pre-write", "--request-file", "request.json"]), {
      route: "pre-write",
      graphMode: "optional",
      requestFile: "request.json",
      timeoutMs: DEFAULT_PRE_WRITE_TIMEOUT_MS
    });
    assert.deepEqual(parseValidateCommandOptions(["pre-write", "--request-file=request.json", "--timeout-ms=5000"]), {
      route: "pre-write",
      graphMode: "optional",
      requestFile: "request.json",
      timeoutMs: 5000
    });
    assert.equal(
      parseValidateCommandOptions(["pre-write", "--request-file", "request.json", "--timeout-ms", "7"]).timeoutMs,
      7
    );
  });

  it("rejects pre-write without a request file or with stdin", () => {
    assert.throws(() => parseValidateCommandOptions(["pre-write"]), ValidationCommandOptionsError);
    assert.throws(
      () => parseValidateCommandOptions(["pre-write", "--request-file", "-"]),
      /stdin request payloads are not supported/
    );
  });

  it("rejects invalid pre-write timeout values", () => {
    for (const value of ["0", "-1", "1.5", "abc", ""]) {
      const flag = value.length === 0 ? ["--timeout-ms="] : ["--timeout-ms", value];
      assert.throws(
        () => parseValidateCommandOptions(["pre-write", "--request-file", "request.json", ...flag]),
        /--timeout-ms must be a positive integer/
      );
    }
  });

  it("rejects scope, repo, check, and graph flags on pre-write", () => {
    for (const flags of [
      ["--repo", "."],
      ["--files", "src/index.ts"],
      ["--staged"],
      ["--changed", "--base", "HEAD"],
      ["--all"],
      ["--check", "typescript.syntax"],
      ["--checks", "typescript.syntax"],
      ["--graph-mode", "required"]
    ]) {
      assert.throws(
        () => parseValidateCommandOptions(["pre-write", "--request-file", "request.json", ...flags]),
        /pre-write cannot be combined/
      );
    }
  });

  it("rejects timeout flags outside pre-write", () => {
    assert.throws(
      () => parseValidateCommandOptions(["request", "--request-file", "request.json", "--timeout-ms", "1"]),
      /cannot be combined with --timeout-ms/
    );
    assert.throws(() => parseCheckCommandOptions(["files", "--files", "src/index.ts", "--timeout-ms", "1"]), /--timeout-ms/);
  });
});
