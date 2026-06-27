#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { graphCoreNativePackageNames } from "./graph-native-targets.mjs";
import { releasePackageDirForName } from "./release-package-dirs.mjs";

const releaseVersion = valueAfter("--version") ?? "0.1.0-alpha.0";
const tag = valueAfter("--tag") ?? "alpha";
const dryRun = process.argv.includes("--dry-run") || process.env.LATTICE_PUBLISH_DRY_RUN === "1";
const implementationPackages = [
  "@the-open-engine/opcore-contracts",
  "@the-open-engine/opcore",
  "@the-open-engine/opcore-graph",
  "@the-open-engine/opcore-edit",
  "@the-open-engine/opcore-validation",
  "@the-open-engine/opcore-validation-python",
  "@the-open-engine/opcore-validation-rust",
  "@the-open-engine/opcore-validation-typescript",
  "@the-open-engine/opcore-asp-provider"
];
const publicPackages = [...graphCoreNativePackageNames, ...implementationPackages];

run("npm", ["whoami"]);
verifyNpmPublishReadiness();
run("npm", ["run", "release:dry-run"]);

for (const packageName of publicPackages) {
  run("npm", ["publish", "--access", "public", "--tag", tag, "--dry-run"], { cwd: releasePackageDirForName(packageName) });
}

if (dryRun) {
  process.stdout.write(`publish dry-run passed for ${releaseVersion} with tag ${tag}\n`);
  process.exit(0);
}

if (process.env.LATTICE_CONFIRM_PUBLISH !== releaseVersion) {
  throw new Error(`Set LATTICE_CONFIRM_PUBLISH=${releaseVersion} to publish public packages`);
}

for (const packageName of publicPackages) {
  run("npm", ["publish", "--access", "public", "--tag", tag], { cwd: releasePackageDirForName(packageName) });
}

process.stdout.write(`published Opcore ${releaseVersion} with npm tag ${tag}\n`);

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function verifyNpmPublishReadiness() {
  const tokenList = run("npm", ["token", "list", "--json"]);
  let tokens;
  try {
    tokens = JSON.parse(tokenList.stdout);
  } catch (error) {
    throw new Error(`npm token list --json did not return parseable token metadata: ${error.message}`);
  }
  if (!Array.isArray(tokens)) throw new Error("npm token list --json did not return a token array");
  const publishReadyToken = tokens.find((token) => tokenAllowsPackageWrites(token) && tokenBypassesTwoFactor(token));
  if (!publishReadyToken) {
    throw new Error(
    "No npm token metadata entry has package write permission plus bypass_2fa/automation publish posture for all public packages"
    );
  }
}

function tokenAllowsPackageWrites(token) {
  const permissions = Array.isArray(token?.permissions) ? token.permissions : [];
  const hasPackageWrite =
    permissions.some((permission) => {
      const name = String(permission?.name ?? permission?.type ?? "").toLowerCase();
      const action = String(permission?.action ?? permission?.permission ?? "").toLowerCase();
      return name === "package" && (action === "write" || action === "publish");
    }) ||
    token?.readonly === false ||
    token?.readOnly === false;
  return hasPackageWrite && tokenScopesCoverPublicPackages(token);
}

function tokenBypassesTwoFactor(token) {
  return token?.bypass_2fa === true || token?.bypass2fa === true || token?.automation === true || token?.type === "automation";
}

function tokenScopesCoverPublicPackages(token) {
  const scopes = Array.isArray(token?.scopes) ? token.scopes : [];
  if (scopes.length === 0) return true;
  return publicPackages.every((packageName) => scopes.some((scope) => scopeAllowsPackage(scope, packageName)));
}

function scopeAllowsPackage(scope, packageName) {
  const scopeName = String(scope?.name ?? scope?.scope ?? scope ?? "");
  const scopeType = String(scope?.type ?? "").toLowerCase();
  if (scopeName === packageName) return true;
  if (scopeName === "@the-open-engine/*") return true;
  if (scopeName === "@the-open-engine" || scopeName === "the-open-engine") return scopeType === "" || scopeType === "organization" || scopeType === "org";
  return false;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
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
  return result;
}
