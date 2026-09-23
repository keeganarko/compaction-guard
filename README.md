# compaction-guard

Before an AI coding agent compacts its conversation, compaction-guard saves an
exact copy, checks the copy by hash, and blocks the compaction if the save
fails.

Version 0.1.0 works with Claude Code. It has one file and no dependencies, and
needs Node.js 18 or later. It is source-available under FSL-1.1-MIT, not open
source; see [License](#license). The picture version of this page is
[README.html](README.html).

## Why

A coding agent can only hold so much conversation. Near that limit, Claude Code
compacts: it replaces the conversation with a summary and carries on from
there. The agent no longer sees anything the summary leaves out.

compaction-guard makes a checked copy of the full transcript at the moment of
each compaction. It keeps the copy outside the agent's own storage, so the copy
survives if that storage is cleaned up or changed. If the copy can't be made
and checked, the compaction doesn't happen.

The background is in the post
[Agents need direction more than anything](https://www.keegan-studio.com/writing/agents-need-direction.html).

## How it works

Claude Code runs compaction-guard as a `PreCompact` hook. It passes JSON on
stdin that includes `session_id`, `transcript_path`, `cwd`, `hook_event_name`
and `trigger` (`manual` for `/compact`, `auto` near the limit). Then:

1. Stream the transcript into a new temporary file in the archive, computing
   its SHA-256 while reading. Flush the file to disk.
2. Compare the transcript's size and modification time before and after the
   copy. If either changed, discard the copy and try again, up to three times.
3. Rename the copy into place and flush the directory.
4. Read the saved copy back and check that its size and hash match what was
   read.
5. Append a receipt to `index.jsonl` and flush it.
6. Exit 0, and the compaction goes ahead.

If any step fails, it exits 2 with a plain reason on stderr, and Claude Code
blocks the compaction. Nothing is lost.

## Install

```sh
git clone https://github.com/keeganarko/compaction-guard.git
cd compaction-guard
npm test
```

Add the hook to `~/.claude/settings.json` (every project) or to a project's
`.claude/settings.json`. Use the absolute path to your clone:

```json
{
  "hooks": {
    "PreCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/compaction-guard/compaction-guard.mjs"
          }
        ]
      }
    ]
  }
}
```

Without a `matcher` the hook runs on both manual and automatic compaction. Add
`"matcher": "manual"` to guard only `/compact`. The same file is in
[examples/claude-settings.json](examples/claude-settings.json).

To check it: run `/compact` in Claude Code, then run
`node compaction-guard.mjs verify`.

## Archive

```text
~/.compaction-guard/
  index.jsonl                                  one receipt per saved copy
  <project>/<session_id>/<UTC time>-<trigger>-<random>.jsonl
```

`<project>` is the name of the folder Claude Code keeps the transcript in. On
macOS and Linux, folders are created `0700` and files `0600`. On Windows, the
archive inherits its folder's permissions.

A receipt looks like this:

```json
{"version":1,"saved_at":"2026-09-23T10:28:47.620Z","session_id":"89b0ab10-…","trigger":"manual","source":"/home/you/.claude/projects/<project>/89b0ab10-….jsonl","archive":"<project>/89b0ab10-…/2026-09-23T10-28-47-606Z-manual-3a85e6b1.jsonl","bytes":248342,"sha256":"2b068bef…"}
```

`archive` is relative to the archive folder, so you can move the whole folder.

## Check the archive

```sh
node compaction-guard.mjs verify
```

`verify` hashes every copy named in `index.jsonl` again. It reports each one
as verified, missing, changed, or invalid (unreadable, or pointing outside the
archive). It exits 0 only if every receipt is verified.

## Configuration

| Setting | Effect |
|---|---|
| `--dir <path>` | Archive folder. Wins over the variable below. |
| `COMPACTION_GUARD_DIR` | Archive folder, if `--dir` isn't given. The default is `~/.compaction-guard`. Use an absolute path. |
| `COMPACTION_GUARD_FAIL_OPEN=1` | If a save fails, let compaction continue anyway (exit 1) instead of blocking it (exit 2). |

## Exit codes

| Mode | Code | Meaning |
|---|---|---|
| hook | 0 | Saved and checked, or the event wasn't `PreCompact`. Compaction continues. |
| hook | 1 | The save failed and fail-open is set. Compaction continues without a copy. |
| hook | 2 | The save failed. Claude Code blocks the compaction and shows the reason. |
| verify | 0 | Every receipt verified, or there are no receipts yet. |
| verify | 1 | At least one copy is missing or changed, or a receipt is invalid. |
| verify | 2 | The archive couldn't be read. |

In hook mode stdout stays empty, because Claude Code reads hook stdout as a
decision. Status goes to stderr.

## Before you install

- **Blocking an automatic compaction can fail your request.** Claude Code's
  [hooks documentation](https://code.claude.com/docs/en/hooks) says that if a
  hook blocks an automatic compaction that was recovering from a context-limit
  error, that request fails. The usual causes are a full disk or a folder you
  can't write to. Fix the cause, or set `COMPACTION_GUARD_FAIL_OPEN=1`.
- **The archive holds whole conversations.** That means code, file contents,
  and anything pasted into the chat, including secrets. It stays on your
  machine. Don't put it in a synced or shared folder, and never commit it.
- **Nothing is deleted.** Every compaction adds a copy, so disk use grows.
  Prune old copies yourself; `verify` will then list their receipts as missing.
- **It copies; it doesn't restore.** It never reads, summarizes or restores a
  conversation.
- **Claude Code only, for now.** Other agents have their own hooks, but they
  haven't been checked for this.

## What was verified

On 2026-09-23:

- `npm test`: 19 of 19 tests pass on Linux (WSL2) with Node.js 18.20.8,
  20.20.2 and 24.19.0. On Windows with Node.js 24.19.0, 17 pass and the 2
  POSIX-only tests (file modes, unwritable folder) are skipped.
- Live run in Claude Code 2.1.280 with the hook installed. `/compact` saved the
  transcript (248,342 bytes), and `verify` confirmed it.
- Live failure run: with the archive folder unwritable, Claude Code printed
  "Compaction blocked by PreCompact hook" with the reason, and no compaction
  was written to the transcript.

Not verified yet: macOS, and the retry when the transcript changes during the
copy (it has no automated test).

## License

Copyright 2026 Keegan Choudhury. Licensed under the
[Functional Source License, Version 1.1, MIT Future License](LICENSE.md)
(FSL-1.1-MIT).

In plain words: you can read, use, change and share this code for any purpose
except a Competing Use. That means making it available to others in a
commercial product or service that substitutes for it (or for a product of
ours that uses it), or that offers the same or substantially similar
functionality. Two years after each version is released, that version is
also available under the MIT license. LICENSE.md has the terms that apply; this
summary doesn't replace them.

FSL is "Fair Source", not open source. This project calls itself
source-available.
