'use strict';

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { TextDecoder } = require('util');
const { URL } = require('url');
const zlib = require('zlib');

const PACKAGE_NAME = '@the-open-engine-company/opcore';
const RELEASE_BASE_URL = 'https://github.com/the-open-engine/opcore/releases/download';
const STATE_SCHEMA = 'opcore.npm-install.v1';
const CLI_STATE_SCHEMA = 'opcore.npm-cli.v1';
const STATE_FILE = 'install-state.json';
const ASSET_SCHEMA = 'opcore.npm-assets.v1';
const ASSET_FILE = 'release-assets.json';
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 384 * 1024 * 1024;
const MAX_ENTRY_BYTES = 128 * 1024 * 1024;
const MAX_ENTRIES = 4096;
const MAX_RECEIPT_BYTES = 64 * 1024;
const MAX_UNINSTALLER_BYTES = 2 * 1024 * 1024;
const MAX_BINARY_BYTES = 128 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const INSTALLER_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const OWNER_ABSENT = Buffer.from('opcore.owner.absent.v1\n');
const MINIMUM_GLIBC = '2.39';

const TARGETS = Object.freeze(
  Object.fromEntries(
    require('../targets.json').map((entry) => [
      `${entry.platform}/${entry.arch}`,
      Object.freeze({ asset: entry.asset, bundleRoot: entry.bundleRoot }),
    ])
  )
);

const STATIC_FILES = new Set([
  'LICENSE',
  'README.md',
  'CONTRIBUTING.md',
  'docs/getting-started.md',
  'docs/configuration.md',
  'docs/providers.md',
  'docs/examples.md',
  'docs/sense.md',
  'docs/agent-signals.md',
  'docs/architecture.md',
  'docs/acceptance.md',
  'docs/design-review.md',
  'docs/assets/asp-overview-mobile.svg',
  'docs/assets/asp-overview.svg',
  'docs/assets/opcore-hook-loop-mobile.svg',
  'docs/assets/opcore-hook-loop.svg',
  'install.sh',
  'opcore.sha256',
  'bin/opcore',
  'skills/opcore/SKILL.md',
  'skills/opcore/agents/openai.yaml',
]);
const STATIC_DIRECTORIES = new Set([
  '',
  'asp',
  'bin',
  'docs',
  'docs/assets',
  'skills',
  'skills/opcore',
  'skills/opcore/agents',
]);
const RECEIPT_KEYS = new Set([
  'agent',
  'binary',
  'skill',
  'manifest',
  'native_manifest',
  'node_native_manifest',
  'python_native_manifest',
  'installer',
  'agent_root_path',
  'binary_path',
  'owners_path',
  'skill_path',
  'hooks',
  'descriptor',
]);
const RECEIPT_DIGEST_KEYS = [
  'binary',
  'skill',
  'manifest',
  'native_manifest',
  'node_native_manifest',
  'python_native_manifest',
  'installer',
  'agent_root_path',
  'binary_path',
  'skill_path',
];
const STATE_KEYS = [
  'schema',
  'version',
  'target',
  'agent',
  'agentRoot',
  'home',
  'skillRoot',
  'binaryPath',
  'receiptPath',
  'hookReceiptPath',
  'uninstallerPath',
  'archiveDigest',
  'binaryDigest',
  'uninstallerDigest',
  'receiptDigest',
  'hookReceiptDigest',
];
const STATE_PATH_KEYS = [
  'agentRoot',
  'home',
  'skillRoot',
  'binaryPath',
  'receiptPath',
  'hookReceiptPath',
  'uninstallerPath',
];
const STATE_DIGEST_KEYS = [
  'archiveDigest',
  'binaryDigest',
  'uninstallerDigest',
  'receiptDigest',
  'hookReceiptDigest',
];

function error(code, detail) {
  return new Error(`${code}: ${detail}`);
}

function isReleaseVersion(version) {
  if (typeof version !== 'string' || version.includes('+')) return false;
  const prereleaseStart = version.indexOf('-');
  const coreText = prereleaseStart === -1 ? version : version.slice(0, prereleaseStart);
  const prereleaseText = prereleaseStart === -1 ? null : version.slice(prereleaseStart + 1);
  const core = coreText.split('.');
  if (
    core.length !== 3 ||
    core.some((part) => !/^(0|[1-9][0-9]*)$/.test(part))
  ) {
    return false;
  }
  if (prereleaseText === null) return true;
  if (!prereleaseText) return false;
  const prerelease = prereleaseText.split('.');
  return prerelease.every(
    (part) =>
      /^[0-9A-Za-z-]+$/.test(part) &&
      (!/^[0-9]+$/.test(part) || /^(0|[1-9][0-9]*)$/.test(part))
  );
}

function selectTarget(platform = process.platform, arch = process.arch) {
  const host = `${platform}/${arch}`;
  const selected = TARGETS[host];
  if (!selected) {
    throw error(
      'UNSUPPORTED_OPCORE_HOST',
      `no release for ${host}; supported hosts: ${Object.keys(TARGETS).join(', ')}`
    );
  }
  return selected;
}

function requireHostCompatibility(platform = process.platform, runtimeHeader) {
  if (platform !== 'linux') return;
  const header = runtimeHeader || process.report.getReport().header;
  const version = header.glibcVersionRuntime;
  const parts = typeof version === 'string' && /^(\d+)\.(\d+)$/.exec(version);
  if (!parts || Number(parts[1]) < 2 || (Number(parts[1]) === 2 && Number(parts[2]) < 39)) {
    throw error(
      'UNSUPPORTED_OPCORE_LIBC',
      `Linux releases require glibc ${MINIMUM_GLIBC} or newer; detected ${version || 'a non-glibc runtime'}. ` +
      'Use the source installer on other Linux systems: ' +
      'https://github.com/the-open-engine/opcore/blob/main/docs/getting-started.md#source-checkout'
    );
  }
}

function archiveName(version, target) {
  if (!isReleaseVersion(version) || version === '0.0.0-development') {
    throw error('UNRELEASED_SHIM_VERSION', `cannot select assets for package version ${version}`);
  }
  return `opcore-v${version}-${target.asset}.tar.gz`;
}

function expectedArchiveNames(version) {
  return new Set(Object.values(TARGETS).map((target) => archiveName(version, target)));
}

function decodeUtf8(buffer, label) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (cause) {
    throw error('INVALID_UTF8', `${label} is not UTF-8: ${cause.message}`);
  }
}

