'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const test = require('node:test');
const { sha256, selectTarget } = require('../lib/install');

const archive = process.env.OPCORE_TEST_BUNDLE;
const packageName = '@the-open-engine-company/opcore';
const sourcePackage = path.resolve(__dirname, '..');
const agentNames = ['codex', 'claude'];

function command(executable, args, fixture, extraEnvironment = {}) {
  return spawnSync(executable, args, {
    cwd: fixture.root,
    env: { ...fixture.environment, ...extraEnvironment },
    encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
  });
}

function requireSuccess(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result;
}

function writeDownloadTransport(root, version) {
  const loader = path.join(root, 'download-fixture.cjs');
  const release = `https://github.com/the-open-engine/opcore/releases/download/v${version}/`;
  // Only transport and one filesystem failure are injected. Published package
  // code, archive validation, shell installation and npm lifecycle stay real.
  fs.writeFileSync(loader, `
const https = require('https');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { EventEmitter } = require('events');
if (process.env.OPCORE_LIFECYCLE_TEST_GLIBC) {
  const originalReport = process.report.getReport;
  process.report.getReport = function() {
    const report = originalReport.apply(this, arguments);
    report.header.glibcVersionRuntime = process.env.OPCORE_LIFECYCLE_TEST_GLIBC;
    return report;
  };
}
const originalGet = https.get;
https.get = function(url, options, callback) {
  const target = String(url);
  if (!target.startsWith(${JSON.stringify(release)})) return originalGet.apply(this, arguments);
  const request = new EventEmitter();
  request.setTimeout = () => request;
  request.destroy = (error) => request.emit('error', error);
  setImmediate(() => {
    const file = target.endsWith('/SHA256SUMS') ? 'SHA256SUMS' : 'release.tar.gz';
    const bytes = fs.readFileSync(path.join(__dirname, file));
    const response = Readable.from([bytes]);
    response.statusCode = 200;
    response.headers = { 'content-length': String(bytes.length) };
    callback(response);
  });
  return request;
};
const originalRename = fs.renameSync;
fs.renameSync = function(from, to) {
  const marker = path.join(__dirname, 'state-write-failed');
  if (process.env.OPCORE_LIFECYCLE_FAIL_STATE && path.basename(to) === 'install-state.json' &&
      !fs.existsSync(marker)) {
    fs.writeFileSync(marker, 'injected once');
    const error = new Error('injected npm state publication failure');
    error.code = 'EIO';
    throw error;
  }
  return originalRename.apply(this, arguments);
};
`);
  return loader;
}

