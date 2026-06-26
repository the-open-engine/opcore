import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const copiedRepoSkips = new Set([
  ".git",
  "node_modules",
  "dist",
  ".ace",
  ".agents",
  ".claude",
  ".codex",
  ".gemini",
  ".opencode",
  ".code-review-graph",
  ".rox-cache",
  ".robustness-engine-cache",
  "target"
]);

describe("current tool setup", () => {
  it("generates wrappers and tooling manifest from external tools", () => {
    const repo = tempRepo();
    const tools = fakeTools();
    const result = run(repo, "bash", ["scripts/setup-current-tools.sh"], {
      env: { LATTICE_CURRENT_TOOLS_DIR: tools }
    });
    assert.match(result.stdout, /current tool wrappers ready/);

    for (const tool of ["rox", "crg", "cix"]) {
      const wrapper = join(repo, ".ace/runtime/bin", tool);
      assert.equal(existsSync(wrapper), true);
      assert.match(readFileSync(wrapper, "utf8"), new RegExp(`${tools}/${tool}`));
    }

    const tooling = JSON.parse(readFileSync(join(repo, ".ace/runtime/tooling.json"), "utf8"));
    assert.equal(tooling.tooling.aceTools.binRoot, ".ace/runtime/bin");
    assert.deepEqual(Object.keys(tooling.tooling.aceTools.tools).sort(), ["cix", "crg", "rox"]);
  });

  it("rejects lattice-internal tool sources", () => {
    const repo = tempRepo();
    const tools = fakeTools();
    const internalRox = join(repo, "packages/graph/rox");
    writeFileSync(internalRox, "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(internalRox, 0o755);

    const result = run(repo, "bash", ["scripts/setup-current-tools.sh"], {
      expectFailure: true,
      env: {
        LATTICE_CURRENT_ROX_PATH: internalRox,
        LATTICE_CURRENT_CRG_PATH: join(tools, "crg"),
        LATTICE_CURRENT_CIX_PATH: join(tools, "cix")
      }
    });
    assert.match(stderrAndStdout(result), /source resolved inside lattice/);
  });

  it("rejects symlinks that resolve to lattice-internal tool sources", () => {
    const repo = tempRepo();
    const tools = fakeTools();
    const internalRox = join(repo, "packages/graph/rox");
    const symlinkDir = mkdtempSync(join(tmpdir(), "lattice-current-tools-link-"));
    const symlinkedRox = join(symlinkDir, "rox");
    writeFileSync(internalRox, "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(internalRox, 0o755);
    symlinkSync(internalRox, symlinkedRox);

    const result = run(repo, "bash", ["scripts/setup-current-tools.sh"], {
      expectFailure: true,
      env: {
        LATTICE_CURRENT_ROX_PATH: symlinkedRox,
        LATTICE_CURRENT_CRG_PATH: join(tools, "crg"),
        LATTICE_CURRENT_CIX_PATH: join(tools, "cix")
      }
    });
    assert.match(stderrAndStdout(result), /source resolved inside lattice/);
  });
});

describe("dev-env current-tool wrappers", () => {
  for (const tool of ["rox", "crg", "cix"]) {
    it(`fails closed when ${tool} wrapper is missing`, () => {
      const repo = tempRepo();
      run(repo, "bash", ["scripts/setup-current-tools.sh"], {
        env: { LATTICE_CURRENT_TOOLS_DIR: fakeTools() }
      });
      rmSync(join(repo, ".ace/runtime/bin", tool));

      const result = run(repo, "bash", ["-lc", devEnvProbeScript()], {
        expectFailure: true
      });

      assert.match(result.stderr, /run npm run setup:tools/);
      assert.match(result.stdout, /status=1/);
      assert.match(result.stdout, /PATH=\/usr\/bin:\/bin/);
      assert.match(result.stdout, /runtime=/);
      assert.match(result.stdout, /cixroot=/);
    });
  }

  it("exports current-tool environment when all wrappers are present", () => {
    const repo = tempRepo();
    run(repo, "bash", ["scripts/setup-current-tools.sh"], {
      env: { LATTICE_CURRENT_TOOLS_DIR: fakeTools() }
    });

    const result = run(repo, "bash", ["-lc", devEnvProbeScript()]);
    const output = parseProbeOutput(result.stdout);
    const realRepo = realpathSync(repo);

    assert.equal(output.status, "0");
    assert.equal(output.PATH, `${join(realRepo, ".ace/runtime/bin")}:/usr/bin:/bin`);
    assert.equal(output.runtime, join(realRepo, ".ace/rox"));
    assert.equal(output.cixroot, realRepo);
  });
});

function tempRepo() {
  const tempRoot = mkdtempSync(join(tmpdir(), "lattice-tools-"));
  const repo = join(tempRoot, "repo");
  cpSync(repoRoot, repo, {
    recursive: true,
    filter(source) {
      const rel = relative(repoRoot, source);
      if (rel === "") return true;
      return !rel.split(/[\\/]/).some((segment) => copiedRepoSkips.has(segment));
    }
  });
  return repo;
}

function fakeTools() {
  const dir = mkdtempSync(join(tmpdir(), "lattice-current-tools-"));
  for (const tool of ["rox", "crg", "cix"]) {
    const path = join(dir, tool);
    writeFileSync(path, `#!/usr/bin/env bash\nprintf '${tool} fake\\n'\n`);
    chmodSync(path, 0o755);
  }
  return dir;
}

function run(cwd, command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (options.expectFailure) {
    assert.notEqual(result.status, 0, `${command} ${args.join(" ")} should fail`);
    return result;
  }
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed\n${stderrAndStdout(result)}`);
  return result;
}

function stderrAndStdout(result) {
  return `${result.stderr}\n${result.stdout}`;
}

function devEnvProbeScript() {
  return [
    "set +e",
    "PATH=/usr/bin:/bin",
    "unset LATTICE_CURRENT_TOOL_RUNTIME_DIR CIX_DAEMON_ROOT_DIR",
    "source scripts/dev-env.sh",
    "status=$?",
    'printf "status=%s\\nPATH=%s\\nruntime=%s\\ncixroot=%s\\n" "$status" "$PATH" "${LATTICE_CURRENT_TOOL_RUNTIME_DIR-}" "${CIX_DAEMON_ROOT_DIR-}"',
    'exit "$status"'
  ].join("\n");
}

function parseProbeOutput(stdout) {
  return Object.fromEntries(
    stdout
      .trimEnd()
      .split("\n")
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      })
  );
}
