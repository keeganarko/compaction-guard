import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseArgs, safeSegment } from '../compaction-guard.mjs';

const SCRIPT = fileURLToPath(new URL('../compaction-guard.mjs', import.meta.url));
const POSIX = process.platform !== 'win32';
const ROOT_USER = typeof process.getuid === 'function' && process.getuid() === 0;

// A synthetic transcript laid out the way Claude Code stores one: <projects>/<project>/<session>.jsonl.
function fixture(t, { lines = 3, session = 'b1946ac9-2f4c-4a7e-9d51-0c7a1f7e2d10' } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'compaction-guard-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const projectDir = path.join(tmp, 'projects', '-home-dev-example');
  fs.mkdirSync(projectDir, { recursive: true });
  const transcript = path.join(projectDir, `${session}.jsonl`);
  const body = Array.from({ length: lines }, (_, i) =>
    JSON.stringify({ type: i % 2 ? 'assistant' : 'user', message: { content: `synthetic line ${i}` } }),
  ).join('\n');
  fs.writeFileSync(transcript, `${body}\n`);
  return { tmp, root: path.join(tmp, 'archive'), transcript, session };
}

function event(fx, extra = {}) {
  return {
    session_id: fx.session,
    transcript_path: fx.transcript,
    cwd: fx.tmp,
    hook_event_name: 'PreCompact',
    trigger: 'auto',
    custom_instructions: '',
    ...extra,
  };
}

function run({ args = [], input, root, env = {} }) {
  const clean = { ...process.env };
  delete clean.COMPACTION_GUARD_DIR;
  delete clean.COMPACTION_GUARD_FAIL_OPEN;
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    input: typeof input === 'string' ? input : JSON.stringify(input ?? {}),
    env: { ...clean, ...(root ? { COMPACTION_GUARD_DIR: root } : {}), ...env },
    encoding: 'utf8',
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function receipts(root) {
  return fs.readFileSync(path.join(root, 'index.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('saves an exact copy and writes a receipt, then lets compaction continue', (t) => {
  const fx = fixture(t);
  const r = run({ input: event(fx), root: fx.root });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, '', 'stdout stays empty so Claude Code does not parse it as a decision');
  assert.match(r.stderr, /saved \d+ bytes/);

  const [receipt, ...rest] = receipts(fx.root);
  assert.equal(rest.length, 0);
  assert.equal(receipt.session_id, fx.session);
  assert.equal(receipt.trigger, 'auto');
  assert.equal(receipt.source, fx.transcript);
  assert.match(receipt.archive, new RegExp(`^-home-dev-example/${fx.session}/[0-9T-]+Z-auto-[0-9a-f]{8}\\.jsonl$`));
  const archived = path.join(fx.root, receipt.archive);
  assert.deepEqual(fs.readFileSync(archived), fs.readFileSync(fx.transcript));
  assert.equal(receipt.sha256, sha256(fx.transcript));
  assert.equal(receipt.bytes, fs.statSync(fx.transcript).size);
  assert.deepEqual(
    fs.readdirSync(path.dirname(archived)).filter((name) => name.endsWith('.tmp')),
    [],
    'no temporary files are left behind',
  );
});

test('keeps the archive private to the user', { skip: !POSIX }, (t) => {
  const fx = fixture(t);
  assert.equal(run({ input: event(fx), root: fx.root }).code, 0);
  const [receipt] = receipts(fx.root);
  const archived = path.join(fx.root, receipt.archive);
  const mode = (p) => fs.statSync(p).mode & 0o777;
  assert.equal(mode(fx.root), 0o700);
  assert.equal(mode(path.dirname(archived)), 0o700);
  assert.equal(mode(archived), 0o600);
  assert.equal(mode(path.join(fx.root, 'index.jsonl')), 0o600);
});

test('records a manual trigger, and an unexpected trigger as unknown', (t) => {
  const fx = fixture(t);
  assert.equal(run({ input: event(fx, { trigger: 'manual' }), root: fx.root }).code, 0);
  assert.equal(run({ input: event(fx, { trigger: '../x' }), root: fx.root }).code, 0);
  assert.deepEqual(
    receipts(fx.root).map((r) => r.trigger),
    ['manual', 'unknown'],
  );
});

test('two compactions in one session keep two copies', (t) => {
  const fx = fixture(t);
  assert.equal(run({ input: event(fx), root: fx.root }).code, 0);
  fs.appendFileSync(fx.transcript, `${JSON.stringify({ type: 'user', message: { content: 'after' } })}\n`);
  assert.equal(run({ input: event(fx), root: fx.root }).code, 0);
  const [first, second] = receipts(fx.root);
  assert.notEqual(first.archive, second.archive);
  assert.notEqual(first.sha256, second.sha256);
  assert.equal(run({ args: ['verify'], root: fx.root }).code, 0);
});

test('blocks compaction when the transcript is missing', (t) => {
  const fx = fixture(t);
  const r = run({ input: event(fx, { transcript_path: path.join(fx.tmp, 'gone.jsonl') }), root: fx.root });
  assert.equal(r.code, 2);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /the transcript does not exist/);
  assert.match(r.stderr, /compaction was blocked and nothing was lost/);
  assert.equal(fs.existsSync(path.join(fx.root, 'index.jsonl')), false);
});

