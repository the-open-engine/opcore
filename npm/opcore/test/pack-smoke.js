#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const packageRoot = path.resolve(__dirname, '..');
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
  process.stdout.write(`packed ${packed.filename} (${metadata.size} bytes)\n`);
} finally {
  fs.rmSync(destination, { recursive: true, force: true });
}