function checksumLines(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (bytes.length === 0 || bytes.length > MAX_MANIFEST_BYTES) {
    throw error('CHECKSUM_MANIFEST_INVALID', `size must be 1..${MAX_MANIFEST_BYTES} bytes`);
  }
  const text = decodeUtf8(bytes, 'SHA256SUMS');
  if (!text.endsWith('\n') || text.includes('\r')) {
    throw error('CHECKSUM_MANIFEST_INVALID', 'SHA256SUMS must use LF lines and end with LF');
  }
  const lines = text.slice(0, -1).split('\n');
  if (lines.length === 0 || lines.length > TARGETS.length || lines.some((line) => line === '')) {
    throw error('CHECKSUM_MANIFEST_INVALID', 'SHA256SUMS has an invalid line count');
  }
  return lines;
}

function addChecksumLine(checksums, line) {
  const match = /^([0-9a-f]{64}) {2}([0-9A-Za-z._-]+)$/.exec(line);
  if (!match) throw error('CHECKSUM_MANIFEST_INVALID', `invalid line: ${line}`);
  if (checksums.has(match[2])) {
    throw error('CHECKSUM_MANIFEST_INVALID', `duplicate entry: ${match[2]}`);
  }
  checksums.set(match[2], match[1]);
}

function requireExpectedChecksums(checksums, expectedNames) {
  if (!expectedNames) return;
  if (checksums.size !== expectedNames.size) {
    throw error('CHECKSUM_MANIFEST_INVALID', 'SHA256SUMS does not contain the release matrix');
  }
  for (const name of expectedNames) {
    if (!checksums.has(name)) {
      throw error('CHECKSUM_MANIFEST_INVALID', `SHA256SUMS has no entry for ${name}`);
    }
  }
}

function parseChecksumManifest(input, expectedNames) {
  const checksums = new Map();
  for (const line of checksumLines(input)) addChecksumLine(checksums, line);
  requireExpectedChecksums(checksums, expectedNames);
  return checksums;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function verifyArchive(filename, archive, manifest, expectedNames) {
  const checksums = parseChecksumManifest(manifest, expectedNames);
  const expected = checksums.get(filename);
  if (!expected) throw error('CHECKSUM_MISSING', `SHA256SUMS has no entry for ${filename}`);
  const actual = sha256(archive);
  if (actual !== expected) {
    throw error('CHECKSUM_MISMATCH', `${filename} expected ${expected} but received ${actual}`);
  }
  return actual;
}

function releaseAssetBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function decodeReleaseAssets(bytes) {
  try {
    return JSON.parse(decodeUtf8(bytes, 'release asset binding'));
  } catch (cause) {
    throw error('RELEASE_ASSETS_INVALID', `cannot parse release asset binding: ${cause.message}`);
  }
}

function requireReleaseAssetIdentity(bytes, value, version) {
  const topLevel = value && !Array.isArray(value) ? Object.keys(value) : [];
  if (topLevel.join(',') !== 'schema,version,archives' || !bytes.equals(releaseAssetBytes(value))) {
    throw error('RELEASE_ASSETS_INVALID', 'release asset binding is not canonical');
  }
  if (value.schema !== ASSET_SCHEMA || value.version !== version) {
    throw error('RELEASE_ASSETS_INVALID', 'release asset binding has the wrong identity');
  }
}

function releaseArchiveMap(value, version) {
  const archives = value.archives;
  if (!archives || Array.isArray(archives) || typeof archives !== 'object') {
    throw error('RELEASE_ASSETS_INVALID', 'release asset binding has no archive map');
  }
  const names = [...expectedArchiveNames(version)].sort();
  if (Object.keys(archives).join(',') !== names.join(',')) {
    throw error('RELEASE_ASSETS_INVALID', 'release asset binding does not match the target matrix');
  }
  for (const name of names) {
    if (!/^[0-9a-f]{64}$/.test(archives[name])) {
      throw error('RELEASE_ASSETS_INVALID', `release asset binding has no digest for ${name}`);
    }
  }
  return new Map(names.map((name) => [name, archives[name]]));
}

function parseReleaseAssets(input, version) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (bytes.length === 0 || bytes.length > MAX_MANIFEST_BYTES) {
    throw error('RELEASE_ASSETS_INVALID', 'release asset binding has an invalid size');
  }
  const value = decodeReleaseAssets(bytes);
  requireReleaseAssetIdentity(bytes, value, version);
  return releaseArchiveMap(value, version);
}

function requireBoundChecksums(checksums, boundChecksums) {
  for (const [name, digest] of boundChecksums) {
    if (checksums.get(name) !== digest) {
      throw error('RELEASE_ASSET_MISMATCH', `SHA256SUMS differs from the npm binding for ${name}`);
    }
  }
}

function verifyBoundArchive(filename, archive, manifest, expectedNames, boundChecksums) {
  const checksums = parseChecksumManifest(manifest, expectedNames);
  requireBoundChecksums(checksums, boundChecksums);
  const expected = checksums.get(filename);
  const actual = sha256(archive);
  if (actual !== expected) {
    throw error('CHECKSUM_MISMATCH', `${filename} expected ${expected} but received ${actual}`);
  }
  return actual;
}

function validateDownloadUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    throw error('DOWNLOAD_FAILED', `unsafe release URL ${rawUrl}`);
  }
  return parsed;
}

function followRedirect(response, context) {
  const status = response.statusCode || 0;
  if (status < 300 || status >= 400 || !response.headers.location) return false;
  response.resume();
  if (context.redirects >= 5) {
    context.finish(
      context.reject,
      error('DOWNLOAD_FAILED', `too many redirects for ${context.rawUrl}`)
    );
    return true;
  }
  try {
    const next = validateDownloadUrl(
      new URL(response.headers.location, context.parsed).toString()
    );
    download(
      next.toString(),
      context.maximumBytes,
      context.redirects + 1,
      context.client
    ).then(
      (value) => context.finish(context.resolve, value),
      (cause) => context.finish(context.reject, cause)
    );
  } catch (cause) {
    context.finish(context.reject, cause);
  }
  return true;
}

function contentLengthIsInvalid(declared, maximumBytes) {
  if (declared === undefined) return false;
  return !/^[0-9]+$/.test(String(declared)) || Number(declared) > maximumBytes;
}

function collectDownload(response, context) {
  const chunks = [];
  let length = 0;
  response.on('data', (chunk) => {
    length += chunk.length;
    if (length > context.maximumBytes) {
      context.destroyRequest(
        error('DOWNLOAD_FAILED', `${context.rawUrl} exceeds ${context.maximumBytes} bytes`)
      );
      return;
    }
    chunks.push(chunk);
  });
  response.on('aborted', () =>
    context.finish(
      context.reject,
      error('DOWNLOAD_FAILED', `${context.rawUrl} response was aborted`)
    )
  );
  response.on('error', (cause) => context.finish(context.reject, cause));
  response.on('end', () => context.finish(context.resolve, Buffer.concat(chunks, length)));
}

