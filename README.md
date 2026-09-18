# Short Deck Journal

Live opponent journal for short-deck (6+) hold'em, forked from
[poker-journal](https://github.com/philchiu7-commits/poker-journal). Vanilla
HTML/JS/CSS PWA, IndexedDB storage, offline via service worker.

What's different from the hold'em journal:

- **Ante-only game model.** One `ante` field per hand; every seat antes, the
  button posts double (`BTN 2×`). Call/limp price = one ante. Open sizes are
  in antes (`3a`…`6a`).
- **9-max ring `U9…U4 / HJ / CO / BN`**, UTG first on every street, button last.
- **36-card deck** (`A…6`), evaluator knows flush > full house and A-6-7-8-9.
- **Ranges panel** on every opponent: paint an estimated preflop range per
  position bucket (EP/MP/HJ/CO/BTN) and situation (first in / vs limp / vs
  raise). Showdown hands overlay as dots so the estimate can be checked.
- **Reads list is a small starter set** — add ids in `vocab.js` as they come up
  (see the header comment there).

Local preview: `python3 -m http.server 8003` in this folder.
