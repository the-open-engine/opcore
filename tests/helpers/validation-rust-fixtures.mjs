import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createValidationRunner } from "../../packages/validation/dist/index.js";
import {
  RUST_SOURCE_HYGIENE_CHECK_ID,
  createRustValidationChecks
} from "../../packages/validation-rust/dist/index.js";

export function runner({ files, env = process.env, packageFiles, timeoutMs } = {}) {
  const content = new Map(Object.entries(files ?? rustCrate()));
  return createValidationRunner({
    workspace: {
      readFile: (path) => (content.has(path) ? { status: "found", content: content.get(path) } : { status: "missing" }),
      listChangedFiles: () => ({ files: [...content.keys()] }),
      listStagedFiles: () => ({ files: [...content.keys()] }),
      listRepoFiles: () => ({ files: [...content.keys()] }),
      listTreeFiles: () => ({ files: [...content.keys()] }),
      listPackageFiles: (_name, root) => ({ files: packageFiles?.[root] ?? [...content.keys()].filter((path) => path.startsWith(`${root}/`)) })
    },
    checks: createRustValidationChecks({ env, timeoutMs })
  });
}

export function request(overrides = {}) {
  return {
    requestId: "validation-rust-1",
    repo: {
      repoId: "lattice-rust-test"
    },
    scope: {
      kind: "files",
      files: ["Cargo.toml", "crates/app/Cargo.toml", "crates/app/src/lib.rs"]
    },
    graph: {
      mode: "optional",
      provider: "lattice-graph"
    },
    overlays: [],
    checks: [RUST_SOURCE_HYGIENE_CHECK_ID],
    ...overrides
  };
}

export function rustCrate(overrides = {}) {
  return {
    "Cargo.toml": '[workspace]\nmembers = ["crates/app"]\nresolver = "2"\n',
    "crates/app/Cargo.toml": '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n',
    "crates/app/src/lib.rs": "pub fn answer() -> i32 { 42 }\n",
    ...overrides
  };
}

