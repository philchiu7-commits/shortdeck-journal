# Short Deck Journal — edit backlog

Local git only — **no GitHub remote yet** (confirm before creating one).
Intended Pages URL once a remote exists:
https://philchiu7-commits.github.io/shortdeck-journal/

Deploy is **manual**: bump `CACHE` in `sw.js`, commit, then (once a remote
exists) `git push origin main`. Never skip the cache bump — the SW is
cache-first, so installed phones keep the old assets otherwise. See `CLAUDE.md`.

---

## Open

- [ ] Decide on `.claude/launch.json` — either `git add .claude/launch.json` (so
      a clone gets the preview config) or add `.claude/` to `.gitignore`.

---

## How to work on this repo

Run Claude Code from `/Users/phil/shortdeck-journal` so `CLAUDE.md` auto-loads:

```bash
cd /Users/phil/shortdeck-journal && claude
```

(The v55–v58 changelog that used to live here was inherited verbatim from the
poker-journal parent and described that repo's work; this repo's own history is
in `git log`.)