function receiveDownload(response, context) {
  if (followRedirect(response, context)) return;
  const status = response.statusCode || 0;
  if (status !== 200) {
    response.resume();
    context.finish(
      context.reject,
      error('DOWNLOAD_FAILED', `${context.rawUrl} returned HTTP ${status}`)
    );
    return;
  }
  if (contentLengthIsInvalid(response.headers['content-length'], context.maximumBytes)) {
    response.resume();
    context.finish(
      context.reject,
      error('DOWNLOAD_FAILED', `${context.rawUrl} exceeds ${context.maximumBytes} bytes`)
    );
    return;
  }
  collectDownload(response, context);
}

function download(rawUrl, maximumBytes, redirects = 0, client = https) {
  let parsed;
  try {
    parsed = validateDownloadUrl(rawUrl);
  } catch (cause) {
    return Promise.reject(cause);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    let request;
    request = client.get(
      parsed,
      { headers: { 'user-agent': PACKAGE_NAME, accept: 'application/octet-stream' } },
      (response) =>
        receiveDownload(response, {
          client,
          destroyRequest: (cause) => request.destroy(cause),
          finish,
          maximumBytes,
          parsed,
          rawUrl,
          redirects,
          reject,
          resolve,
        })
    );
    request.setTimeout(DOWNLOAD_TIMEOUT_MS, () =>
      request.destroy(error('DOWNLOAD_FAILED', `${rawUrl} timed out`))
    );
    request.on('error', (cause) => finish(reject, cause));
  });
}

function readTarString(field, label) {
  const zero = field.indexOf(0);
  const used = zero === -1 ? field : field.subarray(0, zero);
  if (zero !== -1 && !field.subarray(zero).every((byte) => byte === 0)) {
    throw error('ARCHIVE_INVALID', `${label} has bytes after NUL`);
  }
  return decodeUtf8(used, label);
}

function parseTarOctal(field, label) {
  const value = field.toString('ascii').replace(/\0.*$/, '').trim();
  if (!/^[0-7]+$/.test(value)) throw error('ARCHIVE_INVALID', `invalid ${label}`);
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed)) throw error('ARCHIVE_INVALID', `${label} is too large`);
  return parsed;
}

function verifyTarHeader(header) {
  const expected = parseTarOctal(header.subarray(148, 156), 'tar header checksum');
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 32 : header[index];
  }
  if (actual !== expected) throw error('ARCHIVE_INVALID', 'tar header checksum mismatch');
  if (!header.subarray(257, 263).equals(Buffer.from('ustar\0'))) {
    throw error('ARCHIVE_INVALID', 'archive is not POSIX ustar');
  }
  if (!header.subarray(263, 265).equals(Buffer.from('00'))) {
    throw error('ARCHIVE_INVALID', 'unsupported ustar version');
  }
}

function validateMemberPath(member, expectedRoot) {
  if (
    !member ||
    member.startsWith('/') ||
    member.endsWith('/') ||
    member.includes('\\') ||
    member.includes('//')
  ) {
    throw error('ARCHIVE_INVALID', `unsafe archive member ${member}`);
  }
  const parts = member.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw error('ARCHIVE_INVALID', `unsafe archive member ${member}`);
  }
  if (parts[0] !== expectedRoot) {
    throw error('ARCHIVE_INVALID', `archive member is outside ${expectedRoot}: ${member}`);
  }
  return parts.slice(1).join('/');
}

function allowedDirectory(relative) {
  return STATIC_DIRECTORIES.has(relative) || relative.startsWith('asp/');
}

function allowedFile(relative) {
  return STATIC_FILES.has(relative) || relative.startsWith('asp/');
}

function decompressArchive(archive, maximumExpandedBytes) {
  try {
    return zlib.gunzipSync(archive, { maxOutputLength: maximumExpandedBytes });
  } catch (cause) {
    throw error('ARCHIVE_INVALID', `cannot decompress release archive: ${cause.message}`);
  }
}

function isTarTrailer(tar, offset, header) {
  if (!header.every((byte) => byte === 0)) return false;
  if (offset + 1024 > tar.length || !tar.subarray(offset).every((byte) => byte === 0)) {
    throw error('ARCHIVE_INVALID', 'tar trailer is malformed');
  }
  return true;
}

function tarEntryIsDirectory(header, member, size) {
  const type = header[156];
  const directory = type === 53;
  const regular = type === 0 || type === 48;
  if (!directory && !regular) {
    throw error('ARCHIVE_INVALID', `unsupported tar entry type for ${member}`);
  }
  if (directory && size !== 0) {
    throw error('ARCHIVE_INVALID', `directory ${member} has content`);
  }
  if (directory !== member.endsWith('/')) {
    throw error('ARCHIVE_INVALID', `tar entry type and name disagree for ${member}`);
  }
  return directory;
}

function readBundleEntry(tar, offset, expectedRoot) {
  const header = tar.subarray(offset, offset + 512);
  verifyTarHeader(header);
  const name = readTarString(header.subarray(0, 100), 'tar member name');
  const prefix = readTarString(header.subarray(345, 500), 'tar member prefix');
  const member = prefix ? `${prefix}/${name}` : name;
  const relative = validateMemberPath(member.replace(/\/$/, ''), expectedRoot);
  const size = parseTarOctal(header.subarray(124, 136), 'tar entry size');
  if (size > MAX_ENTRY_BYTES) {
    throw error('ARCHIVE_INVALID', `${member} exceeds ${MAX_ENTRY_BYTES} bytes`);
  }
  const directory = tarEntryIsDirectory(header, member, size);
  const link = readTarString(header.subarray(157, 257), 'tar link name');
  if (link) throw error('ARCHIVE_INVALID', `archive link is forbidden: ${member}`);
  const allowed = directory ? allowedDirectory(relative) : allowedFile(relative);
  if (!allowed) throw error('ARCHIVE_INVALID', `unexpected archive entry ${member}`);
  const start = offset + 512;
  const end = start + size;
  if (end > tar.length) throw error('ARCHIVE_INVALID', `truncated tar entry ${member}`);
  return {
    member,
    relative,
    entry: { directory, bytes: directory ? null : Buffer.from(tar.subarray(start, end)) },
    nextOffset: start + Math.ceil(size / 512) * 512,
  };
}

function requireStaticBundleFiles(entries) {
  for (const required of STATIC_FILES) {
    const entry = entries.get(required);
    if (!entry || entry.directory) {
      throw error('ARCHIVE_INVALID', `archive is missing ${required}`);
    }
  }
}

function requireAspDefinition(entries) {
  const hasDefinition = [...entries].some(
    ([name, entry]) => name.startsWith('asp/') && !entry.directory
  );
  if (!hasDefinition) throw error('ARCHIVE_INVALID', 'archive has no ASP definition files');
}