test('blocks compaction when the transcript path is a directory or absent', (t) => {
  const fx = fixture(t);
  const dir = run({ input: event(fx, { transcript_path: fx.tmp }), root: fx.root });
  assert.equal(dir.code, 2);
  assert.match(dir.stderr, /not a regular file/);
  const absent = run({ input: event(fx, { transcript_path: undefined }), root: fx.root });
  assert.equal(absent.code, 2);
  assert.match(absent.stderr, /no transcript_path/);
});

test('blocks compaction when stdin is not JSON', (t) => {
  const fx = fixture(t);
  const r = run({ input: 'not json', root: fx.root });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /not valid JSON/);
});

test('blocks compaction on an unknown argument', (t) => {
  const fx = fixture(t);
  const r = run({ args: ['--dri', fx.root], input: event(fx), root: fx.root });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown argument: --dri/);
});

test('fail-open lets compaction continue, with the reason on stderr', (t) => {
  const fx = fixture(t);
  const r = run({
    input: event(fx, { transcript_path: path.join(fx.tmp, 'gone.jsonl') }),
    root: fx.root,
    env: { COMPACTION_GUARD_FAIL_OPEN: '1' },
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Compaction will continue without a saved copy/);
});

test('ignores events other than PreCompact', (t) => {
  const fx = fixture(t);
  for (const input of [JSON.stringify(event(fx, { hook_event_name: 'SessionStart' })), '{}', 'null', '[]']) {
    const r = run({ input, root: fx.root });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
  }
  assert.equal(fs.existsSync(fx.root), false, 'nothing is written for other events');
});

test('resolves a relative transcript path against the hook cwd', (t) => {
  const fx = fixture(t);
  const relative = path.relative(fx.tmp, fx.transcript);
  const r = run({ input: event(fx, { transcript_path: relative }), root: fx.root });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(receipts(fx.root)[0].source, fx.transcript);
});

test('a hostile session_id cannot write outside the archive', (t) => {
  const fx = fixture(t);
  const r = run({ input: event(fx, { session_id: '../../../escape' }), root: fx.root });
  assert.equal(r.code, 0, r.stderr);
  const [receipt] = receipts(fx.root);
  assert.equal(receipt.session_id, '../../../escape', 'the receipt keeps the original id');
  const archived = path.resolve(fx.root, receipt.archive);
  assert.ok(archived.startsWith(fx.root + path.sep));
  assert.equal(receipt.archive.split('/').length, 3);
  assert.ok(!receipt.archive.split('/').some((part) => part === '..' || part.startsWith('.')));
});

test('--dir overrides COMPACTION_GUARD_DIR', (t) => {
  const fx = fixture(t);
  const other = path.join(fx.tmp, 'other');
  assert.equal(run({ args: ['--dir', other], input: event(fx), root: fx.root }).code, 0);
  assert.equal(fs.existsSync(path.join(other, 'index.jsonl')), true);
  assert.equal(fs.existsSync(fx.root), false);
});

test('copies a large transcript exactly', (t) => {
  const fx = fixture(t, { lines: 100000 });
  assert.ok(fs.statSync(fx.transcript).size > 4 * 1024 * 1024);
  const r = run({ input: event(fx), root: fx.root });
  assert.equal(r.code, 0, r.stderr);
  const [receipt] = receipts(fx.root);
  assert.equal(sha256(path.join(fx.root, receipt.archive)), sha256(fx.transcript));
});

test('blocks compaction when the archive cannot be written', { skip: !POSIX || ROOT_USER }, (t) => {
  const fx = fixture(t);
  fs.mkdirSync(fx.root, { mode: 0o500 });
  const r = run({ input: event(fx), root: fx.root });
  fs.chmodSync(fx.root, 0o700);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /EACCES/);
  assert.match(r.stderr, /compaction was blocked/);
});

