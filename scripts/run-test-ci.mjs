#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const nativePackagingTest = "tests/native-packaging-policy.test.mjs";
const pythonValidationTest = "tests/validation-python.test.mjs";
const testFiles = readdirSync("tests")
  .filter((file) => file.endsWith(".test.mjs"))
  .map((file) => join("tests", file))
  .sort();
const parallelSafeTests = testFiles.filter((file) => file !== nativePackagingTest && file !== pythonValidationTest);
const env = { ...process.env, OPCORE_CI_RECEIPT_GATES_RUN_SEPARATELY: "1" };

runTests("parallel-safe tests", parallelSafeTests);
runTests("Python validation", [pythonValidationTest]);
runTests("native packaging policy", [nativePackagingTest]);

function runTests(label, files) {
  if (files.length === 0) return;
  const result = spawnSync(process.execPath, ["--test", ...files], {
    env,
    encoding: "utf8",
    stdio: "inherit"
  });
  if (result.status !== 0) {
    process.stderr.write(`test:ci ${label} failed\n`);
    process.exit(result.status ?? 1);
  }
}
