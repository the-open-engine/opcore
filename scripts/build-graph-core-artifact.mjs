import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import {
  currentGraphCoreNativeTarget,
  graphCoreNativePackageForTarget,
  graphCoreRustTargetForNativeTarget,
  parseGraphCoreNativeTargetArg
} from "./graph-native-targets.mjs";

const target = parseGraphCoreNativeTargetArg();
const currentTarget = currentGraphCoreNativeTarget();
const rustTarget = target === "linux-x64" || target !== currentTarget ? graphCoreRustTargetForNativeTarget(target) : undefined;
const nativePackage = graphCoreNativePackageForTarget(target);
const graphPackage = JSON.parse(readFileSync(join("packages", "graph", "package.json"), "utf8"));
const binaryName = "lattice-graph-core";
const sourceBinary = rustTarget ? join("target", rustTarget, "release", binaryName) : join("target", "release", binaryName);
const nativeDir = nativePackage.packageDir;
const obsoleteGraphNativeDir = join("packages", "graph", "dist", "native");
const packageRelativeBinary = binaryName;
const packageRelativeChecksum = `${binaryName}.sha256`;
const destinationBinary = join(nativeDir, binaryName);
const temporaryDestinationBinary = join(nativeDir, `${binaryName}.tmp-${process.pid}`);
const destinationChecksum = join(nativeDir, packageRelativeChecksum);
const destinationMetadata = join(nativeDir, "metadata.json");
const rustPathRemapFlags = [
  `--remap-path-prefix=${process.cwd()}=/workspace/lattice`,
  `--remap-path-prefix=${join(homedir(), ".cargo")}=/cargo`,
  `--remap-path-prefix=${join(homedir(), ".rustup")}=/rustup`,
  "-C",
  "strip=symbols"
];
const cargoArgs = ["build", "--package", "lattice-graph-core", "--release"];
if (rustTarget) cargoArgs.push("--target", rustTarget);

run("cargo", cargoArgs, {
  ...process.env,
  ...crossCompileEnv(target, rustTarget),
  RUSTFLAGS: [process.env.RUSTFLAGS, ...rustPathRemapFlags].filter(Boolean).join(" ")
});
rmSync(obsoleteGraphNativeDir, { recursive: true, force: true });
mkdirSync(nativeDir, { recursive: true });
copyFileSync(sourceBinary, temporaryDestinationBinary);
chmodSync(temporaryDestinationBinary, 0o755);
rmSync(destinationBinary, { force: true });
renameSync(temporaryDestinationBinary, destinationBinary);

const checksumSha256 = createHash("sha256").update(readFileSync(destinationBinary)).digest("hex");
writeFileSync(destinationChecksum, `${checksumSha256}  ${basename(destinationBinary)}\n`);
writeFileSync(
  destinationMetadata,
  `${JSON.stringify(
    {
      artifactName: "lattice-graph-core",
      artifactVersion: graphPackage.version,
      targetPlatform: target,
      binaryPath: packageRelativeBinary,
      checksumPath: packageRelativeChecksum,
      checksumSha256,
      buildProfile: "release"
    },
    null,
    2
  )}\n`
);

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) {
    throw new Error(
      [
        `Command failed: ${command} ${args.join(" ")}`,
        `status: ${result.status}`,
        `stdout:\n${result.stdout}`,
        `stderr:\n${result.stderr}`
      ].join("\n")
    );
  }
}

function crossCompileEnv(nativeTarget, rustTarget) {
  if (nativeTarget !== "linux-x64" || rustTarget !== "x86_64-unknown-linux-musl" || process.platform === "linux") {
    return {};
  }
  const zig = findCommand("zig");
  const llvmAr = findCommand("llvm-ar") ?? findCommand("/opt/homebrew/opt/llvm@21/bin/llvm-ar");
  if (!zig || !llvmAr) return {};
  const wrapperDir = join("target", "cross-bin");
  const wrapperPath = join(wrapperDir, "x86_64-linux-musl-zig-cc");
  mkdirSync(wrapperDir, { recursive: true });
  writeFileSync(
    wrapperPath,
    [
      "#!/usr/bin/env bash",
      "out=()",
      "skip_next=0",
      "for arg in \"$@\"; do",
      "  if [[ \"$skip_next\" == 1 ]]; then skip_next=0; continue; fi",
      "  case \"$arg\" in",
      "    --target=*) ;;",
      "    --target) skip_next=1 ;;",
      "    x86_64-unknown-linux-musl) ;;",
      "    *) out+=(\"$arg\") ;;",
      "  esac",
      "done",
      `exec ${JSON.stringify(zig)} cc -target x86_64-linux-musl "\${out[@]}"`,
      ""
    ].join("\n")
  );
  chmodSync(wrapperPath, 0o755);
  return {
    CC_x86_64_unknown_linux_musl: join(process.cwd(), wrapperPath),
    AR_x86_64_unknown_linux_musl: llvmAr,
    CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER: "rust-lld"
  };
}

function findCommand(command) {
  if (command.includes("/")) {
    const result = spawnSync("test", ["-x", command]);
    return result.status === 0 ? command : undefined;
  }
  const result = spawnSync("sh", ["-c", `command -v ${command}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  return result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0] : undefined;
}
