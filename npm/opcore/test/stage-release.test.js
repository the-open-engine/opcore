#!/usr/bin/env node
'use strict';

const test = require('node:test');
const { spawnSync } = require('child_process');
const path = require('path');
const assert = require('assert/strict');
const os = require('os');
const fs = require('fs');

const DOCUMENTATION_BASE = 'https://the-open-engine.github.io/opcore/';
const DOCUMENTATION_ROUTE =
  /https:\/\/the-open-engine\.github\.io\/opcore\/(?:dev|v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))\//g;
const PUBLISH_ORDER_CHILD = 'OPCORE_STAGE_RELEASE_PUBLISH_ORDER_CHILD';
const NESTED_TEST_FIXTURE_VARIABLES = [
  'OPCORE_TEST_BINARY',
  'OPCORE_TEST_BUNDLE',
  'OPCORE_LIFECYCLE_TEST_GLIBC',
  'OPCORE_LIFECYCLE_FAIL_STATE',
];

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opcore-stage-release.'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.resolve(__dirname, '..');
  const packageRoot = path.join(root, 'opcore');
  fs.cpSync(source, packageRoot, { recursive: true });
  const readme = path.join(packageRoot, 'README.md');
  const content = fs.readFileSync(readme, 'utf8');
  fs.writeFileSync(readme, content.replace(DOCUMENTATION_ROUTE, `${DOCUMENTATION_BASE}dev/`));
  return { packageRoot, root };
}

function stage(packageRoot, root, version) {
  const archives = ['linux-x86_64', 'macos-arm64'].map((platform) => {
    const archive = path.join(root, `opcore-v${version}-${platform}.tar.gz`);
    fs.writeFileSync(archive, platform);
    return archive;
  });

  const result = spawnSync(
    process.execPath,
    [path.join(packageRoot, 'test/stage-release.js'), version, ...archives],
    { encoding: 'utf8' }
  );
  return result;
}

test('release staging binds development guidance to the package minor', (t) => {
  const { packageRoot, root } = fixture(t);
  const result = stage(packageRoot, root, '0.4.2');
  assert.equal(result.status, 0, result.stderr);
  const readme = fs.readFileSync(path.join(packageRoot, 'README.md'), 'utf8');
  assert.match(readme, /https:\/\/the-open-engine\.github\.io\/opcore\/v0\.4\/docs\/sense\.html/);
  assert.doesNotMatch(readme, /the-open-engine\.github\.io\/opcore\/dev\//);
  assert.doesNotMatch(readme, /the-open-engine\.github\.io\/opcore\/v0\.3\//);
});

test('release staging is idempotent only for the matching minor', (t) => {
  const { packageRoot, root } = fixture(t);
  assert.equal(stage(packageRoot, root, '0.3.0').status, 0);
  const repeated = stage(packageRoot, root, '0.3.0');
  assert.equal(repeated.status, 0, repeated.stderr);
  const mismatched = stage(packageRoot, root, '0.4.0');
  assert.notEqual(mismatched.status, 0);
  assert.match(mismatched.stderr, /different release documentation minor/);
});

test('release staging rejects a near-host documentation route', (t) => {
  const { packageRoot, root } = fixture(t);
  const readme = path.join(packageRoot, 'README.md');
  const content = `${fs.readFileSync(readme, 'utf8')}\n` +
    '[untrusted](https://the-open-engineXgithub.io/opcore/dev/docs/sense.html)\n';
  fs.writeFileSync(readme, content);
  const result = stage(packageRoot, root, '0.4.2');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unexpected documentation host/);
});

test('tag publication order can run the npm test suite after staging', (t) => {
  if (process.env[PUBLISH_ORDER_CHILD] === '1') {
    t.skip('publish-order child does not recurse');
    return;
  }
  const { packageRoot, root } = fixture(t);
  const version = '0.3.0';
  const staged = stage(packageRoot, root, version);
  assert.equal(staged.status, 0, staged.stderr);
  const versioned = spawnSync('npm', ['pkg', 'set', `version=${version}`], {
    cwd: packageRoot,
    encoding: 'utf8',
  });
  assert.equal(versioned.status, 0, versioned.stderr);
  const environment = { ...process.env, [PUBLISH_ORDER_CHILD]: '1' };
  for (const variable of NESTED_TEST_FIXTURE_VARIABLES) delete environment[variable];
  const tested = spawnSync('npm', ['test'], {
    cwd: packageRoot,
    encoding: 'utf8',
    env: environment,
    timeout: 120_000,
  });
  assert.equal(tested.status, 0, tested.stderr || tested.stdout);
});
