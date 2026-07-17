import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const opcoreBin = resolve(repoRoot, "packages/opcore/dist/index.js");

describe("Opcore agent write gate adapter", () => {
  it("maps Claude Write payloads into pre-write validation and blocks introduced TypeScript errors", () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-agent-gate-write-"));
    try {
      initTypeScriptFixture(temp);
      const shimDir = createOpcoreShim(temp);
      runOpcore(["init", "--repo", temp, "--local", "--approve", "--json"], temp, 0, shimEnv(shimDir));
      const hookPath = join(temp, ".opcore", "hooks", "opcore-agent-gate.mjs");
      assert.equal(existsSync(hookPath), true);

      const blocked = runHook(
        hookPath,
        {
          cwd: temp,
          hook_event_name: "PreToolUse",
          tool_name: "Write",
          tool_input: {
            file_path: join(temp, "src", "index.ts"),
            content: "export const value: number = 'bad';\n"
          },
          env: shimEnv(shimDir),
          expectedStatus: 2
        }
      );
      assert.match(blocked.stderr, /Opcore write gate blocked Write/);
      assert.match(blocked.stderr, /typescript\.types|types/i);
      assert.equal(readFileSync(join(temp, "src", "index.ts"), "utf8"), "export const value: number = 1;\n");

      const clean = runHook(
        hookPath,
        {
          cwd: temp,
          hook_event_name: "PreToolUse",
          tool_name: "Write",
          tool_input: {
            file_path: join(temp, "src", "index.ts"),
            content: "export const value: number = 2;\n"
          },
          env: shimEnv(shimDir),
          expectedStatus: 0
        }
      );
      assert.equal(clean.stderr, "");
      assert.equal(readFileSync(join(temp, "src", "index.ts"), "utf8"), "export const value: number = 1;\n");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("skips non-file hook payloads without blocking the harness", () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-agent-gate-skip-"));
    try {
      initTypeScriptFixture(temp);
      const shimDir = createOpcoreShim(temp);
      runOpcore(["init", "--repo", temp, "--local", "--approve", "--json"], temp, 0, shimEnv(shimDir));
      const hookPath = join(temp, ".opcore", "hooks", "opcore-agent-gate.mjs");

      const skipped = runHook(
        hookPath,
        {
          cwd: temp,
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: {
            command: "echo no file write"
          },
          env: shimEnv(shimDir),
          expectedStatus: 0
        }
      );

      assert.equal(skipped.stdout, "");
      assert.equal(skipped.stderr, "");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("resolves repo-local opcore from node_modules/.bin when the hook PATH is plain", () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-agent-gate-local-bin-"));
    try {
      initTypeScriptFixture(temp);
      createOpcoreShim(temp, "node_modules/.bin");
      runOpcore(["init", "--repo", temp, "--local", "--approve", "--json"], temp, 0);
      const hookPath = join(temp, ".opcore", "hooks", "opcore-agent-gate.mjs");

      const clean = runHook(
        hookPath,
        {
          cwd: temp,
          hook_event_name: "PreToolUse",
          tool_name: "Write",
          tool_input: {
            file_path: join(temp, "src", "index.ts"),
            content: "export const value: number = 2;\n"
          },
          env: { ...process.env, PATH: "/usr/bin:/bin" },
          expectedStatus: 0
        }
      );

      assert.equal(clean.stderr, "");
      assert.equal(readFileSync(join(temp, "src", "index.ts"), "utf8"), "export const value: number = 1;\n");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("reports a missing opcore command without crashing on empty spawn output", () => {
    const temp = mkdtempSync(join(tmpdir(), "opcore-agent-gate-missing-bin-"));
    try {
      initTypeScriptFixture(temp);
      runOpcore(["init", "--repo", temp, "--local", "--approve", "--json"], temp, 0);
      const hookPath = join(temp, ".opcore", "hooks", "opcore-agent-gate.mjs");

      const blocked = runHook(
        hookPath,
        {
          cwd: temp,
          hook_event_name: "PreToolUse",
          tool_name: "Write",
          tool_input: {
            file_path: join(temp, "src", "index.ts"),
            content: "export const value: number = 2;\n"
          },
          env: { ...process.env, PATH: "" },
          expectedStatus: 2
        }
      );

      assert.match(blocked.stderr, /validation command failed/);
      assert.match(blocked.stderr, /ENOENT/);
      assert.doesNotMatch(blocked.stderr, /Cannot read properties/);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});

function initTypeScriptFixture(root) {
  writeFixtureFile(root, "package.json", '{"type":"module","devDependencies":{"typescript":"^5.9.3"}}\n');
  writeFixtureFile(
    root,
    "tsconfig.json",
    JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["src/**/*.ts"] }, null, 2) + "\n"
  );
  writeFixtureFile(root, "src/index.ts", "export const value: number = 1;\n");
}

function createOpcoreShim(root, relativeDir = "bin") {
  const shimDir = join(root, relativeDir);
  mkdirSync(shimDir, { recursive: true });
  const shimPath = join(shimDir, "opcore");
  writeFileSync(shimPath, `#!/usr/bin/env sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(opcoreBin)} "$@"\n`);
  spawnSync("chmod", ["755", shimPath]);
  assert.equal(statSync(shimPath).mode & 0o111, 0o111);
  return shimDir;
}

function shimEnv(shimDir) {
  return { ...process.env, PATH: `${shimDir}:${process.env.PATH ?? ""}` };
}

function runOpcore(args, cwd, expectedStatus, env = process.env) {
  const result = spawnSync(process.execPath, [opcoreBin, ...args], {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  assert.equal(result.status, expectedStatus, result.stderr || result.stdout);
  return result;
}

function runHook(hookPath, options) {
  const { cwd, env, expectedStatus, ...payload } = options;
  const result = spawnSync(process.execPath, [hookPath, "--harness", "claude", "--repo", cwd], {
    cwd,
    env,
    input: JSON.stringify(payload),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"]
  });
  assert.equal(result.status, expectedStatus, [
    `status=${result.status}`,
    `stdout:\n${result.stdout}`,
    `stderr:\n${result.stderr}`
  ].join("\n"));
  return result;
}

function writeFixtureFile(root, path, content) {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}
