#!/usr/bin/env node
// compaction-guard: before an AI coding agent compacts its conversation, save an
// exact copy, check the copy by hash, and block the compaction if the save fails.
//
// Copyright 2026 Keegan Choudhury. Source-available under FSL-1.1-MIT (LICENSE.md).

import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, realpathSync } from 'node:fs';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export const VERSION = '0.1.0';
const INDEX_FILE = 'index.jsonl';
const COPY_ATTEMPTS = 3;

const USAGE = `Usage:
  compaction-guard [--dir <path>]          Hook mode: read a PreCompact event on stdin and save its transcript.
  compaction-guard verify [--dir <path>]   Re-check every saved copy against its receipt.
  compaction-guard --help | --version

Archive: --dir, else COMPACTION_GUARD_DIR, else ~/.compaction-guard.
Set COMPACTION_GUARD_FAIL_OPEN=1 to let compaction continue when a save fails.
`;

// A failure whose message is already plain enough to show the person.
class GuardError extends Error {}

function reason(err) {
  if (err instanceof GuardError) return err.message;
  const message = String(err && err.message ? err.message : err);
  // Node's fs errors already start with their code ("EACCES: permission denied, ...").
  return err && err.code && !message.startsWith(err.code) ? `${err.code}: ${message}` : message;
}

export function parseArgs(argv) {
  const opts = { command: 'hook', dir: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === 'verify') {
      if (opts.command === 'hook') opts.command = 'verify';
    } else if (arg === '--help' || arg === '-h') {
      opts.command = 'help';
    } else if (arg === '--version' || arg === '-v') {
      opts.command = 'version';
    } else if (arg === '--dir') {
      if (i + 1 >= argv.length) throw new GuardError('--dir needs a path');
      opts.dir = argv[++i];
    } else if (arg.startsWith('--dir=')) {
      opts.dir = arg.slice('--dir='.length);
    } else {
      throw new GuardError(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

export function archiveRoot(opts, env) {
  const dir = opts.dir || env.COMPACTION_GUARD_DIR;
  return path.resolve(dir || path.join(homedir(), '.compaction-guard'));
}

// One path segment that cannot climb out of its parent or name a hidden file.
export function safeSegment(value, fallback) {
  const cleaned = String(value ?? '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 128);
  return cleaned || fallback;
}

export async function hashFile(file) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { bytes, sha256: hash.digest('hex') };
}

async function writeAll(handle, chunk) {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
    offset += bytesWritten;
  }
}

// Copies source to a new file at target, hashing the bytes as they are read.
async function copyAndHash(source, target) {
  const out = await open(target, 'wx', 0o600);
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of createReadStream(source)) {
      hash.update(chunk);
      bytes += chunk.length;
      await writeAll(out, chunk);
    }
    await out.sync();
  } finally {
    await out.close();
  }
  return { bytes, sha256: hash.digest('hex') };
}

async function syncDir(dir) {
  // Windows cannot open a directory for flushing; NTFS journals the rename itself.
  if (process.platform === 'win32') return;
  const handle = await open(dir, 'r');
  try {
    await handle.sync();
  } catch (err) {
    // Some filesystems (network and WSL drive mounts) do not support flushing a directory.
    if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(err.code)) throw err;
  } finally {
    await handle.close();
  }
}

async function removeQuietly(file) {
  await unlink(file).catch(() => {});
}

async function statSource(source) {
  let info;
  try {
    info = await stat(source);
  } catch (err) {
    if (err.code === 'ENOENT') throw new GuardError(`the transcript does not exist: ${source}`);
    throw err;
  }
  if (!info.isFile()) throw new GuardError(`the transcript is not a regular file: ${source}`);
  return info;
}