function preparePackage(root, version) {
  const destination = path.join(root, 'package');
  fs.mkdirSync(destination);
  for (const filename of ['bin', 'lib', 'install.js', 'package.json', 'targets.json', 'README.md', 'LICENSE']) {
    fs.cpSync(path.join(sourcePackage, filename), path.join(destination, filename), { recursive: true });
  }
  const metadataPath = path.join(destination, 'package.json');
  const metadata = JSON.parse(fs.readFileSync(metadataPath));
  metadata.version = version;
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  const archives = {};
  const selected = selectTarget();
  for (const target of ['linux-x86_64', 'macos-arm64']) {
    archives[`opcore-v${version}-${target}.tar.gz`] = target === selected.asset
      ? sha256(fs.readFileSync(archive)) : 'a'.repeat(64);
  }
  fs.writeFileSync(path.join(destination, 'release-assets.json'), `${JSON.stringify({
    schema: 'opcore.npm-assets.v1', version, archives,
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(root, 'SHA256SUMS'), Object.entries(archives)
    .map(([filename, digest]) => `${digest}  ${filename}\n`).join(''));
  fs.copyFileSync(archive, path.join(root, 'release.tar.gz'));
  return destination;
}

function emptyFixture(t) {
  const root = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), 'opcore-lifecycle.'))
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home with spaces');
  const prefix = path.join(root, 'prefix with spaces');
  fs.mkdirSync(home);
  return {
    root, home, prefix,
    packageRoot: path.join(prefix, 'lib/node_modules', packageName),
    launcher: path.join(prefix, 'bin/opcore'),
    environment: {
      PATH: process.env.PATH, HOME: home, TMPDIR: root,
      npm_config_cache: path.join(root, 'cache'),
      npm_config_userconfig: path.join(root, 'empty-npmrc'),
      npm_config_globalconfig: path.join(root, 'empty-global-npmrc'),
      // Source-built bundles can exercise npm lifecycle on an older dev host;
      // release CI leaves this unset and checks the real platform floor.
      OPCORE_LIFECYCLE_TEST_GLIBC: process.env.OPCORE_LIFECYCLE_TEST_GLIBC,
    },
  };
}

function fixture(t) {
  const initial = emptyFixture(t);
  const { root, home } = initial;
  for (const agent of agentNames) fs.mkdirSync(path.join(home, `.${agent}`));
  const match = /^opcore-v(.+)-(linux-x86_64|macos-arm64)\.tar\.gz$/.exec(path.basename(archive));
  assert.ok(match, 'test bundle needs its release filename');
  const version = match[1];
  const packageDirectory = preparePackage(root, version);
  const result = { ...initial, version, loader: writeDownloadTransport(root, version) };
  const packed = requireSuccess(command('npm', ['pack', packageDirectory, '--ignore-scripts',
    '--json', '--pack-destination', root], result));
  result.tarball = path.join(root, JSON.parse(packed.stdout)[0].filename);
  return result;
}

function install(fixture, failState = false, extraEnvironment = {}) {
  return command('npm', ['install', '--global', '--prefix', fixture.prefix, '--offline',
    '--no-audit', '--fund=false', '--foreground-scripts', fixture.tarball], fixture, {
    NODE_OPTIONS: `--require=${JSON.stringify(fixture.loader)}`,
    ...(failState ? { OPCORE_LIFECYCLE_FAIL_STATE: '1' } : {}),
    ...extraEnvironment,
  });
}

function assertRemoved(fixture) {
  assert.equal(fs.existsSync(fixture.packageRoot), false);
  assert.equal(fs.existsSync(fixture.launcher), false);
  for (const agent of agentNames) {
    const runtime = path.join(fixture.home, `.${agent}`, 'opcore');
    for (const filename of ['install.receipt', 'hook-install.json']) {
      assert.equal(fs.existsSync(path.join(runtime, filename)), false, `${agent}/${filename}`);
    }
  }
  assert.equal(fs.existsSync(path.join(fixture.home, '.codex/hooks.json')), false);
  assert.equal(fs.existsSync(path.join(fixture.home, '.agents/skills/opcore/SKILL.md')), false);
  assert.equal(fs.existsSync(path.join(fixture.home, '.claude/skills/opcore/SKILL.md')), false);
}

function cleanup(fixture) {
  requireSuccess(command(fixture.launcher, ['uninstall'], fixture));
  requireSuccess(command('npm', ['uninstall', '--global', '--prefix', fixture.prefix,
    '--offline', '--no-audit', '--fund=false', packageName], fixture));
  assertRemoved(fixture);
}

function assertCliInstalled(fixture) {
  const state = JSON.parse(fs.readFileSync(path.join(fixture.packageRoot, 'install-state.json')));
  assert.equal(state.schema, 'opcore.npm-cli.v1');
  assert.equal(requireSuccess(command(fixture.launcher, ['--version'], fixture)).stdout.trim(),
    `opcore ${fixture.version}`);
  for (const agent of agentNames) assert.equal(fs.existsSync(path.join(fixture.home, `.${agent}`)), false);
}

test('real npm preflights both agents, recovers a failed first install and preserves a rejected update', {
  skip: !archive,
}, (t) => {
  const current = fixture(t);
  const claudeConfig = path.join(current.home, '.claude/settings.json');
  fs.writeFileSync(claudeConfig, 'invalid json\n');
  assert.notEqual(install(current).status, 0);
  assertRemoved(current);
  assert.equal(fs.readFileSync(claudeConfig, 'utf8'), 'invalid json\n');
  fs.writeFileSync(claudeConfig, '{}\n');
  requireSuccess(install(current));
  assert.equal(requireSuccess(command(current.launcher, ['--version'], current)).stdout.trim(),
    `opcore ${current.version}`);
  const codexConfig = path.join(current.home, '.codex/hooks.json');
  const savedConfig = fs.readFileSync(codexConfig);
  const receipts = agentNames.map((agent) => path.join(current.home, `.${agent}`, 'opcore/install.receipt'));
  const savedReceipts = receipts.map((filename) => fs.readFileSync(filename));
  fs.writeFileSync(codexConfig, 'invalid update config\n');
  assert.notEqual(install(current).status, 0);
  for (let index = 0; index < receipts.length; index += 1) {
    assert.deepEqual(fs.readFileSync(receipts[index]), savedReceipts[index]);
  }
  assert.equal(requireSuccess(command(current.launcher, ['--version'], current)).stdout.trim(),
    `opcore ${current.version}`);
  fs.writeFileSync(codexConfig, savedConfig);
  requireSuccess(install(current));
  cleanup(current);
});

test('real npm rolls back owned new integrations when final state publication fails', {
  skip: !archive,
}, (t) => {
  const current = fixture(t);
  const failed = install(current, true);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stdout + failed.stderr, /injected npm state publication failure/);
  assertRemoved(current);
  assert.equal(fs.existsSync(path.join(current.home, '.claude/settings.json')), false);
  requireSuccess(install(current));
  cleanup(current);
});

test('real npm recovers skipped scripts through verified CLI-only setup', {
  skip: !archive,
}, (t) => {
  const current = fixture(t);
  for (const agent of agentNames) fs.rmdirSync(path.join(current.home, `.${agent}`));
  const installed = command('npm', ['install', '--global', '--prefix', current.prefix,
    '--offline', '--ignore-scripts', '--no-audit', '--fund=false', current.tarball], current);
  requireSuccess(installed);
  const doctor = command(current.launcher, ['doctor', '--json'], current);
  assert.equal(doctor.status, 1);
  assert.match(JSON.parse(doctor.stdout).recovery, /setup --no-hooks/);
  const environment = { NODE_OPTIONS: `--require=${JSON.stringify(current.loader)}` };
  const interrupted = command(current.launcher, ['setup', '--no-hooks'], current, {
    ...environment, OPCORE_LIFECYCLE_FAIL_STATE: '1',
  });
  assert.notEqual(interrupted.status, 0);
  assert.match(interrupted.stderr, /injected npm state publication failure/);
  assert.equal(fs.existsSync(path.join(current.packageRoot, 'native/opcore')), false);
  requireSuccess(command(current.launcher, ['setup', '--no-hooks'], current, environment));
  requireSuccess(command(current.launcher, ['setup', '--no-hooks'], current, environment));
  assertCliInstalled(current);
  const help = requireSuccess(command(current.launcher, ['--help'], current));
  assert.match(help.stdout, /setup \[--no-hooks\]/);
  cleanup(current);
});

test('real npm lifecycle supports repeatable CLI-only installation without an agent', {
  skip: !archive,
}, (t) => {
  const current = fixture(t);
  for (const agent of agentNames) fs.rmdirSync(path.join(current.home, `.${agent}`));
  requireSuccess(install(current, false, { OPCORE_NO_HOOKS: '1' }));
  requireSuccess(install(current, false, { OPCORE_NO_HOOKS: '1' }));
  assertCliInstalled(current);
  cleanup(current);
});

test('npm --ignore-scripts leaves useful help and setup diagnostics without running native files', (t) => {
  const current = emptyFixture(t);
  const packed = requireSuccess(command('npm', ['pack', sourcePackage, '--ignore-scripts',
    '--json', '--pack-destination', current.root], current));
  const tarball = path.join(current.root, JSON.parse(packed.stdout)[0].filename);
  requireSuccess(command('npm', ['install', '--global', '--prefix', current.prefix,
    '--offline', '--ignore-scripts', '--no-audit', '--fund=false', tarball], current));
  const binDir = path.join(current.packageRoot, 'native');
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, 'opcore'),
    '#!/bin/sh\n: > executed-untrusted\nexit 99\n', { mode: 0o755 });
  for (const args of [['--help'], ['setup', '--help'], ['uninstall', '--help'], ['--version']]) {
    const result = requireSuccess(command(current.launcher, args, current));
    assert.match(result.stdout, /setup|npm package/);
  }
  for (const name of ['doctor', 'status']) {
    const result = command(current.launcher, [name, '--json'], current);
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, 'incomplete');
    assert.equal(report.packageRoot, current.packageRoot);
    assert.match(report.recovery, /opcore setup --no-hooks/);
  }
  const check = command(current.launcher, ['check', '--all'], current);
  assert.equal(check.status, 1);
  assert.match(check.stderr, /NATIVE_SETUP_REQUIRED.*install state/s);
  assert.equal(fs.existsSync(path.join(current.root, 'executed-untrusted')), false);
  assert.deepEqual(fs.readdirSync(current.home), []);
});
