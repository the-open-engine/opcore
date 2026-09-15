#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const { extractBundle, isReleaseVersion } = require('../lib/install');

const archive = process.argv[2];
if (!archive) throw new Error('usage: node test/bundle-smoke.js ARCHIVE');
const name = path.basename(archive);
const match = /^opcore-v(.+)-(linux-x86_64|macos-arm64)\.tar\.gz$/.exec(name);
if (!match || !isReleaseVersion(match[1])) throw new Error(`invalid release archive name: ${name}`);
const root = `opcore-${match[2]}`;
const entries = extractBundle(fs.readFileSync(archive), root);
for (const required of [
  'bin/opcore',
  'install.sh',
  'asp/SOURCE.json',
  'docs/assets/opcore-hook-loop.svg',
  'docs/assets/opcore-hook-loop-mobile.svg',
  'docs/assets/asp-overview.svg',
  'docs/assets/asp-overview-mobile.svg',
]) {
  if (!entries.has(required)) throw new Error(`release archive is missing ${required}`);
}
process.stdout.write(`npm extractor accepted ${name} with ${entries.size} entries\n`);