test('verify reports intact, changed, missing and invalid receipts', (t) => {
  const fx = fixture(t);
  for (let i = 0; i < 3; i++) assert.equal(run({ input: event(fx), root: fx.root }).code, 0);
  const ok = run({ args: ['verify'], root: fx.root });
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /3 receipts/);
  assert.match(ok.stdout, /verified {2}3/);

  const [a, b] = receipts(fx.root);
  fs.appendFileSync(path.join(fx.root, a.archive), 'tampered\n');
  fs.rmSync(path.join(fx.root, b.archive));
  fs.appendFileSync(
    path.join(fx.root, 'index.jsonl'),
    `${JSON.stringify({ archive: '../outside.jsonl', bytes: 1, sha256: 'x' })}\nnot json\n`,
  );
  const bad = run({ args: ['verify'], root: fx.root });
  assert.equal(bad.code, 1);
  assert.match(bad.stdout, /5 receipts/);
  assert.match(bad.stdout, /verified {2}1/);
  assert.match(bad.stdout, new RegExp(`changed: ${a.archive}`));
  assert.match(bad.stdout, new RegExp(`missing: ${b.archive}`));
  assert.match(bad.stdout, /invalid: index\.jsonl line 4: incomplete receipt, or it points outside the archive/);
  assert.match(bad.stdout, /invalid: index\.jsonl line 5: not valid JSON/);
});

test('verify on an empty archive says so', (t) => {
  const fx = fixture(t);
  const r = run({ args: ['verify'], root: fx.root });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /No receipts yet/);
});

test('safeSegment keeps a single, visible path segment', () => {
  assert.equal(safeSegment('abc-123_X.y', 'f'), 'abc-123_X.y');
  assert.equal(safeSegment('..', 'f'), 'f');
  assert.equal(safeSegment('../../etc', 'f'), '_.._etc');
  assert.equal(safeSegment('a/b\\c', 'f'), 'a_b_c');
  assert.equal(safeSegment(undefined, 'f'), 'f');
  assert.equal(safeSegment('x'.repeat(300), 'f').length, 128);
});

test('parseArgs reads commands and the archive flag', () => {
  assert.deepEqual(parseArgs([]), { command: 'hook', dir: undefined });
  assert.deepEqual(parseArgs(['verify', '--dir', '/a']), { command: 'verify', dir: '/a' });
  assert.deepEqual(parseArgs(['--dir=/b']), { command: 'hook', dir: '/b' });
  assert.equal(parseArgs(['--help']).command, 'help');
  assert.throws(() => parseArgs(['--dir']), /needs a path/);
  assert.throws(() => parseArgs(['--nope']), /unknown argument/);
});

// The id restore takes: the saved copy's file name without .jsonl.
function idOf(receipt) {
  return path.posix.basename(receipt.archive, '.jsonl');
}

// Saves the fixture's transcript once and returns the newest receipt.
function save(fx) {
  const r = run({ input: event(fx), root: fx.root });
  assert.equal(r.code, 0, r.stderr);
  return receipts(fx.root).at(-1);
}

