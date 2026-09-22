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

const DOCUMENTATION_BASE = 'https://the-open-engine.github.io/opcore/';
const DOCUMENTATION_ROUTE =
  /https:\/\/the-open-engine\.github\.io\/opcore\/(dev|v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))\//g;
const DOCUMENTATION_HOST_PREFIX = 'https://the-open-engine.';
const DOCUMENTATION_PATH_MARKER = 'github.io/opcore/';

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

function validateDocumentationHosts(content) {
  let marker = content.indexOf(DOCUMENTATION_PATH_MARKER);
  while (marker !== -1) {
    const prefixStart = marker - DOCUMENTATION_HOST_PREFIX.length;
    if (
      prefixStart < 0 ||
      content.slice(prefixStart, marker) !== DOCUMENTATION_HOST_PREFIX
    ) {
      fail('README.md contains an unexpected documentation host');
    }
    marker = content.indexOf(DOCUMENTATION_PATH_MARKER, marker + DOCUMENTATION_PATH_MARKER.length);
  }
}

function rewriteDocumentationLinks(content, releaseRoute) {
  validateDocumentationHosts(content);
  const routes = [...content.matchAll(DOCUMENTATION_ROUTE)].map((route) => route[1]);
  if (routes.length === 0) fail('README.md has no recognized documentation links');
  if (routes.some((route) => route !== 'dev' && route !== releaseRoute)) {
    fail('README.md links to a different release documentation minor');
  }
  const hasDevelopment = routes.includes('dev');
  const hasRelease = routes.includes(releaseRoute);
  if (hasDevelopment && hasRelease) fail('README.md mixes development and release documentation');
  if (!hasDevelopment && !hasRelease) fail('README.md has no matching documentation links');
  return content.replaceAll(
    `${DOCUMENTATION_BASE}dev/`,
    `${DOCUMENTATION_BASE}${releaseRoute}/`
  );
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
  const releaseRoute = `v${match[1]}.${match[2]}`;
  const staged = rewriteDocumentationLinks(content, releaseRoute);
  if (staged === content) return;
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
