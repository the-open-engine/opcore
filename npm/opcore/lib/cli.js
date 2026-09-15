'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  CLI_STATE_SCHEMA,
  MAX_RECEIPT_BYTES,
  STATE_FILE,
  boundAgentEnvironment,
  combinedState,
  registeredContexts,
  stateEntries,
  writeState,
  installerEnvironment,
  parseInstallReceipt,
  readRegularFile,
  readState,
  selectTarget,
  sha256,
} = require('./install');
const { cleanupStandalone } = require('./standalone');
const { withInstallLock } = require('./lock');

const MAX_PACKAGE_METADATA_BYTES = 64 * 1024;
const MAX_BINARY_BYTES = 128 * 1024 * 1024;
const MAX_UNINSTALLER_BYTES = 2 * 1024 * 1024;

function error(code, detail) {
  return new Error(`${code}: ${detail}`);
}

function packageVersion(packageRoot) {
  const bytes = readRegularFile(
    path.join(packageRoot, 'package.json'),
    MAX_PACKAGE_METADATA_BYTES,
    'package metadata'
  );
  let metadata;
  try {
    metadata = JSON.parse(bytes.toString('utf8'));
  } catch (cause) {
    throw error('INSTALLED_STATE_INVALID', `cannot parse package metadata: ${cause.message}`);
  }
  if (!metadata || typeof metadata.version !== 'string') {
    throw error('INSTALLED_STATE_INVALID', 'package metadata has no version');
  }
  return metadata.version;
}

function verifyStateIdentity(packageRoot, state, platform, arch) {
  if (packageVersion(packageRoot) !== state.version) {
    throw error('INSTALLED_STATE_INVALID', 'package and installed state versions differ');
  }
  const target = selectTarget(platform, arch);
  if (target.asset !== state.target) {
    throw error('INSTALLED_STATE_INVALID', 'package was installed for another platform');
  }
  const directory = fs.lstatSync(path.dirname(state.binaryPath));
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw error('INSTALLED_STATE_INVALID', 'native destination is not a regular directory');
  }
}

function verifyBinary(state) {
  const binary = readRegularFile(state.binaryPath, MAX_BINARY_BYTES, 'installed binary');
  if (sha256(binary) !== state.binaryDigest) {
    throw error('INSTALLED_STATE_INVALID', 'installed binary changed after npm installation');
  }
}

function cleanupHookReceipt(state) {
  const hookReceipt = state.hookReceiptDigest === null ? null : readRegularFile(
    state.hookReceiptPath, MAX_RECEIPT_BYTES, 'hook receipt'
  );
  if (hookReceipt === null && fs.lstatSync(state.hookReceiptPath, { throwIfNoEntry: false })) {
    throw error('INSTALLED_STATE_INVALID', 'unexpected hook receipt');
  }
  return hookReceipt;
}

function integrationArtifacts(state) {
  const runtime = path.join(state.agentRoot, 'opcore');
  const artifacts = new Map([
    ['skill', path.join(state.skillRoot, 'opcore', 'SKILL.md')],
    ['manifest', path.join(runtime, 'asp-server.json')],
    ['native_manifest', path.join(runtime, 'asp-server-rust-native.json')],
    ['node_native_manifest', path.join(runtime, 'asp-server-node-native.json')],
    ['python_native_manifest', path.join(runtime, 'asp-server-python-native.json')],
  ]);
  if (state.agent === 'codex') {
    artifacts.set('descriptor', path.join(state.skillRoot, 'opcore', 'agents', 'openai.yaml'));
  }
  return artifacts;
}

function verifyIntegrationArtifacts(state, receipt) {
  for (const [key, filename] of integrationArtifacts(state)) {
    if (!fs.lstatSync(filename, { throwIfNoEntry: false })) continue;
    const bytes = readRegularFile(filename, MAX_UNINSTALLER_BYTES, key);
    if (sha256(bytes) !== receipt.get(key)) {
      throw error('INSTALLED_STATE_INVALID', `modified owned ${key}`);
    }
  }
}

function verifyRegisteredOwner(state, receipt, registered) {
  if (receipt.has('owners_path') && !registered.some((owner) =>
    owner.agent === state.agent && owner.agentRoot === state.agentRoot && owner.skillRoot === state.skillRoot
  )) {
    throw error('INSTALLED_STATE_INVALID', 'shared owner record is missing or conflicts with npm state');
  }
}