function requireDirectoryEntries(entries) {
  for (const relative of entries.keys()) {
    if (!relative) continue;
    const parts = relative.split('/');
    for (let length = 1; length < parts.length; length += 1) {
      const parent = parts.slice(0, length).join('/');
      const entry = entries.get(parent);
      if (!entry || !entry.directory) {
        throw error('ARCHIVE_INVALID', `archive omits directory entry ${parent}`);
      }
    }
  }
}

function extractBundle(archive, expectedRoot, maximumExpandedBytes = MAX_EXPANDED_BYTES) {
  const tar = decompressArchive(archive, maximumExpandedBytes);
  const entries = new Map();
  let offset = 0;
  let ended = false;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (isTarTrailer(tar, offset, header)) {
      ended = true;
      break;
    }
    if (entries.size >= MAX_ENTRIES) {
      throw error('ARCHIVE_INVALID', `archive exceeds ${MAX_ENTRIES} entries`);
    }
    const parsed = readBundleEntry(tar, offset, expectedRoot);
    if (entries.has(parsed.relative)) {
      throw error('ARCHIVE_INVALID', `duplicate archive entry ${parsed.member}`);
    }
    entries.set(parsed.relative, parsed.entry);
    offset = parsed.nextOffset;
  }
  if (!ended) throw error('ARCHIVE_INVALID', 'archive has no complete tar trailer');
  requireStaticBundleFiles(entries);
  requireAspDefinition(entries);
  requireDirectoryEntries(entries);
  verifyInnerBinaryChecksum(entries);
  return entries;
}

function verifyInnerBinaryChecksum(entries) {
  const checksum = decodeUtf8(entries.get('opcore.sha256').bytes, 'inner checksum');
  const match = /^([0-9a-f]{64}) {2}bin\/opcore\n$/.exec(checksum);
  if (!match) throw error('ARCHIVE_INVALID', 'inner binary checksum is malformed');
  const actual = sha256(entries.get('bin/opcore').bytes);
  if (actual !== match[1]) throw error('ARCHIVE_INVALID', 'inner binary checksum does not match');
}