// Flips one bit, so the file keeps its size but not its hash.
function flipBit(file) {
  const bytes = fs.readFileSync(file);
  bytes[0] ^= 1;
  fs.writeFileSync(file, bytes);
}

function tmpFiles(dir) {
  return fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
}

test('verify catches a copy that changed but kept its size', (t) => {
  const fx = fixture(t);
  const receipt = save(fx);
  flipBit(path.join(fx.root, receipt.archive));
  const r = run({ args: ['verify'], root: fx.root });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /changed {3}1/);
  assert.match(r.stdout, new RegExp(`changed: ${receipt.archive}`));
});

test('verify exits 2 when the index cannot be read', (t) => {
  const fx = fixture(t);
  fs.mkdirSync(path.join(fx.root, 'index.jsonl'), { recursive: true });
  const r = run({ args: ['verify'], root: fx.root });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /could not read the archive/);
});

test('restore by receipt id writes the exact bytes to --to', (t) => {
  const fx = fixture(t);
  const receipt = save(fx);
  const target = path.join(fx.tmp, 'restored.jsonl');
  const r = run({ args: ['restore', idOf(receipt), '--to', target], root: fx.root });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`^Restored ${idOf(receipt)} to `));
  assert.deepEqual(fs.readFileSync(target), fs.readFileSync(fx.transcript));
  if (POSIX) assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.deepEqual(tmpFiles(fx.tmp), []);
});

test('restore by SHA-256 prefix puts a deleted transcript back where it was', (t) => {
  const fx = fixture(t);
  const receipt = save(fx);
  const original = fs.readFileSync(fx.transcript);
  fs.rmSync(fx.transcript);
  const r = run({ args: ['restore', receipt.sha256.slice(0, 12)], root: fx.root });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(fs.readFileSync(fx.transcript), original);
});

test('restore into a folder keeps the transcript file name', (t) => {
  const fx = fixture(t);
  const receipt = save(fx);
  const folder = path.join(fx.tmp, 'out');
  fs.mkdirSync(folder);
  const r = run({ args: ['restore', receipt.sha256.toUpperCase(), '--to', folder], root: fx.root });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(fs.readFileSync(path.join(folder, `${fx.session}.jsonl`)), fs.readFileSync(fx.transcript));
});

test('restore never replaces a file without --force', (t) => {
  const fx = fixture(t);
  const receipt = save(fx);
  const saved = fs.readFileSync(fx.transcript);
  fs.appendFileSync(fx.transcript, `${JSON.stringify({ type: 'user', message: { content: 'newer' } })}\n`);
  const newer = fs.readFileSync(fx.transcript);

  const refused = run({ args: ['restore', idOf(receipt)], root: fx.root });
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /already exists; pass --force to replace it/);
  assert.deepEqual(fs.readFileSync(fx.transcript), newer, 'the existing file is untouched');

  const forced = run({ args: ['restore', idOf(receipt), '--force'], root: fx.root });
  assert.equal(forced.code, 0, forced.stderr);
  assert.deepEqual(fs.readFileSync(fx.transcript), saved);
  assert.deepEqual(tmpFiles(path.dirname(fx.transcript)), []);
});

test('restore refuses a copy whose hash no longer matches, and writes nothing', (t) => {
  const fx = fixture(t);
  const receipt = save(fx);
  flipBit(path.join(fx.root, receipt.archive));
  const target = path.join(fx.tmp, 'restored.jsonl');
  const r = run({ args: ['restore', receipt.sha256, '--to', target], root: fx.root });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no saved copy matches its receipt, so nothing was restored/);
  assert.match(r.stderr, new RegExp(`changed: ${receipt.archive}`));
  assert.equal(fs.existsSync(target), false);
  assert.deepEqual(tmpFiles(fx.tmp), []);
});