export function initializeGitSnapshot(repoRootPath, files) {
  git(repoRootPath, ["init", "-q"]);
  git(repoRootPath, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  for (const file of files) {
    const object = git(repoRootPath, ["hash-object", "-w", file]).stdout.trim();
    git(repoRootPath, ["update-index", "--add", "--cacheinfo", "100644", object, file]);
  }
  const tree = git(repoRootPath, ["write-tree"]).stdout.trim();
  const commit = git(repoRootPath, ["commit-tree", tree, "-m", "initial"], gitEnv()).stdout.trim();
  git(repoRootPath, ["update-ref", "refs/heads/main", commit]);
  return commit;
}

export function commitWorktreeFile(repoRootPath, file, message) {
  const object = git(repoRootPath, ["hash-object", "-w", file]).stdout.trim();
  git(repoRootPath, ["update-index", "--add", "--cacheinfo", "100644", object, file]);
  const tree = git(repoRootPath, ["write-tree"]).stdout.trim();
  const parent = git(repoRootPath, ["rev-parse", "HEAD"]).stdout.trim();
  const commit = git(repoRootPath, ["commit-tree", tree, "-p", parent, "-m", message], gitEnv()).stdout.trim();
  git(repoRootPath, ["update-ref", "refs/heads/main", commit]);
  return commit;
}

export function git(repoRootPath, args, env = process.env) {
  const result = spawnSync("git", args, {
    cwd: repoRootPath,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result;
}

export function fakeCargoScript({
  checkStdout = "",
  checkStderr = "",
  checkStatus = 0,
  docStdout = "",
  docStderr = "",
  docStatus = 0,
  fmtStderr = "",
  fmtStatus = 0,
  clippyStdout = "",
  clippyStderr = "",
  clippyStatus = 0,
  udepsStdout = "",
  udepsStderr = "",
  udepsStatus = 0,
  udepsVersionStatus = 0,
  metadata = defaultCargoMetadata(),
  logPath
} = {}) {
  const metadataJson = typeof metadata === "string" ? metadata : JSON.stringify(metadata);
  const logLine = logPath === undefined ? "" : `printf '%s\\n' "$*" >> '${shellEscapeSingleQuoted(logPath)}'`;
  return [
    "#!/bin/sh",
    logLine,
    'if [ "$1" = "--version" ]; then',
    "  printf '%s\\n' 'cargo 1.93.0'",
    "  exit 0",
    "fi",
    'case "$1" in',
    "metadata)",
    `  printf '%s\\n' '${shellEscapeSingleQuoted(metadataJson)}'`,
    "  exit 0",
    "  ;;",
    "check)",
    `  printf '%s' '${shellEscapeSingleQuoted(checkStdout)}'`,
    `  printf '%s' '${shellEscapeSingleQuoted(checkStderr)}' >&2`,
    `  exit ${checkStatus}`,
    "  ;;",
    "doc)",
    `  printf '%s' '${shellEscapeSingleQuoted(docStdout)}'`,
    `  printf '%s' '${shellEscapeSingleQuoted(docStderr)}' >&2`,
    `  exit ${docStatus}`,
    "  ;;",
    "fmt)",
    `  printf '%s' '${shellEscapeSingleQuoted(fmtStderr)}' >&2`,
    `  exit ${fmtStatus}`,
    "  ;;",
    "clippy)",
    '  if [ "$2" = "--version" ]; then',
    "    printf '%s\\n' 'clippy 0.1.93'",
    "    exit 0",
    "  fi",
    `  printf '%s' '${shellEscapeSingleQuoted(clippyStdout)}'`,
    `  printf '%s' '${shellEscapeSingleQuoted(clippyStderr)}' >&2`,
    `  exit ${clippyStatus}`,
    "  ;;",
    "udeps)",
    '  if [ "$2" = "--version" ]; then',
    "    printf '%s\\n' 'cargo-udeps 0.1.61'",
    `    exit ${udepsVersionStatus}`,
    "  fi",
    `  printf '%s' '${shellEscapeSingleQuoted(udepsStdout)}'`,
    `  printf '%s' '${shellEscapeSingleQuoted(udepsStderr)}' >&2`,
    `  exit ${udepsStatus}`,
    "  ;;",
    "*)",
    "  exit 0",
    "  ;;",
    "esac",
    ""
  ].filter((line) => line !== "").join("\n");
}

export function writeFakeRustToolchain(bin, options = {}) {
  mkdirSync(bin, { recursive: true });
  writeExecutable(join(bin, "cargo"), fakeCargoScript(options.cargo));
  writeExecutable(join(bin, "rustfmt"), fakeVersionedToolScript("rustfmt 1.8.0", options.rustfmt));
  writeExecutable(join(bin, "rustdoc"), fakeVersionedToolScript("rustdoc 1.93.0", options.rustdoc));
  writeExecutable(join(bin, "cargo-depgraph"), fakeVersionedToolScript("cargo-depgraph 1.2.3", options.cargoDepgraph));
  writeExecutable(
    join(bin, "rust-code-analysis-cli"),
    fakeVersionedToolScript("rust-code-analysis-cli 0.0.25", options.rustCodeAnalysis)
  );
  return {
    bin,
    env: {
      ...process.env,
      PATH: bin
    }
  };
}

export function defaultCargoMetadata(overrides = {}) {
  return {
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
          }
        ]
      }
    ],
    workspace_members: ["app"],
    workspace_root: ".",
    ...overrides
  };
}

function gitEnv() {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: "Lattice Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_AUTHOR_DATE: "2026-06-05T00:00:00Z",
    GIT_COMMITTER_NAME: "Lattice Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    GIT_COMMITTER_DATE: "2026-06-05T00:00:00Z"
  };
}

function shellEscapeSingleQuoted(value) {
  return String(value).replaceAll("'", "'\\''");
}

function writeExecutable(path, content) {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function fakeVersionedToolScript(version, options = {}) {
  const stdout = options.stdout ?? "";
  const stderr = options.stderr ?? "";
  const status = options.status ?? 0;
  return [
    "#!/bin/sh",
    'if [ "$1" = "--version" ]; then',
    `  printf '%s\\n' '${shellEscapeSingleQuoted(options.version ?? version)}'`,
    "  exit 0",
    "fi",
    `printf '%s' '${shellEscapeSingleQuoted(stdout)}'`,
    `printf '%s' '${shellEscapeSingleQuoted(stderr)}' >&2`,
    `exit ${status}`,
    ""
  ].join("\n");
}
