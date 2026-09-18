# Poker Journal — edit backlog

Repo: https://github.com/philchiu7-commits/poker-journal
Live site auto-deploys from `main` to GitHub Pages.

---

## Open

Nothing outstanding from the July 27 spec. Repo housekeeping only:

- [ ] Decide on `.claude/launch.json` — either `git add .claude/launch.json` (so anyone who clones gets the preview config) or add `.claude/` to `.gitignore`.

## Done in this session

**v55** — lineup polish
- 4-handed & 5-handed table options; 6-max now shows exactly 6 positions
- Lineup pool bucketed by opponent `group`; search hides empty groups
- Lineup edits reseed the Table tab when the current hand is fresh

**v56** — Group 1 bugs
- #8 More bottom padding so the tab bar can't hide the last list item
- #9 "Limp width" → "Limp with"
- #11a Scale-slider write: 50ms debounce + change-event save + pagehide flush
- #18 Verified in code as already increment-only

**v57** — Group 2 layout & UI
- #1+#6 Table seats = lineup array length (dynamic `slotsFor(n)`)
- #3 Hero renders at their actual ring position (no more bottom pinning)
- #2 Drag-to-reorder lineup (HTML5 DnD + touch fallback)
- #4 One row per villain with fixed 90px name column + card slots, no wrap
- #10 Board suit shorthand: `JT9s` / `JT9m` / `JT9r`
- #14 Hide reads with value 0 or unset
- #19 Global "Show exploits on list" toggle in opponents header

**v58** — Groups 3-5
- #5 Squid indicator shows live "X/Y" from lineup + reads
- #20 `V{n}L` → "vs {n} limpers" in note parser
- #7 3bet row: added "Bluff" bubble
- #17 Range row: dropped "Bad polar"
- #11b/#12/#15/#16 four new reads (Limps are weak, PFR OOP cbet, EP Open weak, Attack limped blinds) with exploit rules
- #13 Per-read confidence 0-5 chip; auto-defaults to 3 when a read is set; hides at 0

---

## How to work on this repo

Run Claude Code from `/Users/phil/poker-journal` so `CLAUDE.md` auto-loads:

```bash
cd /Users/phil/poker-journal && claude
```
