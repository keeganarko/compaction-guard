# Changelog

## 0.2.0 — 2026-10-15

### Added

- **`restore`** writes a saved copy back after checking it against its
  receipt. Name the copy by its receipt id or by 8 or more hex digits of its
  SHA-256. It goes back to the path it was saved from, or to `--to <file or
  folder>`. It hashes the copy before writing and again while copying, and it
  never replaces an existing file unless you pass `--force`. Exit 0 restored,
  1 refused, 2 error.
- **Tests** for `verify` (a copy changed without changing its size, an
  unreadable index) and for `restore` (by id, by hash prefix, into a folder,
  over an existing file, from a damaged copy, bad references). 31 tests in
  all, up from 19.
- **CI.** GitHub Actions runs the tests on every push and pull request, on
  Linux and macOS, with Node.js 18 and the newest LTS.
- **Docs.** The README has a diagram of the four steps, an example of
  `verify`'s output, and a section on `restore`. README.html shows the same
  steps and both commands.

### Changed

- A bad argument to `verify` or `restore` gets a plain message and exit 2,
  instead of the hook's "compaction was blocked" message.
- `verify` and `restore` read `index.jsonl` through one shared reader.
  `verify`'s output and exit codes are unchanged.

Hook mode, its settings and its exit codes are unchanged, so existing hook
configurations keep working.

## 0.1.0 — 2026-09-23

First release. A Claude Code `PreCompact` hook that saves an exact copy of the
transcript, checks the copy by SHA-256, writes a receipt to `index.jsonl`, and
blocks the compaction (exit 2) if any step fails. `verify` re-checks every
saved copy against its receipt.
