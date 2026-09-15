'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  CLI_STATE_SCHEMA, STATE_FILE, installerEnvironment, readRegularFile, readState,
  registeredContexts, sha256, writeState,
} = require('./install');

const MAX_BINARY_BYTES = 128 * 1024 * 1024;

function preflightStandalone({ packageRoot, environment = process.env }) {
  const statePath = path.join(packageRoot, STATE_FILE);
  const state = fs.lstatSync(statePath, { throwIfNoEntry: false }) ? readState(packageRoot) : null;
  const home = environment.HOME || os.homedir();
  if ((state && state.schema !== CLI_STATE_SCHEMA) || registeredContexts(packageRoot, home).length) {
    throw new Error('INSTALL_CONTEXT_INVALID: agent integrations own this package; ' +
      'run opcore uninstall before setup --no-hooks');
  }
  requireOwnedBinary(packageRoot, state);
  return state;
}

function requireOwnedBinary(packageRoot, state) {
  const binDir = path.join(packageRoot, 'native');
  const directory = fs.lstatSync(binDir, { throwIfNoEntry: false });
  if (directory && (!directory.isDirectory() || directory.isSymbolicLink())) {
    throw new Error('INSTALLED_STATE_INVALID: native destination is not a regular directory');
  }
  const binaryPath = path.join(binDir, 'opcore');
  if (state || fs.lstatSync(binaryPath, { throwIfNoEntry: false })) {
    const bytes = readRegularFile(binaryPath, MAX_BINARY_BYTES, 'installed binary');
    if (!state || sha256(bytes) !== state.binaryDigest) {
      throw new Error('INSTALLED_STATE_INVALID: refusing to overwrite an unowned or modified binary');
    }
  }
}

function publishBinary(filename, bytes) {
  const temporary = `${filename}.${process.pid}.${crypto.randomBytes(8).toString('hex')}`;
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o755 });
    fs.renameSync(temporary, filename);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function preflightExecutable(request) {
  const executable = path.join(request.bundleRoot, 'bin', 'opcore');
  const bytes = readRegularFile(executable, MAX_BINARY_BYTES, 'verified bundled binary');
  if (sha256(bytes) !== request.expectedBinaryDigest) {
    throw new Error('INSTALLED_STATE_INVALID: bundled binary changed before setup');
  }
  const result = spawnSync(executable, ['--version'], {
    cwd: request.bundleRoot, env: installerEnvironment(request.environment),
    encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024,
  });
  if (result.error || result.status !== 0 || result.stdout.trim() !== `opcore ${request.version}`) {
    throw new Error(`NATIVE_EXEC_FAILED: executable preflight failed: ${
      result.error?.message || result.stderr || 'unexpected version or exit status'}`);
  }
  return bytes;
}

function installStandalone(request) {
  const bytes = preflightExecutable(request);
  const previous = preflightStandalone(request);
  const binaryPath = path.join(request.binDir, 'opcore');
  const previousBytes = previous && readRegularFile(binaryPath, MAX_BINARY_BYTES, 'installed binary');
  const state = {
    schema: CLI_STATE_SCHEMA, version: request.version, target: request.target.asset,
    binaryPath, archiveDigest: request.archiveDigest, binaryDigest: sha256(bytes),
  };
  fs.mkdirSync(request.binDir, { recursive: true, mode: 0o755 });
  publishBinary(binaryPath, bytes);
  try {
    writeState(request.packageRoot, state);
  } catch (cause) {
    const current = readRegularFile(binaryPath, MAX_BINARY_BYTES, 'installed binary');
    if (sha256(current) !== state.binaryDigest) {
      throw new Error(`INSTALL_FAILED: ${cause.message}; binary changed during rollback at ${binaryPath}`);
    }
    if (previousBytes) publishBinary(binaryPath, previousBytes);
    else fs.rmSync(binaryPath);
    throw cause;
  }
  return state;
}

function cleanupStandalone(packageRoot, state) {
  const current = readState(packageRoot);
  if (JSON.stringify(current) !== JSON.stringify(state) ||
      sha256(readRegularFile(state.binaryPath, MAX_BINARY_BYTES, 'installed binary')) !== state.binaryDigest) {
    throw new Error('INSTALLED_STATE_INVALID: CLI-only installation changed before cleanup');
  }
  fs.rmSync(state.binaryPath);
  fs.rmSync(path.join(packageRoot, STATE_FILE));
  try { fs.rmdirSync(path.dirname(state.binaryPath)); } catch (cause) {
    if (cause.code !== 'ENOTEMPTY') throw cause;
  }
}

module.exports = { cleanupStandalone, installStandalone, preflightStandalone };
