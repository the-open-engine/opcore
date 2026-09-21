'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const test = require('node:test');
const zlib = require('zlib');

const {
  MAX_ARCHIVE_BYTES,
  MAX_MANIFEST_BYTES,
  STATE_FILE,
  archiveName,
  expectedArchiveNames,
  extractBundle,
  isReleaseVersion,
  parseChecksumManifest,
  parseInstallReceipt,
  parseReleaseAssets,
  readState,
  runBundleInstaller,
  selectAgent,
  selectAgents,
  stateEntries,
  stateBytes,
  selectTarget,
  requireHostCompatibility,
  sha256,
  verifyArchive,
} = require('../lib/install');
const { cleanup, run, runUninstaller } = require('../lib/cli');
const { install: installImplementation } = require('../lib/setup');

const VERSION = '1.2.3';
const TARGET = selectTarget('linux', 'x64');
const install = (options) => installImplementation({
  runtimeHeader: { glibcVersionRuntime: '2.39' }, ...options,
});

function octal(size, value) {
  const field = Buffer.alloc(size);
  const encoded = value.toString(8).padStart(size - 1, '0');
  field.write(encoded, 0, size - 1, 'ascii');
  return field;
}

function tarHeader(name, type, size, link = '') {
  const header = Buffer.alloc(512);
  assert.ok(Buffer.byteLength(name) <= 100, `test tar name is too long: ${name}`);
  header.write(name, 0, 100, 'utf8');
  octal(8, type === '5' ? 0o755 : 0o644).copy(header, 100);
  octal(8, 0).copy(header, 108);
  octal(8, 0).copy(header, 116);
  octal(12, size).copy(header, 124);
  octal(12, 0).copy(header, 136);
  header.fill(32, 148, 156);
  header.write(type, 156, 1, 'ascii');
  header.write(link, 157, 100, 'utf8');
  header.write('ustar\0', 257, 6, 'binary');
  header.write('00', 263, 2, 'ascii');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  const encoded = checksum.toString(8).padStart(6, '0');
  header.write(`${encoded}\0 `, 148, 8, 'binary');
  return header;
}

function tar(entries) {
  const blocks = [];
  for (const entry of entries) {
    const bytes = entry.bytes || Buffer.alloc(0);
    blocks.push(tarHeader(entry.name, entry.type || '0', bytes.length, entry.link));
    if (bytes.length) {
      blocks.push(bytes);
      blocks.push(Buffer.alloc((512 - (bytes.length % 512)) % 512));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

function bundleEntries(root = TARGET.bundleRoot) {
  const binary = Buffer.from('native-binary-fixture\n');
  const directories = [
    root,
    `${root}/asp`,
    `${root}/bin`,
    `${root}/docs`,
    `${root}/docs/assets`,
    `${root}/skills`,
    `${root}/skills/opcore`,
    `${root}/skills/opcore/agents`,
  ].map((name) => ({ name: `${name}/`, type: '5' }));
  const files = new Map([
    [`${root}/LICENSE`, 'license\n'],
    [`${root}/README.md`, 'readme\n'],
    [`${root}/CONTRIBUTING.md`, 'contributors\n'],
    [`${root}/install.sh`, '#!/usr/bin/env bash\nexit 0\n'],
    [`${root}/opcore.sha256`, `${sha256(binary)}  bin/opcore\n`],
    [`${root}/bin/opcore`, binary],
    [`${root}/skills/opcore/SKILL.md`, 'skill\n'],
    [`${root}/skills/opcore/agents/openai.yaml`, 'interface:\n  display_name: Opcore\n'],
    [`${root}/asp/SOURCE.json`, '{"version":"1.0"}\n'],
    [`${root}/docs/assets/asp-overview-mobile.svg`, '<svg/>\n'],
    [`${root}/docs/assets/asp-overview.svg`, '<svg/>\n'],
    [`${root}/docs/assets/opcore-hook-loop-mobile.svg`, '<svg/>\n'],
    [`${root}/docs/assets/opcore-hook-loop.svg`, '<svg/>\n'],
  ]);
  for (const guide of ['getting-started', 'configuration', 'providers', 'examples', 'sense',
    'agent-signals', 'architecture', 'acceptance', 'design-review']) {
    files.set(`${root}/docs/${guide}.md`, 'guide\n');
  }
  return [
    ...directories,
    ...[...files].map(([name, bytes]) => ({ name, bytes: Buffer.from(bytes) })),
  ];
}

function bundleArchive(entries = bundleEntries()) {
  return zlib.gzipSync(tar(entries));
}

function manifestFor(version, selectedName, selectedArchive) {
  const names = [...expectedArchiveNames(version)].sort();
  return Buffer.from(
    names
      .map((name) => `${name === selectedName ? sha256(selectedArchive) : 'a'.repeat(64)}  ${name}\n`)
      .join('')
  );
}

function releaseAssetsFor(version, selectedName, selectedArchive) {
  const archives = Object.fromEntries(
    [...expectedArchiveNames(version)]
      .sort()
      .map((name) => [name, name === selectedName ? sha256(selectedArchive) : 'a'.repeat(64)])
  );
  return Buffer.from(
    `${JSON.stringify({ schema: 'opcore.npm-assets.v1', version, archives }, null, 2)}\n`
  );
}

function temporary(t) {
  // macOS temporary paths can contain the /var -> /private/var alias.
  const directory = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), 'opcore-npm-test.'))
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writePackage(packageRoot, version = VERSION) {
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, 'package.json'),
    `${JSON.stringify({ name: '@the-open-engine-company/opcore', version }, null, 2)}\n`
  );
}

function codexPackage(t) {
  const root = temporary(t);
  const packageRoot = path.join(root, 'package');
  const home = path.join(root, 'home');
  const agentRoot = path.join(home, '.codex');
  writePackage(packageRoot);
  fs.mkdirSync(agentRoot, { recursive: true });
  return { root, packageRoot, home, agentRoot };
}

