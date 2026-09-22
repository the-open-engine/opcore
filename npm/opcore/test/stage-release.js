#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  ASSET_FILE,
  ASSET_SCHEMA,
  MAX_ARCHIVE_BYTES,
  expectedArchiveNames,
  isReleaseVersion,
} = require('../lib/install');

function fail(message) {
  throw new Error(`release asset staging failed: ${message}`);
}

function archiveDigest(filename) {
  const metadata = fs.lstatSync(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink()) fail(`${filename} is not a regular file`);
  if (metadata.size === 0 || metadata.size > MAX_ARCHIVE_BYTES) {
    fail(`${filename} has an invalid size`);
  }
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function stageDocumentationLinks(version) {
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\./.exec(version);
  if (!match) fail('release version has no documentation minor');
  const readme = path.resolve(__dirname, '..', 'README.md');
  const metadata = fs.lstatSync(readme);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 256 * 1024) {
    fail('README.md is not a bounded regular file');
  }
  const content = fs.readFileSync(readme, 'utf8');
  const base = 'https://the-open-engine.github.io/opcore';
  const development = `${base}/dev/`;
  const release = `${base}/v${match[1]}.${match[2]}/`;
  if (!content.includes(development)) fail('README.md has no development documentation links');
  if (new RegExp(`${base.replaceAll('.', '\\.')}/v[0-9]+\\.[0-9]+/`).test(content)) {
    fail('README.md hard-codes a release documentation minor');
  }
  const staged = content.replaceAll(development, release);
  const temporary = `${readme}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, staged, { flag: 'wx', mode: 0o600 });
    fs.chmodSync(temporary, metadata.mode & 0o777);
    fs.renameSync(temporary, readme);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function main(argv) {
  const [version, ...filenames] = argv;
  if (!isReleaseVersion(version) || version === '0.0.0-development') {
    fail('first argument must be a release semver');
  }
  const expected = [...expectedArchiveNames(version)].sort();
  if (filenames.length !== expected.length) fail(`expected ${expected.length} archives`);
  const supplied = new Map(filenames.map((filename) => [path.basename(filename), filename]));
  if (supplied.size !== expected.length || expected.some((name) => !supplied.has(name))) {
    fail('archive names do not match the release target matrix');
  }
  const archives = Object.fromEntries(
    expected.map((name) => [name, archiveDigest(supplied.get(name))])
  );
  stageDocumentationLinks(version);
  const value = { schema: ASSET_SCHEMA, version, archives };
  const destination = path.resolve(__dirname, '..', ASSET_FILE);
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, destination);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

main(process.argv.slice(2));