function materializeBundle(entries, destination) {
  fs.mkdirSync(destination, { recursive: false, mode: 0o700 });
  const directories = [...entries]
    .filter(([, entry]) => entry.directory)
    .map(([name]) => name)
    .filter(Boolean)
    .sort((left, right) => left.split('/').length - right.split('/').length || left.localeCompare(right));
  for (const relative of directories) {
    fs.mkdirSync(path.join(destination, ...relative.split('/')), { mode: 0o755 });
  }
  const files = [...entries]
    .filter(([, entry]) => !entry.directory)
    .sort(([left], [right]) => left.localeCompare(right));
  for (const [relative, entry] of files) {
    const target = path.join(destination, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    const mode = relative === 'install.sh' || relative === 'bin/opcore' ? 0o755 : 0o644;
    fs.writeFileSync(target, entry.bytes, { flag: 'wx', mode });
  }
}

function resolveDirectoryPath(normalized, label) {
  const missing = [];
  let candidate = normalized;
  while (true) {
    try {
      const metadata = fs.statSync(candidate);
      if (!metadata.isDirectory()) {
        throw error('INSTALL_CONTEXT_INVALID', `${label} must be a directory`);
      }
      return path.join(fs.realpathSync.native(candidate), ...missing.reverse());
    } catch (cause) {
      if (cause.message.startsWith('INSTALL_CONTEXT_INVALID:')) throw cause;
      if (cause.code !== 'ENOENT') {
        throw error('INSTALL_CONTEXT_INVALID', `cannot resolve ${label}: ${cause.message}`);
      }
      const parent = path.dirname(candidate);
      if (parent === candidate) {
        throw error('INSTALL_CONTEXT_INVALID', `cannot resolve ${label}`);
      }
      missing.push(path.basename(candidate));
      candidate = parent;
    }
  }
}

function absoluteEnvironmentPath(value, label) {
  if (!path.isAbsolute(value)) throw error('INSTALL_CONTEXT_INVALID', `${label} must be absolute`);
  return resolveDirectoryPath(path.normalize(value), label);
}

function chooseAgents(environment, home) {
  const requested = environment.OPCORE_AGENT;
  if (requested && requested !== 'codex' && requested !== 'claude') {
    throw error('INSTALL_CONTEXT_INVALID', 'OPCORE_AGENT must be codex or claude');
  }
  if (requested) return [requested];
  const found = ['codex', 'claude'].filter((agent) => {
    const configured = agent === 'codex' ? environment.CODEX_HOME : environment.CLAUDE_CONFIG_DIR;
    return Boolean(configured) ||
      fs.statSync(path.join(home, `.${agent}`), { throwIfNoEntry: false })?.isDirectory();
  });
  if (found.length) return found;
  throw error(
    'INSTALL_CONTEXT_INVALID',
    'no supported agent detected; set OPCORE_AGENT=codex or OPCORE_AGENT=claude, ' +
      'or set OPCORE_NO_HOOKS=1 for an explicit CLI-only installation'
  );
}

function codexContext(environment, home) {
  const agentRoot = absoluteEnvironmentPath(
    environment.CODEX_HOME || path.join(home, '.codex'),
    'CODEX_HOME'
  );
  const skillRoot = absoluteEnvironmentPath(
    environment.OPCORE_SKILL_DIR || path.join(home, '.agents', 'skills'),
    'OPCORE_SKILL_DIR'
  );
  return { agent: 'codex', agentRoot, home, skillRoot };
}

function claudeContext(environment, home) {
  const agentRoot = absoluteEnvironmentPath(
    environment.CLAUDE_CONFIG_DIR || path.join(home, '.claude'),
    'CLAUDE_CONFIG_DIR'
  );
  return { agent: 'claude', agentRoot, home, skillRoot: path.join(agentRoot, 'skills') };
}

function selectAgents(environment = process.env) {
  const rawHome = environment.HOME;
  if (!rawHome || !path.isAbsolute(rawHome)) {
    throw error('INSTALL_CONTEXT_INVALID', 'HOME must be an absolute path');
  }
  const home = absoluteEnvironmentPath(rawHome, 'HOME');
  return chooseAgents(environment, home).map((agent) =>
    agent === 'codex' ? codexContext(environment, home) : claudeContext(environment, home)
  );
}

function selectAgent(environment = process.env) {
  const contexts = selectAgents(environment);
  if (contexts.length !== 1) {
    throw error('INSTALL_CONTEXT_INVALID', 'multiple agents selected; use selectAgents');
  }
  return contexts[0];
}

function installerEnvironment(environment = process.env, overrides = {}) {
  const clean = { PATH: INSTALLER_PATH };
  for (const key of ['HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'OPCORE_SKILL_DIR']) {
    if (typeof environment[key] === 'string' && environment[key] !== '') {
      clean[key] = environment[key];
    }
  }
  return { ...clean, ...overrides };
}

function boundAgentEnvironment({ agent, agentRoot, home, skillRoot }) {
  if (agent === 'codex') {
    return { HOME: home, CODEX_HOME: agentRoot, OPCORE_SKILL_DIR: skillRoot };
  }
  return { HOME: home, CLAUDE_CONFIG_DIR: agentRoot };
}

function installerAgentArgs(agent, contexts, enrollHooks) {
  return [...(contexts ? [] : ['--agent', agent]), ...(enrollHooks ? [] : ['--no-hooks'])];
}

function runBundleInstaller({
  bundleRoot,
  agent,
  agentRoot,
  home,
  skillRoot,
  contexts,
  enrollHooks = true,
  binDir,
  environment = process.env,
}) {
  const result = spawnSync(
    '/bin/bash',
    [path.join(bundleRoot, 'install.sh'),
      ...installerAgentArgs(agent, contexts, enrollHooks), '--bin-dir', binDir],
    {
      cwd: bundleRoot,
      env: installerEnvironment(
        environment,
        { ...(contexts ? {} : boundAgentEnvironment({ agent, agentRoot, home, skillRoot })),
          OPCORE_NPM_WRAPPER: '1' }
      ),
      stdio: 'inherit',
    }
  );
  if (result.error) throw error('BUNDLE_INSTALL_FAILED', result.error.message);
  if (result.signal) throw error('BUNDLE_INSTALL_FAILED', `installer received ${result.signal}`);
  if (result.status !== 0) {
    throw error('BUNDLE_INSTALL_FAILED', `installer exited with status ${result.status}`);
  }
}

function readRegularFile(filename, maximumBytes, label) {
  let descriptor;
  try {
    descriptor = fs.openSync(
      filename,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_CLOEXEC
    );
    const metadata = fs.fstatSync(descriptor);
    if (!metadata.isFile()) {
      throw error('INSTALLED_STATE_INVALID', `${label} is not a regular file`);
    }
    if (metadata.size > maximumBytes) {
      throw error('INSTALLED_STATE_INVALID', `${label} exceeds ${maximumBytes} bytes`);
    }
    return fs.readFileSync(descriptor);
  } catch (cause) {
    if (cause.message.startsWith('INSTALLED_STATE_INVALID:')) throw cause;
    throw error('INSTALLED_STATE_INVALID', `cannot read ${label}: ${cause.message}`);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function parseReceiptEntries(lines) {
  const values = new Map();
  for (const line of lines) {
    const match = /^([a-z_]+) ([^ ]+)$/.exec(line);
    if (!match || !RECEIPT_KEYS.has(match[1]) || values.has(match[1])) {
      throw error('INSTALLED_STATE_INVALID', 'install receipt contains an invalid entry');
    }
    values.set(match[1], match[2]);
  }
  return values;
}

function requireReceiptDigests(values) {
  for (const key of RECEIPT_DIGEST_KEYS) {
    if (!/^[0-9a-f]{64}$/.test(values.get(key) || '')) {
      throw error('INSTALLED_STATE_INVALID', `install receipt has no valid ${key}`);
    }
  }
}

function requireReceiptOwnership(schema, values) {
  if (schema === 'opcore.install.v5') {
    if (values.has('agent') || values.has('owners_path')) {
      throw error('INSTALLED_STATE_INVALID', 'version 5 receipt contains shared ownership');
    }
    return;
  }
  const agentIsValid = ['codex', 'claude'].includes(values.get('agent'));
  const ownersPathIsValid = /^[0-9a-f]{64}$/.test(values.get('owners_path') || '');
  if (!agentIsValid || !ownersPathIsValid) {
    throw error('INSTALLED_STATE_INVALID', 'version 6 receipt has invalid shared ownership');
  }
}

function parseInstallReceipt(bytes) {
  const text = decodeUtf8(bytes, 'install receipt');
  if (!text.endsWith('\n') || text.includes('\r')) {
    throw error('INSTALLED_STATE_INVALID', 'install receipt has invalid line endings');
  }
  const lines = text.slice(0, -1).split('\n');
  const schema = lines.shift();
  if (!['opcore.install.v5', 'opcore.install.v6'].includes(schema)) {
    throw error('INSTALLED_STATE_INVALID', 'install receipt has an unsupported version');
  }
  const values = parseReceiptEntries(lines);
  requireReceiptDigests(values);
  if (!['yes', 'no', 'pending'].includes(values.get('hooks'))) {
    throw error('INSTALLED_STATE_INVALID', 'invalid hook enrollment state');
  }
  requireReceiptOwnership(schema, values);
  values.set('receipt_schema', schema);
  return values;
}

function installedHookReceipt(hookReceiptPath, receipt) {
  const hookReceiptBytes = fs.lstatSync(hookReceiptPath, { throwIfNoEntry: false })
    ? readRegularFile(hookReceiptPath, MAX_RECEIPT_BYTES, 'hook receipt') : null;
  if (receipt.get('hooks') === 'yes' && !hookReceiptBytes) {
    throw error('INSTALLED_STATE_INVALID', 'default hook enrollment did not complete');
  }
  if (receipt.get('hooks') === 'no' && hookReceiptBytes) {
    throw error('INSTALLED_STATE_INVALID', 'unexpected hook receipt');
  }
  return hookReceiptBytes;
}

function requireInstalledReceipt(receipt, identity) {
  if (receipt.get('binary') !== identity.binaryDigest ||
      receipt.get('installer') !== identity.uninstallerDigest) {
    throw error('INSTALLED_STATE_INVALID', 'installed files do not match the install receipt');
  }
  const skillPath = path.join(identity.skillRoot, 'opcore', 'SKILL.md');
  if (receipt.get('binary_path') !== sha256(Buffer.from(identity.binaryPath)) ||
      receipt.get('agent_root_path') !== sha256(Buffer.from(identity.agentRoot)) ||
      receipt.get('skill_path') !== sha256(Buffer.from(skillPath))) {
    throw error('INSTALLED_STATE_INVALID', 'install receipt paths do not match npm state');
  }
  if (receipt.get('receipt_schema') === 'opcore.install.v6' &&
      receipt.get('agent') !== identity.agent) {
    throw error('INSTALLED_STATE_INVALID', 'install receipt agent does not match npm state');
  }
}

function installedState({
  packageRoot,
  version,
  target,
  agent,
  agentRoot,
  home,
  skillRoot,
  archiveDigest,
  expectedBinaryDigest,
}) {
  const binaryPath = path.join(packageRoot, 'native', 'opcore');
  const receiptPath = path.join(agentRoot, 'opcore', 'install.receipt');
  const hookReceiptPath = path.join(agentRoot, 'opcore', 'hook-install.json');
  const uninstallerPath = path.join(agentRoot, 'opcore', 'uninstall.sh');
  const receiptBytes = readRegularFile(receiptPath, MAX_RECEIPT_BYTES, 'install receipt');
  const receipt = parseInstallReceipt(receiptBytes);
  const binaryBytes = readRegularFile(binaryPath, MAX_BINARY_BYTES, 'installed binary');
  const uninstallerBytes = readRegularFile(
    uninstallerPath,
    MAX_UNINSTALLER_BYTES,
    'installed uninstaller'
  );
  const hookReceiptBytes = installedHookReceipt(hookReceiptPath, receipt);
  const binaryDigest = sha256(binaryBytes);
  const uninstallerDigest = sha256(uninstallerBytes);
  if (expectedBinaryDigest && binaryDigest !== expectedBinaryDigest) {
    throw error('INSTALLED_STATE_INVALID', 'installed binary does not match the verified archive');
  }
  requireInstalledReceipt(receipt, {
    agent, agentRoot, binaryDigest, binaryPath, skillRoot, uninstallerDigest,
  });
  return {
    schema: STATE_SCHEMA,
    version,
    target: target.asset,
    agent,
    agentRoot,
    home,
    skillRoot,
    binaryPath,
    receiptPath,
    hookReceiptPath,
    uninstallerPath,
    archiveDigest,
    binaryDigest,
    uninstallerDigest,
    receiptDigest: sha256(receiptBytes),
    hookReceiptDigest: hookReceiptBytes ? sha256(hookReceiptBytes) : null,
  };
}

function stateBytes(state) {
  return Buffer.from(`${JSON.stringify(state, null, 2)}\n`);
}

function writeState(packageRoot, state) {
  const destination = path.join(packageRoot, STATE_FILE);
  if (fs.existsSync(destination)) {
    const metadata = fs.lstatSync(destination);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw error('INSTALLED_STATE_INVALID', 'npm state destination is not a regular file');
    }
  }
  const temporary = path.join(packageRoot, `.${STATE_FILE}.${process.pid}.${crypto.randomBytes(8).toString('hex')}`);
  try {
    fs.writeFileSync(temporary, stateBytes(state), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, destination);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function parseStateBytes(bytes) {
  let state;
  try {
    state = JSON.parse(decodeUtf8(bytes, 'npm install state'));
  } catch (cause) {
    throw error('INSTALLED_STATE_INVALID', `cannot parse npm install state: ${cause.message}`);
  }
  if (!state || Array.isArray(state) || typeof state !== 'object') {
    throw error('INSTALLED_STATE_INVALID', 'npm install state is not an object');
  }
  return state;
}

function requireCanonicalState(bytes, state) {
  if (
    Object.keys(state).length !== STATE_KEYS.length ||
    STATE_KEYS.some((key) => !Object.prototype.hasOwnProperty.call(state, key)) ||
    !bytes.equals(stateBytes(state))
  ) {
    throw error('INSTALLED_STATE_INVALID', 'npm install state is not canonical');
  }
}

function requireStateIdentity(state) {
  if (
    state.schema !== STATE_SCHEMA ||
    !isReleaseVersion(state.version) ||
    state.version === '0.0.0-development' ||
    !Object.values(TARGETS).some((target) => target.asset === state.target) ||
    !['codex', 'claude'].includes(state.agent)
  ) {
    throw error('INSTALLED_STATE_INVALID', 'npm install state identity is invalid');
  }
}

function requireStatePaths(state) {
  for (const key of STATE_PATH_KEYS) {
    if (typeof state[key] !== 'string' || !path.isAbsolute(state[key]) || path.normalize(state[key]) !== state[key]) {
      throw error('INSTALLED_STATE_INVALID', `npm install state ${key} is invalid`);
    }
  }
}

function requireStateDigests(state) {
  for (const key of STATE_DIGEST_KEYS) {
    if (key === 'hookReceiptDigest' && state[key] === null) continue;
    if (!/^[0-9a-f]{64}$/.test(state[key])) {
      throw error('INSTALLED_STATE_INVALID', `npm install state ${key} is invalid`);
    }
  }
}

function requireStateRelationships(packageRoot, state) {
  if (state.binaryPath !== path.join(packageRoot, 'native', 'opcore')) {
    throw error('INSTALLED_STATE_INVALID', 'npm binary path moved');
  }
  if (
    state.receiptPath !== path.join(state.agentRoot, 'opcore', 'install.receipt') ||
    state.hookReceiptPath !== path.join(state.agentRoot, 'opcore', 'hook-install.json') ||
    state.uninstallerPath !== path.join(state.agentRoot, 'opcore', 'uninstall.sh')
  ) {
    throw error('INSTALLED_STATE_INVALID', 'npm receipt paths are inconsistent');
  }
  const expectedSkillRoot =
    state.agent === 'codex' ? state.skillRoot : path.join(state.agentRoot, 'skills');
  if (state.skillRoot !== expectedSkillRoot) {
    throw error('INSTALLED_STATE_INVALID', 'npm skill path is inconsistent');
  }
}

function readState(packageRoot) {
  const filename = path.join(packageRoot, STATE_FILE);
  const bytes = readRegularFile(filename, MAX_RECEIPT_BYTES, 'npm install state');
  const state = parseStateBytes(bytes);
  if (!bytes.equals(stateBytes(state))) {
    throw error('INSTALLED_STATE_INVALID', 'npm install state is not canonical');
  }
  if (state.schema === CLI_STATE_SCHEMA) {
    validateCliState(packageRoot, state);
    return state;
  }
  const entries = stateEntries(state);
  for (const entry of entries) validateStateEntry(packageRoot, entry);
  if (new Set(entries.map((entry) => entry.agent)).size !== entries.length) {
    throw error('INSTALLED_STATE_INVALID', 'duplicate agent ownership');
  }
  if (new Set(entries.map((entry) => entry.agentRoot)).size !== entries.length ||
      new Set(entries.map((entry) => entry.skillRoot)).size !== entries.length) {
    throw error('INSTALLED_STATE_INVALID', 'overlapping agent destinations');
  }
  for (const entry of entries) {
    for (const key of ['binaryPath', 'binaryDigest', 'home', 'version', 'target', 'archiveDigest']) {
      if (entry[key] !== entries[0][key]) {
        throw error('INSTALLED_STATE_INVALID', 'shared npm installation identities disagree');
      }
    }
  }
  return state;
}

function validateCliState(packageRoot, state) {
  const keys = ['schema', 'version', 'target', 'binaryPath', 'archiveDigest', 'binaryDigest'];
  if (Object.keys(state).join(',') !== keys.join(',') ||
      !isReleaseVersion(state.version) || state.version === '0.0.0-development' ||
      !Object.values(TARGETS).some((target) => target.asset === state.target) ||
      state.binaryPath !== path.join(packageRoot, 'native', 'opcore') ||
      !/^[0-9a-f]{64}$/.test(state.archiveDigest) || !/^[0-9a-f]{64}$/.test(state.binaryDigest)) {
    throw error('INSTALLED_STATE_INVALID', 'CLI-only install state is invalid');
  }
}

function stateEntries(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw error('INSTALLED_STATE_INVALID', 'invalid installation entry');
  }
  if (state.schema !== 'opcore.npm-install.v2') return [state];
  if (Object.keys(state).join(',') !== 'schema,installations' ||
      !Array.isArray(state.installations) || !state.installations.length || state.installations.length > 2) {
    throw error('INSTALLED_STATE_INVALID', 'invalid multi-agent npm state');
  }
  return state.installations;
}

function validateStateEntry(packageRoot, state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw error('INSTALLED_STATE_INVALID', 'invalid installation entry');
  }
  requireCanonicalState(stateBytes(state), state);
  requireStateIdentity(state);
  requireStatePaths(state);
  requireStateDigests(state);
  requireStateRelationships(packageRoot, state);
}

function combinedState(entries) {
  return entries.length === 1 ? entries[0] : {
    schema: 'opcore.npm-install.v2', installations: entries,
  };
}

function captureInstallStates(context, contexts) {
  return contexts.map((agentContext) => installedState({ ...context, ...agentContext }));
}

function registryAgents(registry) {
  let metadata;
  try { metadata = fs.lstatSync(registry); } catch (cause) {
    if (cause.code === 'ENOENT') return [];
    throw cause;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw error('INSTALLED_STATE_INVALID', 'unsafe shared ownership directory');
  }
  const agents = [];
  const directory = fs.opendirSync(registry);
  try {
    let entry;
    while ((entry = directory.readSync()) !== null) {
      if (!['codex', 'claude'].includes(entry.name) || !entry.isFile() || agents.length === 2) {
        throw error('INSTALLED_STATE_INVALID', 'ambiguous shared ownership entry');
      }
      agents.push(entry.name);
    }
  } finally { directory.closeSync(); }
  if (agents.sort().join(',') !== 'claude,codex') {
    throw error('INSTALLED_STATE_INVALID', 'shared ownership slot is missing');
  }
  return agents.filter((agent) => {
    const bytes = readRegularFile(path.join(registry, agent), 16384, 'shared owner');
    return !bytes.equals(OWNER_ABSENT);
  });
}

function registeredContexts(packageRoot, home) {
  const binaryPath = path.join(packageRoot, 'native', 'opcore');
  const base = absoluteEnvironmentPath(path.join(home, '.local', 'share', 'opcore', 'owners'), 'owners');
  const registry = path.join(base, sha256(Buffer.from(binaryPath)));
  return registryAgents(registry).map((agent) =>
    registeredContext({ agent, binaryPath, home, registry })
  );
}

function registeredOwnerRoots(bytes) {
  const lines = decodeUtf8(bytes, 'shared owner').split('\n');
  if (lines.length !== 3 || lines[2] !== '' || bytes.includes(0)) {
    throw error('INSTALLED_STATE_INVALID', 'invalid shared ownership record');
  }
  const agentRoot = absoluteEnvironmentPath(lines[0], 'registered agent root');
  const skillRoot = absoluteEnvironmentPath(lines[1], 'registered skill root');
  const runtime = path.join(agentRoot, 'opcore');
  if (agentRoot !== lines[0] || skillRoot !== lines[1] || fs.lstatSync(runtime).isSymbolicLink()) {
    throw error('INSTALLED_STATE_INVALID', 'unsafe shared ownership paths');
  }
  return { agentRoot, runtime, skillRoot };
}

function requireRegisteredReceipt(receipt, agent, paths) {
  if (receipt.get('receipt_schema') !== 'opcore.install.v6' || receipt.get('agent') !== agent) {
    throw error('INSTALLED_STATE_INVALID', 'shared owner receipt has no matching agent identity');
  }
  for (const [key, value] of Object.entries(paths)) {
    if (receipt.get(key) !== sha256(Buffer.from(value))) {
      throw error('INSTALLED_STATE_INVALID', 'shared owner receipt paths disagree');
    }
  }
}

function registeredContext({ agent, binaryPath, home, registry }) {
  const bytes = readRegularFile(path.join(registry, agent), 16384, 'shared owner');
  const { agentRoot, runtime, skillRoot } = registeredOwnerRoots(bytes);
  const receipt = parseInstallReceipt(readRegularFile(
    path.join(runtime, 'install.receipt'), MAX_RECEIPT_BYTES, 'shared owner receipt'
  ));
  const paths = { owners_path: registry, binary_path: binaryPath, agent_root_path: agentRoot,
    skill_path: path.join(skillRoot, 'opcore', 'SKILL.md') };
  requireRegisteredReceipt(receipt, agent, paths);
  return { agent, agentRoot, skillRoot, home };
}

function installationContexts(packageRoot, contexts) {
  const statePath = path.join(packageRoot, STATE_FILE);
  const prior = fs.existsSync(statePath) ? stateEntries(readState(packageRoot)) : [];
  if (prior.some((entry) => entry.schema === CLI_STATE_SCHEMA)) {
    throw error('INSTALL_CONTEXT_INVALID',
      'CLI-only installation exists; use setup --no-hooks to update it, or uninstall before adding agents');
  }
  const registered = registeredContexts(packageRoot, contexts[0].home);
  const allContexts = [...contexts];
  for (const previous of [...prior, ...registered]) {
    const selected = allContexts.find((context) => context.agent === previous.agent);
    if (selected && ['agentRoot', 'skillRoot', 'home'].some((key) => selected[key] !== previous[key])) {
      throw error('INSTALLED_STATE_INVALID', 'conflicting agent ownership locations');
    }
    if (!selected) {
      const { agent, agentRoot, home, skillRoot } = previous;
      allContexts.push({ agent, agentRoot, home, skillRoot });
    }
  }
  return allContexts;
}

function executeInstall(options, contexts, request) {
  if (options.runInstaller) {
    for (const selected of contexts) options.runInstaller({ ...request, ...selected });
  } else {
    const selection = request.environment.OPCORE_AGENT ? contexts[0] : { contexts };
    runBundleInstaller({ ...request, ...selection });
  }
}

function installAndCapture(options, contexts, allContexts, request, context) {
  const previous = new Set(allContexts.filter((selected) =>
    fs.existsSync(path.join(selected.agentRoot, 'opcore', 'install.receipt'))
  ).map((selected) => selected.agent));
  try {
    executeInstall(options, contexts, request);
    const state = combinedState(captureInstallStates(context, allContexts));
    writeState(context.packageRoot, state);
    return state;
  } catch (cause) {
    const rollback = rollbackNewIntegrations(options, allContexts, previous, request, context);
    const recoverable = allContexts.filter((selected) =>
      fs.existsSync(path.join(selected.agentRoot, 'opcore', 'install.receipt'))
    );
    if (recoverable.length) {
      try {
        writeState(context.packageRoot, combinedState(captureInstallStates(context, recoverable)));
      } catch (recovery) {
        rollback.push(`cleanup state recovery failed: ${recovery.message}`);
      }
      rollback.push('Existing or modified integrations were retained. ' +
        'Repair the reported problem and rerun npm installation before removing them.');
    }
    if (rollback.length) throw error('INSTALL_FAILED', `${cause.message}; ${rollback.join('; ')}`);
    throw cause;
  }
}

function rollbackNewIntegrations(options, contexts, previous, request, context) {
  const failures = [];
  for (const selected of contexts) {
    if (previous.has(selected.agent)) continue;
    const receipt = path.join(selected.agentRoot, 'opcore', 'install.receipt');
    if (!fs.existsSync(receipt)) continue;
    try {
      const state = installedState({ ...context, ...selected });
      const owners = registeredContexts(context.packageRoot, selected.home);
      options.rollbackInstallation(state, owners, request.environment);
      if (fs.existsSync(receipt) || fs.existsSync(state.hookReceiptPath)) {
        throw error('UNINSTALL_FAILED', 'owned cleanup left an integration receipt');
      }
    } catch (cause) {
      failures.push(`${selected.agent} cleanup incomplete: ${cause.message}`);
    }
  }
  return failures;
}

function installationSelection(options, packageRoot) {
  const environment = options.environment || process.env;
  if (environment.OPCORE_NO_HOOKS && !['0', '1'].includes(environment.OPCORE_NO_HOOKS)) {
    throw error('INSTALL_CONTEXT_INVALID', 'OPCORE_NO_HOOKS must be 0 or 1');
  }
  if (environment.OPCORE_AGENT_NO_HOOKS &&
      !['0', '1'].includes(environment.OPCORE_AGENT_NO_HOOKS)) {
    throw error('INSTALL_CONTEXT_INVALID', 'OPCORE_AGENT_NO_HOOKS must be 0 or 1');
  }
  const cliOnly = options.noHooks || environment.OPCORE_NO_HOOKS === '1';
  const enrollHooks = environment.OPCORE_AGENT_NO_HOOKS !== '1';
  const contexts = cliOnly ? [] : selectAgents(environment);
  const allContexts = cliOnly ? [] : installationContexts(packageRoot, contexts);
  if (cliOnly) options.preflightStandalone({ packageRoot, environment });
  return { environment, cliOnly, enrollHooks, contexts, allContexts };
}

async function installRelease(options) {
  const packageRoot = path.resolve(options.packageRoot || path.resolve(__dirname, '..'));
  const metadata =
    options.packageMetadata ||
    JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  if (!isReleaseVersion(metadata.version) || metadata.version === '0.0.0-development') {
    throw error(
      'UNRELEASED_SHIM_VERSION',
      `cannot install a release for package version ${metadata.version}`
    );
  }
  const target = selectTarget(options.platform, options.arch);
  const { environment, cliOnly, enrollHooks, contexts, allContexts } =
    installationSelection(options, packageRoot);
  requireHostCompatibility(options.platform, options.runtimeHeader);
  const filename = archiveName(metadata.version, target);
  const releaseAssets =
    options.releaseAssets ||
    readRegularFile(
      path.join(packageRoot, ASSET_FILE),
      MAX_MANIFEST_BYTES,
      'release asset binding'
    );
  const boundChecksums = parseReleaseAssets(releaseAssets, metadata.version);
  const releaseUrl = `${RELEASE_BASE_URL}/v${metadata.version}`;
  const fetchBuffer = options.fetchBuffer || download;
  const manifest = await fetchBuffer(`${releaseUrl}/SHA256SUMS`, MAX_MANIFEST_BYTES);
  const archive = await fetchBuffer(`${releaseUrl}/${filename}`, MAX_ARCHIVE_BYTES);
  const archiveDigest = verifyBoundArchive(
    filename,
    archive,
    manifest,
    expectedArchiveNames(metadata.version),
    boundChecksums
  );
  const entries = extractBundle(archive, target.bundleRoot, options.maximumExpandedBytes);
  const binDir = path.join(packageRoot, 'native');
  const temporaryBase = options.temporaryBase || os.tmpdir();
  const temporary = fs.mkdtempSync(path.join(temporaryBase, 'opcore-npm.'));
  const bundleRoot = path.join(temporary, target.bundleRoot);
  try {
    materializeBundle(entries, bundleRoot);
    const context = { packageRoot, version: metadata.version, target, archiveDigest,
      expectedBinaryDigest: sha256(entries.get('bin/opcore').bytes) };
    if (cliOnly) return options.installStandalone({ ...context, bundleRoot, binDir, environment });
    const state = installAndCapture(options, contexts, allContexts,
      { bundleRoot, binDir, environment, enrollHooks }, context);
    return state;
  } finally {
    try {
      fs.rmSync(temporary, { recursive: true, force: true });
    } catch (cause) {
      process.stderr.write(`opcore: temporary cleanup incomplete at ${temporary}: ${cause.message}\n`);
    }
  }
}

module.exports = {
  ASSET_FILE,
  ASSET_SCHEMA,
  CLI_STATE_SCHEMA,
  DOWNLOAD_TIMEOUT_MS,
  MAX_ARCHIVE_BYTES,
  MAX_EXPANDED_BYTES,
  MAX_MANIFEST_BYTES,
  MAX_RECEIPT_BYTES,
  PACKAGE_NAME,
  RELEASE_BASE_URL,
  STATE_FILE,
  STATE_SCHEMA,
  TARGETS,
  archiveName,
  boundAgentEnvironment,
  download,
  expectedArchiveNames,
  extractBundle,
  installRelease,
  installedState,
  installerEnvironment,
  isReleaseVersion,
  materializeBundle,
  parseChecksumManifest,
  parseInstallReceipt,
  parseReleaseAssets,
  readRegularFile,
  readState,
  runBundleInstaller,
  selectAgent,
  selectAgents,
  registeredContexts,
  stateEntries,
  combinedState,
  selectTarget,
  requireHostCompatibility,
  sha256,
  stateBytes,
  verifyArchive,
  verifyBoundArchive,
  writeState,
};
