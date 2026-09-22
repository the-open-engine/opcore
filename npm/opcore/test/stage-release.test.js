#!/usr/bin/env node
'use strict';

const test = require('node:test');
const { spawnSync } = require('child_process');
const path = require('path');
const assert = require('assert/strict');
const os = require('os');
const fs = require('fs');

test('release staging binds development guidance to the package minor', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opcore-stage-release.'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.resolve(__dirname, '..');
  const packageRoot = path.join(root, 'opcore');
  fs.cpSync(source, packageRoot, { recursive: true });
  const version = '0.4.2';
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
  assert.equal(result.status, 0, result.stderr);
  const readme = fs.readFileSync(path.join(packageRoot, 'README.md'), 'utf8');
  assert.match(readme, /https:\/\/the-open-engine\.github\.io\/opcore\/v0\.4\/docs\/sense\.html/);
  assert.doesNotMatch(readme, /the-open-engine\.github\.io\/opcore\/dev\//);
  assert.doesNotMatch(readme, /the-open-engine\.github\.io\/opcore\/v0\.3\//);
});