async function appendLine(file, line) {
  const handle = await open(file, 'a', 0o600);
  try {
    await handle.appendFile(`${line}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// Saves one PreCompact event's transcript and returns its receipt. Throws on any failure.
export async function saveTranscript(input, root) {
  if (typeof input.transcript_path !== 'string' || input.transcript_path === '') {
    throw new GuardError('the hook input has no transcript_path');
  }
  const base = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  const source = path.resolve(base, input.transcript_path);
  await statSource(source);

  const project = safeSegment(path.basename(path.dirname(source)), 'unknown-project');
  const fromFile = safeSegment(path.basename(source, path.extname(source)), 'unknown-session');
  const session = safeSegment(input.session_id, fromFile);
  const trigger = input.trigger === 'manual' || input.trigger === 'auto' ? input.trigger : 'unknown';
  const dir = path.join(root, project, session);
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `${stamp}-${trigger}-${randomBytes(4).toString('hex')}.jsonl`;
  const archive = path.join(dir, name);

  // Claude Code may still be appending; only keep a copy taken while the file stood still.
  let copied;
  for (let attempt = 1; ; attempt++) {
    const before = await statSource(source);
    const tmp = path.join(dir, `.${name}.${randomBytes(4).toString('hex')}.tmp`);
    try {
      copied = await copyAndHash(source, tmp);
      const after = await statSource(source);
      const still = before.size === after.size && before.mtimeMs === after.mtimeMs && copied.bytes === after.size;
      if (still) {
        await rename(tmp, archive);
        break;
      }
    } catch (err) {
      await removeQuietly(tmp);
      throw err;
    }
    await removeQuietly(tmp);
    if (attempt === COPY_ATTEMPTS) {
      throw new GuardError(`the transcript kept changing while it was being copied (${COPY_ATTEMPTS} attempts)`);
    }
    await delay(100 * attempt);
  }
  await syncDir(dir);
  await syncDir(path.dirname(dir));

  const check = await hashFile(archive);
  if (check.bytes !== copied.bytes || check.sha256 !== copied.sha256) {
    throw new GuardError(`the saved copy does not match what was read from the transcript: ${archive}`);
  }

  const receipt = {
    version: 1,
    saved_at: new Date().toISOString(),
    session_id: typeof input.session_id === 'string' ? input.session_id : null,
    trigger,
    source,
    archive: path.relative(root, archive).split(path.sep).join('/'),
    bytes: copied.bytes,
    sha256: copied.sha256,
  };
  await appendLine(path.join(root, INDEX_FILE), JSON.stringify(receipt));
  await syncDir(root);
  return { ...receipt, archive_path: archive };
}

function isInside(root, file) {
  const rel = path.relative(root, file);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

// Re-hashes every archived copy named in index.jsonl.
export async function verifyArchive(root) {
  const result = { total: 0, verified: 0, missing: [], changed: [], invalid: [] };
  let text;
  try {
    text = await readFile(path.join(root, INDEX_FILE), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return result;
    throw err;
  }
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    result.total++;
    const where = `${INDEX_FILE} line ${i + 1}`;
    let receipt;
    try {
      receipt = JSON.parse(lines[i]);
    } catch {
      result.invalid.push(`${where}: not valid JSON`);
      continue;
    }
    const file = receipt && typeof receipt.archive === 'string' ? path.resolve(root, receipt.archive) : null;
    if (!file || !isInside(root, file) || typeof receipt.sha256 !== 'string' || !Number.isInteger(receipt.bytes)) {
      result.invalid.push(`${where}: incomplete receipt, or it points outside the archive`);
      continue;
    }
    let actual;
    try {
      actual = await hashFile(file);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      result.missing.push(receipt.archive);
      continue;
    }
    if (actual.bytes === receipt.bytes && actual.sha256 === receipt.sha256) result.verified++;
    else result.changed.push(receipt.archive);
  }
  return result;
}

function fail(env, io, why) {
  if (env.COMPACTION_GUARD_FAIL_OPEN === '1') {
    io.err(
      `compaction-guard: could not save the conversation (${why}). ` +
        'Compaction will continue without a saved copy, because COMPACTION_GUARD_FAIL_OPEN=1.\n',
    );
    return 1;
  }
  io.err(
    `compaction-guard: could not save the conversation (${why}), so compaction was blocked and nothing was lost. ` +
      'Fix the cause and compact again, or set COMPACTION_GUARD_FAIL_OPEN=1 to compact without a saved copy.\n',
  );
  return 2;
}

async function runVerify(root, io) {
  let result;
  try {
    result = await verifyArchive(root);
  } catch (err) {
    io.err(`compaction-guard verify: could not read the archive at ${root} (${reason(err)})\n`);
    return 2;
  }
  if (result.total === 0) {
    io.out(`No receipts yet in ${root}\n`);
    return 0;
  }
  const lines = [
    `${result.total} receipts in ${root}`,
    `  verified  ${result.verified}`,
    `  missing   ${result.missing.length}`,
    `  changed   ${result.changed.length}`,
    `  invalid   ${result.invalid.length}`,
    ...result.missing.map((p) => `missing: ${p}`),
    ...result.changed.map((p) => `changed: ${p}`),
    ...result.invalid.map((p) => `invalid: ${p}`),
  ];
  io.out(`${lines.join('\n')}\n`);
  return result.verified === result.total ? 0 : 1;
}

export async function main(argv, env, io) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    io.err(USAGE);
    return fail(env, io, reason(err));
  }
  if (opts.command === 'help') {
    io.out(USAGE);
    return 0;
  }
  if (opts.command === 'version') {
    io.out(`${VERSION}\n`);
    return 0;
  }
  const root = archiveRoot(opts, env);
  if (opts.command === 'verify') return runVerify(root, io);

  if (io.isTTY) {
    io.err(`compaction-guard runs as a Claude Code PreCompact hook and reads its event on stdin.\n\n${USAGE}`);
    return 1;
  }
  let input;
  try {
    input = JSON.parse(await io.readStdin());
  } catch {
    return fail(env, io, 'the hook input on stdin is not valid JSON');
  }
  if (!input || input.hook_event_name !== 'PreCompact') return 0;
  try {
    const receipt = await saveTranscript(input, root);
    io.err(`compaction-guard: saved ${receipt.bytes} bytes (sha256 ${receipt.sha256}) to ${receipt.archive_path}\n`);
    return 0;
  } catch (err) {
    return fail(env, io, reason(err));
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  process.exitCode = await main(process.argv.slice(2), process.env, {
    isTTY: Boolean(process.stdin.isTTY),
    readStdin,
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  });
}