function verifyCleanupInputs(state, registered) {
  verifyBinary(state);
  const uninstaller = readRegularFile(
    state.uninstallerPath,
    MAX_UNINSTALLER_BYTES,
    'installed uninstaller'
  );
  const receipt = readRegularFile(state.receiptPath, MAX_RECEIPT_BYTES, 'install receipt');
  const hookReceipt = cleanupHookReceipt(state);
  if (
    sha256(uninstaller) !== state.uninstallerDigest ||
    sha256(receipt) !== state.receiptDigest ||
    (hookReceipt ? sha256(hookReceipt) : null) !== state.hookReceiptDigest
  ) {
    throw error('INSTALLED_STATE_INVALID', 'receipt-owned cleanup inputs changed');
  }
  const values = parseInstallReceipt(receipt);
  if (
    values.get('binary') !== state.binaryDigest ||
    values.get('installer') !== state.uninstallerDigest ||
    values.get('binary_path') !== sha256(Buffer.from(state.binaryPath)) ||
    values.get('agent_root_path') !== sha256(Buffer.from(state.agentRoot)) ||
    values.get('skill_path') !== sha256(Buffer.from(path.join(state.skillRoot, 'opcore', 'SKILL.md')))
  ) {
    throw error('INSTALLED_STATE_INVALID', 'standalone and npm receipts disagree');
  }
  verifyRegisteredOwner(state, values, registered);
  verifyIntegrationArtifacts(state, values);
  return uninstaller;
}