function createInstalledFiles({ bundleRoot, agent, agentRoot, home, skillRoot, binDir,
  enrollHooks = true }) {
  fs.mkdirSync(binDir, { recursive: true });
  const binaryPath = path.join(binDir, 'opcore');
  fs.copyFileSync(path.join(bundleRoot, 'bin', 'opcore'), binaryPath);
  fs.chmodSync(binaryPath, 0o755);
  const runtime = path.join(agentRoot, 'opcore');
  fs.mkdirSync(runtime, { recursive: true });
  const uninstallerPath = path.join(runtime, 'uninstall.sh');
  fs.writeFileSync(uninstallerPath, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  const hookReceiptPath = path.join(runtime, 'hook-install.json');
  if (enrollHooks) fs.writeFileSync(hookReceiptPath, '{"owned":true}\n');
  const owners = path.join(home, '.local', 'share', 'opcore', 'owners',
    sha256(Buffer.from(binaryPath)));
  fs.mkdirSync(owners, { recursive: true });
  for (const candidate of ['codex', 'claude']) {
    const slot = path.join(owners, candidate);
    if (!fs.existsSync(slot)) fs.writeFileSync(slot, 'opcore.owner.absent.v1\n');
  }
  fs.writeFileSync(path.join(owners, agent), `${agentRoot}\n${skillRoot}\n`);
  const digest = (filename) => sha256(fs.readFileSync(filename));
  const lines = [
    'opcore.install.v6',
    `agent ${agent}`,
    `binary ${digest(binaryPath)}`,
    `skill ${'1'.repeat(64)}`,
    `manifest ${'2'.repeat(64)}`,
    `native_manifest ${'3'.repeat(64)}`,
    `node_native_manifest ${'4'.repeat(64)}`,
    `python_native_manifest ${'5'.repeat(64)}`,
    `installer ${digest(uninstallerPath)}`,
    `agent_root_path ${sha256(Buffer.from(agentRoot))}`,
    `binary_path ${sha256(Buffer.from(binaryPath))}`,
    `owners_path ${sha256(Buffer.from(owners))}`,
    `skill_path ${sha256(Buffer.from(path.join(skillRoot, 'opcore', 'SKILL.md')))}`,
    `hooks ${enrollHooks ? 'yes' : 'no'}`,
    `descriptor ${'7'.repeat(64)}`,
  ];
  fs.writeFileSync(path.join(runtime, 'install.receipt'), `${lines.join('\n')}\n`);
}

function removeCleanupInputs(state) {
  for (const filename of [
    state.binaryPath,
    state.receiptPath,
    state.hookReceiptPath,
    state.uninstallerPath,
  ]) {
    fs.rmSync(filename, { force: true });
  }
  deactivateOwner(state);
}

function deactivateOwner(state) {
  const registry = path.join(state.home, '.local', 'share', 'opcore', 'owners',
    sha256(Buffer.from(state.binaryPath)));
  if (fs.existsSync(registry)) {
    fs.writeFileSync(path.join(registry, state.agent), 'opcore.owner.absent.v1\n');
  }
}

async function installCodexFixture(root, packageRoot, home, agentRoot) {
  const archive = bundleArchive();
  const filename = archiveName(VERSION, TARGET);
  return install({
    packageRoot,
    packageMetadata: { version: VERSION },
    platform: 'linux',
    arch: 'x64',
    environment: { HOME: home, CODEX_HOME: agentRoot },
    temporaryBase: root,
    fetchBuffer: async (url) =>
      url.endsWith('/SHA256SUMS') ? manifestFor(VERSION, filename, archive) : archive,
    releaseAssets: releaseAssetsFor(VERSION, filename, archive),
    runInstaller: createInstalledFiles,
  });
}

test('release versions and the shipped target matrix are strict', () => {
  for (const version of ['0.1.0', '12.34.56', '1.0.0-rc.1', '1.0.0-beta-2']) {
    assert.equal(isReleaseVersion(version), true, version);
  }
  for (const version of ['', 'v1.2.3', '1.2', '01.2.3', '1.2.3+build', '1.2.3-01']) {
    assert.equal(isReleaseVersion(version), false, version);
  }
  assert.deepEqual(selectTarget('linux', 'x64'), {
    asset: 'linux-x86_64',
    bundleRoot: 'opcore-linux-x86_64',
  });
  assert.deepEqual(selectTarget('darwin', 'arm64'), {
    asset: 'macos-arm64',
    bundleRoot: 'opcore-macos-arm64',
  });
  assert.throws(() => selectTarget('linux', 'arm64'), /UNSUPPORTED_OPCORE_HOST/);
  assert.throws(() => selectTarget('darwin', 'x64'), /UNSUPPORTED_OPCORE_HOST/);
  assert.throws(() => archiveName('0.0.0-development', TARGET), /UNRELEASED_SHIM_VERSION/);
});

test('Linux compatibility is explicit and checked before release downloads', async (t) => {
  for (const version of ['2.39', '2.40', '3.0']) {
    assert.doesNotThrow(() => requireHostCompatibility('linux', { glibcVersionRuntime: version }));
  }
  for (const version of [undefined, '2.38', '1.99', 'unknown']) {
    assert.throws(() => requireHostCompatibility('linux', { glibcVersionRuntime: version }),
      /UNSUPPORTED_OPCORE_LIBC/);
  }
  assert.doesNotThrow(() => requireHostCompatibility('darwin', {}));
  const { options, packageRoot, home } = await installBothFixture(t);
  const fetchBuffer = () => assert.fail('invalid installation context must not download');
  await assert.rejects(install({ ...options, runtimeHeader: {}, fetchBuffer }), /LIBC/);
  await assert.rejects(install({ ...options,
    environment: { HOME: home, OPCORE_AGENT: 'invalid' }, fetchBuffer }), /must be codex or claude/);
  await assert.rejects(install({ ...options,
    environment: { HOME: home, OPCORE_AGENT_NO_HOOKS: 'yes' }, fetchBuffer,
  }), /OPCORE_AGENT_NO_HOOKS must be 0 or 1/);
  assert.equal(fs.existsSync(path.join(packageRoot, STATE_FILE)), false);
});

test('agent selection is explicit or unambiguous', (t) => {
  const root = temporary(t);
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  assert.throws(
    () => selectAgent({ HOME: home }),
    /no supported agent detected.*OPCORE_NO_HOOKS=1/
  );
  fs.mkdirSync(path.join(home, '.codex'));
  assert.deepEqual(selectAgent({ HOME: home }), {
    agent: 'codex',
    agentRoot: path.join(home, '.codex'),
    home,
    skillRoot: path.join(home, '.agents', 'skills'),
  });
  assert.equal(selectAgent({ HOME: home, OPCORE_AGENT: 'claude' }).agent, 'claude');
  assert.throws(
    () => selectAgent({ HOME: home, OPCORE_AGENT: 'other' }),
    /must be codex or claude/
  );
  assert.throws(() => selectAgent({ HOME: 'relative', OPCORE_AGENT: 'codex' }), /HOME/);

  const physical = path.join(root, 'physical');
  const alias = path.join(root, 'alias');
  fs.mkdirSync(physical);
  fs.symlinkSync(physical, alias);
  assert.deepEqual(
    selectAgent({
      HOME: home,
      OPCORE_AGENT: 'codex',
      CODEX_HOME: path.join(alias, 'missing-codex'),
      OPCORE_SKILL_DIR: path.join(alias, 'missing-skills'),
    }),
    {
      agent: 'codex',
      agentRoot: path.join(physical, 'missing-codex'),
      home,
      skillRoot: path.join(physical, 'missing-skills'),
    }
  );
});

test('SHA256SUMS requires the exact two-asset release matrix', () => {
  const archive = bundleArchive();
  const filename = archiveName(VERSION, TARGET);
  const manifest = manifestFor(VERSION, filename, archive);
  const parsed = parseChecksumManifest(manifest, expectedArchiveNames(VERSION));
  assert.equal(parsed.get(filename), sha256(archive));
  assert.equal(verifyArchive(filename, archive, manifest, expectedArchiveNames(VERSION)), sha256(archive));
  assert.equal(
    parseReleaseAssets(releaseAssetsFor(VERSION, filename, archive), VERSION).get(filename),
    sha256(archive)
  );

  const invalid = [
    Buffer.from(''),
    Buffer.from(`${'a'.repeat(64)} ${filename}\n`),
    Buffer.from(`${'A'.repeat(64)}  ${filename}\n`),
    Buffer.from(`${'a'.repeat(64)}  ../${filename}\n`),
    Buffer.from(`${'a'.repeat(64)}  ${filename}`),
    Buffer.from(`${'a'.repeat(64)}  ${filename}\r\n`),
    Buffer.from(`${'a'.repeat(64)}  ${filename}\n${'b'.repeat(64)}  ${filename}\n`),
  ];
  for (const bytes of invalid) {
    assert.throws(
      () => parseChecksumManifest(bytes, expectedArchiveNames(VERSION)),
      /CHECKSUM_MANIFEST_INVALID/
    );
  }
  assert.throws(
    () => parseChecksumManifest(Buffer.alloc(MAX_MANIFEST_BYTES + 1)),
    /CHECKSUM_MANIFEST_INVALID/
  );
  assert.throws(
    () => verifyArchive(filename, Buffer.from('wrong'), manifest, expectedArchiveNames(VERSION)),
    /CHECKSUM_MISMATCH/
  );
});

test('the full bundle extracts only regular, expected entries', () => {
  const extracted = extractBundle(bundleArchive(), TARGET.bundleRoot);
  assert.equal(extracted.get('bin/opcore').bytes.toString(), 'native-binary-fixture\n');
  assert.equal(extracted.has('docs/assets/opcore-hook-loop-mobile.svg'), true);
  assert.equal(extracted.has('asp/SOURCE.json'), true);
});

test('archive parsing rejects traversal, links, duplicates, missing assets, and corruption', () => {
  const cases = [];
  cases.push([
    'traversal',
    [...bundleEntries(), { name: `${TARGET.bundleRoot}/../escape`, bytes: Buffer.from('x') }],
  ]);
  cases.push([
    'link',
    [...bundleEntries(), { name: `${TARGET.bundleRoot}/asp/link`, type: '2', link: '/tmp/x' }],
  ]);
  cases.push(['duplicate', [...bundleEntries(), bundleEntries().find((entry) => entry.name.endsWith('/LICENSE'))]]);
  cases.push([
    'unexpected',
    [...bundleEntries(), { name: `${TARGET.bundleRoot}/extra.txt`, bytes: Buffer.from('x') }],
  ]);
  cases.push([
    'missing visual',
    bundleEntries().filter((entry) => !entry.name.endsWith('/docs/assets/asp-overview.svg')),
  ]);
  cases.push([
    'regular file with directory spelling',
    bundleEntries().map((entry) =>
      entry.name === `${TARGET.bundleRoot}/asp/`
        ? { ...entry, type: '0' }
        : entry
    ),
  ]);
  for (const [label, entries] of cases) {
    assert.throws(() => extractBundle(bundleArchive(entries), TARGET.bundleRoot), /ARCHIVE_INVALID/, label);
  }

  const badHeader = tar(bundleEntries());
  badHeader[10] ^= 1;
  assert.throws(
    () => extractBundle(zlib.gzipSync(badHeader), TARGET.bundleRoot),
    /tar header checksum mismatch/
  );
  const truncated = tar(bundleEntries()).subarray(0, -1024);
  assert.throws(() => extractBundle(zlib.gzipSync(truncated), TARGET.bundleRoot), /tar trailer/);
  assert.throws(() => extractBundle(bundleArchive(), TARGET.bundleRoot, 128), /ARCHIVE_INVALID/);

  const wrongInner = bundleEntries().map((entry) =>
    entry.name.endsWith('/bin/opcore') ? { ...entry, bytes: Buffer.from('changed') } : entry
  );
  assert.throws(() => extractBundle(bundleArchive(wrongInner), TARGET.bundleRoot), /inner binary checksum/);
});

test('postinstall downloads by package version, runs the bundle installer, and records state', async (t) => {
  const { root, packageRoot, home, agentRoot } = codexPackage(t);
  const archive = bundleArchive();
  const filename = archiveName(VERSION, TARGET);
  const manifest = manifestFor(VERSION, filename, archive);
  const urls = [];
  const limits = [];
  const state = await install({
    packageRoot,
    packageMetadata: { version: VERSION },
    platform: 'linux',
    arch: 'x64',
    environment: { HOME: home, CODEX_HOME: agentRoot },
    temporaryBase: root,
    fetchBuffer: async (url, limit) => {
      urls.push(url);
      limits.push(limit);
      return url.endsWith('/SHA256SUMS') ? manifest : archive;
    },
    releaseAssets: releaseAssetsFor(VERSION, filename, archive),
    runInstaller: createInstalledFiles,
  });
  assert.deepEqual(urls, [
    `https://github.com/the-open-engine/opcore/releases/download/v${VERSION}/SHA256SUMS`,
    `https://github.com/the-open-engine/opcore/releases/download/v${VERSION}/${filename}`,
  ]);
  assert.deepEqual(limits, [MAX_MANIFEST_BYTES, MAX_ARCHIVE_BYTES]);
  assert.equal(state.agent, 'codex');
  assert.equal(state.target, 'linux-x86_64');
  assert.equal(state.archiveDigest, sha256(archive));
  assert.deepEqual(readState(packageRoot), state);
  assert.equal(fs.readdirSync(root).some((name) => name.startsWith('opcore-npm.')), false);

  let invocation;
  assert.equal(
    run(['check', '--repo', '.'], {
      packageRoot,
      platform: 'linux',
      arch: 'x64',
      spawnNative: (binary, args) => {
        invocation = { binary, args };
        return { status: 7, signal: null };
      },
    }),
    7
  );
  assert.deepEqual(invocation, {
    binary: state.binaryPath,
    args: ['check', '--repo', '.'],
  });
  let help = '';
  const helpOptions = { packageRoot, platform: 'linux', arch: 'x64',
    spawnNative: () => ({ status: 0 }), write: (message) => { help += message; } };
  assert.equal(run(['--help'], helpOptions), 0);
  assert.match(help, /setup \[--no-hooks\]/);
  assert.match(help, /uninstall/);
  help = '';
  assert.equal(run(['check', '--help'], helpOptions), 0);
  assert.equal(help, '');
});

test('postinstall fails before process execution on checksum or platform errors', async (t) => {
  const root = temporary(t);
  const packageRoot = path.join(root, 'package');
  const home = path.join(root, 'home');
  writePackage(packageRoot);
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  let ran = false;
  const common = {
    packageRoot,
    packageMetadata: { version: VERSION },
    environment: { HOME: home, OPCORE_AGENT: 'codex' },
    releaseAssets: releaseAssetsFor(
      VERSION,
      archiveName(VERSION, TARGET),
      bundleArchive()
    ),
    runInstaller: () => {
      ran = true;
    },
  };
  await assert.rejects(
    install({
      ...common,
      platform: 'linux',
      arch: 'x64',
      fetchBuffer: async (url) =>
        url.endsWith('/SHA256SUMS')
          ? manifestFor(VERSION, archiveName(VERSION, TARGET), bundleArchive())
          : Buffer.from('changed'),
    }),
    /CHECKSUM_MISMATCH/
  );
  assert.equal(ran, false);
  assert.equal(fs.existsSync(path.join(packageRoot, STATE_FILE)), false);
  await assert.rejects(
    install({ ...common, platform: 'linux', arch: 'arm64', fetchBuffer: async () => Buffer.alloc(0) }),
    /UNSUPPORTED_OPCORE_HOST/
  );
});

test('bundle installer forwards agent integration without hook enrollment', (t) => {
  const root = temporary(t);
  const bundleRoot = path.join(root, 'bundle');
  const binDir = path.join(root, 'bin');
  const output = path.join(root, 'args');
  fs.mkdirSync(bundleRoot);
  fs.writeFileSync(path.join(bundleRoot, 'install.sh'),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > ${JSON.stringify(output)}\n`, { mode: 0o755 });
  const selected = {
    bundleRoot,
    agent: 'codex',
    agentRoot: path.join(root, 'home', '.codex'),
    home: path.join(root, 'home'),
    skillRoot: path.join(root, 'home', '.agents', 'skills'),
    binDir,
    enrollHooks: false,
    environment: {},
  };
  runBundleInstaller(selected);
  assert.deepEqual(fs.readFileSync(output, 'utf8').trim().split('\n'),
    ['--agent', 'codex', '--no-hooks', '--bin-dir', binDir]);
  runBundleInstaller({ ...selected, contexts: [selected] });
  assert.deepEqual(fs.readFileSync(output, 'utf8').trim().split('\n'),
    ['--no-hooks', '--bin-dir', binDir]);
});

test('explicit uninstall verifies receipts before trusted cleanup and gives the npm command', async (t) => {
  const { root, packageRoot, home, agentRoot } = codexPackage(t);
  const state = await installCodexFixture(root, packageRoot, home, agentRoot);
  let executed = false;
  let output = '';
  const status = run(['uninstall'], {
    packageRoot,
    platform: 'linux',
    arch: 'x64',
    runUninstaller: (verified, _environment, trustedUninstaller) => {
      executed = true;
      assert.deepEqual(verified, state);
      assert.equal(sha256(trustedUninstaller), state.uninstallerDigest);
      removeCleanupInputs(verified);
    },
    write: (message) => {
      output += message;
    },
  });
  assert.equal(status, 0);
  assert.equal(executed, true);
  assert.match(output, /npm uninstall -g @the-open-engine-company\/opcore/);
  assert.equal(fs.existsSync(path.join(packageRoot, STATE_FILE)), false);
});

test('installer and uninstaller ignore Bash startup injection variables', (t) => {
  const root = temporary(t);
  const bundleRoot = path.join(root, 'bundle');
  const binDir = path.join(root, 'bin');
  const home = path.join(root, 'home');
  const marker = path.join(root, 'bash-env-ran');
  const bashEnvironment = path.join(root, 'bash-env');
  fs.mkdirSync(bundleRoot);
  fs.mkdirSync(home);
  fs.writeFileSync(bashEnvironment, `printf pwned > ${JSON.stringify(marker)}\n`);
  fs.writeFileSync(
    path.join(bundleRoot, 'install.sh'),
    '#!/usr/bin/env bash\n[[ -z ${BASH_ENV:-} && -z ${ENV:-} ]]\n',
    { mode: 0o755 }
  );
  runBundleInstaller({
    bundleRoot,
    agent: 'codex',
    agentRoot: path.join(home, '.codex'),
    home,
    skillRoot: path.join(home, '.agents', 'skills'),
    binDir,
    environment: {
      HOME: home,
      CODEX_HOME: path.join(home, '.codex'),
      BASH_ENV: bashEnvironment,
      ENV: bashEnvironment,
      'BASH_FUNC_pwn%%': '() { printf pwned; }',
    },
  });
  assert.equal(fs.existsSync(marker), false);

  runUninstaller(
    {
      agent: 'codex',
      agentRoot: path.join(home, '.codex'),
      home,
      skillRoot: path.join(home, '.agents', 'skills'),
      binaryPath: path.join(binDir, 'opcore'),
    },
    { HOME: home, BASH_ENV: bashEnvironment, ENV: bashEnvironment },
    Buffer.from('#!/usr/bin/env bash\n[[ -z ${BASH_ENV:-} && -z ${ENV:-} ]]\n')
  );
  assert.equal(fs.existsSync(marker), false);
});

test('cleanup refuses modified executable inputs without running them', async (t) => {
  const { root, packageRoot, home, agentRoot } = codexPackage(t);
  const state = await installCodexFixture(root, packageRoot, home, agentRoot);
  fs.appendFileSync(state.uninstallerPath, '# changed\n');
  let executed = false;
  assert.throws(
    () =>
      cleanup({
        packageRoot,
        platform: 'linux',
        arch: 'x64',
        runUninstaller: () => {
          executed = true;
        },
      }),
    /cleanup inputs changed/
  );
  assert.equal(executed, false);
  assert.equal(fs.existsSync(state.receiptPath), true);
});

test('launcher rejects tampered binaries and noncanonical state', async (t) => {
  const { root, packageRoot, home, agentRoot } = codexPackage(t);
  const state = await installCodexFixture(root, packageRoot, home, agentRoot);
  fs.appendFileSync(state.binaryPath, 'changed');
  assert.throws(
    () => run(['check'], { packageRoot, platform: 'linux', arch: 'x64' }),
    /installed binary changed/
  );
  let output = '';
  assert.equal(run(['--version'], { packageRoot, platform: 'linux', arch: 'x64',
    write: (message) => { output += message; },
    spawnNative: () => assert.fail('never execute a modified binary'),
  }), 0);
  assert.match(output, /native setup incomplete/);
  fs.writeFileSync(path.join(packageRoot, STATE_FILE), '{}\n');
  assert.throws(() => readState(packageRoot), /not canonical/);
});

function standaloneFixture(t) {
  const root = temporary(t);
  const home = path.join(root, 'empty home');
  const packageRoot = path.join(root, 'package with spaces');
  fs.mkdirSync(home);
  writePackage(packageRoot);
  const entries = bundleEntries();
  const binary = Buffer.from(`#!/bin/sh\nprintf 'opcore ${VERSION}\\n'\n`);
  entries.find((entry) => entry.name.endsWith('/bin/opcore')).bytes = binary;
  entries.find((entry) => entry.name.endsWith('/opcore.sha256')).bytes =
    Buffer.from(`${sha256(binary)}  bin/opcore\n`);
  const archive = bundleArchive(entries);
  const filename = archiveName(VERSION, TARGET);
  return { root, home, packageRoot, binary, options: {
    packageRoot, platform: 'linux', arch: 'x64', noHooks: true,
    environment: { HOME: home }, temporaryBase: root,
    runtimeHeader: { glibcVersionRuntime: '2.39' },
    fetchBuffer: async (url) => url.endsWith('/SHA256SUMS')
      ? manifestFor(VERSION, filename, archive) : archive,
    releaseAssets: releaseAssetsFor(VERSION, filename, archive),
  } };
}

test('CLI-only setup verifies, updates and removes without discovering agents', async (t) => {
  const { home, packageRoot, binary, options } = standaloneFixture(t);
  const state = await install(options);
  assert.equal(state.schema, 'opcore.npm-cli.v1');
  assert.deepEqual(readState(packageRoot), state);
  assert.deepEqual(fs.readdirSync(home), []);
  assert.deepEqual(await install(options), state);
  const output = [];
  assert.equal(run(['--version'], { ...options, spawnNative: (filename, args) => {
    const result = spawnSync(filename, args, { encoding: 'utf8' });
    output.push(result.stdout.trim());
    return result;
  } }), 0);
  assert.deepEqual(output, [`opcore ${VERSION}`]);
  await assert.rejects(install({ ...options, noHooks: false,
    environment: { HOME: home, OPCORE_AGENT: 'codex' },
  }), /CLI-only installation exists/);
  fs.appendFileSync(state.binaryPath, 'changed');
  assert.throws(() => run(['check'], options), /installed binary changed/);
  await assert.rejects(install(options), /modified binary/);
  assert.throws(() => cleanup(options), /changed before cleanup/);
  fs.writeFileSync(state.binaryPath, binary);
  const changed = { ...state, target: 'macos-arm64' };
  fs.writeFileSync(path.join(packageRoot, STATE_FILE), stateBytes(changed));
  assert.throws(() => run(['check'], options), /another platform/);
  fs.writeFileSync(path.join(packageRoot, STATE_FILE), stateBytes(state));
  const native = path.dirname(state.binaryPath);
  const moved = path.join(packageRoot, 'saved-native');
  fs.renameSync(native, moved);
  fs.symlinkSync(moved, native);
  assert.throws(() => run(['check'], options), /not a regular directory/);
  assert.throws(() => cleanup(options), /not a regular directory/);
  assert.equal(fs.existsSync(path.join(moved, 'opcore')), true);
  fs.unlinkSync(native);
  fs.renameSync(moved, native);
  cleanup(options);
  assert.equal(fs.existsSync(state.binaryPath), false);
  assert.equal(fs.existsSync(path.join(packageRoot, STATE_FILE)), false);
  assert.deepEqual(fs.readdirSync(home), []);
});

test('explicit setup recovers an interrupted download without creating agent files', async (t) => {
  const { home, packageRoot, options } = standaloneFixture(t);
  await assert.rejects(install({ ...options, fetchBuffer: async () => {
    throw new Error('DOWNLOAD_FAILED: fixture connection interrupted');
  } }), /connection interrupted/);
  assert.equal(fs.existsSync(path.join(packageRoot, STATE_FILE)), false);
  let output = '';
  const write = (message) => { output += message; };
  assert.equal(run(['doctor', '--json'], { ...options, write }), 1);
  const report = JSON.parse(output);
  assert.equal(report.status, 'incomplete');
  assert.match(report.recovery, /setup --no-hooks/);
  assert.equal(await run(['setup', '--no-hooks'], { ...options, write }), 0);
  assert.match(output, /setup complete/);
  assert.equal(readState(packageRoot).schema, 'opcore.npm-cli.v1');
  assert.deepEqual(fs.readdirSync(home), []);
  cleanup(options);
});

test('concurrent npm setup and removal cannot replace each other\'s state', async (t) => {
  const { options, packageRoot } = standaloneFixture(t);
  let resume;
  const held = new Promise((resolve) => { resume = resolve; });
  const pending = install({ ...options, fetchBuffer: async (...args) => {
    await held;
    return options.fetchBuffer(...args);
  } });
  await assert.rejects(install(options), /INSTALL_BUSY/);
  assert.throws(() => cleanup(options), /INSTALL_BUSY/);
  resume();
  await pending;
  const lock = path.join(packageRoot, '.opcore-install.lock');
  assert.equal(fs.existsSync(lock), false);
  cleanup(options);
  fs.mkdirSync(lock);
  await assert.rejects(install(options), /confirm no installer is running/);
  fs.rmdirSync(lock);
  await install(options);
  cleanup(options);
});

test('discovery includes both agents and respects each explicit restriction', (t) => {
  const root = temporary(t);
  const home = path.join(root, 'home with spaces');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude'));
  assert.deepEqual(selectAgents({ HOME: home }).map((entry) => entry.agent), ['codex', 'claude']);
  for (const agent of ['codex', 'claude']) {
    assert.deepEqual(selectAgents({ HOME: home, OPCORE_AGENT: agent }).map((entry) => entry.agent), [agent]);
  }
  const custom = selectAgents({
    HOME: home, CODEX_HOME: path.join(home, 'custom codex'),
    CLAUDE_CONFIG_DIR: path.join(home, 'custom claude'),
  });
  assert.equal(custom.length, 2);
  assert.equal(custom[1].agentRoot, path.join(home, 'custom claude'));
  fs.rmdirSync(path.join(home, '.codex'));
  fs.writeFileSync(path.join(home, '.codex'), 'ordinary file');
  assert.deepEqual(selectAgents({ HOME: home }).map((entry) => entry.agent), ['claude']);
});

test('v6 receipts have a hard shared-ownership boundary', () => {
  const digest = 'a'.repeat(64);
  const common = [
    `binary ${digest}`, `skill ${digest}`, `manifest ${digest}`,
    `native_manifest ${digest}`, `node_native_manifest ${digest}`,
    `python_native_manifest ${digest}`, `installer ${digest}`,
    `agent_root_path ${digest}`, `binary_path ${digest}`, `skill_path ${digest}`,
    'hooks no',
  ];
  const receipt = (schema, extra = []) => Buffer.from(`${[schema, ...common, ...extra].join('\n')}\n`);
  assert.throws(() => parseInstallReceipt(receipt('opcore.install.v5', [
    'agent codex', `owners_path ${digest}`,
  ])), /version 5 receipt contains shared ownership/);
  assert.throws(() => parseInstallReceipt(receipt('opcore.install.v6', [
    `owners_path ${digest}`,
  ])), /version 6 receipt has invalid shared ownership/);
  const parsed = parseInstallReceipt(receipt('opcore.install.v6', [
    'agent codex', `owners_path ${digest}`,
  ]));
  assert.equal(parsed.get('agent'), 'codex');
});

test('historical npm v1 state cleans a v5 install without a registry', async (t) => {
  const { root, packageRoot, home, agentRoot } = codexPackage(t);
  const state = await installCodexFixture(root, packageRoot, home, agentRoot);
  const receipt = fs.readFileSync(state.receiptPath, 'utf8').split('\n').filter((line) =>
    !line.startsWith('agent ') && !line.startsWith('owners_path ')
  );
  receipt[0] = 'opcore.install.v5';
  const receiptBytes = Buffer.from(receipt.join('\n'));
  fs.writeFileSync(state.receiptPath, receiptBytes);
  fs.rmSync(path.join(home, '.local', 'share', 'opcore', 'owners'), {
    recursive: true, force: true,
  });
  state.receiptDigest = sha256(receiptBytes);
  fs.writeFileSync(path.join(packageRoot, STATE_FILE), stateBytes(state));
  cleanup({
    packageRoot, platform: 'linux', arch: 'x64', runUninstaller: removeCleanupInputs,
  });
  assert.equal(fs.existsSync(state.binaryPath), false);
});

async function installBothFixture(t, runInstaller = createInstalledFiles) {
  const fixture = codexPackage(t);
  const { root, home, packageRoot } = fixture;
  fs.mkdirSync(path.join(home, '.claude'));
  const archive = bundleArchive();
  const filename = archiveName(VERSION, TARGET);
  const options = {
    packageRoot, packageMetadata: { version: VERSION }, platform: 'linux', arch: 'x64',
    environment: { HOME: home }, temporaryBase: root, runInstaller,
    fetchBuffer: async (url) =>
      url.endsWith('/SHA256SUMS') ? manifestFor(VERSION, filename, archive) : archive,
    releaseAssets: releaseAssetsFor(VERSION, filename, archive),
  };
  return { ...fixture, options };
}

test('npm records both integrations, updates, and verifies all before cleanup', async (t) => {
  const { options, packageRoot } = await installBothFixture(t);
  const state = await install(options);
  assert.equal(state.schema, 'opcore.npm-install.v2');
  assert.deepEqual(stateEntries(readState(packageRoot)).map((entry) => entry.agent), ['codex', 'claude']);
  await install(options);
  const entries = stateEntries(readState(packageRoot));
  const saved = fs.readFileSync(entries[1].receiptPath);
  fs.appendFileSync(entries[1].receiptPath, 'hooks yes\n');
  assert.throws(() => cleanup({
    packageRoot, platform: 'linux', arch: 'x64',
    runUninstaller: () => assert.fail('must verify both receipts first'),
  }), /cleanup inputs changed|invalid entry/);
  fs.writeFileSync(entries[1].receiptPath, saved);
  const calls = [];
  cleanup({
    packageRoot, platform: 'linux', arch: 'x64',
    runUninstaller: (entry, environment, script) => {
      assert.equal(sha256(script), entry.uninstallerDigest);
      calls.push(entry.agent);
      for (const key of ['receiptPath', 'hookReceiptPath', 'uninstallerPath']) fs.rmSync(entry[key]);
      deactivateOwner(entry);
      if (calls.length === 2) fs.rmSync(entry.binaryPath);
    },
  });
  assert.deepEqual(calls, ['codex', 'claude']);
  assert.equal(fs.existsSync(entries[0].binaryPath), false);
});

test('npm preserves hooks-no ownership through install, update, and uninstall', async (t) => {
  const { options, packageRoot, home } = await installBothFixture(t);
  options.environment = { HOME: home, OPCORE_AGENT_NO_HOOKS: '1' };
  await install(options);
  await install(options);
  const entries = stateEntries(readState(packageRoot));
  assert.deepEqual(entries.map((entry) => entry.agent), ['codex', 'claude']);
  for (const entry of entries) {
    assert.equal(parseInstallReceipt(fs.readFileSync(entry.receiptPath)).get('hooks'), 'no');
    assert.equal(fs.existsSync(entry.hookReceiptPath), false);
  }
  cleanup({ packageRoot, platform: 'linux', arch: 'x64', runUninstaller: removeCleanupInputs });
  assert.equal(fs.existsSync(entries[0].binaryPath), false);
});

test('npm rolls back new hooks-no integrations after a partial failure', async (t) => {
  const { options, packageRoot, home } = await installBothFixture(t, (request) => {
    createInstalledFiles(request);
    if (request.agent === 'claude') throw new Error('manifest publication failed');
  });
  options.environment = { HOME: home, OPCORE_AGENT_NO_HOOKS: '1' };
  let removals = 0;
  await assert.rejects(install({
    ...options,
    runUninstaller: (entry) => {
      assert.equal(parseInstallReceipt(fs.readFileSync(entry.receiptPath)).get('hooks'), 'no');
      assert.equal(fs.existsSync(entry.hookReceiptPath), false);
      for (const filename of [entry.receiptPath, entry.uninstallerPath]) {
        fs.rmSync(filename, { force: true });
      }
      deactivateOwner(entry);
      removals += 1;
      if (removals === 2) fs.rmSync(entry.binaryPath);
    },
  }), /manifest publication failed/);
  assert.equal(removals, 2);
  assert.equal(fs.existsSync(path.join(packageRoot, STATE_FILE)), false);
});

test('npm removes new receipt-owned integrations after a partial installer failure', async (t) => {
  const { options, packageRoot } = await installBothFixture(t, (request) => {
    createInstalledFiles(request);
    if (request.agent === 'claude') {
      const runtime = path.join(request.agentRoot, 'opcore');
      const receipt = path.join(runtime, 'install.receipt');
      fs.writeFileSync(receipt, fs.readFileSync(receipt, 'utf8').replace('hooks yes', 'hooks pending'));
      fs.rmSync(path.join(runtime, 'hook-install.json'));
      throw new Error('hook configuration failed');
    }
  });
  let removals = 0;
  await assert.rejects(install({
    ...options,
    runUninstaller: (entry) => {
      for (const key of ['receiptPath', 'hookReceiptPath', 'uninstallerPath']) {
        fs.rmSync(entry[key], { force: true });
      }
      deactivateOwner(entry);
      removals += 1;
      if (removals === 2) fs.rmSync(entry.binaryPath);
    },
  }), /hook configuration failed/);
  assert.equal(removals, 2);
  assert.equal(fs.existsSync(path.join(packageRoot, STATE_FILE)), false);
});

test('npm cleanup persists the remaining owner when a later removal fails', async (t) => {
  const { options, packageRoot } = await installBothFixture(t);
  await install(options);
  assert.throws(() => cleanup({
    packageRoot, platform: 'linux', arch: 'x64',
    runUninstaller: (entry) => {
      if (entry.agent === 'claude') throw new Error('retained changed hook');
      for (const key of ['receiptPath', 'hookReceiptPath', 'uninstallerPath']) fs.rmSync(entry[key]);
      deactivateOwner(entry);
    },
  }), /retained changed hook/);
  assert.equal(readState(packageRoot).agent, 'claude');
  cleanup({ packageRoot, platform: 'linux', arch: 'x64', runUninstaller: removeCleanupInputs });
});

function realBundleFixture(t) {
  const root = temporary(t);
  const home = path.join(root, 'home with spaces');
  const packageRoot = path.join(root, 'package with spaces');
  writePackage(packageRoot);
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude'));
  const native = fs.readFileSync(process.env.OPCORE_TEST_BINARY);
  const installer = fs.readFileSync(path.resolve(__dirname, '../../../scripts/install.sh'));
  const entries = bundleEntries();
  for (const entry of entries) {
    if (entry.name === `${TARGET.bundleRoot}/bin/opcore`) entry.bytes = native;
    if (entry.name === `${TARGET.bundleRoot}/install.sh`) entry.bytes = installer;
    if (entry.name === `${TARGET.bundleRoot}/opcore.sha256`) {
      entry.bytes = Buffer.from(`${sha256(native)}  bin/opcore\n`);
    }
  }
  const archive = bundleArchive(entries);
  const filename = archiveName(VERSION, TARGET);
  const options = {
    packageRoot, packageMetadata: { version: VERSION }, platform: 'linux', arch: 'x64',
    environment: { HOME: home }, temporaryBase: root,
    fetchBuffer: async (url) =>
      url.endsWith('/SHA256SUMS') ? manifestFor(VERSION, filename, archive) : archive,
    releaseAssets: releaseAssetsFor(VERSION, filename, archive),
  };
  return { root, home, packageRoot, options };
}

test('real bundle installs and removes both agents from paths with spaces', {
  skip: !process.env.OPCORE_TEST_BINARY,
}, async (t) => {
  const { home, packageRoot, options } = realBundleFixture(t);
  await install(options);
  const state = await install(options);
  assert.equal(stateEntries(state).length, 2);
  assert.ok(fs.existsSync(path.join(home, '.codex', 'hooks.json')));
  assert.ok(fs.existsSync(path.join(home, '.claude', 'settings.json')));
  cleanup({ packageRoot, platform: 'linux', arch: 'x64', environment: { HOME: home } });
  assert.equal(fs.existsSync(path.join(packageRoot, 'native', 'opcore')), false);
  for (const entry of stateEntries(state)) assert.equal(fs.existsSync(entry.receiptPath), false);
});


test('multi-agent state rejects malformed entries and conflicting destinations', async (t) => {
  const { options, packageRoot, home } = await installBothFixture(t);
  const original = await install(options);
  for (const installations of [[null], [original.installations[0], original.installations[0]]]) {
    fs.writeFileSync(path.join(packageRoot, STATE_FILE), stateBytes({
      schema: 'opcore.npm-install.v2', installations,
    }));
    assert.throws(() => readState(packageRoot), /INSTALLED_STATE_INVALID/);
  }
  fs.writeFileSync(path.join(packageRoot, STATE_FILE), stateBytes(original));
  await assert.rejects(install({ ...options, environment: {
    HOME: home, CODEX_HOME: path.join(home, 'moved codex'),
  } }), /conflicting agent ownership locations/);
  assert.deepEqual(readState(packageRoot), original);
});

test('failed update cannot rebind an old binary to a new verified archive', async (t) => {
  const { options, packageRoot } = await installBothFixture(t);
  const original = await install(options);
  await assert.rejects(install({ ...options, runInstaller: () => {
    fs.appendFileSync(original.installations[0].binaryPath, 'changed');
    throw new Error('preflight rejected');
  } }), /preflight rejected; cleanup state recovery failed/);
  assert.deepEqual(readState(packageRoot), original);
});

test('real bundle recovers package replacement and restricted same-binary installation', {
  skip: !process.env.OPCORE_TEST_BINARY,
}, async (t) => {
  const { options, packageRoot, home } = realBundleFixture(t);
  await install(options);
  fs.rmSync(path.join(packageRoot, STATE_FILE));
  fs.rmSync(path.join(packageRoot, 'native'), { recursive: true });
  const state = await install({ ...options, environment: { HOME: home, OPCORE_AGENT: 'codex' } });
  assert.equal(stateEntries(state).length, 2);
  cleanup({ packageRoot, platform: 'linux', arch: 'x64' });
});

test('real bundle captures first-agent hook failure and retries cleanup after a later failure', {
  skip: !process.env.OPCORE_TEST_BINARY,
}, async (t) => {
  const { options, packageRoot, home } = realBundleFixture(t);
  fs.writeFileSync(path.join(home, '.codex', 'hooks.json'), 'invalid json\n');
  await assert.rejects(install(options), /installer exited/);
  assert.equal(fs.existsSync(path.join(packageRoot, STATE_FILE)), false);
  for (const agent of ['codex', 'claude']) {
    assert.equal(fs.existsSync(path.join(home, `.${agent}`, 'opcore', 'install.receipt')), false);
  }
  fs.rmSync(path.join(home, '.codex', 'hooks.json'));
  await install(options);
  const entries = stateEntries(readState(packageRoot));
  const settings = path.join(home, '.claude', 'settings.json');
  const saved = fs.readFileSync(settings);
  fs.writeFileSync(settings, 'invalid json\n');
  assert.throws(() => cleanup({ packageRoot, platform: 'linux', arch: 'x64' }), /uninstaller exited/);
  assert.equal(readState(packageRoot).agent, 'claude');
  fs.writeFileSync(settings, saved);
  cleanup({ packageRoot, platform: 'linux', arch: 'x64' });
});

test('real bundle refuses unknown registry entries before removing either integration', {
  skip: !process.env.OPCORE_TEST_BINARY,
}, async (t) => {
  const { options, packageRoot, home } = realBundleFixture(t);
  const state = await install(options);
  const registry = path.join(home, '.local', 'share', 'opcore', 'owners',
    sha256(Buffer.from(path.join(packageRoot, 'native', 'opcore'))));
  const unknown = path.join(registry, '.unknown');
  fs.writeFileSync(unknown, 'stale');
  assert.throws(() => cleanup({ packageRoot, platform: 'linux', arch: 'x64' }), /ambiguous shared ownership/);
  for (const entry of stateEntries(state)) assert.ok(fs.existsSync(entry.receiptPath));
  fs.rmSync(unknown);
  const peerOwner = path.join(registry, 'claude');
  const ownerBytes = fs.readFileSync(peerOwner);
  fs.rmSync(peerOwner);
  assert.throws(() => cleanup({ packageRoot, platform: 'linux', arch: 'x64' }), /shared ownership slot is missing/);
  for (const entry of stateEntries(state)) assert.ok(fs.existsSync(entry.receiptPath));
  fs.writeFileSync(peerOwner, ownerBytes);
  const peerManifest = path.join(home, '.claude', 'opcore', 'asp-server.json');
  const manifestBytes = fs.readFileSync(peerManifest);
  fs.rmSync(peerManifest);
  fs.symlinkSync(path.join(home, 'missing target'), peerManifest);
  assert.throws(() => cleanup({ packageRoot, platform: 'linux', arch: 'x64' }), /INSTALLED_STATE_INVALID/);
  for (const entry of stateEntries(state)) assert.ok(fs.existsSync(entry.receiptPath));
  fs.rmSync(peerManifest);
  fs.writeFileSync(peerManifest, manifestBytes);
  cleanup({ packageRoot, platform: 'linux', arch: 'x64' });
});
