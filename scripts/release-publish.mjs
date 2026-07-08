#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { publicReleasePackageNames, releasePackageDirForName } from "./release-package-dirs.mjs";
import { createStagedOpcorePackage } from "./stage-opcore-bundle.mjs";

const releaseVersion = valueAfter("--version") ?? "0.1.0";
const tag = valueAfter("--tag") ?? "latest";
const dryRun = process.argv.includes("--dry-run") || process.env.OPCORE_PUBLISH_DRY_RUN === "1";
const npmEnv = npmPublishEnv();
const publicPackages = publicReleasePackageNames;

if (!dryRun) verifyNpmPublishReadiness();
run("npm", ["run", "release:dry-run"]);

withStagedPublishPackages((packageDirs) => {
  for (const packageName of publicPackages) {
    run("npm", publishArgs(packageName, { dryRun: true }), { cwd: packageDirs.get(packageName) });
  }

  if (dryRun) {
    process.stdout.write(`publish dry-run passed for ${releaseVersion} with tag ${tag}\n`);
    return;
  }

  if (process.env.OPCORE_CONFIRM_PUBLISH !== releaseVersion) {
    throw new Error(`Set OPCORE_CONFIRM_PUBLISH=${releaseVersion} to publish public packages`);
  }

  for (const packageName of publicPackages) {
    if (packageVersionExists(packageName)) {
      process.stdout.write(`${packageName}@${releaseVersion} already published; ensuring ${tag} dist-tag\n`);
    } else {
      run("npm", publishArgs(packageName), { cwd: packageDirs.get(packageName) });
    }
    ensureDistTag(packageName);
  }

  process.stdout.write(`published Opcore ${releaseVersion} with npm tag ${tag}\n`);
});

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function verifyNpmPublishReadiness() {
  if (hasTokenAuth()) {
    process.stdout.write("using npm token publish auth\n");
    run("npm", ["whoami"]);
    verifyTokenMetadataWhenReadable();
    return;
  }
  if (hasTrustedPublishingContext()) {
    const missingPackages = publicPackages.filter((packageName) => !packageExists(packageName));
    if (missingPackages.length > 0) {
      throw new Error(
        [
          "First npm publish requires NODE_AUTH_TOKEN/NPM_TOKEN because npm trusted publishing can only be configured after packages exist.",
          `Missing packages: ${missingPackages.join(", ")}`
        ].join("\n")
      );
    }
    process.stdout.write("using GitHub Actions OIDC trusted publishing context\n");
    return;
  }
  throw new Error("No npm publish auth available: configure trusted publishing for release.yml or provide NODE_AUTH_TOKEN/NPM_TOKEN");
}

function verifyTokenMetadataWhenReadable() {
  const tokenList = run("npm", ["token", "list", "--json"], { allowFailure: true });
  if (tokenList.status !== 0) {
    warnTokenMetadata(
      "npm token list --json is unavailable for this publish token; skipping package write permission plus bypass_2fa metadata preflight"
    );
    return;
  }
  let tokens;
  try {
    tokens = JSON.parse(tokenList.stdout);
  } catch (error) {
    warnTokenMetadata(`npm token list --json did not return parseable token metadata: ${error.message}`);
    return;
  }
  if (!Array.isArray(tokens)) {
    warnTokenMetadata("npm token list --json did not return a token array");
    return;
  }
  const publishReadyToken = tokens.find((token) => tokenAllowsPackageWrites(token) && tokenBypassesTwoFactor(token));
  if (!publishReadyToken) {
    warnTokenMetadata(
      "No npm token metadata entry has package write permission plus bypass_2fa/automation publish posture for all public packages"
    );
  }
}

function publishArgs(packageName, options = {}) {
  const args = ["publish", "--access", "public", "--tag", tag, "--loglevel", "notice"];
  if (shouldPublishWithProvenance(options)) args.push("--provenance");
  if (options.dryRun) args.push("--dry-run");
  return args;
}

function shouldPublishWithProvenance(options = {}) {
  return hasTrustedPublishingContext() && !hasTokenAuth() && !options.dryRun;
}

function withStagedPublishPackages(callback) {
  const stageParent = mkdtempSync(join(tmpdir(), "opcore-publish-"));
  const stagedPackages = [];
  try {
    const packageDirs = new Map(
      publicPackages.map((packageName) => {
        const staged = packageName === "opcore" ? createStagedOpcorePackage(stageParent) : undefined;
        if (staged) stagedPackages.push(staged);
        return [packageName, staged?.packageDir ?? releasePackageDirForName(packageName)];
      })
    );
    return callback(packageDirs);
  } finally {
    for (const staged of stagedPackages) staged.cleanup();
    rmSync(stageParent, { recursive: true, force: true });
  }
}

function packageVersionExists(packageName) {
  const result = run("npm", ["view", `${packageName}@${releaseVersion}`, "version", "--json"], { allowFailure: true });
  if (result.status === 0) {
    const version = JSON.parse(result.stdout);
    return version === releaseVersion;
  }
  if (isNpmNotFound(result)) return false;
  throw commandError("npm", ["view", `${packageName}@${releaseVersion}`, "version", "--json"], result);
}

function packageExists(packageName) {
  const result = run("npm", ["view", packageName, "name", "--json"], { allowFailure: true });
  if (result.status === 0) return JSON.parse(result.stdout) === packageName;
  if (isNpmNotFound(result)) return false;
  throw commandError("npm", ["view", packageName, "name", "--json"], result);
}

function ensureDistTag(packageName) {
  const distTags = readDistTags(packageName);
  if (distTags?.[tag] === releaseVersion) return;
  run("npm", ["dist-tag", "add", `${packageName}@${releaseVersion}`, tag]);
}

function readDistTags(packageName) {
  let lastResult;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const result = run("npm", ["view", packageName, "dist-tags", "--json"], { allowFailure: true });
    if (result.status === 0) return JSON.parse(result.stdout);
    lastResult = result;
    sleep(2000);
  }
  throw commandError("npm", ["view", packageName, "dist-tags", "--json"], lastResult);
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
    env: npmEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0 && !options.allowFailure) throw commandError(command, args, result);
  return result;
}

function npmPublishEnv() {
  const env = { ...process.env };
  if (!env.NODE_AUTH_TOKEN && env.NPM_TOKEN) env.NODE_AUTH_TOKEN = env.NPM_TOKEN;
  return env;
}

function hasTokenAuth() {
  return Boolean(npmEnv.NODE_AUTH_TOKEN || npmEnv.NPM_TOKEN);
}

function hasTrustedPublishingContext() {
  return Boolean(
    process.env.GITHUB_ACTIONS === "true" &&
    process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN &&
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL
  );
}

function warnTokenMetadata(message) {
  process.stderr.write(`[release-publish] ${message}; publish will rely on npm registry authorization.\n`);
}

function isNpmNotFound(result) {
  return /E404|404 Not Found|not found/i.test(`${result.stdout}\n${result.stderr}`);
}

function commandError(command, args, result) {
  return new Error(
    [
      `Command failed: ${command} ${args.join(" ")}`,
      `status: ${result.status}`,
      `stdout:\n${result.stdout}`,
      `stderr:\n${result.stderr}`
    ].join("\n")
  );
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
