# compaction-guard — agent notes

Keep `AGENTS.md` and `CLAUDE.md` identical; edit both. The portfolio rules in
`Dev/CLAUDE.md` still apply; this file narrows them.

## What this is

A Claude Code `PreCompact` hook that copies the transcript, checks the copy by
SHA-256, writes a receipt, and blocks compaction (exit 2) if any step fails.
One file, `compaction-guard.mjs`. Node.js 18+, no dependencies.

## Rules

- **Written fresh. Never copy code from Keegan's private projects, such as
  Assembly.** Build from public behavior and documentation only. Before a release, compare lines against `Dev/assembly/src` (a check done
  on 2026-09-23 found only imports and loop headers in common).
- **License is FSL-1.1-MIT.** Call it "source-available", never "open source".
  Don't change the license, or add a dependency whose license conflicts with it,
  without Keegan.
- **No dependencies.** Node built-ins only.
- **Privacy.** Archives hold whole conversations. Never commit an archive, a
  real transcript, or real output from one. Test fixtures are synthetic.
- **Hook contract.** In hook mode stdout stays empty (Claude Code parses it as
  a decision); status goes to stderr. Exit 0 = continue, 1 = failed but
  fail-open, 2 = block. Keep the reason plain English.
- **Publishing.** Keegan publishes the repo and every release. Commit
  locally; never push, tag or publish without Keegan's say-so.
- **Docs ship in two forms.** `README.md` for detail, `README.html` beside it
  for a person. Update both together, including the "What was verified" facts.

## Verify

```sh
npm test                       # 19 tests, node:test
npx -y node@18 --test          # oldest supported Node
```

A change to the hook path also gets a live run: install the hook in a
throwaway folder with `claude --settings <file>`, run `/compact`, then
`node compaction-guard.mjs verify --dir <archive>`.
