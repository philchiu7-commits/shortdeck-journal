# Short Deck Journal — repo guide for Claude Code

Short-deck (6+ hold'em) opponent journal PWA, forked from ~/poker-journal
(same architecture; see "Short-deck differences" below before touching game logic). Vanilla HTML/JS/CSS, no build step, IndexedDB
for storage, service-worker cache for offline. Installed on Phil's iPhone via
Safari "Add to Home Screen".

## Deploying

Deploy = **bump `CACHE` in `sw.js`, commit, `git push origin main`**. GitHub
Pages (legacy build, `main` branch root) serves at
https://philchiu7-commits.github.io/shortdeck-journal/ ~60–90s after push. All app
paths are relative so the `/shortdeck-journal/` subpath just works. Verify with:

```bash
curl -s https://philchiu7-commits.github.io/shortdeck-journal/sw.js | sed -n 2p
```

**Never skip the cache bump.** The SW is cache-first — installed phones will
keep serving the old assets otherwise. Current cache: see `sw.js` line 2.

**A cache bump needs two reloads.** The first reload is still served by the old
worker while the new one installs, activates and claims the page; the second
reload gets the new assets. Only the second one proves a deploy landed — don't
read the first as a failed deploy and bump again.

## Local preview

Launch config `shortdeck-journal` in `.claude/launch.json` runs
`python3 -m http.server 8003`. Prefer `preview_start` over `Bash` for the
server. To test a change against fresh assets in the preview:

```js
// in the preview's JS console, then reload
(async () => {
  for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
  for (const k of await caches.keys()) await caches.delete(k);
})()
```

## Code layout

- `index.html` — one page, six `<section id="view-*">` blocks (opponents,
  opp-detail, hand-entry, table, hand-detail, data). Hash-routing. The Table
  tab shows tonight's seat-ring lineup (same `tableLineup` meta as hand
  entry's Lineup sheet) with each opponent's front-page card chips; its
  renderer is `renderTableTab` (`renderTable` is the hand-entry felt).
- `app.js` — all UI + business logic, ~4650 lines. Renderers are named
  `render*` and are cheap to re-run; state lives in module globals (`draft`,
  `sheetGroup`, etc.). Sheets are one shared `#sheet` element; dispatch by
  `sheetGroup` string (`"__act__"`, `"__seat__"`, …).
- `db.js` — IndexedDB wrapper + JSON export/import. Same-id opponents
  union-merge on import (reads/exploits/notes from both devices survive;
  newer record wins conflicts) via `mergeOppRecords`. **v30+ also merges
  opponents by exact name match** so bulk imports don't dupe existing
  profiles. Hands/sessions stay plain newer-wins by id — so edit any given hand or
  session on only one device between backups; a concurrent edit on the other
  device is silently overwritten by whichever export is imported later.
- `vocab.js` — positions, tendency-tag ids, action tokens, sizes, card list.
  **Tag ids are stable — never rename.** Adding a tag = safe; renaming an id
  breaks every opponent's saved reads. The header comment documents how Phil
  adds a read (id + cat + label, optional EXPLOIT_RULES / PILL_READS entry).
  Read kinds: default yes/no cycle, `scale` (slider), `position` (seat
  dropdown), `choice` (one-of-N chips via `options`, e.g. `limp-width`).
  Street triads (F/T/R rows) are declared in `READ_GROUPS` in app.js.
- `sw.js` — install/activate/fetch. Uses `cache: "reload"` on install so
  phones fetch fresh assets on version bump. The activate sweep is filtered to
  `PREFIX` (`shortdeck-`) — Cache Storage is keyed per **origin**, not per SW
  scope, and the sibling PWAs (poker-journal, range-lab, squid-web) share
  `philchiu7-commits.github.io`, so an unfiltered sweep would delete their
  offline caches. Keep `CACHE` starting with `PREFIX`.
- `pinyin.js` — Chinese-name search helper for the opponents list.

## Short-deck differences (vs poker-journal)

- **No blinds.** `hand.blinds = { ante }` and `hand.seats`; the button's double
  ante is implied (`BTN 2×`). `estimatePot` treats every ante as dead money
  and the button's extra ante as its live preflop contribution. Limp/call
  price = one ante. Open sizes are in antes (`"4a"`), parsed in `estimatePot`.
- **Ring** `POSITIONS = U9…U4, HJ, CO, BN`; `ringFor(n)` builds an n-max ring;
  `posBucket` → EP (U6+), MP (U4/U5), HJ, CO, BTN. UTG first every street.
- **Deck** `RANKS = "AKQJT9876"`; `score5` ranks flush > full house and
  A-6-7-8-9 as the lowest straight.
- **Ranges panel** (`renderRanges`, `bindRangeGrid`): `opponent.ranges =
  { BTN|CO|HJ|MP|EP: { open|vslimp|vsraise: { "AKs": act } } }`. Unpainted =
  unknown, never fold. `rangeEvidence` classifies showdown hands by what
  preceded the villain's first preflop action and overlays them as dots.
  Painting is pointer-driven (tap, drag with gap interpolation, same-brush
  tap erases); saves via `dbPut("opponents")`. Import merges ranges cell-wise.
- Squid (crazy-squid side game) code is still present but its ctxbar buttons
  are hidden; the Data tab keeps the squid history.
- DB name `shortdeck-journal`, localStorage mirror `sdj.meta.`, export tag
  `app: "shortdeck-journal"` — deliberately distinct so it never shares data
  with poker-journal on the same GitHub Pages origin.

## Data model

- `opponents`: `{id, name, group?, physical?, reads: {tagId: "yes"|"no"|…},
  exploits: [{id, ts, text, src?}], featured?: [{type,id}], notes: [...],
  ranges?: {bucket: {situation: {handClass: act}}}}`.
- `hands`: `{id, ts, opponentId?, villains: [{opponentId, seat, pos, cards}], hero:
  {seat, pos}, actions: [{street, actor, act, size?}], board: [...],
  blinds: {ante}, seats, effstack, mode: "chips"|"table", ...}`.
- The **structured `actions[]` token stream** is the format the v2 exploit
  engine will consume (VPIP-ish, fold-to-cbet, 3bet freq per villain) and
  what `handText()` *would* serialize for LLM summaries (that serializer
  is defined but currently unused — kept for a planned summary export).
  Don't collapse it into a string.

## Hand entry — recent shape

Main page: mode toggle, ctxbar (Ante/Eff), villains, positions,
board+cards, Save — **plus one gradient "＋ Add action" pill** that opens a
bottom sheet with the street/actor/action/size controls. Sheet stays open
across taps; street auto-close chains straight into the board-picker sheet.

The dispatch pattern: `handActionClick(b)` is called from both the main
`#view-hand` click handler and from `sheetClick` when `sheetGroup ===
"__act__"`. Add new action-pad behaviour in `handActionClick`, not in either
caller.

## Conventions I keep hitting

- Terse code, no explanatory comments beyond a short "why" when non-obvious.
- Don't create planning/analysis `.md` files unless asked.
- Verify UI changes in the browser preview before saying "done" — use the
  Browser tools, not "please check". Screenshot for visual proof.
- One commit per shipped change; commit message describes the user-visible
  behaviour, not the diff.

## Related context

- `~/.claude/projects/-Users-phil/memory/reference_poker_journal_shorthand.md`
  — Phil's dictation shorthand for building import JSON from paste-dumps.
- `~/.claude/projects/-Users-phil/memory/project_poker_journal.md` — broader
  project history and decisions.