function runUninstaller(state, environment = process.env, trustedUninstaller) {
  if (!Buffer.isBuffer(trustedUninstaller)) {
    throw error('UNINSTALL_FAILED', 'verified uninstaller bytes are required');
  }
  const temporary = fs.mkdtempSync('/tmp/opcore-uninstall.');
  const script = path.join(temporary, 'uninstall.sh');
  let result;
  try {
    fs.writeFileSync(script, trustedUninstaller, { flag: 'wx', mode: 0o700 });
    result = spawnSync(
      '/bin/bash',
      [
        script,
        '--uninstall',
        '--agent',
        state.agent,
        '--bin-dir',
        path.dirname(state.binaryPath),
        '--binary',
        state.binaryPath,
      ],
      {
        env: installerEnvironment(environment, boundAgentEnvironment(state)),
        stdio: 'inherit',
      }
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  if (result.error) throw error('UNINSTALL_FAILED', result.error.message);
  if (result.signal) throw error('UNINSTALL_FAILED', `uninstaller received ${result.signal}`);
  if (result.status !== 0) {
    throw error('UNINSTALL_FAILED', `uninstaller exited with status ${result.status}`);
  }
}

function requireRemoved(filename, label) {
  if (fs.existsSync(filename)) throw error('UNINSTALL_FAILED', `${label} remains at ${filename}`);
}

function executeCleanup(options, packageRoot, entries, scripts) {
  const execute = options.runUninstaller || runUninstaller;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    execute(entry, options.environment || process.env, scripts[index]);
    requireRemoved(entry.receiptPath, 'install receipt');
    requireRemoved(entry.hookReceiptPath, 'hook receipt');
    requireRemoved(entry.uninstallerPath, 'installed uninstaller');
    for (const [key, filename] of integrationArtifacts(entry)) requireRemoved(filename, key);
    if (index + 1 < entries.length) {
      writeState(packageRoot, combinedState(entries.slice(index + 1)));
    }
  }
  requireRemoved(entries[0].binaryPath, 'installed binary');
}

function cleanup(options = {}) {
  const packageRoot = path.resolve(options.packageRoot || path.resolve(__dirname, '..'));
  return withInstallLock(packageRoot, () => cleanupLocked(options, packageRoot));
}

function cleanupLocked(options, packageRoot) {
  const state = options.state || readState(packageRoot);
  if (state.schema === CLI_STATE_SCHEMA) {
    verifyStateIdentity(packageRoot, state, options.platform, options.arch);
    cleanupStandalone(packageRoot, state);
    return state;
  }
  return cleanupIntegrations(options, packageRoot, state);
}

function cleanupIntegrations(options, packageRoot, state) {
  const entries = stateEntries(state);
  const registered = registeredContexts(packageRoot, entries[0].home);
  // Verify every cleanup input before removing the first integration.
  const scripts = entries.map((entry) => {
    verifyStateIdentity(packageRoot, entry, options.platform, options.arch);
    return verifyCleanupInputs(entry, registered);
  });
  for (const owner of registered) {
    if (!entries.some((entry) => entry.agent === owner.agent &&
        entry.agentRoot === owner.agentRoot && entry.skillRoot === owner.skillRoot)) {
      throw error('INSTALLED_STATE_INVALID', 'npm state omits a shared owner; rerun installation');
    }
  }
  executeCleanup(options, packageRoot, entries, scripts);
  const statePath = path.join(packageRoot, STATE_FILE);
  const stateMetadata = fs.lstatSync(statePath);
  if (!stateMetadata.isFile() || stateMetadata.isSymbolicLink()) {
    throw error('UNINSTALL_FAILED', 'npm state path changed during cleanup');
  }
  fs.rmSync(statePath);
  try {
    fs.rmdirSync(path.dirname(entries[0].binaryPath));
  } catch (cause) {
    if (cause.code !== 'ENOTEMPTY' && cause.code !== 'ENOENT') throw cause;
  }
  return state;
}

const SETUP_HELP = 'npm package commands:\n' +
  '  setup [--no-hooks]  Download and verify this package version; --no-hooks installs only the CLI\n' +
  '  uninstall           Remove verified installed files and recorded agent integrations\n';

function runSetup(argv, options) {
  const write = options.write || ((message) => process.stdout.write(message));
  if (argv.length > 2 || (argv.length === 2 && argv[1] !== '--no-hooks')) {
    throw error('USAGE', 'opcore setup accepts only --no-hooks or --help');
  }
  return require('./setup').install({ ...options, noHooks: argv[1] === '--no-hooks' }).then(() => {
    write('Opcore setup complete. Run opcore doctor from your Git project.\n');
    return 0;
  });
}

function setupFailure(argv, options, cause) {
  const write = options.write || ((message) => process.stdout.write(message));
  const recovery = 'Run opcore setup to complete or retry verified installation, or ' +
    'opcore setup --no-hooks for the CLI without agent integration. ' +
    'Modified or unowned files require review before setup can replace them.';
  if (argv.length === 1 && ['--version', '-V'].includes(argv[0])) {
    write(`opcore ${packageVersion(options.packageRoot)} (npm package; native setup incomplete)\n`);
    return 0;
  }
  if (!argv.length || (argv.length === 1 && ['--help', '-h'].includes(argv[0]))) {
    write(`Opcore npm package ${packageVersion(options.packageRoot)}\n\n${SETUP_HELP}\n`);
    write(`Native commands become available after setup. ${recovery}\n`);
    return 0;
  }
  if (['doctor', 'status'].includes(argv[0])) {
    const report = { schema: 'opcore.npm-setup.v1', status: 'incomplete',
      packageVersion: packageVersion(options.packageRoot), packageRoot: options.packageRoot,
      issue: cause.message, recovery };
    write(argv.includes('--json') ? `${JSON.stringify(report, null, 2)}\n`
      : `Native setup incomplete: ${cause.message}\n${recovery}\n`);
    return 1;
  }
  throw error('NATIVE_SETUP_REQUIRED', `${cause.message}\n${recovery}`);
}

function verifiedRuntime(packageRoot, options) {
  const state = stateEntries(readState(packageRoot))[0];
  verifyStateIdentity(packageRoot, state, options.platform, options.arch);
  verifyBinary(state);
  return state;
}

function run(argv, options = {}) {
  const packageRoot = path.resolve(options.packageRoot || path.resolve(__dirname, '..'));
  if (['setup', 'uninstall'].includes(argv[0]) && argv.length === 2 &&
      ['--help', '-h'].includes(argv[1])) {
    (options.write || ((message) => process.stdout.write(message)))(SETUP_HELP);
    return 0;
  }
  if (argv[0] === 'setup') return runSetup(argv, { ...options, packageRoot });
  if (argv[0] === 'uninstall') return runCleanup(argv, { ...options, packageRoot });
  let state;
  try { state = verifiedRuntime(packageRoot, options); } catch (cause) {
    return setupFailure(argv, { ...options, packageRoot }, cause);
  }
  return runNative(state, argv, options);
}

function runCleanup(argv, options) {
  const write = options.write || ((message) => process.stdout.write(message));
  if (argv.length !== 1) throw error('USAGE', 'opcore uninstall takes no arguments');
  cleanup(options);
  write('Opcore owned files removed. Remove the npm package with the matching command:\n');
  write('  Global:        npm uninstall -g @the-open-engine-company/opcore\n');
  write('  Project-local: npm uninstall @the-open-engine-company/opcore\n');
  return 0;
}

function runNative(state, argv, options) {
  const spawn = options.spawnNative || ((binary, args) => spawnSync(binary, args, { stdio: 'inherit' }));
  const result = spawn(state.binaryPath, argv);
  if (result.error) throw error('NATIVE_EXEC_FAILED', result.error.message);
  if (result.signal) {
    const signal = options.forwardSignal || ((value) => process.kill(process.pid, value));
    signal(result.signal);
    return 1;
  }
  if (result.status === 0 && argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    (options.write || ((message) => process.stdout.write(message)))(`\n${SETUP_HELP}`);
  }
  return result.status === null ? 1 : result.status;
}

module.exports = {
  cleanup,
  packageVersion,
  run,
  runUninstaller,
  verifyBinary,
  verifyCleanupInputs,
  verifyStateIdentity,
};
