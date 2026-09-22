#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const packageRoot = path.resolve(__dirname, '..');
const packageVersion = JSON.parse(
  fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')
).version;
const releaseMatch = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\./.exec(packageVersion);
const docsVersion = packageVersion === '0.0.0-development'
  ? 'dev'
  : releaseMatch && `v${releaseMatch[1]}.${releaseMatch[2]}`;
if (!docsVersion) throw new Error(`package has no documentation route: ${packageVersion}`);
const docsBase = `https://the-open-engine.github.io/opcore/${docsVersion}`;
const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'opcore-pack.'));
try {
  const result = spawnSync(
    'npm',
    ['pack', '--ignore-scripts', '--json', '--pack-destination', destination],
    { cwd: packageRoot, encoding: 'utf8' }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `npm pack exited ${result.status}`);
  const report = JSON.parse(result.stdout);
  if (!Array.isArray(report) || report.length !== 1) throw new Error('npm pack report is malformed');
  const packed = report[0];
  const expected = [
    'LICENSE',
    'README.md',
    'bin/opcore.js',
    'install.js',
    'lib/cli.js',
    'lib/install.js',
    'lib/lock.js',
    'lib/setup.js',
    'lib/standalone.js',
    'package.json',
    'release-assets.json',
    'targets.json',
  ];
  const files = packed.files.map((entry) => entry.path).sort();
  if (JSON.stringify(files) !== JSON.stringify(expected)) {
    throw new Error(`unexpected npm package files: ${files.join(', ')}`);
  }
  const archive = path.join(destination, packed.filename);
  const metadata = fs.lstatSync(archive);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size === 0) {
    throw new Error('npm pack did not produce one regular archive');
  }
  const readmeResult = spawnSync('tar', ['-xOf', archive, 'package/README.md'], {
    encoding: 'utf8',
  });
  if (readmeResult.error) throw readmeResult.error;
  if (readmeResult.status !== 0) {
    throw new Error(readmeResult.stderr || `tar exited ${readmeResult.status}`);
  }
  const requiredGuidance = [
    'targets.exclude',
    'dedup_region_file_limit',
    'importantFanIn',
    'Deliberately not resolved',
    'documentationCoverage.evaluated',
    'not_read',
    'publicSurfaceAuthoritative',
    `${docsBase}/docs/configuration.html#select-targets`,
    `${docsBase}/docs/sense.html#dependency-envelope`,
  ];
  for (const guidance of requiredGuidance) {
    if (!readmeResult.stdout.includes(guidance)) {
      throw new Error(`packed README is missing required guidance: ${guidance}`);
    }
  }
  const route = /https:\/\/the-open-engine\.github\.io\/opcore\/(dev|v[0-9]+\.[0-9]+)\//g;
  for (const match of readmeResult.stdout.matchAll(route)) {
    if (match[1] !== docsVersion) {
      throw new Error(`packed README route ${match[1]} does not match ${packageVersion}`);
    }
  }
  process.stdout.write(`packed ${packed.filename} (${metadata.size} bytes)\n`);
} finally {
  fs.rmSync(destination, { recursive: true, force: true });
}