test('restore falls back to another copy with the same hash', (t) => {
  const fx = fixture(t);
  const older = save(fx);
  const newer = save(fx);
  assert.equal(older.sha256, newer.sha256);
  fs.rmSync(path.join(fx.root, newer.archive));
  const target = path.join(fx.tmp, 'restored.jsonl');
  const r = run({ args: ['restore', older.sha256, '--to', target], root: fx.root });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`^Restored ${idOf(older)} `));
  assert.deepEqual(fs.readFileSync(target), fs.readFileSync(fx.transcript));

  fs.rmSync(path.join(fx.root, older.archive));
  const none = run({ args: ['restore', older.sha256, '--to', path.join(fx.tmp, 'again.jsonl')], root: fx.root });
  assert.equal(none.code, 1);
  assert.match(none.stderr, new RegExp(`missing: ${newer.archive}`));
  assert.match(none.stderr, new RegExp(`missing: ${older.archive}`));
});

test('restore refuses an unknown, ambiguous or too short reference', (t) => {
  const fx = fixture(t);
  const receipt = save(fx);
  const target = path.join(fx.tmp, 'restored.jsonl');

  const unknown = run({ args: ['restore', '0123456789abcdef', '--to', target], root: fx.root });
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /no receipt in .* matches 0123456789abcdef/);

  const prefix = receipt.sha256.slice(0, 8);
  const twin = { ...receipt, archive: receipt.archive.replace(/\.jsonl$/, '-twin.jsonl'), sha256: prefix + '0'.repeat(56) };
  fs.appendFileSync(path.join(fx.root, 'index.jsonl'), `${JSON.stringify(twin)}\n`);
  const ambiguous = run({ args: ['restore', prefix, '--to', target], root: fx.root });
  assert.equal(ambiguous.code, 1);
  assert.match(ambiguous.stderr, /matches receipts with different contents/);

  const short = run({ args: ['restore', prefix.slice(0, 6), '--to', target], root: fx.root });
  assert.equal(short.code, 2);
  assert.match(short.stderr, /at least 8 characters/);
  assert.equal(fs.existsSync(target), false);
});

test('restore will not write inside the archive', (t) => {
  const fx = fixture(t);
  const receipt = save(fx);
  const index = path.join(fx.root, 'index.jsonl');
  const r = run({ args: ['restore', idOf(receipt), '--to', index, '--force'], root: fx.root });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /inside the archive/);
  assert.equal(receipts(fx.root).length, 1);
});

test('verify and restore report a bad argument without blocking anything', (t) => {
  const fx = fixture(t);
  for (const args of [['restore'], ['restore', 'a', 'b'], ['verify', '--force']]) {
    const r = run({ args, root: fx.root });
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.stderr, /compaction-guard (restore|verify): /);
    assert.doesNotMatch(r.stderr, /compaction was blocked/);
  }
  const hook = run({ args: ['stray'], input: event(fx), root: fx.root });
  assert.equal(hook.code, 2, 'in hook mode a stray word still blocks compaction, as in 0.1.0');
  assert.match(hook.stderr, /unknown argument: stray/);
  assert.match(hook.stderr, /compaction was blocked/);
});

test('parseArgs reads restore and its flags', () => {
  assert.deepEqual(parseArgs(['restore', 'abc12345']), {
    command: 'restore',
    dir: undefined,
    ref: 'abc12345',
    to: undefined,
    force: false,
  });
  assert.deepEqual(parseArgs(['--dir', '/a', 'restore', '--to=out.jsonl', '--force', 'abc12345']), {
    command: 'restore',
    dir: '/a',
    ref: 'abc12345',
    to: 'out.jsonl',
    force: true,
  });
  assert.throws(() => parseArgs(['restore']), /needs a receipt id/);
  assert.throws(() => parseArgs(['restore', 'a', 'b']), /unknown argument: b/);
  assert.throws(() => parseArgs(['restore', 'a', '--to']), /--to needs a path/);
  assert.throws(() => parseArgs(['restore', 'a', '--to=']), /--to needs a path/);
  assert.throws(() => parseArgs(['--force']), /unknown argument: --force/);
  assert.throws(() => parseArgs(['verify', 'abc12345']), /unknown argument: abc12345/);
  assert.equal(parseArgs(['restore', '--help']).command, 'help');
});
