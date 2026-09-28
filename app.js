/* app.js — routing, views, and the hand-entry state machine. */

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* ---------- in-memory caches (source of truth is IndexedDB) ---------- */
let OPP = [], HANDS = [];
let _statsCache = null;   // oppStats() memo — invalidated on every HANDS mutation
let curOppId = null, curHandId = null;
/* Hand player: a snapshot of one opponent's shown hands, in the order the Hands
   panel listed them (so the active filters carry into the review). */
let handPlay = null, handPlayIds = [];
let handFiltersFor = null;              // the opponent the hands-panel filters were set for
let proofReel = null;                   // the hand list the open drill-down sheet is showing
let editNoteId = null, editExploitId = null;
let storageDurable = false;
let showSuggestedExploits = {};   // per-opponent toggle for suggested exploits (oppId -> bool)
let showDerivedReads = {};        // per-opponent toggle for hand-derived read suggestions
let showReadEvid = {};            // per-opponent toggle: hands behind the reads already set
let showExploitSignals = {};      // per-opponent toggle: tag-free one-sided tells
let showConvertedNotes = {};      // per-opponent toggle: show notes already converted to hands
let oppEditMode = false;          // opponents list: reorder / regroup mode
let vSearch = "";                 // hand-entry villain search query
let collapsedGroups = new Set();  // opponents list: which group sections are collapsed
let pinnedGroup = null;           // opponents list: group name that always sorts first (null = auto by recency)
let tableLineup = [];             // today's seat ring, ordered: ("hero" | oppId)[] — anchors positions
let lineupSeats = 9;              // table size (6–9); picks which subset of the seat ring is in play
let openSizeStats = {};           // adaptive open-raise sizes: { [bb]: { [bbSize]: count } }
const DEFAULT_OPEN_A = [3, 4, 5, 6];   // standard short-deck open sizes, in antes
let blindsDefault = { ante: "" };   // 2/4 default; sticky once you change it
let pendingReadWrite = null;      // scale-slider write waiting on the debounce timer

const oppById = (id) => OPP.find((o) => o.id === id);

/* ---------- reads: intensity-scaled tendency toggles ----------
   Cycle: off → yes → yes! (strong) → no → no! (strong) → off. Draw-size keeps
   the 3-colour scale; "choice" reads (limp-width) pick one of their options. Legacy tags (over-folds-cbet →
   over-cbet:no, gives-up-turn → barrels-off:no, etc.) migrate on boot. */
const READ_CYCLE = {
  "size-up-draws":   ["green", "yellow", "red"],
};
const readCycle = (id) => READ_CYCLE[id] || ["yes", "yes!", "no", "no!"];
const SCALE_STAT = { "f-cbet-freq": "cbetF", "t-barrel2-freq": "cbetT", "f-xr-freq-pfr": "cr", "f-fold-to-xr": "fxr", "r-af": "afR" };
const SCALE_READS = new Set(
  (typeof TENDENCY_TAGS !== "undefined" ? TENDENCY_TAGS : []).filter((t) => t.kind === "scale").map((t) => t.id));
const isScaleRead = (id) => SCALE_READS.has(id);
const POSITION_READS = new Set(
  (typeof TENDENCY_TAGS !== "undefined" ? TENDENCY_TAGS : []).filter((t) => t.kind === "position").map((t) => t.id));
const isPositionRead = (id) => POSITION_READS.has(id);
const CHOICE_READS = Object.fromEntries(
  (typeof TENDENCY_TAGS !== "undefined" ? TENDENCY_TAGS : []).filter((t) => t.kind === "choice").map((t) => [t.id, t.options || []]));
const isChoiceRead = (id) => !!CHOICE_READS[id];
const TALLY_READS = Object.fromEntries(
  (typeof TENDENCY_TAGS !== "undefined" ? TENDENCY_TAGS : []).filter((t) => t.kind === "tally").map((t) => [t.id, t.options || []]));
const isTallyRead = (id) => !!TALLY_READS[id];
/* The six size-*-v/b tallies are drawn in the Sizings panel, not the Reads list. */
const SIZING_GRID_IDS = new Set(["flop", "turn", "river"].flatMap((s) => ["v", "b"].map((k) => `size-${s}-${k}`)));
/* Tally reads store {option: count}; every option with a count lights up, the leader is the highest. */
const tallyLeader = (counts) => {
  const entries = Object.entries(counts || {}).filter(([, n]) => n > 0);
  if (!entries.length) return null;
  return entries.reduce((a, b) => (b[1] > a[1] ? b : a));
};
const cap1 = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);
const STATE_CLASS = {
  yes: "sgreen", "yes!": "sgreen sstrong",
  no: "sred", "no!": "sred sstrong",
  green: "sgreen", yellow: "syellow", red: "sred",
};
/* Normalise strength suffix ("yes!"/"no!") to base state for exploit lookup. */
const readBase = (s) => s === "yes!" ? "yes" : s === "no!" ? "no" : s;
function oppReads(o) {
  if (!o.reads || typeof o.reads !== "object")
    o.reads = Array.isArray(o.tags) ? Object.fromEntries(o.tags.map((id) => [id, "yes"])) : {};
  return o.reads;
}
function nextReadState(id, cur) {
  const cyc = readCycle(id);
  if (!cur) return cyc[0];
  const i = cyc.indexOf(cur);
  return i < 0 || i === cyc.length - 1 ? null : cyc[i + 1];
}
/* Scale-read text label: number → tight/normal/wide bucket, for chip display. */
function scaleBucket(n) {
  const v = Number(n);
  if (!isFinite(v)) return "";
  if (v <= 20) return "tight";
  if (v <= 40) return "tightish";
  if (v <= 60) return "normal";
  if (v <= 80) return "loose";
  return "wide";
}
const readChip = (id, state) => {
  const lbl = TAG_BY_ID[id]?.label || id;
  if (isScaleRead(id)) {
    const v = Math.max(0, Math.min(100, Number(state) || 0));
    return `<span class="chip mini on sscale" title="${esc(lbl)}: ${v}/100 (${scaleBucket(v)})">${esc(lbl)} · ${v}</span>`;
  }
  if (isPositionRead(id)) {
    const disp = state === "ALL" ? "All" : state;
    return `<span class="chip mini on sgreen" title="${esc(lbl)}: ${esc(disp)}">${esc(lbl)} · ${esc(disp)}</span>`;
  }
  if (isChoiceRead(id)) {
    return `<span class="chip mini on sscale" title="${esc(lbl)}: ${esc(state)}">${esc(lbl)} · ${esc(cap1(state))}</span>`;
  }
  if (isTallyRead(id)) {
    const used = TALLY_READS[id].filter((v) => (state && state[v]) > 0);
    if (!used.length) return "";
    return `<span class="chip mini on sscale" title="${esc(lbl)}: ${esc(used.map((v) => `${v} (${state[v]})`).join(", "))}">${esc(lbl)} · ${esc(used.join(" "))}</span>`;
  }
  return `<span class="chip mini on ${STATE_CLASS[state] || ""}">${esc(lbl)}</span>`;
};
/* How the picker is organised: street -> role (As PFR / As PFC) -> When Bet / When X.
   Display only: ids, saved reads and the exploit rules never see this. A read
   listed nowhere lands in Uncategorized > Other, so nothing can go missing. Edit the
   id lists freely to move a read. Graded reads (choice / position / tally / scale)
   can be listed like any other id. */
const wb = (bet, x) => [{ label: "When Bet", ids: bet }, { label: "When X", ids: x }];
const READ_LAYOUT = [
  { title: "Preflop", subs: [{ rows: [
    { label: "Limping", ids: ["limp-width", "lc-width", "iso-width", "can-ls-light", "lrr-latest-v", "lrr-latest-b", "lc-pp"] },
    { label: "Raising", ids: ["opens-premium", "raise-earliest-v", "raise-earliest-b", "cc-width", "3bets-light", "jams-pre-light"] },
  ] }] },
  { title: "Postflop general", subs: [
    { label: "MWP limp", rows: [{ ids: ["mwl-oop-probe", "mwl-xr", "mwl-ip-stab"] }] },
  ] },
  { title: "Flop exploit", subs: [
    { label: "As PFR", rows: wb(["f-cbet-freq", "f-fold-to-xr"], ["checks-range-oop", "f-xr-freq-pfr"]) },
    { label: "As PFC", rows: [{ ids: ["f-xr-freq-pfc", "punchbag-f-pfc"] }] },
  ] },
  { title: "Turn exploit", subs: [
    { label: "As PFR", rows: wb(["t-barrel2-freq", "t-bluff-hands", "t-call-range"], ["punchbag-t-pfr"]) },
    { label: "As PFC", rows: [{ ids: ["floats-wide", "t-bet-vol", "t-call-style"] }] },
  ] },
  { title: "River exploit", subs: [
    { label: "As PFR", rows: wb(["r-bluff-lines", "r-bluff-hands", "r-af", "r-bluff-bal"], ["r-traps", "punchbag-r-pfr"]) },
    { label: "As PFC", rows: [{ ids: ["r-fold-bal", "r-to-sizing", "r-bet-vol", "r-can-raise", "r-call-range", "r-call-hands"] }] },
  ] },
  { title: "Uncategorized", subs: [{ rows: [] }] },
];

/* Value/bluff position-read pairs — shown in the picker as one compact
   "Label [V ▾][B ▾]" row instead of two separate wide dropdown boxes. */
const POS_PAIRS = [
  { label: "Latest LRR",     v: "lrr-latest-v",     b: "lrr-latest-b" },
  { label: "Earliest raise", v: "raise-earliest-v", b: "raise-earliest-b" },
];
const POS_PAIR_BY_V = Object.fromEntries(POS_PAIRS.map((p) => [p.v, p]));
const POS_PAIR_SECONDARY = new Set(POS_PAIRS.map((p) => p.b));

/* Felt villain-pill engine tag — one-word read summary shown on each seated
   villain's card. Compound rules win over singles (higher signal), and inside
   singles the PILL_READS priority list decides. Returns null → no pill row. */
function pillTag(o) {
  if (!o) return null;
  const reads = oppReads(o);
  for (const rule of COMPOUND_EXPLOIT_RULES) {
    if (!rule.pill) continue;
    const hit = rule.keys.every((k) => {
      const [tId, tState] = k.split(":");
      const cur = reads[tId];
      return cur && readBase(cur) === tState;
    });
    if (hit) return { text: rule.pill, tone: rule.tone || "gray" };
  }
  for (const p of PILL_READS) {
    const cur = reads[p.id];
    if (cur && readBase(cur) === p.state) return { text: p.pill, tone: p.tone || "gray" };
  }
  return null;
}

/* Turn the opponent's set reads into concrete exploit suggestions (EXPLOIT_RULES),
   minus any Phil has dismissed or already accepted (keys in o.exploitDismissed).
   Weighted: yes!/no! (strong) count more than yes/no; compound rules count more
   than singles. Suggestions sort best-first. Compounds require at least one
   strong key so a wall of weak reads doesn't produce a confident-looking exploit. */
const isStrongRead = (state) => state === "yes!" || state === "no!";
function suggestedExploits(o) {
  const reads = oppReads(o);
  const dismissed = new Set(o.exploitDismissed || []);
  const seen = new Set();
  const out = [];
  for (const rule of COMPOUND_EXPLOIT_RULES) {
    let anyStrong = false;
    let strongCount = 0;
    const allMatch = rule.keys.every((k) => {
      const [tId, tState] = k.split(":");
      const cur = reads[tId];
      if (!cur || readBase(cur) !== tState) return false;
      if (isStrongRead(cur)) { anyStrong = true; strongCount++; }
      return true;
    });
    if (!allMatch) continue;
    if (!anyStrong) continue;                                // compounds need ≥1 strong signal
    const key = "cmp:" + rule.id;
    if (dismissed.has(key) || seen.has(key)) continue;
    seen.add(key);
    // Compound base weight 6; +2 per additional strong key past the first.
    const weight = 6 + Math.max(0, strongCount - 1) * 2;
    out.push({ key, text: rule.label + " — " + rule.text, compound: true, weight, strong: true });
  }
  for (const [id, state] of Object.entries(reads)) {
    if (!state) continue;
    const rule = EXPLOIT_RULES[id];
    if (!rule) continue;
    const useAny = !!rule.any;
    const base = readBase(state);
    const text = useAny ? rule.any : rule[base];
    if (!text) continue;
    const key = id + ":" + (useAny ? "any" : base);
    if (dismissed.has(key) || seen.has(key)) continue;
    seen.add(key);
    // Singles: strong=4, regular=2. "any"-kind rules are position/scale reads
    // where strength doesn't apply — treat as 2.
    const weight = useAny ? 2 : (isStrongRead(state) ? 4 : 2);
    out.push({ key, text, weight, strong: isStrongRead(state) });
  }
  out.sort((a, b) => (b.weight || 0) - (a.weight || 0));
  return out;
}

/* ============ on-device learning from the logs (all offline) ============ */

/* Recency-weighted tally of a list of timestamps (half-life ≈ 30 days). Shared
   by exploit effectiveness and any future recency scoring. */
const RECENCY_HALFLIFE_MS = 30 * 864e5;
function recencyScore(tsArr) {
  const now = Date.now();
  return (tsArr || []).reduce((s, ts) => s + Math.pow(0.5, (now - (ts || now)) / RECENCY_HALFLIFE_MS), 0);
}

/* A villain's actions in one hand, bucketed by street. */
function villainStreetActs(h, actor) {
  const m = { pre: [], flop: [], turn: [], river: [] };
  for (const a of h.actions || []) if (a.actor === actor && m[a.street]) m[a.street].push(a.act);
  return m;
}

/* ============ FEATURE 1 — the hands behind every read ============
   One pass flattens a (hand, villain) pair into `facts`; a read query is then a
   one-line predicate over those facts. The same registry drives three panels:
   suggestions for reads not yet set, the hands behind reads already set, and
   the tag-free exploit signals below. Adding a detector costs one row. */

const isAgg = (a) => AGG_ACTS.includes(a);

/* DX logs every all-in as a jam, including a call for less than the bet in front of
   him. That is a call, and counted as a raise it put 30K call-offs of 211K river
   bets into Raise river and handed the preflop raise to whoever called off short.
   Only an actual all-in is rewritten: a logged raise that merely resolves under the
   bet is a misread size, not a call. The pot comes out identical either way. */
function fixCallOffs(h) {
  const acts = h.actions || [];
  if (!acts.some((a) => isAgg(a.act))) return h;
  const ep = estimatePot(h, acts);
  acts.forEach((a, i) => {
    const to = ep.perAct[i], faced = ep.pre[i].curBet;
    if (isAgg(a.act) && ep.allIn[i] && to > 0 && faced > 0 && to <= faced * 1.000001) { a.act = "call"; delete a.size; }
  });
  return h;
}

/* The size Phil actually recorded, never a reconstruction: postflop sizes come
   off a fixed chip row ("50%" → B50), so the bucket is his own reading of the
   bet. A bet logged without a size has no bucket and stays out of every sizing
   count — a guessed size would poison exactly the tell it feeds. */
function sizeBucket(a) {
  if (a.act === "jam" || a.size === "Jam") return "Jam";
  const m = /^(\d+(?:\.\d+)?)%$/.exec(a.size || "");
  if (m) return "B" + Math.round(Number(m[1]));
  return /^\d+(\.\d+)?[ax]$/i.test(a.size || "") ? String(a.size).toLowerCase() : null;
}

/* Everything a detector needs from one villain's hand. `facing` on each of his
   actions records whether a bet or raise was already out there when he acted —
   without that a hand is silent on a read rather than evidence against it. */
function handFacts(h, idx) {
  const me = "v" + idx;
  const v = (h.villains || [])[idx] || {};
  const f = {
    id: h.id, ts: h.ts || 0, pos: v.pos || null,
    cards: (v.cards || []).filter(Boolean),
    board: (h.board || []).filter(Boolean),
    s: { pre: [], flop: [], turn: [], river: [] },
    faced: { pre: false, flop: false, turn: false, river: false },
    xt: { flop: false, turn: false, river: false },      // checked to: a check in front, no bet out
    lead: { flop: false, turn: false, river: false },    // first player to act on the street
    md: { flop: null, turn: null, river: null },         // his hand vs the board as of that street
    pfr: false, limpedFirst: false, isoSpot: false, sd: false, won: null,
  };
  const open = { pre: false, flop: false, turn: false, river: false };
  const acted = { pre: false, flop: false, turn: false, river: false };
  const checked = { pre: false, flop: false, turn: false, river: false };
  let sawLimp = false, first = true, lastPreAgg = null;
  for (const a of h.actions || []) {
    if (!f.s[a.street]) continue;
    if (a.actor === me) {
      if (open[a.street]) f.faced[a.street] = true;
      if (!f.s[a.street].length && a.street !== "pre") {
        f.lead[a.street] = !acted[a.street];
        f.xt[a.street] = checked[a.street] && !open[a.street];
      }
      f.s[a.street].push({ act: a.act, size: a.size || "", bucket: sizeBucket(a), facing: open[a.street] });
      if (first) { f.limpedFirst = a.act === "limp"; f.isoSpot = sawLimp; first = false; }
    } else if (a.street === "pre" && a.act === "limp" && first) sawLimp = true;
    if (isAgg(a.act)) { open[a.street] = true; if (a.street === "pre") lastPreAgg = a.actor; }
    if (a.act === "check") checked[a.street] = true;
    acted[a.street] = true;
  }
  f.pfr = lastPreAgg === me;
  /* Where his hand stood on each street, so "bluff" is asked against the board
     he had in front of him and not the river runout. */
  if (f.cards.length === 2)
    for (const [st, n] of [["flop", 3], ["turn", 4], ["river", 5]])
      if (f.board.length >= n) f.md[st] = madeTier(f.cards, f.board.slice(0, n));
  const win = handWinner(h);
  if (win && win.how === "showdown") { f.sd = true; f.won = win.winners.includes(me); }
  return f;
}
function oppFacts(o, hands) {
  hands = hands || HANDS.filter((h) => (h.villainIds || []).includes(o.id));
  const out = [];
  for (const h of hands) {
    const i = (h.villains || []).findIndex((x) => x.opponentId === o.id);
    if (i >= 0) out.push(handFacts(h, i));
  }
  return out;
}

/* --- readers over facts, so every registry row stays one line --- */
const fActs = (f, st) => f.s[st].map((x) => x.act);
const fDid = (f, st, ...a) => f.s[st].some((x) => a.includes(x.act));
const fFired = (f, st) => f.s[st].some((x) => isAgg(x.act));
const fActed = (f, st) => f.s[st].length > 0;
const fLed = (f, st) => f.s[st].some((x) => x.act === "bet" && !x.facing);
const fCheckRaised = (f, st) => { const a = fActs(f, st); const i = a.indexOf("check"); return i >= 0 && a.slice(i + 1).some(isAgg); };
const fLimpRR = (f) => f.limpedFirst && fActs(f, "pre").slice(1).some(isAgg);
const fOpened = (f) => f.s.pre.some((x) => isAgg(x.act) && !x.facing);
/* He put in the first raise and then had one come back at him. */
const fFacedRR = (f) => { const a = f.s.pre, i = a.findIndex((x) => isAgg(x.act) && !x.facing); return i >= 0 && a.slice(i + 1).some((x) => x.facing); };
const fBucket = (f, st) => { const x = f.s[st].find((y) => isAgg(y.act) && y.bucket); return x ? x.bucket : null; };
const fPair = (f) => f.cards.length === 2 && f.cards[0][0] === f.cards[1][0];
/* Where his hand sits against the board, as of the street he bet on. Phil's
   short-deck ladder, 2026-09-22 — 6+ runs hotter than hold'em, so the value
   line climbs street by street: on the flop top pair is still value, but from
   the turn on any one-pair hand is a bluff and value starts at two pair. A
   bluff does NOT have to have lost at showdown, or reach showdown at all — if
   his cards and that street's board are logged the hand is gradeable. Four to
   a straight or four to a flush drops even two pair to a bluff; only trips or
   better survives it. The polar ends are the no-pair hands and two-pair-plus;
   one pair is the merged middle. Pairs that live entirely on the board are not
   his. */
const SD_CARDRE = /^[6-9TJQKA][cdhs]$/;
const SD_RUNS = [[6,7,8,9,10],[7,8,9,10,11],[8,9,10,11,12],[9,10,11,12,13],[10,11,12,13,14],[14,6,7,8,9]];
/* Four to a straight or four to a flush — a three-card flop can never show it. */
function sdScary(board) {
  const rk = new Set(board.map((c) => RVAL[c[0]]));
  const su = {};
  for (const c of board) su[c[1]] = (su[c[1]] || 0) + 1;
  return SD_RUNS.some((w) => w.filter((r) => rk.has(r)).length >= 4) || Math.max(0, ...Object.values(su)) >= 4;
}
function madeTier(hole, board) {
  if (!hole || hole.length !== 2 || board.length < 3) return null;
  const all = hole.concat(board);
  if (!all.every((c) => SD_CARDRE.test(String(c))) || new Set(all).size !== all.length) return null;
  const s = best7(all);
  if (board.length === 5 && cmpScore(s, best7(board)) === 0) return null;   // playing the board: says nothing
  /* Flop wants top pair, turn and river want two pair. */
  const out = (tier, ownPair) => ({ tier, ownPair, value: board.length === 3 ? tier >= 2 : tier >= 4 });
  const hv = hole.map((c) => RVAL[c[0]]);
  const bv = [...new Set(board.map((c) => RVAL[c[0]]))].sort((a, b) => b - a);
  const cnt = {};
  for (const c of all) cnt[RVAL[c[0]]] = (cnt[RVAL[c[0]]] || 0) + 1;
  const mine = [...new Set(hv.filter((v) => cnt[v] >= 2))];                 // his own paired ranks
  if (s[0] >= 4) return out(4, true);                                      // straight, flush, boat, quads
  if (s[0] === 3) return out(mine.length ? 4 : 0, !!mine.length);          // trips beat a scary board
  if (sdScary(board)) return out(0, !!mine.length);                        // two pair or worse is a bluff here
  if (s[0] === 2 && mine.length === 2) return out(4, true);                // his own two pair
  if (!mine.length) return out(0, false);                                  // board pairs only, or no pair
  const p = Math.max(...mine);
  if (hv[0] === hv[1]) {                                                   // pocket pair
    const above = bv.filter((v) => v > p).length;
    return out(above === 0 ? 3 : above === 1 ? 1 : 0, true);
  }
  const idx = bv.indexOf(p);                                               // 0 = top pair
  return out(idx === 0 ? 2 : idx === 1 ? 1 : 0, true);
}
const mdValue = (m) => !!m && m.value;                 // clears that street's bar
const mdBluff = (m) => !!m && !m.value;
const mdStrong = (m) => !!m && m.tier >= 4;            // two pair or better: the top end of a polar range
const mdAir = (m) => !!m && !m.ownPair;                // no pair of his own: the bottom end
const fMade = (f, st) => f.md[st];
const fBluffed = (f, st) => mdBluff(f.md[st]);
const fValue = (f, st) => mdValue(f.md[st]);
/* Raised that street with a hand that isn't a bluff (value, or cards unknown): not evidence of bluff-raising either way. */
const fRaisedValue = (f, st) => fDid(f, st, "raise", "jam") && !fBluffed(f, st);
/* The street he actually put money in on, latest first — the hand's own verdict. */
const fBetSt = (f) => STREETS3.filter((st) => fFired(f, st) && f.md[st]).pop() || null;
const fBetMade = (f) => { const st = fBetSt(f); return st ? f.md[st] : null; };
/* Same idea for the big streets only, where polar-vs-merged is decided. */
const fBetLate = (f) => (fFired(f, "river") && f.md.river) || (fFired(f, "turn") && f.md.turn) || null;

/* A bucket as a number so sizes can be compared: "Jam" sits above every %. */
const bPct = (b) => { if (b === "Jam") return 999; const m = /^B(\d+)$/.exec(b || ""); return m ? Number(m[1]) : null; };
const fSmallB = (f, st) => { const b = fBucket(f, st); return b === "B25" || b === "B33" ? b : null; };
/* One representative late-street size per hand: the turn bet if he sized one,
   otherwise the river. Merged/polar are about how he bets big streets. */
const fLateB = (f) => fBucket(f, "turn") || fBucket(f, "river");
const STREETS3 = ["flop", "turn", "river"];
const ST_NAME = { pre: "Preflop", flop: "Flop", turn: "Turn", river: "River" };

/* Thresholds stay high: Phil logs the interesting hands, so the sample is small
   and biased and a low bar fires noise. A row without `th` is never suggested —
   it exists only to answer "show me the hands behind this read". */
const READ_EVIDENCE = [
  // ---- preflop ----
  { id: "3bets-light", state: "yes", th: 5, yes: "3-bet", no: "Faced a raise, didn't 3-bet",
    chance: (f) => f.faced.pre, did: (f) => fDid(f, "pre", "3bet") },
  { id: "over-folds-3bet", state: "yes", th: 4, yes: "Folded to the reraise", no: "Faced a reraise, didn't fold",
    chance: fFacedRR, did: (f) => f.s.pre.some((x) => x.act === "fold" && x.facing) },
  { id: "jams-pre-light", state: "yes", th: 4, yes: "Jammed over a raise", no: "Faced a raise, didn't jam",
    chance: (f) => f.faced.pre, did: (f) => fDid(f, "pre", "jam") },
  { id: "iso-raises-limps", state: "yes", th: 4, yes: "Raised over the limps", no: "Limps in front, didn't raise",
    chance: (f) => f.isoSpot, did: (f) => f.s.pre[0] && isAgg(f.s.pre[0].act) },
  { id: "limp-caller", state: "yes", th: 5, yes: "Limped, then called a raise", no: "Limped, didn't call a raise",
    chance: (f) => f.limpedFirst && f.faced.pre, did: (f) => f.s.pre.some((x) => x.act === "call" && x.facing) },
  { id: "calls-raises-wide", state: "yes", th: 6, yes: "Called a raise", no: "Faced a raise, didn't call",
    chance: (f) => f.faced.pre, did: (f) => f.s.pre.some((x) => x.act === "call" && x.facing) },
  { id: "can-ls-light", state: "yes", th: 3, yes: "Limped, then shoved", no: "Limped, didn't shove",
    chance: (f) => f.limpedFirst, did: (f) => fActs(f, "pre").slice(1).includes("jam") },
  { id: "lc-pp", state: "yes", th: 3, yes: "Limp-called a pocket pair", no: "Limp-called something else",
    chance: (f) => f.cards.length === 2 && f.limpedFirst && f.s.pre.some((x) => x.act === "call" && x.facing), did: fPair },
  { id: "limp-width", yes: "Limped in", no: "", chance: (f) => fActed(f, "pre"), did: (f) => f.limpedFirst },
  { id: "lc-width", yes: "Limped, then called", no: "Limped, then folded or raised",
    chance: (f) => f.limpedFirst && f.faced.pre, did: (f) => f.s.pre.some((x) => x.act === "call" && x.facing) },
  { id: "cc-width", yes: "Cold-called a raise", no: "Faced a raise, didn't call",
    chance: (f) => f.faced.pre && !f.limpedFirst, did: (f) => f.s.pre.some((x) => x.act === "call" && x.facing) },
  { id: "iso-width", yes: "Raised over the limps", no: "Limps in front, didn't raise",
    chance: (f) => f.isoSpot, did: (f) => f.s.pre[0] && isAgg(f.s.pre[0].act) },
  { id: "opens-premium", yes: "Opened and showed", no: "Opened, never showed",
    chance: fOpened, did: (f) => f.cards.length === 2 },
  // ---- postflop: what he does facing a bet ----
  { id: "station-f", state: "yes", th: 5, yes: "Called the flop", no: "Faced a flop bet, didn't call",
    chance: (f) => f.faced.flop, did: (f) => fDid(f, "flop", "call") },
  { id: "station-t", state: "yes", th: 5, yes: "Called the turn", no: "Faced a turn bet, didn't call",
    chance: (f) => f.faced.turn, did: (f) => fDid(f, "turn", "call") },
  { id: "station-r", state: "yes", th: 5, yes: "Called the river", no: "Faced a river bet, didn't call",
    chance: (f) => f.faced.river, did: (f) => fDid(f, "river", "call") },
  { id: "bluff-raise-f", state: "yes", th: 4, yes: "Bluff-raised a flop bet", no: "Faced a flop bet, didn't bluff-raise",
    chance: (f) => f.faced.flop && !fRaisedValue(f, "flop"), did: (f) => fDid(f, "flop", "raise", "jam") && fBluffed(f, "flop") },
  { id: "bluff-raise-t", state: "yes", th: 3, yes: "Bluff-raised a turn bet", no: "Faced a turn bet, didn't bluff-raise",
    chance: (f) => f.faced.turn && !fRaisedValue(f, "turn"), did: (f) => fDid(f, "turn", "raise", "jam") && fBluffed(f, "turn") },
  { id: "bluff-raise-r", state: "yes", th: 3, yes: "Bluff-raised a river bet", no: "Faced a river bet, didn't bluff-raise",
    chance: (f) => f.faced.river && !fRaisedValue(f, "river"), did: (f) => fDid(f, "river", "raise", "jam") && fBluffed(f, "river") },
  { id: "br-fdsd", yes: "Bluff-raised a flop bet", no: "Faced a flop bet, didn't bluff-raise",
    chance: (f) => f.faced.flop && !fRaisedValue(f, "flop"), did: (f) => fDid(f, "flop", "raise", "jam") && fBluffed(f, "flop") },
  { id: "br-worst", yes: "Bluff-raised a flop bet", no: "Faced a flop bet, didn't bluff-raise",
    chance: (f) => f.faced.flop && !fRaisedValue(f, "flop"), did: (f) => fDid(f, "flop", "raise", "jam") && fBluffed(f, "flop") },
  { id: "call-nut-ip-f", yes: "Called the flop", no: "Faced a flop bet, didn't call", chance: (f) => f.faced.flop, did: (f) => fDid(f, "flop", "call") },
  { id: "call-nut-ip-t", yes: "Called the turn", no: "Faced a turn bet, didn't call", chance: (f) => f.faced.turn, did: (f) => fDid(f, "turn", "call") },
  { id: "call-nut-ip-r", yes: "Called the river", no: "Faced a river bet, didn't call", chance: (f) => f.faced.river, did: (f) => fDid(f, "river", "call") },
  { id: "call-nut-oop-f", yes: "Called the flop", no: "Faced a flop bet, didn't call", chance: (f) => f.faced.flop, did: (f) => fDid(f, "flop", "call") },
  { id: "call-nut-oop-t", yes: "Called the turn", no: "Faced a turn bet, didn't call", chance: (f) => f.faced.turn, did: (f) => fDid(f, "turn", "call") },
  { id: "call-nut-oop-r", yes: "Called the river", no: "Faced a river bet, didn't call", chance: (f) => f.faced.river, did: (f) => fDid(f, "river", "call") },
  { id: "raise-nuts-f", yes: "Raised the flop", no: "Faced a flop bet, didn't raise", chance: (f) => f.faced.flop, did: (f) => fDid(f, "flop", "raise", "jam") },
  { id: "raise-nuts-t", yes: "Raised the turn", no: "Faced a turn bet, didn't raise", chance: (f) => f.faced.turn, did: (f) => fDid(f, "turn", "raise", "jam") },
  { id: "raise-nuts-r", yes: "Raised the river", no: "Faced a river bet, didn't raise", chance: (f) => f.faced.river, did: (f) => fDid(f, "river", "raise", "jam") },
  { id: "overplays-tp", yes: "Called a river bet", no: "Faced a river bet, didn't call", chance: (f) => f.faced.river, did: (f) => fDid(f, "river", "call") },
  { id: "pays-off-fh", yes: "Called a river bet", no: "Faced a river bet, didn't call", chance: (f) => f.faced.river, did: (f) => fDid(f, "river", "call") },
  { id: "chases-draws", yes: "Called a flop or turn bet and took another card", no: "Faced the bet, didn't continue",
    chance: (f) => f.faced.flop || f.faced.turn,
    did: (f) => (fDid(f, "flop", "call") && fActed(f, "turn")) || (fDid(f, "turn", "call") && fActed(f, "river")) },
  // ---- postflop: what he does with the betting lead ----
  { id: "over-cbet", state: "yes", th: 5, yes: "Raised pre, then bet the flop", no: "Raised pre, didn't bet the flop",
    chance: (f) => fOpened(f) && fActed(f, "flop"), did: (f) => fDid(f, "flop", "bet") },
  { id: "barrels-off", state: "no", th: 5, yes: "Bet the flop, then gave up", no: "Bet the flop, kept firing",
    chance: (f) => fDid(f, "flop", "bet") && fActed(f, "turn"), did: (f) => fDid(f, "turn", "check", "fold") },
  { id: "barrels-off", state: "yes", th: 5, yes: "Fired all three streets", no: "Got to the river without firing it",
    chance: (f) => fFired(f, "flop") && fActed(f, "river"), did: (f) => fFired(f, "flop") && fFired(f, "turn") && fFired(f, "river") },
  { id: "floats-wide", state: "yes", th: 3, yes: "Called the flop, then took the turn", no: "Called the flop, didn't fire the turn",
    chance: (f) => fDid(f, "flop", "call") && fActed(f, "turn"), did: (f) => fFired(f, "turn") },
  { id: "ld-draws", yes: "Led into the raiser", no: "Had the flop lead available, checked", chance: (f) => fActed(f, "flop") && !fOpened(f), did: (f) => fLed(f, "flop") },
  { id: "ld-tp", yes: "Led into the raiser", no: "Had the flop lead available, checked", chance: (f) => fActed(f, "flop") && !fOpened(f), did: (f) => fLed(f, "flop") },
  { id: "ld-2p", yes: "Led into the raiser", no: "Had the flop lead available, checked", chance: (f) => fActed(f, "flop") && !fOpened(f), did: (f) => fLed(f, "flop") },
  { id: "lead-nut-f", yes: "Led the flop", no: "Could lead the flop, checked", chance: (f) => fActed(f, "flop") && !fOpened(f), did: (f) => fLed(f, "flop") },
  { id: "lead-nut-t", yes: "Led the turn", no: "Could lead the turn, checked", chance: (f) => fActed(f, "turn"), did: (f) => fLed(f, "turn") },
  { id: "lead-nut-r", yes: "Led the river", no: "Could lead the river, checked", chance: (f) => fActed(f, "river"), did: (f) => fLed(f, "river") },
  { id: "flop-vmw-lead", yes: "Led the flop", no: "Could lead the flop, checked", chance: (f) => fActed(f, "flop") && !fOpened(f), did: (f) => fLed(f, "flop") },
  { id: "flop-vmw-xr", yes: "Check-raised the flop", no: "Checked the flop into a bet, didn't raise",
    chance: (f) => fActs(f, "flop").includes("check") && f.faced.flop, did: (f) => fCheckRaised(f, "flop") },
  // ---- check-raises, split by how the hand ended ----
  { id: "xr-value-f", state: "yes", th: 3, yes: "Check-raised the flop and won at showdown", no: "Checked the flop into a bet, didn't raise",
    chance: (f) => fActs(f, "flop").includes("check") && f.faced.flop && !!f.md.flop, did: (f) => fCheckRaised(f, "flop") && fValue(f, "flop") },
  { id: "xr-value-t", state: "yes", th: 3, yes: "Check-raised the turn and won at showdown", no: "Checked the turn into a bet, didn't raise",
    chance: (f) => fActs(f, "turn").includes("check") && f.faced.turn && !!f.md.turn, did: (f) => fCheckRaised(f, "turn") && fValue(f, "turn") },
  { id: "xr-value-r", state: "yes", th: 3, yes: "Check-raised the river and won at showdown", no: "Checked the river into a bet, didn't raise",
    chance: (f) => fActs(f, "river").includes("check") && f.faced.river && !!f.md.river, did: (f) => fCheckRaised(f, "river") && fValue(f, "river") },
  { id: "xr-bluff-f", state: "yes", th: 3, yes: "Check-raised the flop and lost at showdown", no: "Checked the flop into a bet, didn't raise",
    chance: (f) => fActs(f, "flop").includes("check") && f.faced.flop && !!f.md.flop, did: (f) => fCheckRaised(f, "flop") && fBluffed(f, "flop") },
  { id: "xr-bluff-t", state: "yes", th: 3, yes: "Check-raised the turn and lost at showdown", no: "Checked the turn into a bet, didn't raise",
    chance: (f) => fActs(f, "turn").includes("check") && f.faced.turn && !!f.md.turn, did: (f) => fCheckRaised(f, "turn") && fBluffed(f, "turn") },
  { id: "xr-bluff-r", state: "yes", th: 3, yes: "Check-raised the river and lost at showdown", no: "Checked the river into a bet, didn't raise",
    chance: (f) => fActs(f, "river").includes("check") && f.faced.river && !!f.md.river, did: (f) => fCheckRaised(f, "river") && fBluffed(f, "river") },
  { id: "xr-oop-v", yes: "Check-raised and won at showdown", no: "Checked into a bet, didn't raise",
    chance: (f) => STREETS3.some((st) => fActs(f, st).includes("check") && f.faced[st]),
    did: (f) => STREETS3.some((st) => fCheckRaised(f, st) && fValue(f, st)) },
  { id: "xr-oop-b", yes: "Check-raised and lost at showdown", no: "Checked into a bet, didn't raise",
    chance: (f) => STREETS3.some((st) => fActs(f, st).includes("check") && f.faced[st]),
    did: (f) => STREETS3.some((st) => fCheckRaised(f, st) && fBluffed(f, st)) },
  // ---- bluffing, measured by the hand he held when he fired ----
  { id: "bluffs-rivers", state: "yes", th: 3, yes: "Bet the river with one pair or worse", no: "Bet the river with two pair or better",
    chance: (f) => !!f.md.river && fFired(f, "river"), did: (f) => fBluffed(f, "river") },
  { id: "barrels-light", state: "yes", th: 3, yes: "Fired flop and turn with one pair or worse", no: "Fired flop and turn with two pair or better",
    chance: (f) => !!f.md.turn && fFired(f, "flop") && fFired(f, "turn"), did: (f) => fBluffed(f, "turn") },
  { id: "bluffs-air", yes: "Bet the river with no pair of his own", no: "Bet the river with a pair or better",
    chance: (f) => !!f.md.river && fFired(f, "river"), did: (f) => !f.md.river.ownPair },
  { id: "bluff-missed-draws", yes: "Bet the river with one pair or worse", no: "Bet the river with two pair or better",
    chance: (f) => !!f.md.river && fFired(f, "river"), did: (f) => fBluffed(f, "river") },
  { id: "bluff-line-bxb", state: "yes", th: 3, yes: "Bet · check · bet, one pair or worse", no: "Reached the river another way",
    chance: (f) => !!f.md.river && fActed(f, "river"),
    did: (f) => fFired(f, "flop") && !fFired(f, "turn") && fFired(f, "river") && fBluffed(f, "river") },
  { id: "bluff-line-xb", state: "yes", th: 3, yes: "Check · bet, one pair or worse", no: "Reached the turn another way",
    chance: (f) => !!f.md.turn && fActed(f, "turn"),
    did: (f) => !fFired(f, "flop") && fFired(f, "turn") && fBluffed(f, "turn") },
  { id: "bluff-line-xxb", state: "yes", th: 3, yes: "Check · check · bet, one pair or worse", no: "Reached the river another way",
    chance: (f) => !!f.md.river && fActed(f, "river"),
    did: (f) => !fFired(f, "flop") && !fFired(f, "turn") && fFired(f, "river") && fBluffed(f, "river") },
  // ---- sizing ----
  { id: "open-big-strong", yes: "Opened with a size recorded", no: "Opened without a size recorded",
    chance: fOpened, did: (f) => !!fBucket(f, "pre") },
  { id: "3bet-big-strong", yes: "3-bet with a size recorded", no: "3-bet without a size recorded",
    chance: (f) => fDid(f, "pre", "3bet"), did: (f) => !!fBucket(f, "pre") },
  { id: "size-up-draws", yes: "Bet postflop with a size recorded", no: "Bet postflop without a size recorded",
    chance: (f) => STREETS3.some((st) => fFired(f, st)), did: (f) => STREETS3.some((st) => !!fBucket(f, st)) },
  { id: "small-with-weak", yes: "Bet postflop under that street's value bar", no: "Bet postflop with a value hand",
    chance: (f) => !!fBetMade(f), did: (f) => mdBluff(fBetMade(f)) },
  { id: "overbets-nuts", yes: "Bet postflop with two pair or better", no: "Bet postflop with less",
    chance: (f) => !!fBetMade(f), did: (f) => mdStrong(fBetMade(f)) },
  { id: "size-flop-v", yes: "Bet the flop with a size, top pair or better", no: "Bet the flop with a size, weaker than top pair",
    chance: (f) => !!f.md.flop && !!fBucket(f, "flop"), did: (f) => fValue(f, "flop") },
  { id: "size-turn-v", yes: "Bet the turn with a size, two pair or better", no: "Bet the turn with a size, one pair or worse",
    chance: (f) => !!f.md.turn && !!fBucket(f, "turn"), did: (f) => fValue(f, "turn") },
  { id: "size-river-v", yes: "Bet the river with a size, two pair or better", no: "Bet the river with a size, one pair or worse",
    chance: (f) => !!f.md.river && !!fBucket(f, "river"), did: (f) => fValue(f, "river") },
  { id: "size-flop-b", yes: "Bet the flop with a size, weaker than top pair", no: "Bet the flop with a size, top pair or better",
    chance: (f) => !!f.md.flop && !!fBucket(f, "flop"), did: (f) => fBluffed(f, "flop") },
  { id: "size-turn-b", yes: "Bet the turn with a size, one pair or worse", no: "Bet the turn with a size, two pair or better",
    chance: (f) => !!f.md.turn && !!fBucket(f, "turn"), did: (f) => fBluffed(f, "turn") },
  { id: "size-river-b", yes: "Bet the river with a size, one pair or worse", no: "Bet the river with a size, two pair or better",
    chance: (f) => !!f.md.river && !!fBucket(f, "river"), did: (f) => fBluffed(f, "river") },

  /* Phil's definitions, 2026-09-22. XT = "checked to": the street's aggressor
     checks and it's on him with no bet in front. */
  { id: "bluff-xt-f", state: "yes", th: 3, yes: "Checked to on the flop, bet weaker than top pair", no: "Checked to on the flop, went another way",
    chance: (f) => f.xt.flop && !!f.md.flop, did: (f) => fFired(f, "flop") && fBluffed(f, "flop") },
  { id: "bluff-xt-t", state: "yes", th: 3, yes: "Checked to on the turn, bet one pair or worse", no: "Checked to on the turn, went another way",
    chance: (f) => f.xt.turn && !!f.md.turn, did: (f) => fFired(f, "turn") && fBluffed(f, "turn") },
  { id: "bluff-xt-r", state: "yes", th: 3, yes: "Checked to on the river, bet one pair or worse", no: "Checked to on the river, went another way",
    chance: (f) => f.xt.river && !!f.md.river, did: (f) => fFired(f, "river") && fBluffed(f, "river") },

  /* Polar vs merged is about the hands he bets, not the size (Phil, 2026-09-22):
     polar = the no-pair hands and two-pair-and-better, nothing in between;
     merged = he'll bet the one-pair middle too. Two complementary rows over
     the same turn/river bets, so exactly one can fire. */
  { id: "polar", state: "yes", th: 5, minN: 7, rate: .7, yes: "Turn/river bet with no pair or two pair+", no: "Turn/river bet with one pair",
    chance: (f) => !!fBetLate(f), did: (f) => { const m = fBetLate(f); return mdAir(m) || mdStrong(m); } },
  { id: "merged", state: "yes", th: 3, minN: 7, rate: .3, yes: "Turn/river bet with one pair", no: "Turn/river bet with no pair or two pair+",
    chance: (f) => !!fBetLate(f), did: (f) => { const m = fBetLate(f); return !mdAir(m) && !mdStrong(m); } },

  /* Protected block: the small bet is capable of two pair or better, read
     against the board as of that street and only when his cards are known. */
  { id: "protected-block", state: "yes", th: 5, yes: "Blocked B25/B33 holding two pair or better", no: "Blocked B25/B33 holding less",
    chance: (f) => STREETS3.some((st) => fSmallB(f, st) && f.md[st]),
    did: (f) => STREETS3.some((st) => fSmallB(f, st) && f.md[st] && f.md[st].tier === 4) },

  /* Checks his whole range OOP: preflop raiser, first to act on the flop. */
  { id: "checks-range-oop", state: "yes", th: 8, minN: 10, rate: .75,
    yes: "Preflop raiser, first to act on the flop - checked", no: "Preflop raiser, first to act on the flop - bet",
    chance: (f) => f.pfr && f.lead.flop && fActed(f, "flop"), did: (f) => f.s.flop[0].act === "check" },
];
const EVIDENCE_BY_TAG = READ_EVIDENCE.reduce((m, r) => ((m[r.id] = m[r.id] || []).push(r), m), {});

/* Split the facts into the hands that showed the pattern and the hands that
   offered the same chance and didn't. A hand with no chance lands on neither
   side. One bad record shouldn't take the whole panel down, so a predicate that
   throws just counts as "no". */
function evidenceSplit(row, facts) {
  const hands = [], miss = [];
  for (const f of facts) {
    let ok = false, hit = false;
    try { ok = !!row.chance(f); if (ok) hit = !!row.did(f); } catch (_) { ok = false; }
    if (ok) (hit ? hands : miss).push(f.id);
  }
  return { hands, miss, chances: hands.length + miss.length };
}

function derivedReads(o, hands, facts) {
  facts = facts || oppFacts(o, hands);
  const reads = oppReads(o);
  const dismissed = new Set(o.readDismissed || []);
  return READ_EVIDENCE.filter((r) => r.th).map((r) => {
    const key = r.id + ":" + r.state;
    const t = TAG_BY_ID[r.id];
    if (!t || readIsActive(r.id, reads[r.id]) || dismissed.has(key) || RETIRED_TAG_IDS.has(r.id)) return null;
    const ev = evidenceSplit(r, facts);
    if (ev.hands.length < r.th) return null;
    if (r.minN && ev.chances < r.minN) return null;
    if (r.rate && ev.hands.length / ev.chances < r.rate) return null;
    return { tagId: r.id, state: r.state, key, count: ev.hands.length, chances: ev.chances,
             hands: ev.hands, miss: ev.miss, yes: r.yes, no: r.no,
             label: t.label + (r.state === "no" ? " (NO)" : "") };
  }).filter(Boolean).sort((a, b) => b.count - a.count);
}

/* The hands behind the reads Phil has already set — the same registry read the
   other way round. Not "should he set this" but "here is what the logs say
   about the one he did set", so a read he is about to exploit is checkable. */
function setReadEvidence(o, facts) {
  const reads = oppReads(o);
  const out = [];
  for (const id of Object.keys(reads)) {
    if (!readIsActive(id, reads[id]) || !TAG_BY_ID[id]) continue;
    const rows = EVIDENCE_BY_TAG[id];
    if (!rows) continue;
    const row = rows.find((r) => r.state === reads[id]) || rows[0];
    const ev = evidenceSplit(row, facts);
    if (!ev.chances) continue;
    out.push({ tagId: id, label: TAG_BY_ID[id].label, yes: row.yes, no: row.no, ...ev });
  }
  return out.sort((a, b) => b.hands.length - a.hands.length);
}

/* ---- tag-free exploit signals ----
   Lopsided tells: nearly every time he did X, the same thing was true. Phil's
   own examples are this shape — "every time they use B33 on the river they are
   bluffing", "they never limp-reraise as a bluff" — and the exploit is the
   lean, which no yes/no read on the card can express. Facts only; what to do
   about them is Phil's to write. Value/bluff here means one thing and only one
   thing: the hand reached showdown and he won it, or reached showdown and lost
   it. Hands that never got there say nothing either way.

   Phil, 2026-09-22: it doesn't have to be 100%. A tell fires either unanimously
   over a small sample, or at 70%+ over at least seven chances — and then the
   wording drops from "always/never" to "usually/rarely" so the card never
   overstates what the logs found. Some tells are absolutes-only (`allOnly`):
   check-raising 30% of the time is not a tendency, it's a balanced player. */
const SIG_MIN_N = 7, SIG_MIN_RATE = 0.7;

function exploitSignals(facts) {
  const out = [];
  const ids = (l) => l.map((f) => f.id);
  /* words = [unanimous phrasing, 70%+ phrasing]. Below the bar, nothing. */
  const sig = (words, hit, miss, minAll, what, allOnly) => {
    const tot = hit.length + miss.length;
    if (!tot) return;
    const all = hit.length === tot && tot >= minAll;
    if (!all && (allOnly || tot < SIG_MIN_N || hit.length / tot < SIG_MIN_RATE)) return;
    out.push({
      label: all ? words[0] : words[1],
      detail: `${hit.length} of ${tot} ${what} · ${Math.round((100 * hit.length) / tot)}%`,
      hands: ids(hit), miss: ids(miss), chances: tot, rate: hit.length / tot,
    });
  };

  // Limp-reraise: does he ever have a bluff in there?
  const lrrKnown = facts.filter((f) => fLimpRR(f) && !!f.md.flop);
  const lrrV = lrrKnown.filter((f) => fValue(f, "flop")), lrrB = lrrKnown.filter((f) => fBluffed(f, "flop"));
  sig(["Limp-reraise is never a bluff", "Limp-reraise is usually value"], lrrV, lrrB, 3, "hands seen");
  sig(["Limp-reraise is always a bluff", "Limp-reraise is usually a bluff"], lrrB, lrrV, 3, "hands seen");

  // Limp-shove — a count, not a rate: twice is already a pattern worth knowing.
  const ls = facts.filter((f) => f.limpedFirst && fActs(f, "pre").slice(1).includes("jam"));
  if (ls.length >= 2) out.push({ label: "Limps, then shoves", detail: `${ls.length} hands`,
    hands: ids(ls), miss: ids(facts.filter((f) => f.limpedFirst && !ls.includes(f))), chances: facts.filter((f) => f.limpedFirst).length });

  for (const st of STREETS3) {
    const N = ST_NAME[st];
    // One bucket that leans hard to one end of his range.
    const shown = facts.filter((f) => f.md[st] && fBucket(f, st));
    const by = {};
    for (const f of shown) (by[fBucket(f, st)] = by[fBucket(f, st)] || []).push(f);
    for (const b of Object.keys(by)) {
      const val = by[b].filter((f) => fValue(f, st)), blf = by[b].filter((f) => fBluffed(f, st));
      sig([`${N} ${b} is always a bluff`, `${N} ${b} is usually a bluff`], blf, val, 3, "hands seen");
      sig([`${N} ${b} is always value`, `${N} ${b} is usually value`], val, blf, 3, "hands seen");
    }
    // Does he vary his size on this street at all?
    const sized = facts.filter((f) => fBucket(f, st));
    if (sized.length) {
      const top = Object.entries(sized.reduce((m, f) => ((m[fBucket(f, st)] = (m[fBucket(f, st)] || 0) + 1), m), {}))
        .sort((x, y) => y[1] - x[1])[0][0];
      const on = sized.filter((f) => fBucket(f, st) === top);
      sig([`Only ever bets ${top} on the ${st}`, `Almost always bets ${top} on the ${st}`], on, sized.filter((f) => !on.includes(f)), 4, "sized bets");
    }
    // Folding to a bet.
    const faced = facts.filter((f) => f.faced[st]);
    const folded = faced.filter((f) => fDid(f, st, "fold")), stuck = faced.filter((f) => !fDid(f, st, "fold"));
    sig([`Never folds the ${st}`, `Rarely folds the ${st}`], stuck, folded, 4, "bets faced");
    sig([`Always folds the ${st}`, `Usually folds the ${st}`], folded, stuck, 4, "bets faced");
    // Checked to — does he take the free card or stab at it?
    const xt = facts.filter((f) => f.xt[st] && fActed(f, st));
    const stab = xt.filter((f) => fFired(f, st)), pass = xt.filter((f) => !fFired(f, st));
    sig([`Always stabs when checked to on the ${st}`, `Usually stabs when checked to on the ${st}`], stab, pass, 4, "checked-to spots");
    sig([`Never bets when checked to on the ${st}`, `Rarely bets when checked to on the ${st}`], pass, stab, 4, "checked-to spots");
    // ...and when he does stab, is it air?
    const xtK = xt.filter((f) => f.md[st] && fFired(f, st));
    const xtB = xtK.filter((f) => fBluffed(f, st)), xtV = xtK.filter((f) => !fBluffed(f, st));
    sig([`Stabs checked-to ${st}s with nothing`, `Usually bluffing when he stabs the ${st}`], xtB, xtV, 3, "hands seen");
    // Small bets: block or protection?
    const sm = facts.filter((f) => fSmallB(f, st) && f.md[st]);
    const smStrong = sm.filter((f) => f.md[st].tier === 4), smWeak = sm.filter((f) => f.md[st].tier < 4);
    sig([`${N} B25/B33 is always two pair or better`, `${N} B25/B33 is usually two pair or better`], smStrong, smWeak, 5, "small bets");
    sig([`${N} B25/B33 is always one pair or worse`, `${N} B25/B33 is usually one pair or worse`], smWeak, smStrong, 5, "small bets");
  }

  // Preflop raiser, first to act on the flop — c-bet or give up?
  const lead = facts.filter((f) => f.pfr && f.lead.flop && fActed(f, "flop"));
  const ck = lead.filter((f) => f.s.flop[0].act === "check"), cb = lead.filter((f) => f.s.flop[0].act !== "check");
  sig(["Never c-bets when first to act as the raiser", "Usually checks when first to act as the raiser"], ck, cb, 5, "flops as raiser");
  sig(["C-bets every flop as the raiser", "C-bets almost every flop as the raiser"], cb, ck, 5, "flops as raiser");

  // Never check-raises — absolutes only: 30% check-raise is balance, not a tell.
  const xrSpots = facts.filter((f) => STREETS3.some((st) => fActs(f, st).includes("check") && f.faced[st]));
  const xr = xrSpots.filter((f) => STREETS3.some((st) => fCheckRaised(f, st)));
  sig(["Never check-raises", ""], xrSpots.filter((f) => !xr.includes(f)), xr, 5, "chances", true);
  // Never reraises preflop — same reasoning.
  const vsRaise = facts.filter((f) => f.faced.pre);
  const tb = vsRaise.filter((f) => fDid(f, "pre", "3bet", "4bet", "jam"));
  sig(["Never reraises preflop", ""], vsRaise.filter((f) => !tb.includes(f)), tb, 6, "raises faced", true);
  // Entering the pot.
  const entered = facts.filter((f) => f.s.pre.some((x) => x.act !== "fold"));
  const limped = entered.filter((f) => f.limpedFirst), raised = entered.filter((f) => !f.limpedFirst);
  sig(["Never limps", ""], raised, limped, 6, "pots entered", true);
  sig(["Always limps in", "Usually limps in"], limped, raised, 6, "pots entered");
  // Strongest lean first, then biggest sample — the top of the list is the one
  // worth acting on tonight.
  return out.sort((x, y) => (y.rate || 1) - (x.rate || 1) || y.chances - x.chances);
}

/* Sheet: the hands behind one read — the hands he did it in, and the hands that
   offered the same chance and went another way. N hands is a claim; N of M is
   what decides whether the read is true. Rows open the hand. */
/* Hand-list order: hands that went to showdown, then ones where this opponent's
   cards are known (shown / mucked face up), then the rest — newest first in each. */
function showdownFirst(oppId) {
  const rank = (h) => {
    const vs = h.villains || [], i = oppId ? vs.findIndex((x) => x.opponentId === oppId) : -1;
    const v = i < 0 ? null : vs[i];
    // The stored flag is stamped on save and survives imports handWinner can't
    // resolve; a showdown he folded out of is not a look at his cards.
    const sd = handSD(h) || (h.showdown == null && handWinner(h)?.how === "showdown");
    if (sd && (i < 0 || !(h.actions || []).some((a) => a.actor === "v" + i && a.act === "fold"))) return 2;
    return v && (v.cards || []).filter(Boolean).length === 2 ? 1 : 0;
  };
  return (a, b) => rank(b) - rank(a) || b.ts - a.ts;
}
function openReadProof(label, sub, ids, other, oppId) {
  const byId = new Map(HANDS.map((h) => [h.id, h]));
  const pick = (l) => [...new Set(l || [])].map((x) => byId.get(x)).filter(Boolean).sort(showdownFirst(oppId));
  const hit = pick(ids), miss = pick(other && other.ids);
  if (!hit.length && !miss.length) return;
  const block = (t, l) => l.length
    ? `<div class="rdhead"><b>${esc(t)}</b><span class="rdn">${l.length}</span></div>` + l.map((h) => handRowHTML(h, oppId)).join("")
    : "";
  sheetGroup = "__rgcell__";
  // Tapping one of these hands browses the whole selection, in the order it is
  // listed — a cell like "HU IP Cbet" is a set of hands to read, not just one.
  proofReel = { oppId: oppId || curOppId, label, ids: hit.concat(miss).map((h) => h.id) };
  showSheet(
    `<div class="sheethead"><span class="t">${esc(label)}</span><button data-sheetclose>Close</button></div>
     <div class="rdsub">${esc(sub)}</div>
     <div class="list rgcell-hands">${
       miss.length && other ? block(other.yes || "Did this", hit) + block(other.no || "Had the chance, didn't", miss)
       : hit.map((h) => handRowHTML(h, oppId)).join("")}</div>`);
}

/* Opponent-page panels hide/show from their title; which ones are hidden is remembered
   on this device (same for every opponent). */
function bindFolds() {
  let hidden = [];
  try { hidden = JSON.parse(localStorage.getItem("sd-folds") || "[]"); } catch (e) {}
  const panels = document.querySelectorAll("#view-opp [data-fold]");
  for (const p of panels) {
    const head = p.querySelector(".cardpanel-head");
    const t = head && head.querySelector(".ptitle");
    if (!t) continue;
    t.classList.add("foldtitle");
    t.setAttribute("role", "button");
    t.insertAdjacentHTML("afterbegin", `<span class="foldchev" aria-hidden="true">▾</span>`);
    p.classList.toggle("folded", hidden.includes(p.dataset.fold));
    t.onclick = () => {
      const on = p.classList.toggle("folded");
      hidden = hidden.filter((x) => x !== p.dataset.fold).concat(on ? [p.dataset.fold] : []);
      try { localStorage.setItem("sd-folds", JSON.stringify(hidden)); } catch (e) {}
    };
  }
}

/* FEATURE 2 — predictive defaults for hand entry, from history. */
function predictEffStack() {
  const withStack = HANDS.filter((h) => h.effStack).sort((a, b) => b.ts - a.ts);
  return withStack.length ? String(withStack[0].effStack) : "";
}

/* FEATURE 4 — exploit effectiveness score (recency-weighted "Worked" taps). */
function exploitScore(e) { return recencyScore(e.wins); }

/* Merge opponent `fromId` INTO `intoId`: reassign every hand's villain refs,
   union reads/notes/exploits/dismissed, then delete the absorbed profile. */
async function mergeOpponents(fromId, intoId) {
  if (fromId === intoId) return;
  const from = oppById(fromId), into = oppById(intoId);
  if (!from || !into) return;
  for (const h of HANDS) {
    let touched = false;
    for (const v of h.villains || []) if (v.opponentId === fromId) { v.opponentId = intoId; touched = true; }
    if ((h.villainIds || []).includes(fromId)) {
      h.villainIds = [...new Set(h.villainIds.map((x) => (x === fromId ? intoId : x)))];
      touched = true;
    }
    if (touched) { h.updatedAt = Date.now(); await dbPut("hands", h); }
  }
  mergeOppRecords(into, from);                 // same union as import (db.js): reads, notes, exploits, dismissals, featured, aliases…
  // The absorbed name becomes an alias so imports and search still find it.
  const al = into.aliases || [];
  if (from.name && normName(from.name) !== normName(into.name) && !al.some((a) => normName(a) === normName(from.name)))
    into.aliases = [...al, from.name];
  await dbPut("opponents", into);
  await dbDel("opponents", fromId);
  await refreshCache();
}

async function refreshCache() {
  [OPP, HANDS] = await Promise.all(["opponents", "hands"].map(dbAll));
  HANDS.forEach(fixCallOffs);
  for (const o of OPP) if (migrateRanges(o)) dbPut("opponents", o).catch(() => {});
  _statsCache = null;
}

/* Legacy read migration: fold removed tags onto their surviving axis-mate. */
const READ_LEGACY_MAP = {};   // no legacy ids in the short-deck fork yet
/* One-time backfill: re-parse notes that were already converted to hands and,
   when the new parser extracts a squid state the saved hand doesn't have,
   patch the hand. Doesn't overwrite existing squid data — additive only.
   Also stamps villain-level squid (v.squid) when the note gives it. */
async function migrateNoteConvertedSquid() {
  const marker = await metaGet("migrations.noteSquidV1");
  if (marker) return;
  const handById = Object.fromEntries(HANDS.map((h) => [h.id, h]));
  let patched = 0;
  for (const o of OPP) {
    for (const n of (o.notes || [])) {
      if (!n.handId || !n.text) continue;
      const h = handById[n.handId]; if (!h) continue;
      const parsed = parseNoteToDraft(n.text, o.id);
      let dirty = false;
      // hand-level squid: only fill if missing
      const sq = h.squid || {};
      if (sq.have == null && parsed.squidHave !== "") {
        h.squid = { ...sq, have: Number(parsed.squidHave) };
        dirty = true;
      }
      if ((h.squid?.left == null) && parsed.squidLeft !== "") {
        h.squid = { ...(h.squid || {}), left: Number(parsed.squidLeft) };
        dirty = true;
      }
      // villain-level squid (v0 in parsed maps to the note's opponent)
      const parsedV = parsed.villains[0];
      const idx = (h.villains || []).findIndex((v) => v.opponentId === o.id);
      if (idx >= 0 && parsedV && parsedV.squid != null && h.villains[idx].squid == null) {
        h.villains[idx].squid = parsedV.squid;
        dirty = true;
      }
      if (dirty) { h.updatedAt = Date.now(); await dbPut("hands", h); patched++; }
    }
  }
  await metaSet("migrations.noteSquidV1", { ts: Date.now(), patched });
}

/* One-time repair: note-converted hands could carry a board card that was
   already dealt (a hole card, or a paired board both defaulting to spades —
   the old parser's collision guard never fired). Re-suit the duplicate board
   card; hole cards are left alone. */
async function migrateDupBoardCards() {
  if (await metaGet("migrations.dupCardsV1")) return;
  let patched = 0;
  for (const h of HANDS) {
    if (!h.srcNoteId || !Array.isArray(h.board)) continue;
    const seen = new Set([...(h.heroCards || []), ...(h.villains || []).flatMap((v) => v.cards || [])].filter(Boolean));
    let dirty = false;
    h.board = h.board.map((c) => {
      if (!c) return c;
      if (!seen.has(c)) { seen.add(c); return c; }
      const alt = ["s", "h", "d", "c"].map((x) => c[0] + x).find((x) => !seen.has(x));
      if (!alt) return c;
      seen.add(alt); dirty = true;
      return alt;
    });
    if (dirty) { h.updatedAt = Date.now(); await dbPut("hands", h); patched++; }
  }
  await metaSet("migrations.dupCardsV1", { ts: Date.now(), patched });
}

/* DX imports made before the ring fix labelled n players as U(n+2)…U6 (skipping
   U5/U4). The first seat of an n-player table is U(n) now, so a hand holding
   U(n+2) is one of the old ones: shift its U seats onto the real ring. Safe to
   re-run — a fixed hand never contains U(n+2). */
async function fixDxSeats() {
  let patched = 0;
  for (const h of HANDS) {
    const n = h.seats;
    if (!(n >= 4) || !(h.imported?.source === "dx" || String(h.id).startsWith("dxh-"))) continue;
    const vs = h.villains || [];
    const pos = [...vs.map((v) => v.pos), h.heroPos].filter(Boolean);
    if (!pos.includes("U" + (n + 2))) continue;
    const from = Array.from({ length: n - 3 }, (_, i) => "U" + (n + 2 - i));
    const to = Array.from({ length: n - 3 }, (_, i) => "U" + (n - i));
    const map = Object.fromEntries(from.map((f, i) => [f, to[i]]));
    for (const v of vs) if (map[v.pos]) v.pos = map[v.pos];
    if (map[h.heroPos]) h.heroPos = map[h.heroPos];
    h.updatedAt = Date.now();
    await dbPut("hands", h);
    patched++;
  }
  if (patched) _statsCache = null;
  return patched;
}

async function migrateLegacyReads() {
  if (await metaGet("mig.legacyReads")) return;   // one-shot: skip the full-table rewrite on every boot
  for (const o of OPP) {
    const r = oppReads(o);
    let dirty = false;
    for (const [oldId, { to, state }] of Object.entries(READ_LEGACY_MAP)) {
      if (r[oldId] == null) continue;
      const old = r[oldId], base = readBase(old);
      let next = base === "yes" ? state : base === "no" ? (state === "yes" ? "no" : "yes") : old;
      if (isScaleRead(to)) next = next === "yes" ? 90 : next === "no" ? 10 : null;   // scales hold 0–100, not yes/no
      else if (isStrongRead(old)) next += "!";                                       // keep the ! strength
      if (r[to] == null && next != null) r[to] = next;
      delete r[oldId];
      dirty = true;
    }
    // Scale reads hold numbers; a yes/no left there (early imports) shows as
    // "off" on the card but "on" in the detail — normalise it.
    for (const id of Object.keys(r)) {
      if (!isScaleRead(id) || typeof r[id] === "number") continue;
      const b = readBase(r[id]);
      const n = b === "yes" ? 90 : b === "no" ? 10 : (r[id] == null || r[id] === "" ? NaN : Number(r[id]));
      if (Number.isFinite(n)) r[id] = n; else delete r[id];
      dirty = true;
    }
    if (dirty) { o.updatedAt = Date.now(); await dbPut("opponents", o); }
  }
  await metaSet("mig.legacyReads", 1);
}

/* ---------- small utils ---------- */
function fmtWhen(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (d.toDateString() === new Date().toDateString())
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}
function toast(msg, ms) {
  const t = $("toast");
  t.onclick = null; t.style.cursor = "";              // a plain toast is never a leftover tappable (undo/reload/nag) button
  t.textContent = msg;
  t.classList.toggle("wide", msg.length > 24);        // wrap longer messages
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), ms || (msg.length > 40 ? 3200 : 1800));
}
const UNK_SUIT = { cls: "cx", sym: "?" };                      // bad/rank-only card → render unstyled, never throw
const suitOf = (c) => SUITS.find((s) => s.id === c[c.length - 1]) || UNK_SUIT;
const cardHTML = (c) => c ? `<span class="${suitOf(c).cls}">${c.slice(0, -1)}${suitOf(c).sym}</span>` : "";
const cardsStr = (cs) => (cs || []).filter(Boolean).join("");
/* Card as a little tile (hand view + rows). `prev` = earlier-street board card, dimmed. */
const tileHTML = (c, prev) => c
  ? `<span class="ctile${prev ? " prev" : ""} ${suitOf(c).cls}">${c.slice(0, -1)}<span class="suit">${suitOf(c).sym}</span></span>` : "";
const tilesHTML = (cs) => (cs || []).filter(Boolean).map((c) => tileHTML(c)).join("");

/* ---------- action phrasing (hand-history style: "opens to 40K") ---------- */
/* Hands imported from external replayers store raw chip counts (200 = 200 chips,
   not 200K). Detect them so the display doesn't inflate blinds and bets 1000×. */
const isRawSize = (h) => !!(h && h.imported && (h.imported.noK || h.imported.source === "hnlbds"));
const sizeLabel = (s, raw = false) => !s ? "" :
  raw
    ? (/^\$?\d/.test(s) ? String(s).replace(/^\$/, "") : s)
    : /^\$\d/.test(s) ? s.slice(1) + "K" :
      /^\d+(\.\d+)?k$/i.test(s) ? s.toUpperCase() :
      /^(\d+(?:\.\d+)?)(%)$/.test(s) ? s.replace(/%$/, "") : s;
function actVerb(a) {
  switch (a.act) {
    case "fold":  return "folds";
    case "check": return "checks";
    case "call":  return "calls";
    case "limp":  return "limps";
    case "jam":   return "jams";
    case "bet":   return "bets";
    case "raise": return a.street === "pre" ? "opens" : "raises";
    case "3bet":  return "3-bets";
    case "4bet":  return "4-bets";
    case "5bet":  return "5-bets";
    default:      return a.act;
  }
}
/* Verb + size split for rendering; "bet/raise sized Jam" reads as "jams".
   "to" only fits absolute sizes ("opens to 40K", "3-bets to 4x") — not
   pot-relative ones ("raises pot", "bets 50%"). */
function actParts(a, raw = false) {
  let verb = actVerb(a), sz = a.size ? sizeLabel(a.size, raw) : null;
  if (sz === "Jam") { verb = "jams"; sz = null; }
  return { verb, sz, to: !!sz && verb !== "bets" && !/%|pot|over/i.test(a.size || "") };
}
function actPhrase(a, raw = false) {
  const { verb, sz, to } = actParts(a, raw);
  return verb + (sz ? (to ? " to " : " ") + sz : "");
}
/* One action in the entry pad's own language: "B50" is half the pot, the same
   chips the B33/B50/B66 buttons put in. Derived from the resolved amount, so a
   hand typed in chips still reads as a pot fraction. Preflop stays in antes and
   multiples — that's how short-deck opens are read. */
/* How big each bet and raise was, read the way the Sizing grid reads it: a bet
   against the pot it went into, a raise as what he put in on top of the call
   against the pot with that call already in (a pot-size raise is B100). The
   share snaps to the grid's rung — B33/B50/B66/B75/B100/B150 — so the replayer
   and the grid never disagree about the same bet; past B150 it is the fraction
   itself, to the nearest 10%. A jam carries its rung too: "JAM B75" says what
   the shove cost, "JAM" alone that the pot couldn't be rebuilt. → {tag, allInCall} */
function sizeRead(h, i) {
  const acts = h.actions || [], a = acts[i];
  if (!a) return { tag: "" };
  if (a.act === "fold" || a.act === "check" || a.act === "call" || a.act === "limp") return { tag: a.act };
  const raw = isRawSize(h), lbl = a.size ? sizeLabel(a.size, raw) : "";
  const jam = a.size === "Jam" || a.act === "jam";
  const pe = estimatePot(h, acts.slice(0, i + 1)), lvl = pe.perAct[i], b = pe.pre[i];
  // All in for no more than the bet in front of him is a call, the way the
  // table reads it: no size of his own, so no rung either.
  if ((jam || pe.allIn[i]) && b && b.curBet > 0 && lvl > 0 && lvl <= b.curBet) return { tag: "call", allInCall: true };
  if (a.street === "pre") return { tag: jam ? "JAM" : lbl || a.act };
  let own = 0;
  for (let j = 0; j < i; j++) if (acts[j].street === a.street && acts[j].actor === a.actor) own = pe.perAct[j] || own;
  const pot = b ? b.pot + b.curBet - own : 0;           // pot once his call is in (the bare pot when there's no bet to call)
  const r = lvl && pot > 0 ? (lvl - b.curBet) / pot : 0;
  const rung = r > 0 ? (r > 1.6 ? "B" + Math.round(r * 10) * 10 : sdStepFor(r)) : "";
  // A bet the stack couldn't cover is a jam, whatever size was typed.
  if (jam || pe.allIn[i]) return { tag: rung ? "JAM " + rung : "JAM" };
  return { tag: rung || lbl || a.act };
}
const sizeTag = (h, i) => sizeRead(h, i).tag;
/* What the seat says on the felt: postflop in pot-%, preflop in the usual prose. */
function replaySay(h, i) {
  const a = (h.actions || [])[i];
  if (!a) return "";
  if (a.street === "pre" || ["fold", "check", "call", "limp"].includes(a.act)) return actPhrase(a, isRawSize(h));
  const { tag: t, allInCall } = sizeRead(h, i);
  if (allInCall) return "calls all-in";
  return t.startsWith("JAM") ? "jams" + t.slice(3) : actVerb(a) + " " + t;
}

/* ---------- bottom sheet ---------- */
function showSheet(html) {
  $("sheet").innerHTML = html;
  $("sheet").classList.remove("hidden");
  $("sheet-backdrop").classList.remove("hidden");
}
function hideSheet() {
  $("sheet").classList.add("hidden");
  $("sheet-backdrop").classList.add("hidden");
  sheetGroup = null;
  // Closing any sheet clears the focused table seat so a subsequent action
  // isn't misattributed to that seat via currentActor's focusPos branch (bug #8).
  if (typeof draft !== "undefined" && draft && draft.focusPos != null) {
    draft.focusPos = null;
    metaSet("draftHand", JSON.parse(JSON.stringify(draft)));
  }
}

/* ---------- routing ---------- */
const VIEWS = ["opponents", "opp", "hand", "table", "handview", "data"];
const TAB_FOR = { opponents: "opponents", opp: "opponents", hand: "hand", table: "table", handview: "opponents", data: "data" };

/* Laptop: a hand docks down the right of the page it came from, which stays
   live beside it — reads can be marked while the hand is open. The phone keeps
   the hand as its own screen; CSS hides the page underneath there. */
let curView = null, curHash = "", hvUnder = null, hvUnderHash = null;
const hvWide = () => matchMedia("(min-width: 1000px)").matches;
function route() {
  const raw = (location.hash || "#opponents").slice(1);
  // Only split on the FIRST slash — base64 import payloads can contain "/".
  const si = raw.indexOf("/");
  const view = si < 0 ? raw : raw.slice(0, si);
  const arg = si < 0 ? undefined : raw.slice(si + 1);
  // #imp/<base64> — deep-link from the hnlbds hand-history bookmarklet.
  if (view === "imp" && arg) {
    location.hash = "#opponents";
    setTimeout(() => openHandImportSheet(arg), 40);
    return;
  }
  // #bulk/<base64> — deep-link from the convert.html collector page.
  if (view === "bulk" && arg) {
    location.hash = "#opponents";
    setTimeout(() => openBulkImportSheet(arg), 40);
    return;
  }
  const v = VIEWS.includes(view) ? view : "opponents";
  if (v !== "handview" && v !== "opp") handPlay = null;
  if (v !== "handview") { replayStop(); splitDetach(); }
  // Filters belong to a player, not to a screen: narrowing to four hands is the
  // prelude to reading them one by one, so opening one and coming back keeps them.
  if (v === "opp" ? arg !== handFiltersFor : v !== "handview") { resetHandFilters(); noCardsOpen = false; }
  const from = curView, fromHash = curHash, wide = hvWide();
  curView = v; curHash = "#" + raw;
  if (v === "handview" && from !== "handview") {
    hvUnder = from && from !== "hand" ? from : null; hvUnderHash = hvUnder ? fromHash : null;
    if (!hvUnder) { hvUnder = "opponents"; hvUnderHash = "#opponents"; renderOpponents(); }   // opened from a link
  }
  const under = v === "handview" ? hvUnder : null;
  VIEWS.forEach((x) => {
    $("view-" + x).classList.toggle("hidden", x !== v && x !== under);
    $("view-" + x).classList.toggle("under", x === under);
  });
  document.body.classList.toggle("hvopen", v === "handview");
  document.querySelectorAll("#tabbar button").forEach((b) =>
    b.classList.toggle("on", b.dataset.tab === TAB_FOR[v]));
  hideSheet();
  ({ opponents: renderOpponents, opp: () => renderOppDetail(arg), hand: renderHandEntry,
     table: renderTableTab, handview: () => renderHandView(arg), data: renderData })[v]();
  // The page beside a docked hand keeps its scroll, on the way in and back out.
  if (v === "handview" && wide) $("view-handview").scrollTop = 0;
  else if (!(wide && from === "handview" && v === hvUnder)) window.scrollTo(0, 0);
  if (v !== "handview") { hvUnder = null; hvUnderHash = null; }
  maybeNagBackup();                          // data lives only on this phone — prompt a backup if stale
}

/* ================= Hands-panel filters (per opponent detail) =================
   Multi-select within a dimension (OR), AND across dimensions. Cleared on
   navigation away by resetHandFilters(). */
let handFilters = { pos: new Set(), pot: new Set(), squid: new Set(), role: new Set(), sd: false, q: null };
const resetHandFilters = () => {
  handFilters = { pos: new Set(), pot: new Set(), squid: new Set(), role: new Set(), sd: false, q: null };
  if ($("od-hfind")) { $("od-hfind").value = ""; $("od-hfind-read").innerHTML = ""; }
};
const handFiltersActive = () => handFilters.pos.size || handFilters.pot.size || handFilters.squid.size || handFilters.role.size || handFilters.sd || !!handFilters.q?.groups.length;
/* Hands where we never saw this player's cards sit in a collapsed group
   (stats-only). One open/closed flag, reset when you switch opponents. */
let noCardsOpen = false;
const cardsSeen = (h, oppId) => {
  const v = (h.villains || []).find((x) => x.opponentId === oppId);
  return !!(v && (v.cards || []).some(Boolean));
};
/* The stored flag only comes from handWinner, which needs every live player's
   cards — a DX capture rarely has them, so it's false on every DX hand. A DX
   record is complete (every fold is on it), so two or more still in over a
   full board is a showdown with or without cards. A short board with two
   still in is a capture gap: left out, not guessed. */
const foldedIn = (h) => new Set((h.actions || []).filter((a) => a.act === "fold").map((a) => a.actor));
function handSD(h) {
  if (h.showdown) return true;
  if (h.imported?.source !== "dx" || (h.board || []).filter(Boolean).length !== 5) return false;
  const f = foldedIn(h);
  return (h.villains || []).filter((_, i) => !f.has("v" + i)).length + (h.hero !== false && !f.has("hero") ? 1 : 0) >= 2;
}
/* "He got to showdown": the hand went there and he was still in it. */
function oppSD(h, oppId) {
  const i = (h.villains || []).findIndex((v) => v.opponentId === oppId);
  return i >= 0 && handSD(h) && !foldedIn(h).has("v" + i);
}
/* Villain seat → coarse bucket for filtering (BTN/CO/HJ/EP/Blinds/Straddle). */
function posBucket(pos) {
  if (!pos) return null;
  if (pos === "BN") return "BTN";
  if (pos === "CO") return "CO";
  if (pos === "HJ") return "HJ";
  if (pos === "U4" || pos === "U5") return "MP";
  if (/^U\d$/.test(pos)) return "EP";
  return null;
}
/* Pot type by count of preflop raises across everyone. */
function potBucket(h) {
  const pre = (h.actions || []).filter((a) => a.street === "pre");
  const raises = pre.filter((a) => a.act === "raise" || a.act === "3bet" || a.act === "4bet" || a.act === "5bet" || a.act === "jam").length;
  if (raises === 0) return "Limped";
  if (raises === 1) return "SRP";
  if (raises === 2) return "3BP";
  return "4BP+";
}
/* Squid state bucket from h.squid.have. */
function squidBucket(h) {
  const n = h?.squid?.have;
  if (n == null) return "nS";
  if (n === 0) return "nS";
  if (n === 1) return "w1S";
  return "w2S+";
}
/* This villain's preflop role. Priority: jam > raise > call > limp > check/fold → null. */
function villainRole(h, oppId) {
  const idx = (h.villains || []).findIndex((v) => v.opponentId === oppId);
  if (idx < 0) return null;
  const pre = (h.actions || []).filter((a) => a.actor === "v" + idx && a.street === "pre").map((a) => a.act);
  if (!pre.length) return null;
  if (pre.some((a) => ["raise", "3bet", "4bet", "5bet", "jam"].includes(a))) return "PFR";
  if (pre.includes("limp")) return "Limp";
  if (pre.includes("call")) return "PFC";
  return null;
}
function handMatchesFilters(h, oppId) {
  const f = handFilters;
  if (f.q?.groups.length && !hqMatch(h, oppId, f.q)) return false;
  if (f.sd && !oppSD(h, oppId)) return false;
  if (f.pot.size && !f.pot.has(potBucket(h))) return false;
  if (f.squid.size && !f.squid.has(squidBucket(h))) return false;
  if (f.role.size) {
    const r = villainRole(h, oppId);
    if (!r || !f.role.has(r)) return false;
  }
  if (f.pos.size) {
    const v = (h.villains || []).find((x) => x.opponentId === oppId);
    const b = posBucket(v?.pos);
    if (!b || !f.pos.has(b)) return false;
  }
  return true;
}
const POS_BUCKETS_ALL = ["BTN", "CO", "HJ", "MP", "EP"];
const POT_BUCKETS = ["Limped", "SRP", "3BP", "4BP+"];
const SQUID_BUCKETS = ["nS", "w1S", "w2S+"];
const ROLE_BUCKETS = ["PFR", "PFC", "Limp"];
function renderHandFilters(oppId, allHands) {
  const f = handFilters;
  /* Live counts for each chip — reflect *what would remain* if this chip flipped,
     with every OTHER dimension's current filter still applied. */
  const countIf = (dim, val) => {
    const trial = { ...f, pos: new Set(f.pos), pot: new Set(f.pot), squid: new Set(f.squid), role: new Set(f.role) };
    if (dim === "sd") trial.sd = val;
    else { const s = new Set(trial[dim]); s.add(val); trial[dim] = s; }
    const save = handFilters; handFilters = trial;
    const n = allHands.filter((h) => handMatchesFilters(h, oppId)).length;
    handFilters = save;
    return n;
  };
  const chip = (dim, val, label) => {
    const on = dim === "sd" ? f.sd : f[dim].has(val);
    const n = countIf(dim, val);
    return `<button class="hfchip${on ? " on" : ""}" data-hf="${dim}" data-hfv="${esc(val ?? "")}">${esc(label)}<i>${n}</i></button>`;
  };
  const row = (label, dim, vals) =>
    `<div class="hfrow"><span class="hflbl">${label}</span><div class="chiprow tight">${vals.map((v) => chip(dim, v, v)).join("")}</div></div>`;
  $("od-handfilters").innerHTML =
    row("Pos", "pos", POS_BUCKETS_ALL) +
    row("Pot", "pot", POT_BUCKETS) +
    row("Squid", "squid", SQUID_BUCKETS) +
    row("Role", "role", ROLE_BUCKETS) +
    `<div class="hfrow"><span class="hflbl">Show</span><div class="chiprow tight">
      <button class="hfchip${f.sd ? " on" : ""}" data-hf="sd" data-hfv="1" title="He got to showdown">Showdown<i>${allHands.filter((h) => oppSD(h, oppId)).length}</i></button>
    </div></div>`;
  $("od-hf-clear").classList.toggle("hidden", !handFiltersActive());
}

/* ================= Ranges (9×9 per position bucket, per situation) =================
   Phil's estimate of how each opponent plays each hand class preflop, painted
   by hand. opponent.ranges = { U7|U6|U5|U4|HJ|CO|BN: { open|vslimp|vsraise: { "AKs": act } } }.
   Unpainted = unknown (never assume fold). Showdown hands overlay as dots so
   the estimate can be checked against what was actually seen. */
/* Cards → 81-hand class: "AA", "AKs", "AKo", … (short deck ranks A–6). */
function handClass(cards) {
  if (!cards || !cards[0] || !cards[1]) return null;
  const r1 = cards[0][0], r2 = cards[1][0], s1 = cards[0][1], s2 = cards[1][1];
  if (r1 === r2) return r1 + r2;
  const i1 = RANKS.indexOf(r1), i2 = RANKS.indexOf(r2);
  if (i1 < 0 || i2 < 0) return null;
  const hi = i1 < i2 ? r1 : r2, lo = i1 < i2 ? r2 : r1;
  return hi + lo + (s1 === s2 ? "s" : "o");
}
const combosOf = (cls) => cls.length === 2 ? 6 : cls.endsWith("s") ? 4 : 12;
const RANGE_TOTAL_COMBOS = 630;                 // 36-card deck
const RANGE_BUCKETS = ["U7", "U6", "U5", "U4", "HJ", "CO", "BN"];
/* Seat → range bucket: each seat is its own bucket; U9/U8 fold into U7 (the earliest bucket). */
const rangeBucketOf = (pos) => RANGE_BUCKETS.includes(pos) ? pos : /^U\d$/.test(pos || "") && +pos[1] > 7 ? "U7" : null;
const RANGE_SITS = [
  { id: "open",    label: "First in", acts: [["limp", "Limp"], ["raise", "Raise"], ["fold", "Fold"]] },
  { id: "vslimp",  label: "vs limp",  acts: [["limp", "Over-limp"], ["raise", "Iso"], ["fold", "Fold"]] },
  { id: "vsraise", label: "vs raise", acts: [["call", "Call"], ["3bet", "3bet"], ["lcall", "Limp-call"], ["lrr", "Limp-reraise"], ["fold", "Fold"]] },
];
const RANGE_SIT_BY_ID = Object.fromEntries(RANGE_SITS.map((s) => [s.id, s]));
const ACT_COLORS = { raise: "#d64848", "3bet": "#a02828", lrr: "#b36ad6", lcall: "#3f8f8f", call: "#6bbf6b", limp: "#e5c04a", fold: "#7c8794" };
const RAISE_ACTS = new Set(["raise", "3bet", "4bet", "5bet", "jam", "bet"]);
let rangeBucket = "BN", rangeSit = "open";
/* Showdown evidence: hands where this villain showed cards, keyed
   bucket → situation → class → [{act, id}]. Situation = what happened before
   the villain's FIRST preflop action: a raise → vsraise, a limp → vslimp,
   nothing → open. The villain's own first action is normalised to the
   situation's vocabulary (any raise after a raise = 3bet; BN check = limp).
   A limp that then faces a raise also files his answer under vsraise (reraise = lrr, call = lcall). */
function rangeEvidence(oppId, hands) {
  const ev = {};
  for (const h of (hands || HANDS)) {
    const idx = (h.villains || []).findIndex((v) => v.opponentId === oppId);
    if (idx < 0) continue;
    const v = h.villains[idx];
    const hc = handClass(v.cards);
    const bucket = rangeBucketOf(v.pos);
    if (!hc || !bucket) continue;
    const me = "v" + idx;
    const pre = (h.actions || []).filter((a) => a.street === "pre");
    const i = pre.findIndex((a) => a.actor === me);
    if (i < 0) continue;
    const before = pre.slice(0, i).map((a) => a.act);
    const raised = before.some((a) => RAISE_ACTS.has(a));
    const sit = raised ? "vsraise" : before.includes("limp") || before.includes("call") ? "vslimp" : "open";
    let act = pre[i].act;
    if (RAISE_ACTS.has(act)) act = raised ? "3bet" : "raise";
    else if (act === "check" || (act === "call" && !raised)) act = "limp";
    else if (act !== "call" && act !== "limp" && act !== "fold") continue;
    (((ev[bucket] ||= {})[sit] ||= {})[hc] ||= []).push({ act, id: h.id });
    // limped, then a raise came in behind: his answer goes in "vs raise" too, a reraise as limp-reraise
    if (act === "limp") {
      const j = pre.findIndex((a, k) => k > i && a.actor === me);
      if (j > 0 && pre.slice(i + 1, j).some((a) => RAISE_ACTS.has(a.act))) {
        const a2 = RAISE_ACTS.has(pre[j].act) ? "lrr" : pre[j].act === "call" ? "lcall" : pre[j].act;
        if (a2 === "lrr" || a2 === "lcall" || a2 === "fold") ((ev[bucket].vsraise ||= {})[hc] ||= []).push({ act: a2, id: h.id });
      }
    }
  }
  return ev;
}
const RG_LBL = { raise: "Raise", "3bet": "3bet", lrr: "Limp-reraise", lcall: "Limp-call", call: "Call", limp: "Limp", fold: "Fold" };
/* Distinct actions seen for a class, most common first; an old painted action leads. */
function evidenceActs(ev, painted) {
  const n = {};
  for (const e of ev) n[e.act] = (n[e.act] || 0) + 1;
  const acts = Object.keys(n).sort((a, b) => n[b] - n[a]);
  if (painted && !acts.includes(painted)) acts.unshift(painted);
  return acts;
}
/* One colour, or hard-edged bands when he did more than one thing with the hand. */
function actsBg(acts) {
  const c = acts.map((a) => ACT_COLORS[a] || "#5a6068");
  if (c.length < 2) return c[0];
  const w = 100 / c.length;
  return `linear-gradient(90deg,${c.map((x, i) => `${x} ${(i * w).toFixed(2)}% ${((i + 1) * w).toFixed(2)}%`).join(",")})`;
}
function rangeGridHTML(painted, evid) {
  const cells = [];
  for (let i = 0; i < RANKS.length; i++) {
    for (let j = 0; j < RANKS.length; j++) {
      const hi = RANKS[i], lo = RANKS[j];
      const cls = i === j ? hi + hi : (i < j ? hi + lo + "s" : lo + hi + "o");
      const ev = evid[cls] || [];
      const acts = evidenceActs(ev, painted[cls]);
      const style = acts.length ? `background:${actsBg(acts)};color:#fff;text-shadow:0 0 2px rgba(0,0,0,.6);` : "background:#1a1d23;color:#6b7078;";
      const badge = ev.length ? `<span class="rgn">${ev.length}</span>` : "";
      cells.push(`<div class="rgcell tappable" data-rgcell="${cls}" style="${style}" title="${cls}${ev.length ? ` · seen ${ev.length}×` : ""}">${cls}${badge}</div>`);
    }
  }
  return cells.join("");
}
/* Combo share per painted action, e.g. { raise: 84, limp: 120 } out of 630. */
function rangeCombos(painted) {
  const out = {};
  for (const [cls, act] of Object.entries(painted)) out[act] = (out[act] || 0) + combosOf(cls);
  return out;
}
const pct = (n) => `${Math.round((n / RANGE_TOTAL_COMBOS) * 100)}%`;
/* ---------- hand-import (from external replay via bookmarklet) ---------- */

/* Decode base64url or base64 with UTF-8 payload. */
function decodeImportPayload(b64) {
  try {
    const norm = b64.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(decodeURIComponent(escape(atob(norm))));
  } catch (e) { return null; }
}
/* Pending import kept in memory so the sheet's "Save" can commit after
   Phil optionally edits which villains map to which opponents. */
let pendingImport = null;
/* Match an imported villain name against OPP: exact → saved alias → case-insensitive →
   prefix similarity. Returns the opponent record or null. Prefix rule: shared prefix
   ≥3 chars AND ≥60% of the shorter name — good for CJK handles like 阿九AA / 阿九AA88. */
function matchImportName(rawName) {
  const n = (rawName || "").trim();
  if (!n) return null;
  const nl = n.toLowerCase();
  for (const o of OPP) if (o.name && o.name.trim() === n) return o;
  for (const o of OPP) if ((o.aliases || []).some((a) => (a || "").trim() === n)) return o;
  for (const o of OPP) {
    if (o.name && o.name.trim().toLowerCase() === nl) return o;
    if ((o.aliases || []).some((a) => (a || "").trim().toLowerCase() === nl)) return o;
  }
  let best = null, bestScore = 0;
  for (const o of OPP) {
    const cands = [o.name, ...(o.aliases || [])].filter(Boolean).map((s) => s.trim()).filter(Boolean);
    for (const c of cands) {
      const cl = c.toLowerCase();
      let pref = 0;
      while (pref < cl.length && pref < nl.length && cl[pref] === nl[pref]) pref++;
      if (pref < 3) continue;
      const shorter = Math.min(cl.length, nl.length);
      if (pref / shorter < 0.6) continue;
      const score = pref * 100 + (100 - Math.abs(cl.length - nl.length));
      if (score > bestScore) { bestScore = score; best = o; }
    }
  }
  return best;
}
function openHandImportSheet(b64) {
  const rec = decodeImportPayload(b64);
  if (!rec || rec.kind !== "hand-import") { toast("Bad hand-import payload"); return; }
  pendingImport = {
    rec,
    map: rec.villains.map((v) => {
      const hit = matchImportName(v.name);
      return { name: v.name, pos: v.pos, cards: v.cards, chips: v.chips, matchId: hit?.id || null, create: !hit };
    }),
  };
  renderHandImportSheet();
}
function renderHandImportSheet() {
  const p = pendingImport; if (!p) return;
  const rec = p.rec;
  sheetGroup = "__handimport__";
  const rows = p.map.map((m, i) => {
    const cards = (m.cards || []).filter(Boolean).join(" ") || "—";
    const opt = OPP.map((o) => `<option value="${esc(o.id)}"${m.matchId === o.id ? " selected" : ""}>${esc(o.name)}</option>`).join("");
    return `<div class="himrow" data-hi="${i}">
      <div class="himmain">
        <span class="himpos">${esc(m.pos || "?")}</span>
        <span class="himnm">${esc(m.name)}</span>
        <span class="himcards">${esc(cards)}</span>
      </div>
      <div class="himctrl">
        <label class="himcreate"><input type="checkbox" data-hicreate ${m.create ? "checked" : ""}> new</label>
        <select data-hisel ${m.create ? "disabled" : ""}>
          <option value="">— pick opponent —</option>${opt}
        </select>
      </div>
    </div>`;
  }).join("");
  const b = rec.blinds || {};
  const meta = `ante ${b.ante || rec.ante || "?"}`;
  const board = (rec.board || []).filter(Boolean).join(" ") || "—";
  const actCount = (rec.actions || []).length;
  showSheet(
    `<div class="sheethead"><span class="t">Import hand · ${rec.villains.length} players</span>
       <button data-sheetclose>Close</button></div>
     <div class="sheetnote">${esc(meta)} · board ${esc(board)} · ${actCount} actions${rec.tableId ? ` · table ${esc(rec.tableId)}` : ""}</div>
     <div class="himlist">${rows}</div>
     <div class="row"><button class="primary" data-hisave>Import hand</button></div>`);
}
/* Persist one decoded hand-import record + villain mapping. Shared by the
   single-hand sheet and the bulk-import sheet. Returns:
     {ok:true, hand} on success
     {skipped:true, reason:"dup"} if the (tableId,roundId) is already logged */
async function commitOneImport(rec, map) {
  if (rec.tableId && rec.roundId) {
    const dup = HANDS.find((h) => h.imported && h.imported.tableId === rec.tableId && h.imported.roundId === rec.roundId);
    if (dup) return { skipped: true, reason: "dup" };
  }
  const villains = [];
  const villainIds = [];
  for (const m of map) {
    let oppId = m.matchId;
    const rawName = (m.name || "").trim();
    // The bulk sheet resolves every hand's villains before the first one is
    // written, so without this re-check one villain spawns a profile per hand.
    if ((m.create || !oppId) && rawName) {
      const live = OPP.find((o) => (o.name || "").trim().toLowerCase() === rawName.toLowerCase());
      if (live) oppId = live.id;
    }
    if (!oppId) {
      const opp = { id: uid(), name: rawName, group: "", reads: {}, exploits: [], notes: [], aliases: [], updatedAt: Date.now() };
      await dbPut("opponents", opp);
      OPP.push(opp);
      oppId = opp.id;
    } else {
      const opp = OPP.find((o) => o.id === oppId);
      if (opp && rawName && rawName !== (opp.name || "").trim()) {
        opp.aliases = opp.aliases || [];
        if (!opp.aliases.some((a) => (a || "").trim() === rawName)) {
          opp.aliases.push(rawName);
          opp.updatedAt = Date.now();
          await dbPut("opponents", opp);
        }
      }
    }
    villains.push({
      opponentId: oppId, pos: m.pos || null,
      cards: (m.cards && m.cards.some(Boolean)) ? m.cards : null,
      chips: m.chips || null,
    });
    villainIds.push(oppId);
  }
  // hnlbds labels every preflop raise "raise" and every flat "call"; number
  // the re-raises so they store (and read) as 3-bets / 4-bets like manually
  // entered hands, and turn calls before any raise into limps — that's what
  // separates a limp-reraise (Lrr) from a cold 3-bet in the range grid.
  let preRaises = 0;
  const actions = (rec.actions || []).map((a) => {
    if (a.street !== "pre") return a;
    if (a.act === "call" && preRaises === 0) return { ...a, act: "limp" };
    if (a.act !== "raise" && a.act !== "jam") return a;
    preRaises++;
    if (a.act === "jam" || preRaises === 1) return a;
    return { ...a, act: preRaises === 2 ? "3bet" : preRaises === 3 ? "4bet" : "5bet" };
  });
  const hand = {
    id: uid(),
    ts: (rec.beginTime ? rec.beginTime * 1000 : Date.now()),
    updatedAt: Date.now(),
    // hnlbds records are all-villain (Phil was railing); dx records name the
    // seat he was in, so honour rec.hero rather than filing himself as an opponent.
    hero: !!rec.hero,
    heroPos: rec.hero?.pos || null,
    heroCards: (rec.hero?.cards || []).some(Boolean) ? rec.hero.cards : null,
    villains, villainIds,
    board: rec.board || [],
    actions,
    blinds: { ante: rec.blinds?.ante || rec.ante || null },
    seats: rec.seats || null,
    effStack: null,
    note: rec.tableId ? `Imported · table ${rec.tableId}${rec.roundId ? ` #${rec.roundId}` : ""}` : "Imported",
    imported: { source: rec.source || "external", tableId: rec.tableId, roundId: rec.roundId, noK: (rec.source || "") === "hnlbds" },
  };
  fixCallOffs(hand);
  const win = handWinner(hand); hand.showdown = !!win && win.how === "showdown";
  await dbPut("hands", hand);
  HANDS.push(hand); _statsCache = null;
  return { ok: true, hand };
}

async function commitHandImport() {
  const p = pendingImport; if (!p) return;
  const res = await commitOneImport(p.rec, p.map);
  pendingImport = null;
  hideSheet();
  if (res.skipped) toast("Already imported this hand");
  else toast(`Imported hand · ${p.map.length} villains`);
  renderOpponents();
}

/* ---------- Bulk import (from convert.html collector) ---------- */
let pendingBulkImport = null;
function openBulkImportSheet(b64) {
  let arr;
  try {
    const json = decodeURIComponent(escape(atob(b64)));
    arr = JSON.parse(json);
  } catch (e) { toast("Bad bulk-import payload"); return; }
  if (!Array.isArray(arr) || !arr.length) { toast("Empty bulk payload"); return; }
  pendingBulkImport = {
    recs: arr,
    items: arr.map((rec) => ({
      rec,
      map: (rec.villains || []).map((v) => {
        const hit = matchImportName(v.name);
        return { name: v.name, pos: v.pos, cards: v.cards, chips: v.chips, matchId: hit?.id || null, create: !hit };
      }),
      alreadyLogged: !!(rec.tableId && rec.roundId &&
        HANDS.find((h) => h.imported && h.imported.tableId === rec.tableId && h.imported.roundId === rec.roundId)),
    })),
  };
  renderBulkImportSheet();
}
function renderBulkImportSheet() {
  const p = pendingBulkImport; if (!p) return;
  sheetGroup = "__bulkimport__";
  const dupCount = p.items.filter((it) => it.alreadyLogged).length;
  const newCount = p.items.length - dupCount;
  const newOpps = new Set();
  const matchOpps = new Set();
  for (const it of p.items) {
    for (const m of it.map) {
      if (m.matchId) matchOpps.add(m.matchId);
      else if (m.create && m.name) newOpps.add(m.name.toLowerCase().trim());
    }
  }
  const rows = p.items.map((it, i) => {
    const b = it.rec.blinds || {};
    const meta = `ante ${b.ante || "?"}`;
    const names = (it.rec.villains || []).map((v) => v.name).join(", ");
    const board = (it.rec.board || []).filter(Boolean).join(" ") || "—";
    const badge = it.alreadyLogged ? `<span class="himdup">dup</span>` : "";
    return `<div class="himbulkrow ${it.alreadyLogged ? "dup" : ""}">
      <div class="himbulktop">
        <span class="himbulkidx">#${i + 1}</span>
        <span class="himbulkmeta">${esc(meta)} · ${(it.rec.actions || []).length} actions · board ${esc(board)}</span>
        ${badge}
      </div>
      <div class="himbulknames">${esc(names)}</div>
    </div>`;
  }).join("");
  showSheet(
    `<div class="sheethead"><span class="t">Bulk import · ${p.items.length} hands</span>
       <button data-sheetclose>Close</button></div>
     <div class="sheetnote">
       ${newCount} new · ${dupCount} already logged<br>
       ${matchOpps.size} matched villains · ${newOpps.size} new villains will be created
     </div>
     <div class="himbulklist">${rows}</div>
     <div class="row">
       <button class="primary" data-bulksave ${newCount ? "" : "disabled"}>${newCount ? `Import ${newCount} hand${newCount === 1 ? "" : "s"}` : "Nothing to import"}</button>
     </div>`);
}
async function commitBulkImport() {
  const p = pendingBulkImport; if (!p) return;
  let ok = 0, dup = 0, fail = 0;
  for (const it of p.items) {
    try {
      const r = await commitOneImport(it.rec, it.map);
      if (r.ok) ok++;
      else if (r.skipped) dup++;
    } catch (e) { fail++; }
  }
  pendingBulkImport = null;
  hideSheet();
  const parts = [];
  if (ok) parts.push(`${ok} imported`);
  if (dup) parts.push(`${dup} dup`);
  if (fail) parts.push(`${fail} failed`);
  toast(parts.join(" · ") || "Nothing to import");
  renderOpponents();
}

/* Sheet: side-by-side view of a note's raw text and the parsed draft it will
   become. Lets Phil verify shorthand → hand conversion before committing, and
   catch cases where the parser missed something. */
function openNoteReviewSheet(note, oppId) {
  const d = parseNoteToDraft(note.text, oppId);
  const v0 = d.villains[0] || {};
  const posLbl = v0.pos || "—";
  const cardsLbl = (v0.cards || []).some(Boolean) ? cardsStr(v0.cards) : "—";
  const boardLbl = (d.board || []).filter(Boolean).join(" ") || "—";
  const squidBits = [];
  if (d.squidHave !== "") squidBits.push(`table ${d.squidHave}🦑`);
  if (d.squidLeft !== "") squidBits.push(`${d.squidLeft} left`);
  if (v0.squid != null) squidBits.push(`this villain ${v0.squid}🦑`);
  const squidLbl = squidBits.join(" · ") || "—";
  const actLbl = (d.actions || []).length
    ? d.actions.map((a) => `${a.street}:${a.actor} ${a.act}${a.size ? " " + a.size : ""}`).join("<br>")
    : "—";
  sheetGroup = "__notereview__";
  showSheet(
    `<div class="sheethead"><span class="t">Review parse</span>
       <button data-sheetclose>Close</button></div>
     <div class="notereview">
       <div class="nrsec"><span class="nrlbl">Raw</span><div class="nrval mono">${esc(note.text || "")}</div></div>
       <div class="nrsec"><span class="nrlbl">Position</span><div class="nrval">${esc(posLbl)}</div></div>
       <div class="nrsec"><span class="nrlbl">Cards</span><div class="nrval">${esc(cardsLbl)}</div></div>
       <div class="nrsec"><span class="nrlbl">Board</span><div class="nrval">${esc(boardLbl)}</div></div>
       <div class="nrsec"><span class="nrlbl">Squid</span><div class="nrval">${esc(squidLbl)}</div></div>
       <div class="nrsec"><span class="nrlbl">Actions</span><div class="nrval">${actLbl}</div></div>
       <div class="row">
         <button class="secondary" data-nrconvert data-noteid="${esc(note.id)}">Open in editor</button>
       </div>
     </div>`);
}
/* Sheet: "Hands" brush → tap a cell to list the villain's showdown hands in
   that class for the current bucket + situation. Rows open the hand. */
function openRangeCellSheet(oppId, hc) {
  const ev = rangeEvidence(oppId)[rangeBucket]?.[rangeSit]?.[hc] || [];
  const byId = new Map(HANDS.map((h) => [h.id, h]));
  const acts = evidenceActs(ev).filter((a) => ev.some((e) => e.act === a));
  const sect = (a) => {
    const hs = [...new Set(ev.filter((e) => e.act === a).map((e) => e.id))].map((id) => byId.get(id)).filter(Boolean).sort(showdownFirst(oppId));
    return `<div class="rgsec"><span class="rgswatch" style="background:${ACT_COLORS[a]}"></span> ${esc(RG_LBL[a] || a)} · ${hs.length}</div>${hs.map((h) => handRowHTML(h, oppId)).join("")}`;
  };
  const rows = acts.map(sect).join("")
    || `<div class="empty">No hands with ${esc(hc)} from ${rangeBucket} (${RANGE_SIT_BY_ID[rangeSit].label.toLowerCase()}).</div>`;
  sheetGroup = "__rgcell__";
  showSheet(
    `<div class="sheethead"><span class="t">${esc(hc)} · ${rangeBucket} · ${esc(RANGE_SIT_BY_ID[rangeSit].label)} · ${ev.length}</span>
       <button data-sheetclose>Close</button></div>
     <div class="list rgcell-hands">${rows}</div>`);
}
function rangeSave(oppId) {
  const o = oppById(oppId);
  if (!o) return;
  o.updatedAt = Date.now();
  dbPut("opponents", o).catch(() => {});
}
function renderRanges(oppId, hands) {
  const o = oppById(oppId);
  if (!o) return;
  const ranges = o.ranges || {};
  const evAll = rangeEvidence(oppId, hands);
  const sit = RANGE_SIT_BY_ID[rangeSit] || RANGE_SITS[0];
  rangeSit = sit.id;
  const painted = ranges[rangeBucket]?.[rangeSit] || {};
  const evid = evAll[rangeBucket]?.[rangeSit] || {};
  const bucketChips = RANGE_BUCKETS.map((b) => {
    const n = Object.keys(ranges[b]?.[rangeSit] || {}).length;
    const e = Object.values(evAll[b]?.[rangeSit] || {}).reduce((t, a) => t + a.length, 0);
    return `<button class="chip mini${b === rangeBucket ? " on" : ""}" data-rgbucket="${b}">${b}${n ? `<i>${n}</i>` : ""}${e ? `<i class="rgev">${e}●</i>` : ""}</button>`;
  }).join("");
  const sitChips = RANGE_SITS.map((x) => {
    const n = Object.keys(ranges[rangeBucket]?.[x.id] || {}).length;
    return `<button class="chip mini${x.id === rangeSit ? " on" : ""}" data-rgsit="${x.id}">${esc(x.label)}${n ? `<i>${n}</i>` : ""}</button>`;
  }).join("");
  const key = sit.acts.map(([a, l]) => `<span><span class="rgswatch" style="background:${ACT_COLORS[a]}"></span> ${esc(l)}</span>`).join("");
  const combos = rangeCombos(painted);
  const paintedN = Object.values(combos).reduce((t, n) => t + n, 0);
  $("od-rangegrid").innerHTML = `
    <div class="rgpicker chiprow tight">${bucketChips}</div>
    <div class="rgpicker chiprow tight">${sitChips}</div>
    <div class="rgsummary">${key}</div>
    <div class="rgblock"><div class="rggrid">${rangeGridHTML(painted, evid)}</div></div>
    <div class="chiprow tight rgtools${paintedN ? "" : " hidden"}">
      <button class="chip mini danger" data-rgclear>Clear old painted ${rangeBucket}</button>
    </div>`;
  $("od-rangelegend").innerHTML =
    `<span class="rglegnote">Cells fill in from hands where his cards were logged. A hand he played more than one way shows every colour. Tap a cell to see those hands.</span>`;
  const hint = $("od-rangehint");
  if (hint) hint.textContent = `${rangeBucket} · ${sit.label}`;
}
function bindRangeGrid() {
  $("od-rangegrid").onclick = (e) => {
    if (!curOppId) return;
    const cell = e.target.closest("[data-rgcell]");
    if (cell) { openRangeCellSheet(curOppId, cell.dataset.rgcell); return; }
    const b = e.target.closest("[data-rgbucket],[data-rgsit],[data-rgclear]");
    if (!b) return;
    if (b.dataset.rgbucket) rangeBucket = b.dataset.rgbucket;
    else if (b.dataset.rgsit) rangeSit = b.dataset.rgsit;
    else if (b.hasAttribute("data-rgclear")) {
      const o = oppById(curOppId);
      if (!o?.ranges?.[rangeBucket]?.[rangeSit]) return;
      if (!confirm(`Clear the old painted ${rangeBucket} · ${RANGE_SIT_BY_ID[rangeSit].label} range?`)) return;
      delete o.ranges[rangeBucket][rangeSit];
      rangeSave(curOppId);
    }
    renderRanges(curOppId);
  };
}

/* ================= Opponents list ================= */

function oppStats() {
  if (_statsCache) return _statsCache;
  const m = {};
  for (const h of HANDS) for (const vid of h.villainIds || []) {
    m[vid] = m[vid] || { count: 0, last: 0 };
    m[vid].count++; m[vid].last = Math.max(m[vid].last, h.ts);
  }
  return (_statsCache = m);
}

function updateGroupsDatalist() {
  $("groups").innerHTML = [...new Set(OPP.map((o) => o.group).filter(Boolean))]
    .map((g) => `<option value="${esc(g)}">`).join("");
}

/* Is a note hand-shaped (worth a Convert button), or a pure tendency comment? */
function isConvertibleNote(text) {
  if (!text) return false;
  const d = parseNoteToDraft(text, "__probe__");
  const v0 = d.villains[0] || {};
  return !!(v0.pos || (v0.cards || []).some(Boolean) || (d.board || []).some(Boolean) || (d.actions || []).length);
}

/* A note that reads as a hand, not a tendency: his cards or a board, plus at
   least one action. "3bets light from BN" has an action and a seat but no
   cards, so it stays a note; "BN KJs open 4a, flop Kh 9d 6c cbet" is a hand. */
function isHandHistoryNote(text) {
  if (!text) return false;
  const d = parseNoteToDraft(text, "__probe__");
  const v0 = d.villains[0] || {};
  const cards = (v0.cards || []).filter(Boolean).length === 2;
  const board = (d.board || []).filter(Boolean).length >= 3;
  return (cards || board) && (d.actions || []).length > 0;
}
/* Turn one note into a saved hand and link the two (note.handId). */
async function noteToHand(n, oppId, d) {
  d = d || parseNoteToDraft(n.text, oppId);
  const now = Date.now();
  const rec = {
    id: uid(), ts: now, updatedAt: now, hero: false,
    heroPos: null, heroCards: null,
    villains: d.villains.map((v) => ({ opponentId: v.opponentId, pos: v.pos || null,
      cards: (v.cards || []).some(Boolean) ? v.cards : null })),
    villainIds: [oppId],
    board: d.board, actions: d.actions,
    effStack: null, blinds: null,
    squid: (d.squidHave || d.squidLeft)
      ? { have: d.squidHave ? Number(d.squidHave) : null, left: d.squidLeft ? Number(d.squidLeft) : null } : null,
    note: n.text, srcNoteId: n.id,
  };
  rec.result = null; rec.showdown = false;
  fixCallOffs(rec);
  await dbPut("hands", rec);
  HANDS.push(rec); _statsCache = null;
  n.handId = rec.id;
  return rec;
}

/* Short chip label for a long exploit when no explicit abbr is typed. */
function autoShort(text) {
  const words = String(text || "").trim().split(/\s+/);
  let s = words.slice(0, 3).join(" ");
  if (s.length > 18) return s.slice(0, 17) + "…";
  return s + (words.length > 3 ? "…" : "");
}
/* Ordered front-page card items for an opponent (reads + exploits), migrating a
   legacy single pinnedExploit into the new list on first read. */
function featuredItems(o) {
  if (!Array.isArray(o.featured))
    o.featured = o.pinnedExploit ? [{ type: "exploit", id: o.pinnedExploit }] : [];
  return o.featured;
}
/* A read is "on" if it has a real state — for scale reads, a value > 0.
   Reads at 0 are treated the same as unset (see #14). */
const readIsActive = (id, state) => {
  if (state == null || state === "") return false;
  if (isScaleRead(id)) return Number(state) > 0;
  if (isPositionRead(id)) return !!String(state).trim();
  if (isTallyRead(id)) return !!tallyLeader(state);
  return true;
};
const readIsShown = (o, id) => readIsActive(id, oppReads(o)[id]);

/* Render one featured item as a compact chip (read chip, or abbreviated exploit
   chip whose full text shows on hover); "" if the item no longer exists. */
function featuredChip(o, it) {
  if (it.type === "read") {
    if (!readIsShown(o, it.id)) return "";
    return readChip(it.id, oppReads(o)[it.id]);
  }
  const e = (o.exploits || []).find((x) => x.id === it.id);
  if (!e) return "";
  const label = (e.abbr && e.abbr.trim()) ? e.abbr.trim() : autoShort(e.text);
  return `<span class="excard" title="${esc(e.text)}">💡 ${esc(label)}</span>`;
}
/* Manual-order comparator within a group: explicit o.order first, then last-seen. */
function oppOrderCmp(stats) {
  return (a, b) => {
    const oa = a.order ?? Infinity, ob = b.order ?? Infinity;
    if (oa !== ob) return oa - ob;
    return (stats[b.id]?.last || b.updatedAt || 0) - (stats[a.id]?.last || a.updatedAt || 0);
  };
}

function oppRowHTML(o, st) {
  // The list row is just type + name (+ looks-like); reads and exploits live on the detail page.
  const chips = "";
  const showChips = !oppEditMode && chips;
  const handle = oppEditMode ? `<span class="draghandle" data-drag="${o.id}">⠿</span>` : "";
  const move = oppEditMode ? `<button class="movebtn" data-move="${o.id}">Group ▾</button>` : "";
  const badge = st ? `<span class="handbadge">${st.count}</span>` : "";
  const physLine = !oppEditMode && !chips && o.physical ? `<div class="s">${esc(o.physical)}</div>` : "";
  const type = PLAYER_TYPE_BY_ID[o.type];
  const typeCls = type ? ` ptype-${type.id}` : "";
  const typeStyle = type ? ` style="--player-color:${type.color}"` : "";
  // Tap the badge — filled with the type icon when set, empty circle otherwise
  // — to open a bottom-sheet picker without leaving the opponent list.
  const typePill = type
    ? `<button class="ptypemini set" data-ptype-open="${o.id}" title="${esc(type.label)} — tap to change">${type.icon}<span class="ptypename">${esc(type.label)}</span></button>`
    : `<button class="ptypemini empty" data-ptype-open="${o.id}" title="Set player type">◦</button>`;
  return `<div class="lrow opprow${typeCls}${oppEditMode ? " editing" : ""}" data-opp="${o.id}"${typeStyle}>
    ${handle}
    <div class="opprow-body">
      <div class="t">${typePill}${esc(o.name)}</div>
      ${physLine}
      ${showChips ? `<div class="chiprow cardchips">${chips}</div>` : ""}
    </div>
    ${move}${badge}
  </div>`;
}

/* Sheet: quick player-type picker from the opponents list row. */
function openPlayerTypeSheet(oppId) {
  const o = oppById(oppId); if (!o) return;
  sheetGroup = "__ptype__";
  const chips = PLAYER_TYPES.map((t) => {
    const on = o.type === t.id;
    return `<button class="ptypechip${on ? " on" : ""}" data-ptype-set="${t.id}" data-ptype-opp="${o.id}" style="${on ? `background:${t.color};border-color:${t.color};color:#0a0d12` : `border-color:${t.color};color:${t.color}`}">${t.icon} ${esc(t.label)}</button>`;
  }).join("");
  showSheet(
    `<div class="sheethead"><span class="t">${esc(o.name)} · player type</span>
       <button data-sheetclose>Close</button></div>
     <div class="chiprow tight">${chips}
       ${o.type ? `<button class="chip mini" data-ptype-set="" data-ptype-opp="${o.id}">Clear</button>` : ""}
     </div>`);
}

/* Search blob incl. pinyin so romanized typing matches Chinese names.
   Cached per opponent (keyed by id) and rebuilt only when an identity field
   changes — toPinyin ran on every opponent on every keystroke otherwise. */
const _searchBlobCache = new Map();
function searchBlob(o) {
  const c = _searchBlobCache.get(o.id);
  if (c && c.n === o.name && c.g === o.group && c.p === o.physical) return c.blob;
  const p = toPinyin(o.name);
  const blob = [o.name, o.physical, o.group, p.full, p.initials]
    .join(" ").toLowerCase().replace(/\s+/g, "");
  _searchBlobCache.set(o.id, { n: o.name, g: o.group, p: o.physical, blob });
  return blob;
}
function oppMatches(o, nq) {
  if (!nq) return true;
  return searchBlob(o).includes(nq);
}

function renderOpponents() {
  const nq = $("opp-search").value.trim().toLowerCase().replace(/\s+/g, "");
  const stats = oppStats();
  let list = OPP.filter((o) => !o.archived);
  if (nq) list = list.filter((o) => oppMatches(o, nq));
  list.sort(oppOrderCmp(stats));
  // section by group — most-recently-touched group first (ungrouped ranks by its own recency)
  const groupRecency = {};
  for (const o of list) {
    const g = o.group || "";
    const r = Math.max(stats[o.id]?.last || 0, o.updatedAt || 0);
    if (r > (groupRecency[g] || 0)) groupRecency[g] = r;
  }
  const groups = [...new Set(list.map((o) => o.group || ""))]
    .sort((a, b) => {
      // Pinned group (via edit-mode ★) always wins; else most-recently-touched first.
      if (pinnedGroup != null) {
        if (a === pinnedGroup) return -1;
        if (b === pinnedGroup) return 1;
      }
      return (groupRecency[b] || 0) - (groupRecency[a] || 0);
    });
  $("opp-edit").classList.toggle("on", oppEditMode);
  $("opp-edit").textContent = oppEditMode ? "Done" : "Edit";
  const byGroup = {};
  for (const o of list) (byGroup[o.group || ""] ||= []).push(o);
  $("opp-list").innerHTML = list.length ? groups.map((g) => {
    const members = byGroup[g] || [];
    const collapsed = collapsedGroups.has(g);
    const rows = members.map((o) => oppRowHTML(o, stats[o.id])).join("");
    const showHead = groups.length > 1 || g || oppEditMode;
    const add = oppEditMode ? `<button class="groupadd" data-groupadd="${esc(g)}">＋ add</button>` : "";
    const isPinned = pinnedGroup === g;
    const pinBtn = oppEditMode
      ? `<button class="grouppin${isPinned ? " on" : ""}" data-grouppin="${esc(g)}" title="Show this group first">${isPinned ? "★ First" : "☆ First"}</button>`
      : "";
    const head = showHead
      ? `<div class="grouphead">
           <button class="groupcollapse" data-groupcollapse="${esc(g)}">
             <span class="chev">${collapsed ? "▸" : "▾"}</span>
             <span class="tagcat">${esc(g || "ungrouped")}</span>
             <span class="gcount">${members.length}</span>
           </button>${pinBtn}${add}
         </div>` : "";
    return `${head}<div class="groupsec${collapsed ? " hidden" : ""}" data-group="${esc(g)}">${rows}</div>`;
  }).join("") : `<div class="empty">No opponents yet — tap ＋ to add your first villain.</div>`;
  updateGroupsDatalist();
  if (oppEditMode) bindOppDrag();
}

async function toggleGroupCollapse(g) {
  if (collapsedGroups.has(g)) collapsedGroups.delete(g);
  else collapsedGroups.add(g);
  await metaSet("collapsedGroups", [...collapsedGroups]);
  renderOpponents();
}

/* ---- reorder (drag) + regroup, active only in edit mode ---- */

/* Persist the current visual order of a group section as explicit o.order values. */
async function commitGroupOrder(sec) {
  const ids = [...sec.querySelectorAll("[data-opp]")].map((r) => r.dataset.opp);
  await Promise.all(ids.map((id, i) => {
    const o = oppById(id);
    if (o && o.order !== i) { o.order = i; o.updatedAt = Date.now(); return dbPut("opponents", o); }
  }));
}

/* Pointer-based drag: works on touch (iOS) and mouse. Drag a handle to reorder
   rows within their group section; drop position tracks the pointer. */
function bindOppDrag() {
  const list = $("opp-list");
  list.querySelectorAll(".draghandle").forEach((h) => {
    h.onpointerdown = (e) => {
      e.preventDefault();
      const row = h.closest(".opprow");
      const sec = row.closest(".groupsec");
      row.classList.add("dragging");
      const move = (ev) => {
        const x = ev.clientX, y = ev.clientY;
        const rows = [...sec.querySelectorAll(".opprow:not(.dragging)")];
        let after = null;
        for (const r of rows) {
          const box = r.getBoundingClientRect();
          // a laptop lays the rows out in columns, so reading order is left to right, then down
          const grid = box.width < sec.clientWidth * 0.9;
          if (grid ? y > box.bottom || (y > box.top && x > box.left + box.width / 2) : y > box.top + box.height / 2) after = r;
        }
        if (after) after.after(row);
        else sec.prepend(row);
      };
      const up = async () => {
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", up);
        row.classList.remove("dragging");
        await commitGroupOrder(sec);
        await refreshCache();
        renderOpponents();
      };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up);
    };
  });
}

/* Move one opponent to another group (or ungrouped / a brand-new group). */
function openMoveSheet(id) {
  const o = oppById(id);
  if (!o) return;
  const groups = [...new Set(OPP.map((x) => x.group).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const opt = (g, lbl) =>
    `<button class="mergeitem" data-setgroup="${esc(g)}">
       <span class="mnm">${esc(lbl)}</span>${(o.group || "") === g ? '<span class="msub">current</span>' : ""}
     </button>`;
  showSheet(`<div class="sheethead"><span class="t">Move ${esc(o.name)}</span>
      <button class="chip" data-sheetclose>Done</button></div>
    <div class="sheetnote">Move to a group, or make a new one.</div>
    <div class="mergelist">
      ${opt("", "Ungrouped")}
      ${groups.map((g) => opt(g, g)).join("")}
    </div>
    <input id="newgroup-name" class="vsearch" placeholder="New group name…" autocomplete="off">
    <button id="newgroup-go" class="primary" style="margin-top:8px">Move to new group</button>`);
  $("newgroup-go").onclick = async () => {
    const g = $("newgroup-name").value.trim();
    if (!g) return;
    await setOppGroup(id, g);
  };
  $("sheet").querySelectorAll("[data-setgroup]").forEach((b) => {
    b.onclick = () => setOppGroup(id, b.dataset.setgroup);
  });
}
async function setOppGroup(id, group) {
  const o = oppById(id);
  if (!o) return;
  o.group = group;
  o.order = undefined;                 // let it fall to the end of the new group
  o.updatedAt = Date.now();
  await dbPut("opponents", o);
  hideSheet();
  renderOpponents();
}

/* From a group heading: pull in opponents that are currently ungrouped. */
function openGroupAddSheet(group) {
  const pool = OPP.filter((o) => !o.archived && !(o.group || "")).sort((a, b) => a.name.localeCompare(b.name));
  if (!pool.length) { toast("No ungrouped players to add"); return; }
  const label = group || "ungrouped";
  showSheet(`<div class="sheethead"><span class="t">Add to “${esc(label)}”</span>
      <button class="chip" data-sheetclose>Done</button></div>
    <div class="sheetnote">Tap players to move them into this group.</div>
    <div class="mergelist">
      ${pool.map((o) => `<button class="mergeitem" data-addto="${o.id}">
        <span class="mnm">${esc(o.name)}</span></button>`).join("")}
    </div>`);
  $("sheet").querySelectorAll("[data-addto]").forEach((b) => {
    b.onclick = async () => {
      const o = oppById(b.dataset.addto);
      if (o) { o.group = group; o.order = undefined; o.updatedAt = Date.now(); await dbPut("opponents", o); }
      b.remove();
      renderOpponents();
    };
  });
}

/* Squid count picker: a scrollable column of numbers (press-and-select). */
function openSquidPicker(which) {
  const isHave = which === "have";
  // Cap the picker at n+4 where n is the current table size — a 6-max table
  // can never have more than 10 squid (5 each). "have" ≤ n+4, "left" ≤ n+4.
  const max = effectiveSeats() + 4;
  const cur = isHave ? draft.squidHave : draft.squidLeft;
  const title = isHave ? "🦑 Squid — have" : "🦑 Squid — left";
  const nums = ["", ...Array.from({ length: max + 1 }, (_, n) => String(n))];
  const hint = isHave
    ? "How many squids are on the table right now. 0 = no one has one yet; 1 = one player has posted; …"
    : "How many squid buy-ins are still available for the table this session.";
  showSheet(`<div class="sheethead"><span class="t">${title}</span>
      <button class="chip" data-sheetclose>Done</button></div>
    <div class="sheetnote">${hint}</div>
    <div class="numpicker">${nums.map((n) =>
      `<button class="numopt${String(cur) === n ? " on" : ""}" data-num="${n}">${n === "" ? "–" : n}</button>`).join("")}</div>`);
  $("sheet").querySelectorAll("[data-num]").forEach((b) => {
    b.onclick = () => {
      mutate(() => {
        if (isHave) draft.squidHave = b.dataset.num;
        else draft.squidLeft = b.dataset.num;
      });
      hideSheet();
    };
  });
}

/* Pointer-based drag-reorder for the lineup sheet — HTML5 DnD is unreliable on
   iOS Safari, so we watch touch/pointer moves and swap items based on hit-test. */
function attachTouchReorder(sheet, arr, onDrop) {
  const items = [...sheet.querySelectorAll(".lineitem[draggable]")];
  if (!items.length) return;
  items.forEach((el) => {
    const handle = el.querySelector(".draghandle");
    if (!handle) return;
    handle.addEventListener("touchstart", (e) => {
      e.preventDefault();
      const startIdx = +el.dataset.lidx;
      el.classList.add("dragging");
      const move = (ev) => {
        const t = ev.touches[0];
        const under = document.elementFromPoint(t.clientX, t.clientY);
        const target = under?.closest?.(".lineitem[draggable]");
        items.forEach((i) => i.classList.remove("dragover"));
        if (target && target !== el) target.classList.add("dragover");
      };
      const end = (ev) => {
        el.classList.remove("dragging");
        items.forEach((i) => i.classList.remove("dragover"));
        const t = ev.changedTouches?.[0];
        if (t) {
          const under = document.elementFromPoint(t.clientX, t.clientY);
          const target = under?.closest?.(".lineitem[draggable]");
          if (target && target !== el) {
            const dst = +target.dataset.lidx;
            const [item] = arr.splice(startIdx, 1);
            arr.splice(dst, 0, item);
            onDrop();
          }
        }
        handle.removeEventListener("touchmove", move);
        handle.removeEventListener("touchend", end);
      };
      handle.addEventListener("touchmove", move, { passive: false });
      handle.addEventListener("touchend", end);
    }, { passive: false });
  });
}

/* Today's table lineup (seat ring): set once, then one anchored position per
   hand fills in the rest. Edited in a live sheet, persisted to meta. */
const lineupName = (id) => id === "hero" ? "You (Hero)" : (oppById(id)?.name || "?");
const saveLineup = () => metaSet("tableLineup", tableLineup);
function openLineupSheet() { renderLineupSheet(); }
function renderLineupSheet() {
  const rows = tableLineup.map((id, i) =>
    `<div class="lineitem" draggable="true" data-lidx="${i}">
       <span class="draghandle" aria-hidden="true">⠿</span>
       <span class="seatno">${i + 1}</span>
       <span class="mnm">${esc(lineupName(id))}</span>
       <span class="linebtns">
         <button class="chip mini" data-lrm="${esc(id)}">✕</button>
       </span>
     </div>`).join("") || `<div class="empty">No one seated yet — add players below.</div>`;
  const inLineup = new Set(tableLineup);
  const pool = OPP.filter((o) => !o.archived && !inLineup.has(o.id)).sort((a, b) => a.name.localeCompare(b.name));
  // Bucket by group; ungrouped last. Search filters chips and hides empty groups.
  const groupsMap = new Map();
  pool.forEach((o) => {
    const g = (o.group || "").trim();
    if (!groupsMap.has(g)) groupsMap.set(g, []);
    groupsMap.get(g).push(o);
  });
  const groupKeys = [...groupsMap.keys()].sort((a, b) => a === "" ? 1 : b === "" ? -1 : a.localeCompare(b));
  const poolHtml = groupKeys.map((g) => {
    const chips = groupsMap.get(g).map((o) => `<button class="chip" data-ladd="${o.id}">${esc(o.name)}</button>`).join("");
    const label = esc(g || "No group");
    return `<div class="lineup-group" data-group="${esc(g)}"><div class="glabel sub">${label}</div><div class="chiprow">${chips}</div></div>`;
  }).join("");
  const heroAdd = inLineup.has("hero") ? "" : `<div class="chiprow" style="margin-bottom:8px"><button class="chip" data-ladd="hero">＋ You</button></div>`;
  const sizes = [4, 5, 6, 7, 8, 9].map((n) =>
    `<button class="chip mini${lineupSeats === n ? " on" : ""}" data-lsize="${n}">${n}</button>`).join("");
  const overCap = tableLineup.length > lineupSeats
    ? `<div class="sheetnote warn">⚠︎ ${tableLineup.length} players seated but table is ${lineupSeats}-handed. Increase table size or remove players.</div>` : "";
  showSheet(`<div class="sheethead"><span class="t">Table lineup</span>
      <button class="chip" data-sheetclose>Done</button></div>
    <div class="sheetnote">Seat everyone in clockwise order for today. Then each hand, tap just one player's position and the rest fill in automatically.</div>
    <div class="posrow" style="margin-bottom:8px"><span class="poslabel">Table size</span><div class="chiprow tight">${sizes}</div></div>
    ${overCap}
    <div class="linelist">${rows}</div>
    <div class="glabel" style="margin-top:14px">Add to table (all players)</div>
    <input id="lineup-search" class="vsearch" placeholder="🔍 Search…" autocomplete="off">
    <div id="lineup-pool">${heroAdd}${poolHtml}</div>
    ${tableLineup.length ? `<button class="secondary" id="lineup-clear" style="margin-top:12px">Clear lineup</button>` : ""}`);
  const sheet = $("sheet");
  const refresh = async () => {
    // Keep lineupSeats in sync with the lineup array length (source of truth).
    lineupSeats = effectiveSeats();
    await saveLineup();
    await metaSet("lineupSeats", lineupSeats);
    // If the current hand hasn't started (no actions/board/cards), let a lineup
    // edit re-seed the Table tab so it reflects the change.
    if (draft.mode === "table" && draftIsFresh()) {
      draft.villains = [];
      draft.heroPos = null;
      draft.heroIn = false;
      seedTableFromLineup();
    }
    renderLineupSheet();
    renderHandEntry();
    renderTableTab();
  };
  sheet.querySelectorAll("[data-lsize]").forEach((b) =>
    b.onclick = async () => {
      lineupSeats = Number(b.dataset.lsize);
      if (tableLineup.length > lineupSeats) {
        const dropped = tableLineup.slice(lineupSeats);
        tableLineup = tableLineup.slice(0, lineupSeats);
        toast(`Trimmed lineup to ${lineupSeats}. Dropped: ${dropped.map(lineupName).join(", ")}`, 3600);
      }
      await metaSet("lineupSeats", lineupSeats);
      refresh();
    });
  sheet.querySelectorAll("[data-ladd]").forEach((b) =>
    b.onclick = () => {
      if (tableLineup.length >= 9) {
        toast("Table is 9-handed max.", 3200);
        return;
      }
      tableLineup.push(b.dataset.ladd);
      refresh();
    });
  sheet.querySelectorAll("[data-lrm]").forEach((b) =>
    b.onclick = () => { tableLineup = tableLineup.filter((x) => x !== b.dataset.lrm); refresh(); });
  // Drag-to-reorder for the lineup (touch + mouse via HTML5 DnD).
  let dragSrc = -1;
  sheet.querySelectorAll(".lineitem[draggable]").forEach((el) => {
    el.addEventListener("dragstart", (e) => {
      dragSrc = +el.dataset.lidx;
      el.classList.add("dragging");
      e.dataTransfer?.setData("text/plain", String(dragSrc));
      e.dataTransfer && (e.dataTransfer.effectAllowed = "move");
    });
    el.addEventListener("dragend", () => el.classList.remove("dragging"));
    el.addEventListener("dragover", (e) => {
      e.preventDefault();
      el.classList.add("dragover");
    });
    el.addEventListener("dragleave", () => el.classList.remove("dragover"));
    el.addEventListener("drop", (e) => {
      e.preventDefault();
      el.classList.remove("dragover");
      const dst = +el.dataset.lidx;
      if (dragSrc < 0 || dragSrc === dst) return;
      const [item] = tableLineup.splice(dragSrc, 1);
      tableLineup.splice(dst, 0, item);
      dragSrc = -1;
      refresh();
    });
  });
  // Touch drag: pointer-based fallback for iPhone Safari (HTML5 DnD is spotty on iOS).
  attachTouchReorder(sheet, tableLineup, refresh);
  const clr = $("lineup-clear");
  if (clr) clr.onclick = () => { if (confirm("Clear the table lineup?")) { tableLineup = []; refresh(); } };
  const srch = $("lineup-search");
  if (srch) srch.oninput = () => {
    const nq = srch.value.trim().toLowerCase().replace(/\s+/g, "");
    sheet.querySelectorAll("#lineup-pool [data-ladd]").forEach((b) => {
      if (b.dataset.ladd === "hero") return;
      const o = oppById(b.dataset.ladd);
      b.style.display = (!nq || (o && oppMatches(o, nq))) ? "" : "none";
    });
    // hide a group heading entirely if none of its chips are visible
    sheet.querySelectorAll("#lineup-pool .lineup-group").forEach((g) => {
      const anyVisible = [...g.querySelectorAll("[data-ladd]")].some((b) => b.style.display !== "none");
      g.style.display = anyVisible ? "" : "none";
    });
  };
}

/* Front-page card editor: pick & order the reads + exploits shown on the list
   row. Mirrors the lineup sheet — ordered list with ↑ ↓ ✕ plus an add-picker. */
function itemLabel(o, it) {
  if (it.type === "read") return TAG_BY_ID[it.id]?.label || it.id;
  const e = (o.exploits || []).find((x) => x.id === it.id);
  return e ? (e.abbr?.trim() || autoShort(e.text)) : "(deleted)";
}
function openCardSheet() { renderCardSheet(); }
function renderCardSheet() {
  const o = oppById(curOppId);
  if (!o) return;
  const feat = featuredItems(o);
  const key = (it) => it.type + ":" + it.id;
  const chosen = new Set(feat.map(key));
  const rows = feat.map((it, i) => {
    const e = it.type === "exploit" ? (o.exploits || []).find((x) => x.id === it.id) : null;
    const tag = it.type === "exploit"
      ? `<input class="abbrin" data-abbr="${it.id}" placeholder="short tag" value="${esc(e?.abbr || "")}">`
      : "";
    return `<div class="lineitem">
       <span class="seatno">${i + 1}</span>
       <span class="mnm">${it.type === "exploit" ? "💡 " : ""}${esc(itemLabel(o, it))}</span>
       ${tag}
       <span class="linebtns">
         <button class="chip mini" data-cup="${i}"${i === 0 ? " disabled" : ""}>↑</button>
         <button class="chip mini" data-cdown="${i}"${i === feat.length - 1 ? " disabled" : ""}>↓</button>
         <button class="chip mini" data-crm="${esc(key(it))}">✕</button>
       </span>
     </div>`;
  }).join("") || `<div class="empty">Nothing on the card yet — add reads or exploits below.</div>`;
  const setReads = Object.keys(oppReads(o)).filter((id) => oppReads(o)[id] && !chosen.has("read:" + id) && TAG_BY_ID[id]);
  const exps = (o.exploits || []).filter((e) => !chosen.has("exploit:" + e.id));
  const pool =
    setReads.map((id) => `<button class="chip" data-cadd="read:${esc(id)}">${esc(TAG_BY_ID[id].label)}</button>`).join("") +
    exps.map((e) => `<button class="chip" data-cadd="exploit:${esc(e.id)}">💡 ${esc(e.abbr?.trim() || autoShort(e.text))}</button>`).join("");
  // Strong reads auto-show on the row while no reads are featured; give each
  // one a per-opponent opt-out so a noisy read can be kept off the card.
  const featHasReads = feat.some((it) => it.type === "read");
  const strong = Object.entries(oppReads(o)).filter(([rid, s]) => isStrongRead(s) && readIsShown(o, rid));
  const autoHTML = !featHasReads && strong.length
    ? `<div class="glabel" style="margin-top:12px">Auto-shown strong reads</div>
       <div class="sheetnote">These show on the row while no reads are featured — tap one to hide/show it.</div>
       <div class="chiprow" id="card-auto">` +
      strong.map(([rid, s]) => {
        const hid = !!(o.hiddenReads || {})[rid];
        return `<button class="chip mini${hid ? "" : " on " + (STATE_CLASS[s] || "")}" data-chide="${esc(rid)}">${hid ? "🚫 " : ""}${esc(TAG_BY_ID[rid]?.label || rid)}</button>`;
      }).join("") + `</div>`
    : "";
  showSheet(`<div class="sheethead"><span class="t">Front-page card</span>
      <button class="chip" data-sheetclose>Done</button></div>
    <div class="sheetnote">Pick which reads &amp; exploits show on this player's row, and drag the order. Exploit chips show your short tag (full text on hover).</div>
    <div class="linelist">${rows}</div>
    <div class="glabel" style="margin-top:12px">Add to card</div>
    <div class="chiprow" id="card-pool">${pool || `<span class="chipnote">set some reads or add exploits first</span>`}</div>
    ${autoHTML}`);
  const sheet = $("sheet");
  const refresh = async () => {
    o.updatedAt = Date.now();
    await dbPut("opponents", o);
    $("od-card-preview").innerHTML = featuredItems(o).map((it) => featuredChip(o, it)).filter(Boolean).join("")
      || `<span class="chipnote">Nothing featured yet — tap Edit to choose reads & exploits.</span>`;
    renderCardSheet();
  };
  const idxOf = (k) => feat.findIndex((it) => key(it) === k);
  sheet.querySelectorAll("[data-cadd]").forEach((b) => b.onclick = () => {
    const [type, ...rest] = b.dataset.cadd.split(":"); feat.push({ type, id: rest.join(":") }); refresh();
  });
  sheet.querySelectorAll("[data-crm]").forEach((b) => b.onclick = () => {
    const i = idxOf(b.dataset.crm); if (i >= 0) feat.splice(i, 1); refresh();
  });
  sheet.querySelectorAll("[data-cup]").forEach((b) => b.onclick = () => {
    const i = +b.dataset.cup; if (i > 0) { [feat[i - 1], feat[i]] = [feat[i], feat[i - 1]]; refresh(); }
  });
  sheet.querySelectorAll("[data-cdown]").forEach((b) => b.onclick = () => {
    const i = +b.dataset.cdown; if (i < feat.length - 1) { [feat[i + 1], feat[i]] = [feat[i], feat[i + 1]]; refresh(); }
  });
  sheet.querySelectorAll("[data-abbr]").forEach((inp) => inp.onchange = async () => {
    const e = (o.exploits || []).find((x) => x.id === inp.dataset.abbr);
    if (e) { e.abbr = inp.value.trim(); o.updatedAt = Date.now(); await dbPut("opponents", o); renderCardSheet(); }
  });
  sheet.querySelectorAll("[data-chide]").forEach((b) => b.onclick = () => {
    o.hiddenReads = o.hiddenReads || {};
    const rid = b.dataset.chide;
    if (o.hiddenReads[rid]) delete o.hiddenReads[rid]; else o.hiddenReads[rid] = true;
    refresh();
  });
}

/* Add a reusable archetype exploit (EXPLOIT_TEMPLATES) onto this opponent —
   abbr = short code (card chip), text = full description (tap to reveal). */
function openTemplateSheet() {
  const o = oppById(curOppId);
  if (!o) return;
  const has = (abbr) => (o.exploits || []).some((e) => e.src === "tmpl:" + abbr);
  showSheet(`<div class="sheethead"><span class="t">Exploit templates</span>
      <button class="chip" data-sheetclose>Done</button></div>
    <div class="sheetnote">Tap to add an archetype. The code (e.g. EQF) shows on the card; the full text reveals on tap.</div>
    <div class="mergelist">${EXPLOIT_TEMPLATES.map((t) =>
      `<button class="mergeitem tmplitem" data-tmpl="${esc(t.abbr)}"${has(t.abbr) ? " disabled" : ""}>
         <span class="tmplcode">${esc(t.abbr)}</span>
         <span class="tmplbody"><span class="mnm">${esc(t.name)}</span>
           <span class="tmpltext">${esc(t.text)}</span></span>
         ${has(t.abbr) ? '<span class="msub">added</span>' : '<span class="msub">＋</span>'}
       </button>`).join("")}</div>`);
  $("sheet").querySelectorAll("[data-tmpl]").forEach((b) => b.onclick = async () => {
    if (b.disabled) return;
    const t = EXPLOIT_TEMPLATES.find((x) => x.abbr === b.dataset.tmpl);
    if (!t) return;
    (o.exploits = o.exploits || []).unshift({ id: uid(), ts: Date.now(), text: t.text, abbr: t.abbr, wins: [], adj: false, src: "tmpl:" + t.abbr });
    o.updatedAt = Date.now();
    await dbPut("opponents", o);
    toast(`Added ${t.abbr}`);
    openTemplateSheet();          // re-render so it shows as "added"
    renderOppDetail(curOppId);
  });
}

async function createOpponent(name, group) {
  const o = { id: uid(), name, group: group || "", tags: [], physical: "", notes: [],
    createdAt: Date.now(), updatedAt: Date.now(), archived: false };
  OPP.push(o);
  await dbPut("opponents", o);
  return o;
}

/* ================= Opponent detail ================= */

function renderOppDetail(id) {
  const o = oppById(id);
  if (!o) { location.hash = "#opponents"; return; }
  if (curOppId !== id) { editNoteId = null; editExploitId = null; }
  curOppId = id;
  const mine = HANDS.filter((h) => (h.villainIds || []).includes(id));   // this villain's hands — scanned once, reused across the whole detail render
  const ST = sdStats(id, mine).T;
  sdStatT = ST;
  $("od-name").textContent = o.name;
  $("od-meta").textContent = [o.group, o.physical].filter(Boolean).join(" · ");
  // Player-type picker + pill: color-themes the opponent's list row and puts
  // a matching pill next to their name in detail.
  const type = PLAYER_TYPE_BY_ID[o.type];
  const nameEl = $("od-name");
  nameEl.style.setProperty("--player-color", type ? type.color : "");
  nameEl.classList.toggle("has-player-type", !!type);
  $("od-name").innerHTML = esc(o.name) +
    (type ? ` <span class="ptypepill" style="background:${type.color};border-color:${type.color}">${type.icon} ${esc(type.label)}</span>` : "");
  const ptypeHTML = PLAYER_TYPES.map((t) => {
    const on = o.type === t.id;
    return `<button class="ptypechip${on ? " on" : ""}" data-ptype="${t.id}" style="${on ? `background:${t.color};border-color:${t.color};color:#0a0d12` : `border-color:${t.color};color:${t.color}`}">${t.icon} ${esc(t.label)}</button>`;
  }).join("");
  $("od-ptype").innerHTML =
    `<div class="chiprow tight">${ptypeHTML}${o.type ? `<button class="chip mini" data-ptype="">Clear</button>` : ""}</div>`;
  const feat = featuredItems(o);
  $("od-card-preview").innerHTML = feat.map((it) => featuredChip(o, it)).filter(Boolean).join("")
    || `<span class="chipnote">Nothing featured yet — tap Edit to choose reads & exploits.</span>`;
  $("od-editform").classList.add("hidden");
  $("od-e-name").value = o.name;
  $("od-e-group").value = o.group || "";
  $("od-e-physical").value = o.physical || "";

  const reads = oppReads(o);
  const readBtn = (id, lbl, bubble) => {
    const st = reads[id];
    if (isPositionRead(id)) {
      const active = readIsActive(id, st);
      const opts = ['<option value="">–</option>']
        .concat(POSITIONS.map((p) => `<option value="${p}"${st === p ? " selected" : ""}>${p}</option>`))
        .join("");
      return `<div class="posread${active ? " on" : ""}" title="${esc(lbl)}">
        <span class="prlbl">${esc(lbl)}</span>
        <select class="prselect" data-posselect="${id}">${opts}</select>
      </div>`;
    }
    if (isChoiceRead(id)) {
      const active = readIsActive(id, st);
      const opts = CHOICE_READS[id].map((v) =>
        `<button class="chip mini${st === v ? " on sscale" : ""}" data-choice="${id}" data-val="${esc(v)}">${esc(cap1(v))}</button>`).join("");
      return `<div class="choiceread${active ? " on" : ""}"><span class="prlbl">${esc(lbl)}</span><div class="choiceopts">${opts}</div></div>`;
    }
    if (isScaleRead(id)) {                                            // computed from his logged hands, not a manual slider
      const k = SCALE_STAT[id], r = k && ST[k + "|all"];
      if (!r || !r[1]) return `<div class="scaleread statread"><span class="scalelbl">${esc(lbl)}</span><span class="scaleval">–</span></div>`;
      const pc = Math.round((100 * r[0]) / r[1]);
      return `<div class="scaleread statread on stk" data-stk="${k}|all"><span class="scalelbl">${esc(lbl)}</span><span class="scaleval"><b>${pc}%</b> · ${r[0]}/${r[1]}</span></div>`;
    }
    const base = bubble ? "bubble" : "chip mini";
    return `<button class="${base}${st ? " on " + STATE_CLASS[st] : ""}" data-tag="${id}">${esc(lbl)}</button>`;
  };
  // A single seat <select> for a position read.
  const posSelect = (id) => {
    const st = reads[id];
    const opts = ['<option value="">–</option>']
      .concat(POSITIONS.map((p) => `<option value="${p}"${st === p ? " selected" : ""}>${p}</option>`)).join("");
    return `<select class="prselect${readIsActive(id, st) ? " on" : ""}" data-posselect="${id}">${opts}</select>`;
  };
  // Choice / position reads render as a labelled row that lines up with the
  // F/T/R bubble rows above — one visual language for every graded read.
  const structRow = (label, inner) => `<div class="readgroup"><span class="rglabel">${esc(label)}</span>${inner}</div>`;
  const structFor = (id) => {
    if (POS_PAIR_SECONDARY.has(id)) return "";                 // drawn with its V partner
    if (isPositionRead(id)) {
      const pair = POS_PAIR_BY_V[id];
      if (pair) return structRow(pair.label,
        `<div class="prpair"><label class="prtag${readIsActive(pair.v, reads[pair.v]) ? " on" : ""}">V${posSelect(pair.v)}</label>` +
        `<label class="prtag${readIsActive(pair.b, reads[pair.b]) ? " on" : ""}">B${posSelect(pair.b)}</label></div>`);
      return structRow(TAG_BY_ID[id].label, `<div class="prpair">${posSelect(id)}</div>`);
    }
    if (isTallyRead(id)) {
      const counts = reads[id] || {};
      const lead = tallyLeader(counts);
      const opts = TALLY_READS[id].map((v) => {
        const n = counts[v] || 0;
        return `<button class="chip mini${n ? " on sscale" : ""}" data-tally="${id}" data-val="${esc(v)}">${esc(cap1(v))}${n ? `<span class="tallyn">${n}</span>` : ""}</button>`;
      }).join("");
      const clr = lead ? `<button class="chip mini scaleclr" data-tallyclear="${id}" title="Clear">✕</button>` : "";
      return structRow(TAG_BY_ID[id].label, `<div class="bubbles">${opts}${clr}</div>`);
    }
    const opts = CHOICE_READS[id].map((v) =>
      `<button class="chip mini${reads[id] === v ? " on sscale" : ""}" data-choice="${id}" data-val="${esc(v)}">${esc(cap1(v))}</button>`).join("");
    return structRow(TAG_BY_ID[id].label, `<div class="bubbles">${opts}</div>`);
  };
  const live = (id) => { const t = TAG_BY_ID[id]; return t && !RETIRED_TAG_IDS.has(id) && !SIZING_GRID_IDS.has(id) ? t : null; };
  const placed = new Set(READ_LAYOUT.flatMap((c) => c.subs.flatMap((sb) => sb.rows.flatMap((r) => r.ids))));
  const rowHTML = (r) => {
    // Graded reads (choice + position + tally + scale) drop to aligned "label + controls"
    // rows so heavy dropdown boxes don't zig-zag between small chips.
    const chipIds = [], rowIds = [];
    r.ids.forEach((id) => {
      if (!live(id)) return;
      (isPositionRead(id) || isChoiceRead(id) || isTallyRead(id) || isScaleRead(id) ? rowIds : chipIds).push(id);
    });
    const chips = chipIds.map((id) => readBtn(id, TAG_BY_ID[id].label, false)).join("");
    const rows = rowIds.map((id) => isScaleRead(id) ? readBtn(id, TAG_BY_ID[id].label, false) : structFor(id)).join("");
    return `<div class="readsub">${r.label ? `<span class="rslabel">${esc(r.label)}</span>` : ""}` +
      (chips ? `<div class="chiprow readwrap">${chips}</div>` : "") + rows +
      (!chips && !rows ? `<div class="chiprow readwrap"><span class="chipnote">—</span></div>` : "") + `</div>`;
  };
  $("od-tags").innerHTML = READ_LAYOUT.map((cat) => {
    let subs = cat.subs;
    if (cat.title === "Uncategorized") {
      // reads not placed above, plus retired reads an opponent still carries (so they can be cleared)
      const extra = TENDENCY_TAGS.filter((t) => live(t.id) && !placed.has(t.id)).map((t) => readBtn(t.id, t.label, false))
        .concat(TENDENCY_TAGS.filter((t) => RETIRED_TAG_IDS.has(t.id) && readIsActive(t.id, reads[t.id]))
          .map((t) => readBtn(t.id, t.label + " (retired)", false))).join("");
      subs = [{ rows: subs[0].rows }];
      var otherHTML = extra ? `<div class="readsub"><span class="rslabel">Other</span><div class="chiprow readwrap">${extra}</div></div>` : "";
    }
    return `<div class="tagcat">${esc(cat.title)}</div>` + subs.map((sb) =>
      (sb.label ? `<div class="tagrole">${esc(sb.label)}</div>` : "") +
      `<div class="${sb.label ? "roleblock" : ""}">${sb.rows.map(rowHTML).join("")}</div>`).join("") +
      (cat.title === "Uncategorized" ? otherHTML : "");
  }).join("");

  // FEATURE 1 — what this opponent's logged hands say. Three panels off one
  // registry: reads worth adding, the hands behind the reads already on the
  // card, and one-sided tells that no read on the card can express.
  const facts = oppFacts(o, mine);
  const sgHead = (label, key, open) =>
    `<div class="sugghead" data-toggle="${key}"><span>${esc(label)}</span><span class="toggle-arrow">${open ? "▼" : "▶"}</span></div>`;
  const ofN = (n, m) => `${n} of ${m} chance${m === 1 ? "" : "s"}${m ? ` · ${Math.round((100 * n) / m)}%` : ""}`;

  const dReads = derivedReads(o, mine, facts);
  const showD = showDerivedReads[id];
  const dHTML = dReads.length
    ? sgHead("From logged hands · small sample", "dreads", showD) + (showD ? dReads.map((s) =>
        `<div class="suggitem" data-dtag="${esc(s.tagId)}" data-dstate="${esc(s.state || "yes")}" data-dkey="${esc(s.key)}">
           <div class="notetext">📊 <b>${esc(s.label)}</b> — ${ofN(s.count, s.chances)}</div>
           <div class="noterowbtns">
             <button class="chip mini" data-dwhy>Show the hands</button>
             <button class="chip mini on sgreen" data-dacc>＋ Add read</button>
             <button class="chip mini" data-ddismiss>Dismiss</button>
           </div></div>`).join("") : "")
    : "";

  const setEv = setReadEvidence(o, facts);
  const showE = showReadEvid[id];
  const eHTML = setEv.length
    ? sgHead(`Hands behind your reads · ${setEv.length}`, "revid", showE) + (showE ? setEv.map((s) =>
        `<div class="suggitem" data-ewhy="${esc(s.tagId)}">
           <div class="notetext">▦ <b>${esc(s.label)}</b> — ${ofN(s.hands.length, s.chances)}</div>
           <div class="noterowbtns"><button class="chip mini" data-ewhygo>Show the hands</button></div>
         </div>`).join("") : "")
    : "";

  const sigs = exploitSignals(facts);
  const showS = showExploitSignals[id];
  const sHTML = sigs.length
    ? sgHead(`Exploit signals · ${sigs.length}`, "rsig", showS) + (showS ? sigs.map((s, i) =>
        `<div class="suggitem suggstrong" data-swhy="${i}">
           <div class="notetext">🎯 <b>${esc(s.label)}</b> — ${esc(s.detail)}</div>
           <div class="noterowbtns"><button class="chip mini" data-swhygo>Show the hands</button></div>
         </div>`).join("") : "")
    : "";

  $("od-readsugg").innerHTML = dHTML + eHTML + sHTML;

  {
    const allNotes = o.notes || [];
    const converted = allNotes.filter((n) => n.handId);
    const showConv = !!showConvertedNotes[id];
    const visibleNotes = showConv ? allNotes : allNotes.filter((n) => !n.handId);
    const toggleHTML = converted.length
      ? `<div class="sugghead" data-toggle-convnotes>
           <span>${showConv ? "Hide" : "Show"} converted (${converted.length})</span>
           <span class="toggle-arrow">${showConv ? "▼" : "▶"}</span>
         </div>` : "";
    const notesHTML = visibleNotes.map((n) =>
      n.id === editNoteId
        ? `<div class="noteitem" data-note="${n.id}">
            <textarea class="noteedit" rows="2">${esc(n.text)}</textarea>
            <div class="noterowbtns">
              <button class="chip mini" data-notecancel>Cancel</button>
              <button class="chip mini on" data-notesave>Save</button>
            </div></div>`
        : `<div class="noteitem" data-note="${n.id}">
            <div class="notetext">${n.handId ? '<span class="convtag">✓ hand</span> ' : ""}${esc(n.text)}</div>
            <div class="noterowbtns">
              ${n.handId
                ? `<button class="chip mini" data-notegohand>Open hand ↗</button>`
                : (isConvertibleNote(n.text)
                    ? `<button class="chip mini" data-notehand>→ Convert to hand</button>
                       <button class="chip mini" data-notereview>Review parse</button>`
                    : "")}
              <button class="chip mini" data-noteedit>Edit</button>
              <button class="chip mini" data-notedel>Delete</button>
            </div></div>`
    ).join("");
    $("od-notes").innerHTML = toggleHTML + (notesHTML || `<div class="empty">No notes yet.</div>`);
  }

  // FEATURE 4 — order exploits: ones the villain ADJUSTS to first, then by
  // effectiveness (recency-weighted "Worked" taps)
  const exps = [...(o.exploits || [])].map((e) => ({ e, sc: exploitScore(e) }))
    .sort((a, b) => (b.e.adj ? 1 : 0) - (a.e.adj ? 1 : 0) || b.sc - a.sc);
  const scored = exps.filter((x) => x.sc > 0).sort((a, b) => b.sc - a.sc);
  const topId = scored.length ? scored[0].e.id : null;
  $("od-exploits").innerHTML = exps.map(({ e: n }) => {
    const topBadge = n.id === topId ? `<span class="topbadge">top</span>` : "";
    const adjBadge = n.adj ? `<span class="adjbadge" title="This player adjusts to this exploit">⚠︎ ADJ</span>` : "";
    const hidden = !!n.hideFront;
    return n.id === editExploitId
      ? `<div class="noteitem" data-exp="${n.id}">
          <textarea class="noteedit" rows="2">${esc(n.text)}</textarea>
          <div class="noterowbtns">
            <button class="chip mini" data-expcancel>Cancel</button>
            <button class="chip mini on sgreen" data-expsave>Save</button>
          </div></div>`
      : `<div class="noteitem${n.adj ? " adj" : ""}${hidden ? " hiddenfront" : ""}" data-exp="${n.id}">
          <div class="notetext">${esc(n.text)} ${adjBadge}${topBadge}</div>
          <div class="noterowbtns">
            <button class="chip mini confcycle${(n.conf ?? 0) === 0 ? " off" : ""}" data-expconfcycle title="Confidence 0–5 · tap to cycle">${n.conf ?? 0}</button>
            <button class="chip mini pinbtn${hidden ? "" : " on"}" data-exphide title="Show or hide this exploit on the opponent list card">${hidden ? "🚫 Hidden" : "👁 On front"}</button>
            <button class="chip mini adjbtn${n.adj ? " on" : ""}" data-expadj title="Does this player adjust when you use this?">Adj.</button>
            <button class="chip mini" data-expedit>Edit</button>
            <button class="chip mini" data-expdel>Delete</button>
          </div></div>`;
  }).join("") || `<div class="empty">No exploits yet — how do you beat this player?</div>`;

  const suggs = suggestedExploits(o);
  const showSugg = showSuggestedExploits[id];
  $("od-exsugg").innerHTML = suggs.length
    ? `<div class="sugghead" data-toggle-sugg>
        <span>Suggested from reads (${suggs.length})</span>
        <span class="toggle-arrow">${showSugg ? "▼" : "▶"}</span>
      </div>` + (showSugg ? suggs.map((s) => {
        const icon = s.compound ? "🎯" : (s.strong ? "⭐" : "💡");
        return `<div class="suggitem${s.compound ? " suggcompound" : ""}${s.strong ? " suggstrong" : ""}" data-key="${esc(s.key)}">
           <div class="notetext">${icon} ${esc(s.text)}</div>
           <div class="noterowbtns">
             <button class="chip mini on sgreen" data-exacc>＋ Add</button>
             <button class="chip mini" data-exdismiss>Dismiss</button>
           </div></div>`;
      }).join("") : "")
    : "";

  // Showdowns lead — a hand where his cards turned over is worth more than a
  // newer one that ended on a fold. Then cards-known, then the rest.
  const allHands = mine.slice().sort(showdownFirst(id));
  renderHandFilters(id, allHands);
  const hands = handFiltersActive() ? allHands.filter((h) => handMatchesFilters(h, id)) : allHands;
  // Hands where we saw the cards lead; no-cards hands (stats-only) go in a
  // collapsed group so they don't bury the reviewable spots.
  const seen = hands.filter((h) => cardsSeen(h, id));
  const noCards = hands.filter((h) => !cardsSeen(h, id));
  handPlayIds = hands.map((h) => h.id);                 // the reel is whatever the filters left
  handFiltersFor = id;
  $("od-play").classList.toggle("hidden", !hands.length);
  $("od-play").textContent = `▶ Play ${hands.length}`;
  const seenHTML = seen.map((h) => handRowHTML(h, id)).join("");
  const noCardsHTML = noCards.length
    ? `<div class="grouphead nocardshead">
         <button class="groupcollapse" data-nocards>
           <span class="chev">${noCardsOpen ? "▾" : "▸"}</span>
           <span class="tagcat">No cards seen</span>
           <span class="gcount">${noCards.length}</span>
         </button>
       </div>
       <div class="nocardssec${noCardsOpen ? "" : " hidden"}">${noCards.map((h) => handRowHTML(h, id)).join("")}</div>`
    : "";
  $("od-hands").innerHTML = (seenHTML + noCardsHTML) ||
    (allHands.length ? `<div class="empty">No hands match these filters. ${allHands.length} total — try clearing.</div>` : `<div class="empty">No hands logged.</div>`);

  renderStats(id, mine);
  renderSizing(id, mine);
  renderSeq(id, mine);
  renderRanges(id, mine);
}

/* ================= Hand rendering (rows + full text) ================= */

function actorLabel(h, actor) {
  if (actor === "hero") return "Hero";
  const i = Number(actor.slice(1));
  return oppById(h.villains?.[i]?.opponentId)?.name || `V${i + 1}`;
}
function actionStr(h, a) {
  const raw = isRawSize(h);
  const sz = a.size ? (raw ? String(a.size).replace(/^\$/, "") : a.size) : "";
  return `${actorLabel(h, a.actor)} ${a.act}${sz ? " " + sz : ""}`;
}
/* Plain-English hand-history line for a list row — reads like a live-poker
   log: "Pre: raise 40K, 3-bet 120K, call · Flop K♠7♥2♣: check, bet 160K,
   fold". Multipliers ("3x") and pot-percent sizes ("50%") are resolved to
   chip amounts via estimatePot so every visible size is a K count. Actor
   labels are omitted — order alone reads clearly in a two-player context. */
function fmtK(n, raw = false) {
  if (!n) return "";
  if (raw) return String(Math.round(n));
  if (n >= 10) return Math.round(n) + "K";
  return (Math.round(n * 10) / 10) + "K";
}
/* Sizing fallback that preserves % / x markers so a percent-pot size never
   renders as a bare "50" (which reads as chip count). Only used when the
   pot estimator can't resolve to a K amount. */
const sizeLabelKeepMarker = (s, raw = false) => !s ? "" :
  raw
    ? (/^\$?\d/.test(s) ? String(s).replace(/^\$/, "") : s)
    : /^\$\d/.test(s) ? s.slice(1) + "K" :
      /^\d+(\.\d+)?k$/i.test(s) ? s.toUpperCase() : s;
function handHistoryLineHTML(h, focusActor) {
  const acts = h.actions || [];
  if (!acts.length) return "";
  const raw = isRawSize(h);
  const pe = estimatePot(h, acts);
  const uniqActors = new Set(acts.map((a) => a.actor));
  // Focus mode (opponent-page rows): in a multiway hand show only that
  // player's own actions. Heads-up hands keep the full dialogue — half the
  // story would vanish otherwise.
  const focus = focusActor && uniqActors.size > 2 ? focusActor : null;
  const multiway = !focus && uniqActors.size > 2;
  const shortActor = (actor) => {
    if (actor === "hero") return "Hero";
    const i = Number(actor.slice(1));
    const v = h.villains?.[i];
    const nm = oppById(v?.opponentId)?.name;
    const seat = v?.pos;
    const stem = nm ? nm.split(/\s+/)[0] : `V${i + 1}`;
    return seat ? `${seat} ${stem}` : stem;
  };
  const verb = (a, i) => {
    if (a.act === "jam" || a.size === "Jam") return "jam";
    if (a.act === "fold")  return "fold";
    if (a.act === "check") return "check";
    const amt = pe.perAct[i] ? fmtK(pe.perAct[i], raw) : (a.size ? sizeLabelKeepMarker(a.size, raw) : "");
    switch (a.act) {
      case "call":  return amt ? "call " + amt : "call";
      case "limp":  return "limp";
      case "bet":   return amt ? "bet " + amt : "bet";
      case "raise": return amt ? "raise " + amt : "raise";
      case "3bet":  return amt ? "3-bet " + amt : "3-bet";
      case "4bet":  return amt ? "4-bet " + amt : "4-bet";
      case "5bet":  return amt ? "5-bet " + amt : "5-bet";
      default:      return a.act;
    }
  };
  const b = h.board || [];
  const streetPrefix = { pre: "Pre", flop: "Flop", turn: "Turn", river: "River" };
  const boardTiles = (cards) => cards.filter(Boolean).map((c) => tileHTML(c)).join("");
  const parts = [];
  // Other players' folds are always shown, small: on a player's own rows (focus) their other actions are hidden but who folded still matters.
  const smallFold = (i) => acts[i].act === "fold" && (focus ? acts[i].actor !== focus : multiway);
  const seatOf = (actor) => (actor === "hero" ? h.heroPos : h.villains?.[Number(actor.slice(1))]?.pos) || shortActor(actor);
  // Preflop shows every action (who opened, who folded, who 3bet); later streets on a player's own rows keep just his actions plus the folds.
  const idxAll = acts.map((_, i) => i).filter((i) => !focus || acts[i].actor === focus || acts[i].street === "pre" || smallFold(i));
  for (const st of STREETS) {
    const idxs = idxAll.filter((i) => acts[i].street === st);
    if (!idxs.length) continue;
    let head = `<span class="hh-st">${streetPrefix[st]}</span>`;
    if (st === "flop" && b.slice(0, 3).some(Boolean)) head += boardTiles(b.slice(0, 3));
    else if (st === "turn" && b[3]) head += boardTiles([b[3]]);
    else if (st === "river" && b[4]) head += boardTiles([b[4]]);
    // Multi-way hands (imports especially) are unreadable as a bare verb chain;
    // prefix each action with the actor so it's clear who's doing what.
    // Other players' folds are small: one reads "HJ fold", a run of them "5 folds".
    const labelled = multiway || (focus && st === "pre");
    const pieces = [];
    for (let k = 0; k < idxs.length; k++) {
      const i = idxs[k];
      if (smallFold(i)) {
        let run = 1;
        while (k + run < idxs.length && smallFold(idxs[k + run])) run++;
        pieces.push(`<span class="hh-fold">${run > 1 ? run + " folds" : esc(seatOf(acts[i].actor)) + " fold"}</span>`);
        k += run - 1;
        continue;
      }
      const v = esc(verb(acts[i], i));
      if (!labelled) { pieces.push(`<span class="hh-verb">${v}</span>`); continue; }
      const who = esc(focus ? seatOf(acts[i].actor) : shortActor(acts[i].actor));
      pieces.push(`<span class="hh-act"><span class="hh-who">${who}</span> <span class="hh-verb">${v}</span></span>`);
    }
    const chain = pieces.join(`<span class="hh-comma">,</span> `);
    parts.push(`<span class="hh-street">${head}<span class="hh-colon">:</span> ${chain}</span>`);
  }
  return parts.join(`<span class="hh-sep">·</span>`);
}
/* Row in a hands list, in the standard hand-history style. With `oppId`,
   lead with THAT villain's position + hole cards; on the general feed, lead
   with the villain lineup. Bottom line: compressed street-by-street action. */
function handRowHTML(h, oppId) {
  const win = handWinner(h);   // computed once — reused for the hero-result dot and the villain won-badge below
  const res = !win ? (h.result || null)
    : (h.hero === false ? null
       : (win.winners.includes("hero") ? (win.winners.length > 1 ? "chop" : "won") : "lost"));
  const dot = res ? `<span class="dot ${res}"></span>` : "";
  // Table-state squid count (how many are up) — used on the general feed.
  const squid = h.squid?.have != null ? `<span class="hr-squid">${h.squid.have}🦑</span>` : "";
  const subFor = (html) => html ? `<div class="s hh-line">${html}</div>` : "";
  if (oppId) {
    const i = (h.villains || []).findIndex((v) => v.opponentId === oppId);
    if (i >= 0) {
      const v = h.villains[i];
      // On a player's own rows show THAT player's squid count, not the table state.
      const vsquid = v.squid != null ? `<span class="hr-squid">${v.squid}🦑</span>` : "";
      const won = h.hero === false && win && win.winners.includes("v" + i)
        ? `<span class="hh-won">won${win.how === "showdown" ? " @ showdown" : ""}</span>` : "";
      const bits = [
        v.pos ? `<span class="hv-pos">${esc(v.pos)}</span>` : "",
        v.cards && v.cards.some(Boolean) ? tilesHTML(v.cards) : "",
        won,
      ].filter(Boolean).join("");
      return `<div class="lrow" data-hand="${h.id}">
        <div class="t hr-t">${dot}${bits}${vsquid}</div>${subFor(handHistoryLineHTML(h, "v" + i))}
      </div>`;
    }
  }
  const names = (h.villains || []).map((v) => oppById(v.opponentId)?.name).filter(Boolean).join(", ");
  return `<div class="lrow" data-hand="${h.id}">
    <div class="t">${dot}${esc(names || "Hand")}${squid}</div>${subFor(handHistoryLineHTML(h))}
  </div>`;
}

function boardFor(h, street) {
  const b = h.board || [];
  if (street === "flop") return b.slice(0, 3).filter(Boolean).join("");
  if (street === "turn") return b[3] || "";
  if (street === "river") return b[4] || "";
  return "";
}

/* Plain-text hand render — also the future LLM serialization format. */
const kAmt = (n, raw = false) => raw ? String(n) : (n + "K");
/* Stakes line: "2K ante" (button posts double). */
function blindsStr(h, raw) {
  const a = h.blinds?.ante;
  return a ? `${kAmt(a, raw)} ante` : "";
}
/* Compact chip-stack label for raw imported counts: 424224 → "424K". */
const stackStr = (n) =>
  n >= 1e6 ? (Math.round(n / 1e5) / 10) + "M" :
  n >= 1000 ? Math.round(n / 1000) + "K" : String(Math.round(n * 10) / 10);   // computed stacks land on fractions; one decimal is enough
function handText(h) {
  const raw = isRawSize(h);
  const L = [];
  const seat = (pos) => (pos ? ` (${pos})` : "");
  const players = [
    ...(h.hero === false ? [] : [`Hero${seat(h.heroPos)}${h.heroCards ? " " + cardsStr(h.heroCards) : ""}`]),
    ...(h.villains || []).map((v, i) =>
      `${actorLabel(h, "v" + i)}${seat(v.pos)}${v.chips ? " " + stackStr(v.chips) : ""}${v.cards ? " " + cardsStr(v.cards) : ""}`),
  ];
  L.push(players.join("  vs  "));

  const ctx = [];
  const bl = blindsStr(h, raw);
  if (bl) ctx.push(bl);
  if (h.effStack) ctx.push(`${kAmt(h.effStack, raw)} eff`);
  if (h.squid) {
    const s = [];
    if (h.squid.have != null) s.push(`${h.squid.have} have`);
    if (h.squid.left != null) s.push(`${h.squid.left} left`);
    if (s.length) ctx.push(`squid ${s.join(", ")}`);
  }
  if (ctx.length) L.push(ctx.join("   ·   "));

  const streetLines = [];
  for (const st of STREETS) {
    const acts = (h.actions || []).filter((a) => a.street === st);
    const board = boardFor(h, st);
    if (!acts.length && !board) continue;
    streetLines.push(`${st.toUpperCase().padEnd(5)}${board ? "[" + board + "] " : ""} ` +
      (acts.map((a) => actionStr(h, a)).join(",  ") || "—"));
  }
  if (streetLines.length) L.push("", ...streetLines);
  if (h.note) L.push("", h.note);
  return L.join("\n");
}

/* Rich hand-view render — classic hand-history layout: a matchup header,
   then one block per street (board so far, new cards bright), then one
   line per action: position · name · (hole cards on first preflop line)
   · "opens to 40K". */
function handHTML(h, focusOpp) {
  const raw = isRawSize(h);
  const posOf = (actor) => actor === "hero" ? h.heroPos : h.villains?.[Number(actor.slice(1))]?.pos;
  const cardsOf = (actor) => actor === "hero" ? h.heroCards : h.villains?.[Number(actor.slice(1))]?.cards;
  const posB = (actor) => posOf(actor) ? `<span class="hv-pos">${esc(posOf(actor))}</span>` : "";
  const hole = (cs) => cs && cs.some(Boolean) ? `<span class="hv-hole">${tilesHTML(cs)}</span>` : "";

  const seatH = (actor) => {
    const v = actor === "hero" ? null : h.villains?.[Number(actor.slice(1))];
    const stk = v?.chips ? `<span class="hv-stack">${stackStr(v.chips)}</span>` : "";
    const foc = focusOpp && v && v.opponentId === focusOpp ? " hv-focus" : "";
    return `<div class="hv-seat${foc}">${posB(actor)}<b>${esc(actorLabel(h, actor))}</b>${hole(cardsOf(actor))}${stk}</div>`;
  };
  const seats = [];
  if (h.hero !== false) seats.push(seatH("hero"));
  (h.villains || []).forEach((_, i) => seats.push(seatH("v" + i)));
  let html = `<div class="hv-seats">${seats.join("")}</div>`;

  const ctx = [];
  const bl = blindsStr(h, raw);
  if (bl) ctx.push(bl);
  if (h.effStack) ctx.push(`${kAmt(h.effStack, raw)} eff`);
  if (h.squid) {
    const s = [];
    if (h.squid.have != null) s.push(`${h.squid.have}🦑`);
    if (h.squid.left != null) s.push(`${h.squid.left} left`);
    if (s.length) ctx.push(s.join(" · "));
  }
  if (ctx.length) html += `<div class="hv-ctx">${esc(ctx.join("  ·  "))}</div>`;
  const win = handWinner(h);
  if (win) {
    const names = win.winners.map((p) => actorLabel(h, p)).join(" & ");
    const txt = win.winners.length > 1
      ? `Chop — ${names}`
      : `${names} wins` + (win.how === "showdown" ? " at showdown" : " — everyone folded");
    const cls = h.hero !== false
      ? (win.winners.includes("hero") ? (win.winners.length > 1 ? "chop" : "won") : "lost") : "";
    html += `<div class="hv-result ${cls}">${esc(txt)}</div>`;
  } else if (h.result) {                        // legacy manually-tagged hands
    html += `<div class="hv-result ${h.result}">${esc("Hero " + h.result)}</div>`;
  }

  const pe = estimatePot(h, h.actions);
  const b = h.board || [];
  const upTo = { flop: 3, turn: 4, river: 5 };   // board shown cumulatively per street
  const newAt = { pre: 0, flop: 0, turn: 3, river: 4 };
  const shownCards = new Set();                   // hole cards once per actor, on first pre line
  const blocks = [];
  for (const st of STREETS) {
    const acts = (h.actions || []).map((a, i) => ({ a, i })).filter((x) => x.a.street === st);
    const hasNew = st !== "pre" && b.slice(newAt[st], upTo[st]).some(Boolean);
    if (!acts.length && !hasNew) continue;
    const boardH = st === "pre" ? "" :
      b.slice(0, upTo[st]).filter(Boolean).map((c, i) => tileHTML(c, i < newAt[st])).join("");
    const lines = acts.map(({ a, i }) => {
      const cs = st === "pre" && !shownCards.has(a.actor) ? cardsOf(a.actor) : null;
      if (st === "pre") shownCards.add(a.actor);
      const { verb, sz, to } = actParts(a, raw);
      // relative sizes (%, pot, x) also show the resolved chip amount
      const amt = sz && /%|pot|over|x$/i.test(a.size || "") && pe.perAct[i]
        ? ` <span class="hv-amt">${potStr(pe.perAct[i], raw)}</span>` : "";
      return `<div class="hv-line">${posB(a.actor)}<b>${esc(actorLabel(h, a.actor))}</b>${hole(cs)}` +
        `<span class="hv-verb">${esc(verb)}${to ? " to" : ""}</span>` +
        (sz ? `<b class="hv-size">${esc(sz)}</b>` : "") + amt + `</div>`;
    }).join("");
    const potH = st !== "pre" && pe.atStart[st] > 0
      ? `<span class="hv-pot">${potStr(pe.atStart[st], raw)}</span>` : "";
    blocks.push(`<div class="hv-block">
      <div class="hv-sthead"><span class="hv-st">${st === "pre" ? "PREFLOP" : st.toUpperCase()}</span>` +
      (boardH ? `<span class="hv-board">${boardH}</span>` : "") + potH + `</div>${lines}</div>`);
  }
  if (blocks.length) html += `<div class="hv-streets">${blocks.join("")}</div>`;
  if (h.note) html += `<div class="hv-note">${esc(h.note)}</div>`;
  return html;
}

/* ================= Replayer =================
   Every hand view opens on a felt: the ring as it was seated, stepped one action
   at a time. Short deck, so stacks read in antes and the button's double ante is
   the only live money preflop. The pot math is re-run over each prefix rather
   than copied here — estimatePot stays the single source of sizing truth. */
let replayStep = 0, replayTimer = null;
const REPLAY_MS = 1100;

/* Who sat where. Ring grows until every logged position fits, then rotates so
   Hero (or the first villain in a hand Hero sat out) is at the bottom. */
function replaySeats(h, focus) {
  const parts = [];
  if (h.hero !== false && h.heroPos) parts.push({ p: "hero", pos: h.heroPos, name: "You", cards: h.heroCards, chips: h.effStack });
  (h.villains || []).forEach((v, i) => {
    if (v.pos) parts.push({ p: "v" + i, pos: v.pos, opp: v.opponentId, name: oppById(v.opponentId)?.name || `V${i + 1}`, cards: v.cards, chips: v.chips });
  });
  let n = Math.max(4, Math.min(9, Number(h.seats) || parts.length));
  while (n < 9 && parts.some((x) => !ringFor(n).includes(x.pos))) n++;
  // Slot 0 is bottom centre. The player being reviewed sits there so his seat
  // is in the same place in every hand of the reel — hero anchors it otherwise.
  const anchor = (focus && parts.find((x) => x.opp === focus)) || parts[0] || {};
  const ring = ringFor(n), ai = Math.max(0, ring.indexOf(anchor.pos));
  return { ring, n, parts, focus: anchor.p, slot: (pos) => (((ring.indexOf(pos) - ai) % n) + n) % n };
}

/* Seats that only ever folded preflop, in a hand that saw a flop. They never
   played the hand, so the strip and the history read as the hand between the
   players who did. A preflop hand keeps every fold — there the folds are the story. */
function replayQuiet(h) {
  const A = h.actions || [];
  if (!A.some((a) => a.street !== "pre")) return new Set();
  const q = new Set(A.filter((a) => a.street === "pre" && a.act === "fold").map((a) => a.actor));
  for (const a of A) if (a.act !== "fold") q.delete(a.actor);
  return q;
}
/* The felt reads by colour before it reads by words: orange a bet, red a
   raise, pink all in, green a call. */
function replayKind(a, pe, i) {
  if (["fold", "check", "call", "limp"].includes(a.act)) return a.act;
  if (a.act === "jam" || a.size === "Jam" || pe.allIn[i]) {
    const b = pe.pre[i], v = pe.perAct[i];
    return b && b.curBet > 0 && v > 0 && v <= b.curBet ? "call" : "jam";   // all in for no more than the bet: a call
  }
  return a.act === "bet" ? "bet" : "raise";
}
/* Where the pot goes once the hand is over — side pots layered off what each
   seat put in, dead antes to the main pot. A bet nobody matched goes back to
   whoever made it, so `uncalled` is not part of anyone's win. */
function replayPayout(h, pe) {
  const win = handWinner(h);
  if (!win) return null;
  const A = h.actions || [], inv = pe.invested;
  const folded = new Set(A.filter((a) => a.act === "fold").map((a) => a.actor));
  const parts = (h.villains || []).map((_, i) => "v" + i);
  if (h.hero !== false) parts.unshift("hero");
  const live = parts.filter((p) => !folded.has(p));
  const board = (h.board || []).filter(Boolean);
  const cardsOf = (p) => p === "hero" ? h.heroCards : h.villains?.[Number(p.slice(1))]?.cards;
  const score = {};
  if (win.how === "showdown") live.forEach((p) => { score[p] = best7(board.concat(cardsOf(p))); });
  const pay = {}, levels = [...new Set(live.map((p) => inv[p] || 0))].filter((x) => x > 0).sort((a, b) => a - b);
  let prev = 0, paid = 0, main = null;
  for (const L of levels) {
    let layer = 0;
    for (const p in inv) layer += Math.max(0, Math.min(inv[p], L) - prev);
    const elig = live.filter((p) => (inv[p] || 0) >= L);
    let ws = win.winners.filter((p) => elig.includes(p));
    if (win.how === "showdown") {
      let best = null; ws = [];
      for (const p of elig) {
        const d = best ? cmpScore(score[p], best) : 1;
        if (d > 0) { best = score[p]; ws = [p]; } else if (d === 0) ws.push(p);
      }
    }
    if (!ws.length) ws = elig;
    if (!main) main = ws;
    ws.forEach((p) => { pay[p] = (pay[p] || 0) + layer / ws.length; });
    paid += layer; prev = L;
  }
  const rest = pe.now - paid;
  if (rest > 0 && main) main.forEach((p) => { pay[p] = (pay[p] || 0) + rest / main.length; });
  const top = Object.entries(inv).sort((a, b) => b[1] - a[1]);
  const uncalled = top.length > 1 && top[0][1] > top[1][1] && !folded.has(top[0][0]) ? { p: top[0][0], n: top[0][1] - top[1][1] } : null;
  const won = {};
  for (const p in pay) won[p] = pay[p] - (uncalled && uncalled.p === p ? uncalled.n : 0);
  return { win, pay, won, uncalled, score };
}
const SD_HAND_NAMES = ["High card", "Pair", "Two pair", "Trips", "Straight", "Full house", "Flush", "Quads", "Straight flush"];
function best5(cs) {
  let best = null;
  const n = cs.length;
  for (let a = 0; a < n - 4; a++) for (let b = a + 1; b < n - 3; b++) for (let c = b + 1; c < n - 2; c++)
    for (let d = c + 1; d < n - 1; d++) for (let e = d + 1; e < n; e++) {
      const five = [cs[a], cs[b], cs[c], cs[d], cs[e]], sc = score5(five);
      if (!best || cmpScore(sc, best.score) > 0) best = { score: sc, cards: five };
    }
  if (best) best.cards.sort((x, y) => RVAL[y[0]] - RVAL[x[0]]);
  return best;
}

function replayHTML(h, k) {
  const acts = h.actions || [];
  k = Math.max(0, Math.min(acts.length, k));
  const raw = isRawSize(h), ante = Number(h.blinds?.ante) || 0;
  const pe = estimatePot(h, acts.slice(0, k));
  const cur = k ? acts[k - 1] : null, street = cur ? cur.street : "pre";
  const done = k === acts.length;
  const folded = new Set(acts.slice(0, k).filter((a) => a.act === "fold").map((a) => a.actor));
  const upTo = { pre: 0, flop: 3, turn: 4, river: 5 };
  const S = replaySeats(h, hvOppId(h)), slots = slotsFor(S.n);
  if (!S.parts.length) return "";                  // nobody was given a seat — nothing to replay
  const inFront = Object.values(pe.contrib).reduce((a, x) => a + x, 0);
  const pay = done ? replayPayout(h, pe) : null;
  const peAll = done ? pe : estimatePot(h, acts);
  // Each seat's last word this street stays up until the street is swept (the
  // laptop felt has room for it; the phone shows only the live one).
  const said = {};
  for (let j = k - 1; j >= 0 && acts[j].street === street; j--) if (!(acts[j].actor in said)) said[acts[j].actor] = j;

  // Board: what this street has dealt, all of it once the hand is over.
  const board = (h.board || []).slice(0, done ? 5 : upTo[street]).filter(Boolean);
  const pot = Math.max(0, pe.now - inFront);
  const centre = `<div class="rcentre">
      ${board.length ? `<div class="rboard">${tilesHTML(board)}</div>` : ""}
      <div class="rpot">Pot ${pot ? potStr(pot, raw) : "—"}</div></div>`;

  let felt = `<div class="feltoval"></div>${centre}`;
  for (const x of S.parts) {
    const sl = slots[S.slot(x.pos)];
    // Pull the ring in a little: the seat pills are taller than the dots the
    // geometry was drawn for, and the top/bottom ones would hang off the felt.
    const sx = 50 + (sl[0] - 50) * 0.88, sy = 50 + (sl[1] - 50) * 0.87;
    const up = cur && cur.actor === x.p;
    const out = folded.has(x.p);
    const shown = (x.cards || []).some(Boolean);
    // Hole cards face up when they were seen, backs otherwise — the seat still
    // has to read as a player holding two cards.
    const cards = `<div class="rcards${shown ? "" : " back"}">${shown ? tilesHTML(x.cards) : "<i></i><i></i>"}</div>`;
    // What he has behind right now, not what he sat down with.
    const left = Math.max(0, x.chips - (pe.invested[x.p] || 0) + (pay?.pay[x.p] || 0));
    const stk = x.chips
      ? `<span class="tstack${left ? "" : " allin"}">${left ? stackStr(left) + (ante > 1 ? ` · ${Math.round(left / ante)}a` : "") : "all in"}</span>`
      : "";
    const dB = x.pos === "BN" ? `<span class="tdealer">D</span>` : "";
    const sj = said[x.p];
    const say = sj != null && !(done && !up) ? `<div class="rsay k-${replayKind(acts[sj], peAll, sj)}${up ? "" : " keep"}">${esc(replaySay(h, sj))}</div>` : "";
    felt += `<div class="rseat${x.p === "hero" ? " hero" : ""}${x.p === S.focus && x.p !== "hero" ? " focus" : ""}${out ? " out" : ""}${up ? " up" : ""}" style="left:${sx}%;top:${sy}%">
      ${cards}<div class="rpill"><span class="tpos">${esc(x.pos)}</span><span class="tnm">${esc(x.name)}</span>${stk}${dB}</div>${say}</div>`;
    const bet = pe.contrib[x.p] || 0;
    if (bet && !out) {   // chips pushed a third of the way toward the middle, like a real table
      const bx = sx + (50 - sx) * 0.45, by = sy + (50 - sy) * 0.45;
      felt += `<div class="rbet" style="left:${bx.toFixed(1)}%;top:${by.toFixed(1)}%">${potStr(bet, raw)}</div>`;
    }
  }
  if (done) {
    const win = pay?.win;
    const amt = pay ? Object.values(pay.won).reduce((a, x) => a + x, 0) : 0;
    const txt = win
      ? (win.winners.length > 1 ? "Chop — " : "") + win.winners.map((w) => actorLabel(h, w)).join(" & ") +
        (win.winners.length > 1 ? "" : " wins") + (amt ? " " + potStr(amt, raw) : "") +
        (win.winners.length === 1 && win.how === "showdown" ? " at showdown" : "")
      : "";
    if (txt) felt += `<div class="rend">${esc(txt)}</div>`;
  }
  // What the record can't tell, said under the felt rather than guessed at.
  const warns = [];
  const last = acts[acts.length - 1];
  if (last && isAgg(last.act)) {
    const out = new Set(acts.filter((a) => a.act === "fold").map((a) => a.actor));
    if (new Set(acts.map((a) => a.actor).filter((p) => p !== last.actor && !out.has(p))).size)
      warns.push(["ends on an unanswered bet", "The last bet has no answer on record — the fold or call was never logged"]);
  }
  if (!S.parts.some((x) => x.chips)) warns.push(["no stacks", "No starting stacks on record for this hand, so none can be shown"]);
  const unseated = (h.villains || []).filter((v) => !v.pos).length;
  if (unseated) warns.push([`${unseated} not seated`, "No position on record, so there is no honest seat for them"]);
  const foot = warns.length ? `<div class="rfoot">${warns.map(([t, why]) => `<span class="rwarn" title="${esc(why)}">${esc(t)}</span>`).join("")}</div>` : "";

  // Controls: jump to a street, step an action at a time, or let it run.
  const first = {};
  acts.forEach((a, i) => { if (first[a.street] == null) first[a.street] = i + 1; });
  const jump = STREETS.map((st) => first[st] == null ? "" :
    `<button class="rchip${street === st && (k || st === "pre") ? " on" : ""}" data-rst="${st}">${st === "pre" ? "Pre" : st[0].toUpperCase() + st.slice(1)}</button>`).join("");
  // Every action as a chip, in order, sized the way the entry pad sizes them.
  // Tap one to put the felt on that decision.
  const posOf = {};
  S.parts.forEach((x) => { posOf[x.p] = x.pos; });
  let seen = null;
  const quiet = replayQuiet(h);
  const strip = acts.map((a, i) => {
    if (a.street === "pre" && quiet.has(a.actor)) return "";
    const sep = a.street === seen ? "" : `<span class="rssep">${(a.street === "pre" ? "pre" : a.street).toUpperCase()}</span>`;
    seen = a.street;
    const agg = ["bet", "raise", "3bet", "4bet", "5bet", "jam"].includes(a.act);
    return `${sep}<button class="ract${i === k - 1 ? " on" : ""}${agg ? " agg" : ""}${a.act === "fold" ? " out" : ""}" data-rjump="${i + 1}">
        <span class="ra-p">${esc(posOf[a.actor] || "")}</span><span class="ra-t">${esc(sizeTag(h, i))}</span></button>`;
  }).join("");
  // ⏭ leaves this hand for the next one in the reel — stepping to the end is what ▶ is for.
  const reel = handPlayList(), ri = reel.indexOf(h.id);
  const ctl = `<div class="rctl">
      <div class="chiprow tight">${jump}</div>
      <div class="rtrans">
        <button data-hvstep="-1" aria-label="Previous hand"${ri <= 0 ? " disabled" : ""}>⏮</button>
        <button data-rgo="0" aria-label="Restart">↺</button>
        <button data-rstep="-1" aria-label="Back"${k === 0 ? " disabled" : ""}>◀</button>
        <button data-rplay class="rplay" aria-label="Play">${replayTimer ? "❚❚" : "▶"}</button>
        <button data-rstep="1" aria-label="Forward"${done ? " disabled" : ""}>▶</button>
        <button data-hvstep="1" aria-label="Next hand"${ri < 0 || ri === reel.length - 1 ? " disabled" : ""}>⏭</button>
        <span class="rcount">${k}/${acts.length}</span>
      </div>
      ${strip ? `<div class="rstrip">${strip}</div>` : ""}</div>`;
  return `<div class="rfelt">${felt}</div>${foot}${ctl}`;
}

/* The whole hand as a hand-history panel: one column per street headed by the
   pot that came into it, a card per action with the seat's position badge, the
   antes up front and the showdown at the end. Tapping a card steps the felt. */
function replayHistoryHTML(h, k) {
  const acts = h.actions || [];
  if (!acts.length) return `<div class="rplog-empty">No actions on record.</div>`;
  const raw = isRawSize(h), ante = Number(h.blinds?.ante) || 0;
  const pe = estimatePot(h, acts), S = replaySeats(h, hvOppId(h)), quiet = replayQuiet(h);
  const seat = {};
  S.parts.forEach((x) => { seat[x.p] = x; });
  const posOf = (p) => seat[p]?.pos || "";
  const who = (p) => `<span class="rphh-who"><span class="rphh-pos${posOf(p) === "BN" ? " p-d" : ""}">${esc(posOf(p) || "?")}</span>` +
    `<span class="rphh-nm">${esc(seat[p]?.name || actorLabel(h, p))}</span></span>`;
  const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
  const seats = Number(h.seats) || S.parts.length;
  const antes = ante ? `<button class="rphh-blinds${k === 0 ? " on" : ""}" data-rjump="0"><span>Ante ${esc(kAmt(ante, raw))} ×${seats}</span>` +
    (S.parts.some((x) => x.pos === "BN") ? `<span><i class="rphh-pos p-d">BN</i>+${esc(kAmt(ante, raw))} live</span>` : "") + `</button>` : "";
  const cols = [];
  for (const st of STREETS) {
    const idx = acts.map((a, i) => a.street === st ? i : -1).filter((i) => i >= 0);
    if (!idx.length) continue;
    const cards = idx.filter((i) => !(st === "pre" && quiet.has(acts[i].actor))).map((i) => {
      const a = acts[i], kind = replayKind(a, pe, i), say = replaySay(h, i);
      const amt = pe.perAct[i];
      const txt = esc(cap(say)) + (amt && (a.street !== "pre" || !/\d/.test(say)) ? ` <span class="rphh-amt">${esc(potStr(amt, raw))}</span>` : "") +
        (pe.allIn[i] ? `<i class="rphh-allin">All-in</i>` : "");
      return `<button class="rphh-card k-${kind}${i === k - 1 ? " on" : ""}" data-rjump="${i + 1}">${who(a.actor)}<span class="rphh-act">${txt}</span></button>`;
    }).join("");
    cols.push(`<div class="rphh-col"><button class="rphh-hd" data-rjump="${idx[0] + 1}"><span>${st === "pre" ? "Preflop" : cap(st)}</span>` +
      `<b>${esc(potStr(pe.atStart[st], raw))}</b></button>${cards}</div>`);
  }
  const pay = replayPayout(h, pe), n = acts.length;
  const out = new Set(acts.filter((a) => a.act === "fold").map((a) => a.actor));
  const live = S.parts.filter((x) => acts.some((a) => a.actor === x.p) && !out.has(x.p));
  if (pay || live.some((x) => (x.cards || []).some(Boolean))) {
    let cards = "";
    for (const x of live) {
      const won = !!pay && pay.win.winners.includes(x.p), cs = (x.cards || []).filter(Boolean);
      cards += `<button class="rphh-card k-sd${won ? " won" : ""}${k === n ? " on" : ""}" data-rjump="${n}">${who(x.p)}` +
        `<span class="rphh-act rphh-sd">${cs.length ? tilesHTML(cs) : "<em>not shown</em>"}${won && pay.won[x.p] ? `<b>+${esc(potStr(pay.won[x.p], raw))}</b>` : ""}</span></button>`;
    }
    if (pay) {
      const w = pay.win, names = w.winners.map((p) => seat[p]?.name || actorLabel(h, p)).join(" & ");
      const amt = Object.values(pay.won).reduce((a, x) => a + x, 0);
      const board = (h.board || []).filter(Boolean), c0 = seat[w.winners[0]]?.cards || [];
      const five = w.how === "showdown" ? best5(board.concat(c0.filter(Boolean))) : null;
      cards += `<div class="rphh-win"><div>${esc(names)} ${w.winners.length > 1 ? "chop" : "wins"}${amt ? " " + esc(potStr(amt, raw)) : ""}` +
        `${w.how === "folds" ? " <small>all fold</small>" : ""}</div>` +
        (pay.uncalled ? `<div class="rphh-ret">${esc(seat[pay.uncalled.p]?.name || actorLabel(h, pay.uncalled.p))} gets ${esc(potStr(pay.uncalled.n, raw))} back, uncalled</div>` : "") +
        (five ? `<div class="rphh-five">${tilesHTML(five.cards)}<small>${SD_HAND_NAMES[five.score[0]]}</small></div>` : "") + `</div>`;
    }
    cols.push(`<div class="rphh-col"><button class="rphh-hd" data-rjump="${n}"><span>${pay ? (pay.win.how === "folds" ? "Result" : "Showdown") : "End"}</span>` +
      `<b>${esc(potStr(pe.now - (pay?.uncalled?.n || 0), raw))}</b></button>${cards}</div>`);
  }
  return `<div class="rphh-title">Hand history${ante ? " · " + esc(kAmt(ante, raw)) + " ante" : ""} · ${seats}-handed</div>${antes}` +
    `<div class="rphh-cols" style="--n:${cols.length}">${cols.join("")}</div>`;
}

function renderReplay() {
  const h = HANDS.find((x) => x.id === curHandId);
  if (!h) return;
  $("hv-felt").innerHTML = replayHTML(h, replayStep);
  $("hv-log").innerHTML = replayHistoryHTML(h, replayStep);
  // Scroll the strip itself rather than scrollIntoView, which would drag the page.
  const strip = $("hv-felt").querySelector(".rstrip"), on = strip && strip.querySelector(".ract.on");
  if (on) strip.scrollLeft = on.offsetLeft - strip.clientWidth / 2 + on.offsetWidth / 2;
}
function replayGo(k) {
  const h = HANDS.find((x) => x.id === curHandId);
  if (!h) return;
  const n = (h.actions || []).length;
  replayStep = Math.max(0, Math.min(n, k));
  if (replayStep >= n) replayStop();
  renderReplay();
}
function replayStop() {
  if (replayTimer) { clearInterval(replayTimer); replayTimer = null; }
}
function replayToggle() {
  if (replayTimer) { replayStop(); renderReplay(); return; }
  const h = HANDS.find((x) => x.id === curHandId);
  const n = (h?.actions || []).length;
  if (!n) return;
  if (replayStep >= n) replayStep = 0;                 // replaying a finished hand starts it over
  replayTimer = setInterval(() => replayGo(replayStep + 1), REPLAY_MS);
  replayGo(replayStep + 1);
}

/* ================= Table (tonight's lineup) + hand detail ================= */

/* One glance mid-session: the seat ring from the lineup sheet, each opponent
   rendered with their front-page card chips. Same data as hand entry's Lineup.
   (renderTable is taken — that's the hand-entry felt renderer.) */
function renderTableTab() {
  const stats = oppStats();
  // Row cards always render in normal (non-edit) mode here.
  const em = oppEditMode; oppEditMode = false;
  const rows = tableLineup.map((id, i) => {
    const seat = `<span class="seatno">${i + 1}</span>`;
    if (id === "hero") return `<div class="tblrow tblhero">${seat}<div class="lrow"><div class="t">You (Hero)</div></div></div>`;
    const o = oppById(id);
    if (!o) return "";
    return `<div class="tblrow">${seat}${oppRowHTML(o, stats[o.id])}</div>`;
  }).join("");
  oppEditMode = em;
  $("tbl-sub").textContent = tableLineup.length
    ? `${lineupSeats}-handed · ${tableLineup.length} seated, clockwise order` : "";
  $("tbl-list").innerHTML = rows ||
    `<div class="empty">No lineup yet — tap Edit to seat tonight's players.</div>`;
}

function renderHandView(id) {
  const h = HANDS.find((x) => x.id === id);
  if (!h) { location.hash = "#opponents"; return; }
  curHandId = id;
  replayStop(); replayStep = 0;                               // every hand opens at the deal
  let list = handPlayList(), i = list.indexOf(id);
  // Opened outside a reel — a note link, a reload — so build one from this
  // player's own hands; the steppers are useless without it.
  if (i < 0) {
    const oid = hvOppId(h);
    const own = oid ? HANDS.filter((x) => (x.villainIds || []).includes(oid)).sort((a, b) => b.ts - a.ts).map((x) => x.id) : [];
    if (own.length > 1) { handPlay = { oppId: oid, ids: own }; list = handPlayList(); i = list.indexOf(id); }
  }
  $("hv-text").innerHTML = handHTML(h, i >= 0 ? handPlay.oppId : null);
  renderReplay();
  renderHandPager(id);
  splitSync();
  const nav = $("hv-nav");
  nav.classList.toggle("hidden", i < 0);
  $("view-handview").classList.toggle("playing", i >= 0);   // keeps Delete clear of the floating stepper
  if (i < 0) return;
  nav.querySelector("[data-hvstep='-1']").disabled = i === 0;
  nav.querySelector("[data-hvstep='1']").disabled = i === list.length - 1;
  $("hv-count").textContent = `${handPlay.label || oppById(handPlay.oppId)?.name || "Hand"} · ${i + 1}/${list.length}`;
}
/* The reel is always in view: a rail down the left of the felt listing every
   hand in it, scrolled to the one open. Green when the player being read won
   it, red when he lost — a fold is a loss whether or not the rest can be scored. */
function hvResult(h, focus) {
  const vi = focus ? (h.villains || []).findIndex((v) => v.opponentId === focus) : -1;
  const seat = vi >= 0 ? "v" + vi : (h.hero === false ? null : "hero");
  if (!seat) return { who: null, res: null };
  const who = vi >= 0 ? h.villains[vi] : { pos: h.heroPos, cards: h.heroCards };
  if ((h.actions || []).some((a) => a.actor === seat && a.act === "fold")) return { who, res: "lost" };
  const win = handWinner(h);
  return { who, res: win ? (win.winners.includes(seat) ? (win.winners.length > 1 ? "chop" : "won") : "lost") : null };
}
function renderHandPager(id) {
  const box = $("hv-pager"), list = handPlayList(), i = list.indexOf(id);
  box.classList.toggle("hidden", i < 0);
  box.parentElement.classList.toggle("rail", i >= 0);
  if (i < 0) { box.innerHTML = ""; return; }
  const focus = handPlay ? handPlay.oppId : null;
  box.innerHTML = `<div class="hvpos">${i + 1}/${list.length}</div><div class="hvlist">${list.map((x, k) => {
    const h = HANDS.find((y) => y.id === x);
    if (!h) return "";
    const { who, res } = hvResult(h, focus);
    const cards = (who?.cards || []).filter(Boolean);
    return `<button class="hvrow${x === id ? " on" : ""}${res ? " " + res : ""}" data-hvgo="${esc(x)}">` +
      `<span class="hvn">${k + 1}</span>` +
      `<span class="hvc">${cards.length ? tilesHTML(cards) : `<span class="hvnc">··</span>`}</span>` +
      `<span class="hvp">${esc(who?.pos || "")}</span></button>`;
  }).join("")}</div>`;
  const lst = box.querySelector(".hvlist"), cur = lst.querySelector(".hvrow.on");
  if (cur) lst.scrollTop = Math.max(0, cur.offsetTop - lst.clientHeight / 2 + cur.offsetHeight / 2);
}
/* ---- Reads split: mark a read without leaving the hand ----
   The pane borrows the opponent page's own #od-tags grid instead of cloning it,
   so one set of handlers serves both screens; it is moved home on the way out. */
let splitWant = false, splitSlot = null;
const hvVillains = (h) => (h?.villains || []).filter((v) => v.opponentId && oppById(v.opponentId));
function hvOppId(h) {
  const vs = hvVillains(h);
  if (vs.some((v) => v.opponentId === curOppId)) return curOppId;
  if (handPlay && vs.some((v) => v.opponentId === handPlay.oppId)) return handPlay.oppId;
  return vs[0]?.opponentId || null;
}
function splitHome() {
  const t = $("od-tags");
  if (splitSlot && t.parentNode !== splitSlot.parent) splitSlot.parent.insertBefore(t, splitSlot.next);
}
/* Leaving the hand view puts the grid back but remembers he wanted it open. */
function splitDetach() {
  splitHome();
  $("hv-split").classList.add("hidden");
  $("view-handview").classList.remove("reading");
}
function splitSync(oppId) {
  const h = HANDS.find((x) => x.id === curHandId), vs = hvVillains(h);
  if (!splitSlot) { const t = $("od-tags"); splitSlot = { parent: t.parentNode, next: t.nextSibling }; }
  // Wide, the reads are live on the page beside the hand — no pane needed.
  const can = !!vs.length && !hvWide();
  $("hv-reads").classList.toggle("hidden", !can);
  $("hv-reads").classList.toggle("on", splitWant && can);
  const on = splitWant && can;
  if (!on) { splitDetach(); return; }
  const id = oppId || hvOppId(h);
  if (id && id !== curOppId) renderOppDetail(id);
  $("hv-split-body").appendChild($("od-tags"));
  $("hv-split").classList.remove("hidden");
  $("view-handview").classList.add("reading");
  $("hv-split-who").textContent = oppById(curOppId)?.name || "Reads";
  // Two villains in the hand, two sets of reads — say whose you are marking.
  $("hv-split-vill").innerHTML = vs.length > 1
    ? vs.map((v) => `<button class="chip mini${v.opponentId === curOppId ? " on" : ""}" data-splitopp="${esc(v.opponentId)}">${esc(oppById(v.opponentId).name)}</button>`).join("")
    : "";
}
/* Backing out of a hand goes to the player, not to the hand read before it —
   stepping through a reel would otherwise unwind one hand at a time. */
/* Back steps out of a screen rather than rewinding history: assigning the hash
   would stack player-hand-player and trap ‹ between the two, and location.replace
   only lands on the next tick. replaceState + route() is immediate. */
function navUp(hash) { history.replaceState(null, "", hash); route(); }
function hvBack() {
  if (hvWide() && hvUnderHash) return navUp(hvUnderHash);
  const h = HANDS.find((x) => x.id === curHandId);
  const id = (handPlay && handPlay.oppId) || hvOppId(h) || curOppId;
  // Going back to the list he came from, so the filters he left are still his —
  // matching curOppId first keeps go() from clearing them. replace, not assign:
  // pushing would stack player-hand-player and trap ‹ between the two.
  if (id && oppById(id)) { curOppId = id; navUp("#opp/" + id); }
  else navUp("#opponents");
}
/* Drag the grab bar to trade hand for reads; the size is his, so it is kept. */
function bindSplitGrab() {
  const g = $("hv-split-grab");
  let y0 = 0, h0 = 0, px = null;
  g.addEventListener("pointerdown", (e) => {
    y0 = e.clientY; h0 = $("hv-split").getBoundingClientRect().height; px = e.pointerId;
    g.setPointerCapture(px); e.preventDefault();
  });
  g.addEventListener("pointermove", (e) => {
    if (px === null) return;
    const h = Math.round(Math.max(150, Math.min(window.innerHeight * 0.75, h0 + (y0 - e.clientY))));
    document.documentElement.style.setProperty("--hvsplit-h", h + "px");
  });
  const end = () => {
    if (px === null) return;
    px = null;
    metaSet("hvSplitH", document.documentElement.style.getPropertyValue("--hvsplit-h"));
  };
  g.addEventListener("pointerup", end);
  g.addEventListener("pointercancel", end);
}
/* Deleted hands drop out of the reel rather than dead-ending it. */
const handPlayList = () => handPlay ? handPlay.ids.filter((x) => HANDS.some((h) => h.id === x)) : [];
function handStep(d) {
  const list = handPlayList(), i = list.indexOf(curHandId), j = i + d;
  if (i < 0 || j < 0 || j >= list.length) return;
  location.hash = "#handview/" + list[j];
}

/* ================= Data / backup ================= */

function renderData() {
  metaGet("lastExportAt").then((ts) => {
    const days = ts ? Math.floor((Date.now() - ts) / 86400000) : null;
    $("data-backupnag").textContent = ts
      ? (days === 0 ? "Backed up today." : `Last backup ${days} day${days > 1 ? "s" : ""} ago.`)
      : "Never backed up — data lives only on this phone.";
  });
  const store = $("data-storage");
  if (storageDurable) {
    store.textContent = "✓ Storage is protected — your data won't be auto-cleared.";
    store.className = "muted sub2 ok";
  } else {
    store.textContent = "⚠ Storage not protected. Install to Home Screen (Share → Add to Home Screen) and reopen so iOS keeps your data.";
    store.className = "sub2 warn";
  }
  $("data-stats").textContent = `${OPP.length} opponents · ${HANDS.length} hands`;
  renderImportLog();
  metaGet("autoSnapshot").then((snap) => {
    if (!snap) { $("data-autobackup").textContent = "Auto-backup: not yet made — save a hand or open an opponent to create one."; return; }
    const secs = Math.floor((Date.now() - snap.ts) / 1000);
    const ago = secs < 60 ? `${secs}s` : secs < 3600 ? `${Math.floor(secs / 60)}m` : `${Math.floor(secs / 3600)}h`;
    const c = snap.counts || {};
    $("data-autobackup").textContent =
      `Auto-backup: updated ${ago} ago · ${c.opponents || 0} opps · ${c.hands || 0} hands. Refreshes on every change (stays inside the app; tap Save to write a file).`;
  });
}

async function renderImportLog() {
  const log = await importLog();
  const el = $("data-imports");
  if (!log.length) { el.innerHTML = `<div class="muted sub2">None yet. Each JSON import is listed here and can be undone.</div>`; return; }
  const when = (ts) => new Date(ts).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  el.innerHTML = log.map((b) => {
    const c = b.counts || {};
    const bits = [`${c.hands || 0} hand${c.hands === 1 ? "" : "s"}`, `${c.opponents || 0} new opp`];
    if (c.merged) bits.push(`${c.merged} merged`);
    return `<div class="importrow"><div class="grow"><div class="imlabel">${esc(b.label || "Import")}</div>
      <div class="muted sub2">${when(b.ts)} · ${bits.join(" · ")}</div></div>
      <button class="secondary" data-undoimport="${b.id}">Undo</button></div>`;
  }).join("");
}

/* ================= Hand entry ================= */

/* A fresh empty draft — villains, positions, cards, actions all cleared. Save
   always fully unselects; only long-lived table context (blinds, squid, mode,
   eff-stack default) carries over. */
function newDraft() {
  return {
    id: null, ts: null,
    villains: [],
    heroPos: null, heroCards: [null, null],
    heroIn: false,   // Hero opts in explicitly via the "You" chip
    board: [null, null, null, null, null],
    actions: [], street: "pre", actor: null, lastV: "v0",
    note: "", effStack: predictEffStack(),
    ante: blindsDefault.ante,
    squidHave: "", squidLeft: "",
    mode: "chips", focusPos: null,
    assignBtn: false, btnRot: 0,
  };
}
// No user input yet — safe to reseed seats from a lineup change.
const draftIsFresh = () =>
  !draft.actions.length && !draft.board.some(Boolean) && !draft.heroCards.some(Boolean);

/* Effective BTN position: whoever currently sits at the "BN" label. Rotations
   move the position labels around the players, so BN always points at
   whoever holds the button now. */
function effectiveBtnPos() {
  const ring = seatRing();
  return ring.includes("BN") ? "BN" : ring[ring.length - 1];
}
/* Rotate the labels to `newRot`, keeping every player in their physical slot:
   the player who was SB now has the button, the old BB is now SB, and so on.
   Every stored pos is remapped so the felt still finds each player at their
   old slot under the new label. */
function setBtnRot(newRot) {
  const base = baseSeatRing();
  if (!base.length) return;
  const n = base.length;
  newRot = ((newRot % n) + n) % n;
  const oldRing = rotateRing(base, draft.btnRot || 0);
  const newRing = rotateRing(base, newRot);
  const remap = (p) => { const i = oldRing.indexOf(p); return i < 0 ? p : newRing[i]; };
  if (draft.heroPos) draft.heroPos = remap(draft.heroPos);
  for (const v of draft.villains) if (v.pos) v.pos = remap(v.pos);
  draft.btnRot = newRot;
  draft.assignBtn = false;
}
function moveBtn(dir) { setBtnRot((draft.btnRot || 0) + (dir === "cw" ? 1 : -1)); }
/* Assign flow: put the button on the tapped seat by rotating the labels so
   "BN" lands there and the blinds follow — a D badge on a seat still labelled
   CO would leave the turn order (which reads labels) wrong. */
function assignBtnTo(pos) {
  const slot = seatRing().indexOf(pos);
  if (slot < 0) return;
  setBtnRot(slot - baseSeatRing().indexOf("BN"));   // rotateRing(base, rot)[slot] === "BN"
}

/* ---- seat model (table mode) — positions ARE the seats ---- */
function seatOccupant(pos) {
  if (draft.heroPos === pos) return { type: "hero" };
  const idx = draft.villains.findIndex((v) => v.pos === pos);
  if (idx >= 0) return { type: "villain", idx };
  return { type: "empty" };
}
function actorForPos(pos) {
  const o = seatOccupant(pos);
  return o.type === "hero" ? "hero" : o.type === "villain" ? "v" + o.idx : null;
}
/* Evenly-spaced slot positions around the felt oval for n seats.
   Slot 0 = bottom-centre; walks clockwise so the ring [U9…U4, HJ, CO, BN]
   places BN to the first UTG seat's right (viewer POV) — deal order. */
function slotsFor(n) {
  const cx = 50, cy = 50, rx = 39, ry = 44;
  const slots = [];
  for (let i = 0; i < n; i++) {
    const a = Math.PI / 2 - (i * 2 * Math.PI) / n;
    slots.push([+(cx - rx * Math.cos(a)).toFixed(1), +(cy + ry * Math.sin(a)).toFixed(1)]);
  }
  return slots;
}
/* Felt seat order: one slot per position in the ring (in ring order, no hero
   rotation). Number of seats always matches the current lineup ring size. */
function seatOrder() {
  const ring = seatRing();
  const slots = slotsFor(ring.length);
  return slots.map((slot, i) => ({ slot, pos: ring[i] }));
}

function renderTable() {
  const d = draft;
  // center board mirror
  const board = d.board.map((c) => c ? cardHTML(c) : "").filter(Boolean).join(" ");
  let felt = `<div class="feltoval"></div>
    <div class="feltcenter">${board ? `<div class="feltboard">${board}</div>` : ""}</div>`;

  const btn = effectiveBtnPos();
  const stackStr = d.effStack ? "$" + kAmt(d.effStack) : "";
  const up = sheetGroup === "__act__" ? currentActor() : null;   // seat that's on to act
  const upPos = up ? draftActorPos(up) : null;
  felt += seatOrder().map(({ slot, pos }) => {
    const occ = seatOccupant(pos);
    const focused = d.focusPos === pos || pos === upPos;
    const dBadge = pos === btn ? `<span class="tdealer" title="Button">D</span>` : "";
    let inner, cls = "tseat";
    if (occ.type === "hero") {
      cls += " hero";
      const cards = d.heroCards.some(Boolean)
        ? `<div class="theroc">${d.heroCards.map((c) => c ? cardHTML(c) : "").join("")}</div>` : "";
      inner = `${cards}<div class="tpill"><span class="tpos">${pos}</span><span class="tnm">You</span>${stackStr ? `<span class="tstack">${stackStr}</span>` : ""}</div>${dBadge}`;
    } else if (occ.type === "villain") {
      cls += " vill";
      const v = d.villains[occ.idx];
      const o = oppById(v.opponentId);
      const pt = pillTag(o);
      const tag = pt ? `<span class="ttag t-${esc(pt.tone)}">${esc(pt.text)}</span>` : "";
      inner = `<div class="tpill"><span class="tpos">${pos}</span><span class="tnm">${esc(o?.name || "?")}</span>${stackStr ? `<span class="tstack">${stackStr}</span>` : ""}</div>${dBadge}${tag}`;
    } else {
      cls += " empty";
      inner = `<div class="tpill add"><span class="tpos">${pos}</span><span class="tnm">＋</span></div>${dBadge}`;
    }
    if (focused) cls += " focus";
    if (d.assignBtn) cls += " btnpick";
    return `<button class="${cls}" data-seat="${pos}" style="left:${slot[0]}%;top:${slot[1]}%">${inner}</button>`;
  }).join("");
  $("he-felt").innerHTML = felt;

  // bottom panel: table-setup bar (BTN + adjust) + assignment/edit for focused seat
  const setup = $("he-tablesetup");
  if (setup) {
    setup.innerHTML =
      `<div class="tsetup-row">
         <button class="tspill tsblinds" data-blindsedit>
           <span class="tspilllbl">Ante</span><span class="tspillval">${esc(d.ante || "–")}${d.ante ? ` · BTN ${esc(String(Number(d.ante) * 2))}` : ""}</span>
         </button>
       </div>
       <div class="tsetup-row">
         <span class="tsetup-lbl">BTN</span>
         <button class="tsbtn" data-btnmove="ccw" title="Counter-clockwise">↺</button>
         <button class="tsbtn" data-btnmove="cw" title="Clockwise">↻</button>
         <button class="tsbtn${d.assignBtn ? " on" : ""}" data-btnassign>${d.assignBtn ? "Tap seat…" : "Assign"}</button>
         <button class="tsbtn" data-adjustall>Adjust Stacks</button>
       </div>`;
  }

  // bottom seat panel is now sheet-driven; keep it empty so it doesn't take space.
  const el = $("he-seatassign");
  if (el) el.innerHTML = "";
  // Only refresh the seat sheet when it's the active sheet — otherwise a card
  // pick (sheetGroup === "v0"/"hero"/etc) re-renders through renderTable and
  // clobbers the card grid, closing the picker after one card (bug #9).
  if (d.focusPos && (sheetGroup == null || sheetGroup === "__seat__")) renderSeatSheet(d.focusPos);
  else if (!d.focusPos && sheetGroup === "__seat__") hideSheet();
}

/* Sheet-based seat editor / assignment (replaces the old bottom panel). */
function renderSeatSheet(pos) {
  const d = draft;
  const occ = seatOccupant(pos);
  const seatV = occ.type === "villain" ? d.villains[occ.idx] : null;
  const seatCards = occ.type === "hero" ? d.heroCards
                   : occ.type === "villain" ? (seatV.cards || [null, null])
                   : null;
  sheetGroup = "__seat__";
  if (occ.type === "empty") {
    const stats = oppStats();
    const opps = OPP.filter((o) => !o.archived).sort((a, b) =>
      (stats[b.id]?.last || b.updatedAt || 0) - (stats[a.id]?.last || a.updatedAt || 0));
    const seatedIds = d.villains.filter((v) => v.pos && v.pos !== pos).map((v) => v.opponentId);
    showSheet(
      `<div class="sheethead"><span class="t">Seat ${esc(pos)}</span>
         <button data-sheetclose>Close</button></div>
       <div class="sheetnote">Place a player at this seat.</div>
       <div class="chiprow" style="max-height:56vh;overflow:auto">
         <button class="chip" data-assign-hero>You</button>` +
      opps.map((o) => `<button class="chip${seatedIds.includes(o.id) ? " seated" : ""}" data-assign-opp="${o.id}">${esc(o.name)}</button>`).join("") +
      `</div>`);
    return;
  }
  const nm = occ.type === "hero" ? "You" : (oppById(seatV.opponentId)?.name || "?");
  const cardGroup = occ.type === "hero" ? "hero" : "v" + occ.idx;
  const cardSlots = seatCards.map((c, i) =>
    `<button class="cslot mini${c ? " filled" : ""}" data-seatcard="${i}" data-cardgroup="${cardGroup}">` +
    (c ? cardHTML(c) : `<span class="lbl">?</span>`) + `</button>`).join("");
  showSheet(
    `<div class="sheethead"><span class="t">Seat ${esc(pos)} — ${esc(nm)}</span>
       <button data-sheetclose>Close</button></div>
     <div class="seatedit">
       <div class="seatedit-hd">
         ${occ.type === "villain" ? `<button class="chip mini" data-seatchange>Change player</button>` : ""}
         <button class="chip mini danger" data-seatclear>Remove from seat</button>
       </div>
       <div class="seatedit-row">
         <label class="seatedit-fld">
           <span>Stack</span>
           <input id="he-seatstack" type="number" inputmode="numeric" placeholder="–" value="${esc(String(d.effStack || ""))}">
         </label>
         <div class="seatedit-fld">
           <span>Cards</span>
           <div class="seatedit-cards">${cardSlots}</div>
         </div>
       </div>
     </div>`);
  const stkIn = $("he-seatstack");
  if (stkIn) stkIn.oninput = () => { draft.effStack = stkIn.value; persistDraft(); };
}
let draft = newDraft();
let undoStack = [];

function mutate(fn) {
  undoStack.push(JSON.stringify(draft));
  if (undoStack.length > 80) undoStack.shift();
  fn();
  draftChanged();
}
function undo() {
  const s = undoStack.pop();
  if (s) { draft = JSON.parse(s); draftChanged(); }
}
let _draftSaveT = null, _draftDirty = false;
/* Persist the hand draft. draftChanged() debounces this ~400ms so a fast run of
   pad taps doesn't serialize + write the draft on every tap; render stays sync. */
function persistDraft() {
  _draftSaveT = null; _draftDirty = false;
  metaSet("draftHand", JSON.parse(JSON.stringify(draft)));
}
function flushDraft() {   // run a queued draft write now (pagehide/hidden) so the last edit survives suspend
  if (!_draftDirty) return;
  clearTimeout(_draftSaveT);
  persistDraft();
}
function draftChanged() {
  _draftDirty = true;
  clearTimeout(_draftSaveT);
  _draftSaveT = setTimeout(persistDraft, 400);
  renderHandEntry();
}
/* Is Hero part of this hand? Table mode: only if seated. Chips mode: the "You" toggle. */
function heroPresent(d) {
  return d.mode === "table" ? d.heroPos != null : d.heroIn;
}
function currentActor() {
  if (draft.mode === "table") {
    if (draft.focusPos) return actorForPos(draft.focusPos);
    // No seat focused: whoever is next after the last action on this street,
    // else first-to-act — consecutive taps walk the table instead of landing
    // on the same seat every time.
    const last = draft.actions[draft.actions.length - 1];
    if (last && last.street === draft.street) return nextActorByPos(last.actor) || null;
    return firstToAct(draft.street) || null;
  }
  let a = draft.actor;
  if (!draft.heroIn && a === "hero") a = null;
  // No actor picked yet? Use position-based first-to-act so chips mode
  // opens on the correct seat: firstToAct() = UTG, who acts first on every
  // street in ante-only short deck (was falling to v0 — bug #7).
  if (!a) {
    const f = firstToAct(draft.street);
    if (f) return f;
  }
  return a || (draft.villains.length ? "v0" : (draft.heroIn ? "hero" : null));
}
/* Drop villain i from the draft: its actions go too, and every later villain's
   "vN" actor id shifts down so their actions stay attached to the right player. */
function removeVillain(i) {
  draft.villains.splice(i, 1);
  const shift = (a) => {
    if (!a || !a.startsWith("v")) return a;
    const n = Number(a.slice(1));
    return n === i ? null : n > i ? "v" + (n - 1) : a;
  };
  draft.actions = draft.actions.filter((a) => a.actor !== "v" + i).map((a) => ({ ...a, actor: shift(a.actor) }));
  draft.actor = shift(draft.actor) ?? (draft.villains.length ? "v0" : (draft.heroIn ? "hero" : null));
  draft.lastV = shift(draft.lastV) ?? "v0";
}
/* Chips-mode auto-alternate: hero↔villain, or cycle villains when hero is out. */
function nextActorChips(actor) {
  if (draft.heroIn) return actor === "hero" ? draft.lastV : "hero";
  const n = draft.villains.length;
  if (n <= 1) return actor;
  return "v" + ((Number(actor.slice(1)) + 1) % n);
}
/* ---------- shorthand-note → hand parser ----------
   Extracts what's reliable from Phil's rough notes: position, holding, board,
   squid state, and the villain's headline preflop action. Anything ambiguous
   is left for manual entry (the raw note stays as draft.note). */
const POS_RX = /\b(U9|U8|U7|U6|U5|U4|HJ|CO|BN|EP|MP)\b/;
const HOLDING_RX = /\b([AKQJT6-9])([AKQJT6-9])([so])?\b/g;    // A9o, A9s, 66
/* Squid patterns:
   - nS = 0 squids (nobody)
   - wS = at least one squid (default 1)
   - w2S = 2 squids up (or w/2S)
   - 0/5, 2/5 = have/left pair (0/5squid → nobody has one; 5 left)
   - 2rdS / 3rdS / 4thS = ordinal squid count → previous (n-1) already up */
const SQUID_RX = /\b(nS|wS|w\d{1,2}S|w\/?\d{1,2}S|\d{1,2}\/\d{1,2}|\d(?:st|nd|rd|th)S)(?:squid)?\b/i;
const PRE_ACT_RX = /\b(Open|Iso|Lrr|Lc|Ld|3b|4b|Lb|limp|Ls|oL)\b/;
const SUIT_RX = /(ss|hh|dd|cc|ds|rr)/;                        // board suit hints
const EP_DEFAULT = "U8";                                       // "EP" without a number → deepest EP in a std 8-max game
function parsePosToken(tok) {
  if (!tok) return null;
  if (tok === "MP") return "U4";
  if (tok === "EP") return EP_DEFAULT;
  return tok;
}
function pickSuits(hs, wants) { /* pick two suit letters honoring 'o'/'s'/monotone hints */
  const all = ["s", "h", "d", "c"];
  const avail = all.filter((s) => !hs.has(s));
  if (wants === "s") return [avail[0], avail[0]];                        // both same
  if (wants === "o") return [avail[0], avail[1] || avail[0]];            // different
  return [avail[0], avail[1] || avail[0]];
}
function parseNoteToDraft(text, opponentId) {
  const d = newDraft();
  d.villains = [{ opponentId, pos: null, cards: [null, null], squid: null }];
  // Expand "V{n}L" -> "vs {n} limpers" so the shorthand reads clean in
  // hand summaries and stays parseable by the same downstream tokens.
  if (text) text = text.replace(/\bV(\d+)L\b/gi, (_, n) => `vs ${n} limpers`);
  d.note = text;
  if (!text) return d;
  // squid — sets hand-level squid state AND the villain's personal count
  // when the note gives us an ordinal ("3rdS" → this player already has 2).
  const sq = text.match(SQUID_RX);
  if (sq) {
    const s = sq[1].replace("w/", "w").toLowerCase();
    if (s === "ns") { d.squidHave = "0"; d.villains[0].squid = 0; }
    else if (s === "ws") { d.squidHave = "1"; d.villains[0].squid = 1; }
    else if (/^w\d/.test(s)) d.squidHave = s.slice(1).replace("s", "");
    else if (/^\d+\/\d+$/.test(s)) {
      const [h, l] = s.split("/");
      d.squidHave = h;
      d.squidLeft = l;
      if (h === "0") d.villains[0].squid = 0;
    }
    else if (/^\d(st|nd|rd|th)s$/.test(s)) {
      // "3rdS" = 3rd squid coming to him → he already has 2.
      const n = parseInt(s[0], 10) - 1;
      d.villains[0].squid = n;
      if (!d.squidHave) d.squidHave = String(Math.max(n, 1));
    }
  }
  // position — first token from a "AvB" (subject is first)
  const m = text.match(/\b(U9|U8|U7|U6|U5|U4|HJ|CO|BN)v(U9|U8|U7|U6|U5|U4|HJ|CO|BN)\b/);
  if (m) d.villains[0].pos = parsePosToken(m[1]);
  else {
    const pm = text.match(POS_RX);
    if (pm) d.villains[0].pos = parsePosToken(pm[1]);
  }
  // holding — pick the first plausible 2-card token; default offsuit
  const holds = [...text.matchAll(HOLDING_RX)].map((m) => ({ r1: m[1], r2: m[2], suit: m[3] || "o" }));
  const hold = holds.find((h) => (h.r1 === h.r2 && !h.suit) || h.suit);   // paired or explicit s/o
  if (hold) {
    const suits = pickSuits(new Set(), hold.suit);
    d.villains[0].cards = [hold.r1 + suits[0], hold.r2 + suits[1]];
  } else {
    // Phil's plural shorthand: "Qs" / "Ks" / "9s" = pair of that rank. Ambiguous
    // with single-card notation (Q♠), but in note context we treat standalone
    // rank+s as the plural. Skip if the token sits inside a longer card-ish
    // string (e.g. "AQs" already matched above, or a board like "QsJhTd").
    const pm = text.match(/(?:^|[^AKQJT6-9])([AKQJT6-9])s(?![AKQJT6-9hdcs])/);
    if (pm) {
      const r = pm[1];
      const suits = pickSuits(new Set(), "o");
      d.villains[0].cards = [r + suits[0], r + suits[1]];
    }
  }
  // board — look for BOARD-shaped token: 3+ ranks maybe followed by suit-code
  // Suffixes:
  //   s   = two cards share a random suit (which two + which suit random)
  //   m   = monotone (all same, random suit)
  //   r   = rainbow (distinct suits)
  //   ss/hh/dd/cc = legacy: monotone in that specific suit
  //   ds  = legacy: first two diamonds, then spade
  //   rr  = legacy: rainbow
  const boardTok = text.match(/\b([AKQJT6-9]{3,5})([smr]|ss|hh|dd|cc|ds|rr)?\b/);
  if (boardTok && boardTok[1].length >= 3) {
    const ranks = boardTok[1].split("");
    const SUITS4 = ["s", "h", "d", "c"];
    const used = new Set((d.villains[0].cards || []).filter(Boolean));   // never re-deal a hole card
    const suitHint = boardTok[2];
    const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
    // Precompute per-index suit assignments for the random-suit hints.
    let suitPlan = null;
    if (suitHint === "m") {
      const ok = SUITS4.filter((x) => ranks.every((r) => !used.has(r + x)));   // a suit no hole card blocks
      const x = pick(ok.length ? ok : SUITS4);
      suitPlan = ranks.map(() => x);
    } else if (suitHint === "r") {
      // Rainbow: three distinct suits for the first three cards, then random for 4th/5th.
      const shuffled = SUITS4.slice().sort(() => Math.random() - 0.5);
      suitPlan = ranks.map((_, i) => i < 3 ? shuffled[i] : pick(SUITS4));
    } else if (suitHint === "s") {
      // Two-of-three share a suit: pick which two indices, which shared suit,
      // and give the odd card a distinct suit.
      const shared = pick(SUITS4);
      const idxs = [0, 1, 2].sort(() => Math.random() - 0.5);
      const pair = [idxs[0], idxs[1]];
      const odd = idxs[2];
      const others = SUITS4.filter((x) => x !== shared);
      suitPlan = ranks.map((_, i) => {
        if (i === odd) return pick(others);
        if (pair.includes(i)) return shared;
        return pick(SUITS4);   // 4th/5th card: random
      });
    }
    const boardSuits = new Set();
    for (let i = 0; i < ranks.length && i < 5; i++) {
      const r = ranks[i];
      let suit;
      if (suitPlan) suit = suitPlan[i];
      else if (suitHint === "ss" || suitHint === "hh" || suitHint === "dd" || suitHint === "cc") suit = suitHint[0];
      else if (suitHint === "ds") suit = i < 2 ? "d" : "s";
      else suit = SUITS4.find((x) => !boardSuits.has(x) && !used.has(r + x));   // no hint: rainbow-ish
      if (!suit || used.has(r + suit)) suit = SUITS4.find((x) => !used.has(r + x)) || suit;
      boardSuits.add(suit);
      used.add(r + suit);
      d.board[i] = r + suit;
    }
  }
  // preflop action chain — walk the note in order, extract every recognized
  // token, and resolve sizing math (3b 3x after Open 40k → 120k) so the parsed
  // hand matches what filling it in manually would produce.
  //
  // Actor heuristic: notes are villain-centric, so the villain's own action
  // (Open/3b/4b/Lrr/limp) is v0; a matching counteraction on the OTHER side
  // (an opposing 3b or "call"/"cc" written after) is hero. Not perfect for
  // multiway pots but right for the common headline case.
  const ACT_MAP = {
    Open:  { act: "raise",   who: "v0" },
    open:  { act: "raise",   who: "v0" },
    raise: { act: "raise",   who: "v0" },
    Raise: { act: "raise",   who: "v0" },
    Iso:   { act: "raise",   who: "v0" },
    "3b":  { act: "3bet",    who: "v0" },
    "4b":  { act: "4bet",    who: "v0" },
    Lrr:   { act: "limp",    who: "v0" },   // limp then reraise; reraise pushed below
    Lc:    { act: "limp",    who: "v0" },
    Ld:    { act: "limp",    who: "v0" },
    Lb:    { act: "limp",    who: "v0" },
    limp:  { act: "limp",    who: "v0" },
    Limp:  { act: "limp",    who: "v0" },
    L:     { act: "limp",    who: "v0" },
    oL:    { act: "limp",    who: "v0" },   // overlimp — same act, different context marker
    Ls:    { act: "limp",    who: "v0" },
    cc:    { act: "call",    who: "v0" },   // cold-call — villain calling a raise
    call:  { act: "call",    who: "hero" }, // "call" from hero's POV
  };
  // Two regexes so limp-family tokens (limp/L/oL/Lc/Ld/Lb/Ls/Lrr) don't greedily
  // swallow a following number as their size — those actions are un-sized in
  // Phil's shorthand, and a following "88" is almost always a holding.
  const SIZED_CHAIN_RX = /\b(Open|open|raise|Raise|Iso|3b|4b|cc|call)(?:\s*(\d{1,4})[Kk]?\b|\s*(\d(?:\.\d+)?)[xX]\b)?/g;
  /* Capitalised Limp is listed the way Open/open and raise/Raise already are:
     "CO Limp AQo" otherwise saves with no preflop action and the range grid
     paints the class grey as No Action. */
  const UNSIZED_CHAIN_RX = /\b(Lrr|Lc|Ld|Lb|Ls|oL|limp|Limp|L)\b/g;
  // Walk both regexes and merge by match index so tokens stay in source order.
  const raw = [];
  let cmm;
  while ((cmm = SIZED_CHAIN_RX.exec(text)) !== null) raw.push({ i: cmm.index, tok: cmm[1], numK: cmm[2], mult: cmm[3] });
  while ((cmm = UNSIZED_CHAIN_RX.exec(text)) !== null) raw.push({ i: cmm.index, tok: cmm[1], numK: null, mult: null });
  raw.sort((a, b) => a.i - b.i);
  const chain = [];
  for (const cm of raw) {
    const { tok, numK, mult } = cm;
    const spec = ACT_MAP[tok]; if (!spec) continue;
    let size = null;
    if (numK) size = numK + "k";
    else if (mult) size = mult + "x";
    chain.push({ tok, act: spec.act, who: spec.who, size });
    // "Lrr" is the pair (limp, then raise) — push a follow-up raise entry.
    if (tok === "Lrr") chain.push({ tok: "Lrr-raise", act: "3bet", who: "v0", size: null });
  }
  // Resolve multipliers into chip amounts using the most recent raise size in
  // the chain. Preserve the "Nx" storage too — estimatePot uses that — but
  // convert isolated multipliers on 3b/4b/Lrr when a chip-anchored open exists.
  let lastK = null;
  for (const step of chain) {
    if (step.size && /^\d+k$/.test(step.size)) lastK = parseFloat(step.size);
    else if (step.size && /^\d+(\.\d+)?x$/.test(step.size) && lastK != null) {
      const mult = parseFloat(step.size);
      lastK = Math.round(lastK * mult);
      step.size = lastK + "k";
    }
  }
  for (const step of chain) {
    d.actions.push({ street: "pre", actor: step.who, act: step.act, size: step.size || null });
  }
  // Postflop bets — shorthand:
  //   B50  → 50% pot bet, stored as "50%"
  //   B50k → 50K chip bet, stored as "50k"
  // Attribute to v0; walk streets in board-fill order (flop → turn → river)
  // so the first B after the board becomes flop, the second becomes turn, etc.
  const streetOrder = ["flop", "turn", "river"];
  let streetIdx = 0;
  const boardHasFlop  = d.board.slice(0, 3).some(Boolean);
  const boardHasTurn  = !!d.board[3];
  const boardHasRiver = !!d.board[4];
  if (boardHasFlop && !boardHasTurn) streetIdx = 0;
  else if (boardHasTurn && !boardHasRiver) streetIdx = 0;
  else if (boardHasRiver) streetIdx = 0;
  const BET_RX = /\bB(\d{1,4})(k)?\b/g;
  let bm;
  while ((bm = BET_RX.exec(text)) !== null) {
    const n = bm[1], kFlag = bm[2];
    const size = kFlag ? n + "k" : n + "%";
    const street = streetOrder[Math.min(streetIdx, streetOrder.length - 1)];
    d.actions.push({ street, actor: "v0", act: "bet", size });
    streetIdx++;
  }
  return d;
}

function ensureVillainSlot() {
  if (!draft.villains.length)
    draft.villains.push({ opponentId: null, pos: null, cards: [null, null] });
}
/* Everyone in the hand needs a seat before board cards go in. */
function positionsMissing() {
  const need = [];
  if (heroPresent(draft) && !draft.heroPos) need.push("You");
  draft.villains.forEach((v, i) => {
    if (!v.pos) need.push(oppById(v.opponentId)?.name || "V" + (i + 1));
  });
  return need;
}

function lineText(d) {
  const parts = [];
  d.villains.forEach((v, i) => {
    const nm = v.opponentId ? (oppById(v.opponentId)?.name || "?") : "V" + (i + 1);
    parts.push(nm + (v.pos ? " " + v.pos : ""));
  });
  if (heroPresent(d) && (d.heroPos || d.heroCards.some(Boolean)))
    parts.push("Hero" + (d.heroPos ? " " + d.heroPos : "") +
      (d.heroCards.some(Boolean) ? " " + cardsStr(d.heroCards) : ""));
  if (d.effStack) parts.push("eff " + d.effStack + "K");
  if (d.squidHave || d.squidLeft)
    parts.push("squid " + (d.squidHave || "?") + "/" + (d.squidLeft || "?"));
  for (const st of STREETS) {
    const acts = d.actions.filter((a) => a.street === st);
    const b = boardFor(d, st);
    if (!acts.length && !b) continue;
    if (st !== "pre") parts.push("｜" + st.toUpperCase() + (b ? " " + b : ""));
    acts.forEach((a) =>
      parts.push(actorLabel(d, a.actor) + " " + a.act + (a.size ? " " + a.size : "")));
  }
  return parts.join(" · ");
}

/* ---- turn order + street completion (positions drive who's next) ---- */
/* Short deck (ante-only, button double ante): UTG acts first on every street, BN last. */
const ORDER_POST = POSITIONS;
const actOrderFor = () => POSITIONS;
const AGG_ACTS = ["bet", "raise", "3bet", "4bet", "5bet", "jam"];

function draftActorPos(actor) {
  return actor === "hero" ? draft.heroPos : draft.villains[Number(actor.slice(1))]?.pos;
}
function draftParticipants() {
  const p = draft.villains.map((_, i) => "v" + i);
  if (heroPresent(draft)) p.unshift("hero");
  return p;
}
function liveActors() {                       // folds are terminal
  const folded = new Set(draft.actions.filter((a) => a.act === "fold").map((a) => a.actor));
  return draftParticipants().filter((p) => !folded.has(p));
}
/* Next to act after `actor`, walking seat order among live positioned players. */
function nextActorByPos(actor) {
  const myPos = draftActorPos(actor);
  if (!myPos) return null;
  const order = actOrderFor(draft.street);
  const live = liveActors().map((p) => ({ p, pos: draftActorPos(p) })).filter((x) => x.pos);
  const i = order.indexOf(myPos);
  for (let k = 1; k <= order.length; k++) {
    const hit = live.find((x) => x.pos === order[(i + k) % order.length] && x.p !== actor);
    if (hit) return hit.p;
  }
  return null;
}
/* First to act on a street, or null when positions are unknown. */
function firstToAct(street) {
  const order = actOrderFor(street);
  const live = liveActors().map((p) => ({ p, pos: draftActorPos(p) })).filter((x) => x.pos);
  live.sort((a, b) => order.indexOf(a.pos) - order.indexOf(b.pos));
  return live[0]?.p || null;
}

/* ---- table lineup: anchor one seat, derive the rest around the ring ----
   The lineup is today's clockwise seat order. Set one player's position and
   everyone else's follows by their offset along the ORDER_POST seat ring. */
const lineupId = (actor) => actor === "hero" ? "hero" : draft.villains[Number(actor.slice(1))]?.opponentId;
const lineupActive = () => tableLineup.length >= 2;
/* Seat ring for n seats (4..9), clockwise from the first seat left of the
   button (UTG). No blinds in short deck: UTG labels numbered from the table
   size (U9, U8, …) then HJ/CO/BN. 4-max = U4/HJ/CO/BN. */
const ringFor = (n) => {
  const tail = ["HJ", "CO", "BN"];
  const k = n - tail.length;
  const utg = Array.from({ length: k }, (_, i) => "U" + (n - i));
  return utg.concat(tail);
};
/* Seat count = lineup array length (clamped 4..9), falling back to lineupSeats
   or 9 when no lineup is set. Lineup is the source of truth for table size. */
const effectiveSeats = () =>
  Math.max(4, Math.min(9, tableLineup.length || lineupSeats || 9));
const baseSeatRing = () => ringFor(effectiveSeats());
/* Rotate a ring right by `rot` (each label shifts to the next slot CW).
   BTN rotation reassigns which position label sits at each physical slot
   without moving the players — see moveBtn(). */
const rotateRing = (ring, rot) => {
  const n = ring.length;
  const k = (((rot | 0) % n) + n) % n;
  return k ? ring.slice(n - k).concat(ring.slice(0, n - k)) : ring;
};
const seatRing = () => rotateRing(baseSeatRing(), draft.btnRot || 0);
function deriveLineup(anchor) {
  if (!lineupActive()) return;
  const ring = seatRing();
  const ai = tableLineup.indexOf(lineupId(anchor));
  const ap = draftActorPos(anchor);
  if (ai < 0 || !ap) return;
  const pIdx = ring.indexOf(ap);
  if (pIdx < 0) return;                            // anchor on a seat outside this table size
  const L = ring.length;
  for (const p of draftParticipants()) {
    if (p === anchor) continue;
    const li = tableLineup.indexOf(lineupId(p));
    if (li < 0) continue;
    const pos = ring[(((pIdx + (li - ai)) % L) + L) % L];
    if (p === "hero") draft.heroPos = pos;
    else draft.villains[Number(p.slice(1))].pos = pos;
  }
}
/* Seed Table-mode seats from the saved lineup: put each lineup member on the
   ring position at the same clockwise index. No-op if no lineup, or if the
   draft already has villains / a hero seat. */
function seedTableFromLineup() {
  if (!lineupActive()) return;
  if (draft.villains.length || draft.heroPos) return;
  const ring = seatRing();
  const n = Math.min(tableLineup.length, ring.length);
  for (let i = 0; i < n; i++) {
    const id = tableLineup[i];
    const pos = ring[i];
    if (id === "hero") { draft.heroIn = true; draft.heroPos = pos; }
    else draft.villains.push({ opponentId: id, pos, cards: [null, null] });
  }
}
/* When a seat is already anchored this hand, fill any newly-added player in. */
function autoDeriveLineup() {
  if (!lineupActive()) return;
  const anchor = draftParticipants().find((p) => draftActorPos(p) && tableLineup.includes(lineupId(p)));
  if (anchor) deriveLineup(anchor);
}
/* Betting on `street` is closed: everyone live has responded to the last
   aggression (or everyone has checked/limped through). */
function streetClosed(street) {
  const acts = draft.actions.filter((a) => a.street === street);
  if (!acts.length) return false;
  const live = liveActors();
  if (live.length < 2) return false;          // hand is over, nothing to advance
  let lastAgg = -1;
  acts.forEach((a, i) => { if (AGG_ACTS.includes(a.act)) lastAgg = i; });
  if (lastAgg >= 0) {
    const aggr = acts[lastAgg].actor;
    const after = new Set(acts.slice(lastAgg + 1).map((a) => a.actor));
    return live.every((p) => p === aggr || after.has(p));
  }
  const acted = new Set(acts.map((a) => a.actor));
  return live.every((p) => acted.has(p));
}

/* How many raises have gone in preflop (open=1, 3bet=2, 4bet=3 …). */
function preRaiseLevel() {
  return draft.actions.filter((a) => a.street === "pre" &&
    ["raise", "3bet", "4bet", "5bet"].includes(a.act)).length;
}
/* Facing an all-in on this street? (act "jam" or any aggression sized "Jam") */
function facingJam(street) {
  const agg = draft.actions.filter((a) => a.street === street && AGG_ACTS.includes(a.act));
  const last = agg[agg.length - 1];
  return !!last && (last.act === "jam" || last.size === "Jam");
}
/* Preflop buttons depend on what's already happened. */
function preflopActs() {
  if (facingJam("pre")) return ["fold", "call"];   // can't raise an all-in
  const lvl = preRaiseLevel();
  if (lvl === 0) {
    // the button's double ante already covers a limp: it has the option to check
    const cur = currentActor();
    if (cur && draftActorPos(cur) === "BN") return ["fold", "check", "raise"];
    return ["fold", "limp", "raise"];
  }
  return [
    null,
    ["fold", "call", "3bet"],    // facing a raise
    ["fold", "call", "4bet"],    // facing a 3bet
    ["fold", "call", "5bet"],    // facing a 4bet
  ][lvl] || ["fold", "call", "jam"];   // facing a 4bet+ / all-in
}
/* Postflop buttons depend on the betting on the CURRENT street. */
function postflopActs() {
  const st = draft.street;
  if (facingJam(st)) return ["fold", "call"];      // can't raise an all-in
  const bets = draft.actions.filter((a) => a.street === st &&
    ["bet", "raise", "jam"].includes(a.act)).length;
  return [
    ["check", "bet"],            // checked to you / first in
    ["fold", "call", "raise"],   // facing a bet
    ["fold", "call", "raise"],   // facing a raise (re-raise)
  ][bets] || ["fold", "call", "jam"];   // facing a re-raise+ / all-in
}
function actLabel(a) {
  if (["3bet", "4bet", "5bet"].includes(a)) return a;
  return a[0].toUpperCase() + a.slice(1);
}
/* ---------- hand evaluator + auto result ----------
   Result is never entered by hand: if everyone folds to one player they
   win; if 2+ reach the end with a full board and known hole cards, the
   evaluator settles it (ties = chop). Anything else stays unknown. */
const RVAL = Object.fromEntries("6789TJQKA".split("").map((r, i) => [r, i + 6]));
function score5(cs) {                       // 5 cards → comparable score array
  const vs = cs.map((c) => RVAL[c[0]]).sort((a, b) => b - a);
  const flush = cs.every((c) => c[1] === cs[0][1]);
  const counts = {};
  vs.forEach((v) => counts[v] = (counts[v] || 0) + 1);
  const groups = Object.entries(counts).map(([v, n]) => [n, Number(v)])
    .sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  let straight = 0;
  if (groups.length === 5) {
    if (vs[0] - vs[4] === 4) straight = vs[0];
    else if (vs[0] === 14 && vs[1] === 9 && vs[4] === 6) straight = 9;   // A6789: ace plays low
  }
  const rest = groups.map((g) => g[1]);
  if (flush && straight) return [8, straight];
  if (groups[0][0] === 4) return [7, ...rest];
  if (flush) return [6, ...vs];                                        // short deck: flush > full house
  if (groups[0][0] === 3 && groups[1]?.[0] === 2) return [5, ...rest];
  if (straight) return [4, straight];
  if (groups[0][0] === 3) return [3, ...rest];
  if (groups[0][0] === 2 && groups[1]?.[0] === 2) return [2, ...rest];
  if (groups[0][0] === 2) return [1, ...rest];
  return [0, ...vs];
}
function cmpScore(x, y) {
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
}
function best7(cs) {                        // best 5 of up to 7
  let best = null;
  const n = cs.length;
  for (let a = 0; a < n - 4; a++) for (let b = a + 1; b < n - 3; b++)
    for (let c = b + 1; c < n - 2; c++) for (let d = c + 1; d < n - 1; d++)
      for (let e = d + 1; e < n; e++) {
        const s = score5([cs[a], cs[b], cs[c], cs[d], cs[e]]);
        if (!best || cmpScore(s, best) > 0) best = s;
      }
  return best;
}
/* Who won this hand, if it's determinable. → { winners:[actors], how } | null */
function handWinner(h) {
  const parts = (h.villains || []).map((_, i) => "v" + i);
  if (h.hero !== false) parts.unshift("hero");
  const folded = new Set((h.actions || []).filter((a) => a.act === "fold").map((a) => a.actor));
  const live = parts.filter((p) => !folded.has(p));
  if (live.length === 1 && folded.size) return { winners: live, how: "folds" };
  if (live.length < 2) return null;
  const board = (h.board || []).filter(Boolean);
  const cardsOf = (p) => p === "hero" ? h.heroCards : h.villains?.[Number(p.slice(1))]?.cards;
  if (board.length !== 5 || !live.every((p) => (cardsOf(p) || []).filter(Boolean).length === 2)) return null;
  let best = null, winners = [];
  for (const p of live) {
    const s = best7(board.concat(cardsOf(p)));
    const d = best ? cmpScore(s, best) : 1;
    if (d > 0) { best = s; winners = [p]; }
    else if (d === 0) winners.push(p);
  }
  return { winners, how: "showdown" };
}
/* Hero-relative outcome for dots/records: "won" | "lost" | "chop" | null. */
function heroResult(h) {
  const win = handWinner(h);
  if (!win) return h.result || null;        // legacy hands with manually set result
  if (h.hero === false) return null;
  if (!win.winners.includes("hero")) return "lost";
  return win.winners.length > 1 ? "chop" : "won";
}

/* ---------- rough pot tracking (in K) ----------
   Sizes are shorthand ("4x", "50%", "Jam"), so this is a deliberate
   approximation: multipliers apply to the last bet, percentages to the
   current pot, jams to the effective stack, unsized aggression to
   typical defaults. Good enough for "how big was that turn jam". */
function estimatePot(src, actions) {
  const num = (v) => { const n = Number(v); return isFinite(n) && n > 0 ? n : 0; };
  const ante = num(src.ante ?? src.blinds?.ante);
  const eff = num(src.effStack);
  const unit = ante;                             // price of entry preflop = one more ante
  let street = "pre", contrib = {}, curBet = unit;
  // Everyone's ante is dead money; the button's second ante is a live blind
  // (its preflop contribution) unless the button isn't in the hand.
  const players = ["hero", ...(src.villains || []).map((_, i) => "v" + i)];
  const posOf = (p) => p === "hero" ? (src.hero === false ? null : src.heroPos) : src.villains?.[Number(p.slice(1))]?.pos;
  const seats = num(src.seats) || Math.max(players.filter(posOf).length, 2);
  // What each player brought. His own recorded stack when there is one, the
  // effective stack otherwise — nobody can put in more than this all hand.
  const stackOf = (p) => (p === "hero" ? eff : num(src.villains?.[Number(p.slice(1))]?.chips) || eff);
  // Chips already behind on earlier streets. The ante is posted, so it counts
  // from the start; the button's second ante is live and rides in contrib.
  const spent = {};
  players.forEach((p) => { if (posOf(p)) spent[p] = ante; });
  let dead = ante * seats;
  const btn = players.find((p) => posOf(p) === "BN");
  if (btn) contrib[btn] = ante; else dead += ante;
  let pot = Math.max(0, dead);
  const potNow = () => pot + Object.values(contrib).reduce((a, x) => a + x, 0);
  const atStart = { pre: potNow() };             // pot as each street begins
  const perAct = [];                             // resolved "to" amount per action
  const allIn = [];                              // did that action put the actor in for everything
  const pre = [];                                // pot + level facing each action, for pot-% labels
  // The most this player can still have in front this street. A jam on the
  // river is the stack he has left, not the stack he sat down with. No stack on
  // record means no ceiling — better an estimate than a bet clamped to zero.
  const room = (p) => stackOf(p) > 0 ? Math.max(0, stackOf(p) - (spent[p] || 0)) : Infinity;
  for (const a of actions || []) {
    if (a.street !== street) {
      for (const p in contrib) spent[p] = (spent[p] || 0) + contrib[p];
      pot = potNow(); contrib = {}; street = a.street; curBet = 0; atStart[street] = pot;
    }
    pre.push({ pot: potNow(), curBet });
    const cap = room(a.actor);
    if (a.act === "fold" || a.act === "check") { perAct.push(0); allIn.push(false); continue; }
    if (a.act === "limp") {
      const v = Math.min(unit, cap);
      contrib[a.actor] = v; curBet = Math.max(curBet, v); perAct.push(v); allIn.push(isFinite(cap) && cap > 0 && v >= cap); continue;
    }
    if (a.act === "call") {
      const v = Math.min(curBet, cap);
      if (curBet) contrib[a.actor] = v;
      perAct.push(v); allIn.push(isFinite(cap) && cap > 0 && !!curBet && v >= cap); continue;
    }
    let lvl = 0;                                 // aggression → a new "to" level this street
    const s = a.size;
    if (s && /^\d+(\.\d+)?k$/i.test(s)) lvl = parseFloat(s);
    else if (s && /^\$/.test(s)) lvl = parseFloat(s.slice(1));
    else if (s && /^\d+(\.\d+)?a$/i.test(s)) lvl = parseFloat(s) * unit;   // "4a" = four antes
    else if (s && /^\d+(\.\d+)?x$/i.test(s)) lvl = parseFloat(s) * (curBet || unit);
    else if (s && /%$/.test(s)) lvl = (parseFloat(s) / 100) * potNow() + curBet;
    else if (s === "pot") lvl = potNow() + curBet;
    else if (s === "over") lvl = 1.3 * potNow() + curBet;
    else if (s === "Jam" || a.act === "jam") lvl = isFinite(cap) ? cap : (curBet ? 2.5 * curBet : potNow());
    else lvl = curBet ? 2.5 * curBet : 0.66 * potNow();
    lvl = Math.min(lvl, cap);
    if (cap - lvl > 0 && cap - lvl <= 0.05 * unit) lvl = cap;   // DX rounds each amount to 0.01k: a jam can land a hair under the stack
    if (!isFinite(lvl) || lvl <= 0) { perAct.push(0); allIn.push(false); continue; }
    contrib[a.actor] = Math.max(contrib[a.actor] || 0, lvl);
    curBet = Math.max(curBet, lvl);
    perAct.push(lvl);
    allIn.push(isFinite(cap) && cap > 0 && lvl >= cap);
  }
  // Everything each player has put in so far, earlier streets plus what is in
  // front of him now — the felt subtracts it to show what he has left.
  const invested = { ...spent };
  for (const p in contrib) invested[p] = (invested[p] || 0) + contrib[p];
  return { atStart, now: potNow(), curBet, perAct, allIn, pre, contrib: { ...contrib }, invested, stackOf };
}
const potStr = (n, raw = false) => !n ? "" :
  raw
    ? "≈" + Math.round(n)
    : "≈" + (n >= 10 ? Math.round(n) : Math.round(n * 10) / 10) + "K";

/* Size options depend on the action: open raise = chip amounts, 3bet+ = multipliers. */
function sizesFor(a) {
  if (a.street !== "pre") return SIZES_POST;
  if (a.act === "3bet") return SIZES_3BET;
  if (a.act === "4bet" || a.act === "5bet") return SIZES_4BET;
  return SIZES_OPEN;
}

/* True when the pending action is a preflop open-raise we size in antes. */
function isOpenRaise(a) { return a && a.street === "pre" && a.act === "raise"; }

/* Round chips to a table-friendly number that always ends in 0: 32K→30K,
   48K→50K, 16K→20K. Step grows with magnitude but stays a multiple of 10. */
function niceChips(k) {
  const step = k < 200 ? 10 : (k < 600 ? 50 : 100);
  return Math.max(10, Math.round(k / step) * step);
}

const OPEN_HALFLIFE_MS = 30 * 864e5;   // recency half-life ≈ 30 days
const OPEN_DEFAULT_BASE = 0.75;        // keeps 8–15bb present until a custom size is used enough

function openSizePicks(bb) {
  const v = openSizeStats[bb];
  return Array.isArray(v) ? v : [];
}
/* Recency-weighted score per BB size at this blind level: each past pick
   contributes 0.5^(age/halflife), so recent sizing choices dominate. This is
   the seam a predictive model would later slot into (adding position / squid /
   stack features) — same button API, richer scoring. */
function openSizeWeights(bb) {
  const now = Date.now(), w = {};
  for (const p of openSizePicks(bb))
    w[p.size] = (w[p.size] || 0) + Math.pow(0.5, (now - (p.ts || now)) / OPEN_HALFLIFE_MS);
  return w;
}
/* Up to four {chips, n} open sizes at this blind level: chips is the rounded
   stack (niceChips), n its real bb ratio — 8bb at 4K blinds rounds to 30K,
   which is 7.5bb, and that's what the button says and what gets recorded. */
function openSizeButtons(bb) {
  const w = openSizeWeights(bb);
  const cand = new Set(DEFAULT_OPEN_A);
  for (const k of Object.keys(w)) cand.add(Number(k));
  const score = (n) => (w[n] || 0) + (DEFAULT_OPEN_A.includes(n) ? OPEN_DEFAULT_BASE : 0);
  const seen = new Set();
  return [...cand].filter((n) => n > 0)
    .sort((a, b) => score(b) - score(a)                  // most-used-recently first
      || Math.abs(a - 4) - Math.abs(b - 4) || a - b)     // then closest to 4 antes
    .map((n) => niceChips(n * bb))
    .filter((chips) => !seen.has(chips) && seen.add(chips))   // 8bb and 7.5bb can round to the same stack
    .slice(0, 4)
    .sort((a, b) => a - b)                               // ALWAYS smallest → biggest
    .map((chips) => ({ chips, n: Math.round((chips / bb) * 2) / 2 }));
}
async function recordOpenSize(bb, bbSize) {
  if (!bb || !bbSize || bbSize <= 0) return;
  const arr = (openSizeStats[bb] = openSizePicks(bb));
  arr.push({ size: bbSize, ts: Date.now() });
  if (arr.length > 60) arr.splice(0, arr.length - 60);   // keep a recent window
  await metaSet("openSizeStats", openSizeStats);
}

function renderHandEntry() {
  const d = draft;
  const table = d.mode === "table";

  // hand line
  const lt = lineText(d);
  $("he-line").textContent = lt || (table ? "New hand — tap a seat" : "New hand — tap a villain");
  $("he-line").classList.toggle("muted", !lt);
  $("he-notehint").classList.toggle("hidden", !d.note);
  $("he-notehint-text").textContent = d.note || "";

  // mode toggle + show/hide the two entry styles
  $("he-mode").innerHTML =
    `<button class="${!table ? "on" : ""}" data-mode="chips">Chips</button>` +
    `<button class="${table ? "on" : ""}" data-mode="table">Table</button>`;
  $("he-chipsonly").classList.toggle("hidden", table);
  $("he-table").classList.toggle("hidden", !table);
  // Table mode duplicates blinds/eff in its setup bar — hide the ctxbar copies.
  ["he-ante", "he-effstack"].forEach((id) => {
    const el = $(id); if (el && el.closest(".ctxfield")) el.closest(".ctxfield").classList.toggle("hidden", table);
  });
  if (table) renderTable();

  // villain picker: Hero + selected always shown; then search results, or recent when idle
  const stats = oppStats();
  const selIds = d.villains.map((v) => v.opponentId);
  const byRecent = (a, b) => (stats[b.id]?.last || b.updatedAt || 0) - (stats[a.id]?.last || a.updatedAt || 0);
  const active = OPP.filter((o) => !o.archived);
  const nq = vSearch.trim().toLowerCase().replace(/\s+/g, "");
  const heroChip = `<button class="chip heroic${d.heroIn ? " on" : ""}" data-heroin>You</button>`;
  const addAnonChip = `<button class="chip" data-addanon title="Add an unnamed villain to this hand">＋ V</button>`;
  const chip = (o, on) =>
    `<button class="chip${on ? " on" : ""}" data-vopp="${o.id}">${esc(o.name)}</button>`;
  let html = heroChip + addAnonChip;
  if (nq) {
    // search takes over: pinyin-aware filter over everyone
    const matched = active.filter((o) => oppMatches(o, nq)).sort(byRecent);
    html += matched.map((o) => chip(o, selIds.includes(o.id))).join("")
      || `<span class="chipnote">no match</span>`;
  } else if (lineupActive()) {
    // show EVERY seated villain in seat order (not just recent) so they're all reachable
    const seated = tableLineup.filter((id) => id !== "hero").map((id) => oppById(id)).filter(Boolean);
    html += seated.map((o) => chip(o, selIds.includes(o.id))).join("");
    const extras = active.filter((o) => !tableLineup.includes(o.id) && selIds.includes(o.id));
    if (extras.length) html += `<span class="chipdiv"></span>` + extras.map((o) => chip(o, true)).join("");
  } else {
    // no lineup: recency-sorted, put selected first
    const selected = active.filter((o) => selIds.includes(o.id)).sort(byRecent);
    const pool = active.filter((o) => !selIds.includes(o.id)).sort(byRecent).slice(0, 8);
    html += selected.map((o) => chip(o, true)).join("")
      + (selected.length && pool.length ? `<span class="chipdiv"></span>` : "")
      + pool.map((o) => chip(o, false)).join("");
  }
  $("he-villains").innerHTML = html;
  if (document.activeElement !== $("he-vsearch")) $("he-vsearch").value = vSearch;
  $("he-lineup-btn").textContent = lineupActive() ? `Lineup · ${tableLineup.length}` : "Lineup";
  $("he-lineup-btn").classList.toggle("on", lineupActive());

  // position rows — chips reflect today's table size (4–9-handed).
  // Preserve any position already saved on the draft so it's not hidden.
  const ring = seatRing();
  const extras = new Set([d.heroPos, ...d.villains.map((v) => v.pos)].filter((p) => p && !ring.includes(p)));
  const posList = [...ring, ...extras];
  $("he-heropos").closest(".posrow").classList.toggle("hidden", !d.heroIn);
  $("he-heropos").innerHTML = posList.map((p) =>
    `<button class="chip mini${d.heroPos === p ? " on" : ""}" data-hpos="${p}">${p}</button>`).join("");
  // one position row per selected villain, labelled by name
  $("he-vposrows").innerHTML = d.villains.map((v, i) => {
    const nm = v.opponentId ? (oppById(v.opponentId)?.name || "?") : "V" + (i + 1);
    const chips = posList.map((p) =>
      `<button class="chip mini${v.pos === p ? " on" : ""}" data-vposi="${i}" data-vpos="${p}">${p}</button>`).join("");
    return `<div class="posrow"><span class="poslabel" title="${esc(nm)}">${esc(nm)}</span><div class="chiprow tight">${chips}</div></div>`;
  }).join("");

  // action trigger + running list on the main page. The street/actor/act/size
  // controls live in the bottom "Add action" sheet — see renderActionPad().
  const cur = currentActor();
  const curLbl = cur ? draftActorLabel(cur) : (table ? "seat a player" : "tap a villain");
  $("he-openact").innerHTML =
    `<span class="actopen-hd">${d.street.toUpperCase()}</span>` +
    `<span class="actopen-mid">＋ Add action</span>` +
    `<span class="actopen-tl">${esc(curLbl)}</span>`;
  const acts = d.actions;
  $("he-actlist").classList.toggle("hidden", !acts.length);
  if (acts.length) $("he-actlist").textContent = acts.map((a) =>
    `${draftActorLabel(a.actor)} ${a.act}${a.size ? " " + a.size : ""}`).join(" · ");
  if (sheetGroup === "__act__") renderActionPad();

  // card slots — one row per villain: fixed-width name column + two card slots.
  // No wrapping; long / Chinese names truncate with ellipsis so the slots stay aligned.
  const slotBtn = (zone, i, card, lbl) =>
    `<button class="cslot${card ? " filled" : ""}" data-slot="${zone}:${i}">` +
    (card ? cardHTML(card) : `<span class="lbl">${lbl}</span>`) + `</button>`;
  let ch = `<div class="crow crow-board">` +
    d.board.map((c, i) => slotBtn("board", i, c, ["F", "F", "F", "T", "R"][i])).join("") +
    `</div>`;
  if (d.heroIn) {
    ch += `<div class="crow crow-holes"><span class="cdiv">hero</span>` +
      d.heroCards.map((c, i) => slotBtn("hero", i, c, "?")).join("") + `</div>`;
  }
  d.villains.forEach((v, i) => {
    const nm = v.opponentId ? (oppById(v.opponentId)?.name || "?") : "V" + (i + 1);
    // Per-villain squid slot — a compact cycling chip (–, 0, 1, 2, 3) next to
    // their hole-card slots. Records how many squids THIS player already has;
    // decoupled from the hand-level squid.have (which is table state).
    const sq = v.squid == null ? "–" : String(v.squid);
    ch += `<div class="crow crow-holes"><span class="cdiv">${esc(nm)}</span>` +
      (v.cards || [null, null]).map((c, j) => slotBtn("v" + i, j, c, "?")).join("") +
      `<button class="vsquid${v.squid != null ? " on" : ""}" data-vsquid="${i}" title="This villain's squid count">🦑${sq}</button>` +
      `</div>`;
  });
  $("he-cards").innerHTML = ch;

  // squid pickers (compact buttons at top) — number chosen in a scroll sheet.
  // When a lineup is active, prefer showing the live "X/Y" — X = villains in
  // the lineup tagged force-squid, Y = total villains — instead of the manual
  // per-hand pick, so the ratio updates as reads change (#5).
  const squidLabel = () => {
    // Manual pick always wins — the ratio was only meant as a default hint.
    if (d.squidHave !== "") return String(d.squidHave);
    if (!lineupActive()) return "–";
    const villains = tableLineup.filter((id) => id !== "hero");
    const y = villains.length;
    const x = villains.filter((id) => oppById(id)?.reads?.["force-squid"]).length;
    return `${x}/${y}`;
  };
  $("he-squidhave-btn").innerHTML = `🦑<i>${squidLabel()}</i>`;
  $("he-squidleft-btn").innerHTML = `Left<i>${d.squidLeft === "" ? "–" : d.squidLeft}</i>`;
  $("he-squidhave-btn").classList.toggle("set", d.squidHave !== "");
  $("he-squidleft-btn").classList.toggle("set", d.squidLeft !== "");

  // blinds + eff stack (don't clobber focused inputs)
  for (const [id, val] of [["he-ante", d.ante], ["he-effstack", d.effStack]])
    if (document.activeElement !== $(id)) $(id).value = val;
}

/* --- action-pad sheet (Option 1 wizard): street / actor / act / size --- */

function draftActorLabel(actor) {
  if (!actor) return "";
  if (actor === "hero") return "Hero";
  const i = Number(actor.slice(1));
  const v = draft.villains[i];
  const nm = v?.opponentId ? (oppById(v.opponentId)?.name || "?") : "V" + (i + 1);
  return nm.slice(0, 12);
}

function openActionSheet() {
  sheetGroup = "__act__";
  showSheet(
    `<div class="sheethead"><span class="t">Action</span>
       <button data-sheetclose>Done</button></div>
     <div class="actionpad-sheet">
       <div id="he-street" class="seg"></div>
       <div id="he-pot" class="potline hidden"></div>
       <div id="he-actor" class="seg"></div>
       <div id="he-acts" class="actgrid"></div>
       <div id="he-sizes" class="sizegrid hidden"></div>
     </div>`);
  renderActionPad();
}

function renderActionPad() {
  const d = draft;
  const table = d.mode === "table";
  if (!$("he-street")) return;                       // sheet not open

  $("he-street").innerHTML = STREETS.map((s) =>
    `<button class="${d.street === s ? "on" : ""}" data-street="${s}">${s.toUpperCase()}</button>`).join("");

  const cur = currentActor();
  const vBtns = d.villains.map((v, i) => {
    const nm = v.opponentId ? (oppById(v.opponentId)?.name || "?").slice(0, 9) : "V" + (i + 1);
    return `<button class="${cur === "v" + i ? "on" : ""}" data-actor="v${i}">${esc(nm)}</button>`;
  }).join("") || `<button class="${cur === "v0" ? "on" : ""}" data-actor="v0">VILLAIN</button>`;
  $("he-actor").innerHTML =
    (heroPresent(d) ? `<button class="${cur === "hero" ? "on" : ""}" data-actor="hero">HERO</button>` : "") + vBtns;

  const pe = estimatePot(d, d.actions);
  const showPot = d.actions.length > 0 && pe.now > 0;
  $("he-pot").classList.toggle("hidden", !showPot);
  if (showPot) $("he-pot").textContent = "Pot " + potStr(pe.now);

  const acts = d.street === "pre" ? preflopActs() : postflopActs();
  $("he-acts").innerHTML = acts.map((a) =>
    `<button data-act="${a}">${actLabel(a)}</button>`).join("");

  const last = d.actions[d.actions.length - 1];
  const needSize = last && SIZED_ACTS.includes(last.act) && !last.size;
  $("he-sizes").classList.toggle("hidden", !needSize);
  if (needSize) {
    const prev = d.actions.slice(0, -1);
    const base = estimatePot(d, prev);
    const facing = prev.length && prev[prev.length - 1].street === last.street ? base.curBet : 0;
    const chipAmt = (s) => {
      if (/%$/.test(s)) return (parseFloat(s) / 100) * base.now + facing;
      if (s === "pot") return base.now + facing;
      if (s === "over") return 1.3 * base.now + facing;
      if (/^\d+(\.\d+)?x$/i.test(s)) return facing ? parseFloat(s) * facing : 0;
      return 0;
    };
    const bb = Number(d.ante) || 0;
    let btns;
    if (isOpenRaise(last) && bb > 0) {
      btns = openSizeButtons(bb).map(({ n, chips }) =>
        `<button class="sizebtn" data-size="$${chips}" data-bbsize="${n}">` +
        `<span class="sz">${chips}K</span><span class="amt">${n}a</span></button>`).join("") +
      `<button class="sizebtn" data-size="Jam"><span class="sz">Jam</span></button>`;
    } else {
      btns = sizesFor(last).map((s) => {
        const amt = base.now > 0 ? chipAmt(s) : 0;
        const lbl = /%$/.test(s) ? "B" + s.replace(/%$/, "") : s;   // pot-% shown as B33…B100
        return `<button class="sizebtn" data-size="${s}"><span class="sz">${lbl}</span>${amt ? `<span class="amt">${potStr(amt)}</span>` : ""}</button>`;
      }).join("");
    }
    $("he-sizes").innerHTML =
      `<div class="sizehint">${actLabel(last.act)} size</div>` +
      `<div class="sizeopts">` + btns +
      `<label class="sizebtn sizecustom"><input data-sizenum type="number" placeholder="custom" inputmode="numeric"></label>` +
      `</div>`;
  }
}

/* Dispatch a click on a street / actor / act / size button. Shared by the
   view-hand click handler and the action-sheet's sheetClick. Returns true if
   the button belonged to this dispatcher (so callers can chain). */
/* Chip amount (K) for a size string, or null when the size is relative
   (multiplier / percentage / Jam) and can't be compared to effstack in isolation. */
function chipAmountFromSize(size) {
  if (!size) return null;
  let m;
  if ((m = /^\$(\d+(?:\.\d+)?)$/.exec(size))) return Number(m[1]);
  if ((m = /^(\d+(?:\.\d+)?)k$/i.exec(size))) return Number(m[1]);
  if (/^\d+(?:\.\d+)?$/.test(size)) return Number(size);
  return null;
}
/* Clamp a chip-sized bet to "Jam" when it meets or exceeds the effective stack. */
function clampSizeToJam(size) {
  const eff = Number(draft.effStack) || 0;
  if (eff <= 0 || !size || size === "Jam") return size;
  const chips = chipAmountFromSize(size);
  return (chips !== null && chips >= eff) ? "Jam" : size;
}
/* Both players allin? True once someone jammed and a distinct actor called (or
   re-jammed). Once true, no further action is possible — the pop-up should
   close so Phil can enter the villain's hand instead of chasing card streets. */
function bothAllin(actions) {
  const jammers = new Set();
  for (const a of actions) {
    const isJam = a.act === "jam" || a.size === "Jam";
    if (isJam) {
      if (jammers.size && !jammers.has(a.actor)) return true;   // 2 different jammers = both allin
      jammers.add(a.actor);
      continue;
    }
    if (jammers.size && !jammers.has(a.actor) && a.act === "call") return true;
  }
  return false;
}

function handActionClick(b) {
  if (b.dataset.street) {
    mutate(() => {
      draft.street = b.dataset.street;
      const f = firstToAct(draft.street);
      if (f) draft.actor = f;
    });
    return true;
  }
  if (b.dataset.actor) {
    mutate(() => {
      draft.actor = b.dataset.actor;
      if (b.dataset.actor.startsWith("v")) draft.lastV = b.dataset.actor;
      if (draft.mode === "table") draft.focusPos = draftActorPos(b.dataset.actor) || null;
    });
    return true;
  }
  if (b.dataset.act) {
    const actor = currentActor();
    if (!actor) { toast("Tap a seated player first"); return true; }
    let openBoard = null;
    mutate(() => {
      if (draft.mode !== "table" && actor.startsWith("v")) { ensureVillainSlot(); draft.lastV = actor; }
      draft.actions.push({ street: draft.street, actor, act: b.dataset.act, size: null });
      if (draft.mode === "table") draft.focusPos = null;   // next tap follows table order (currentActor)
      if (streetClosed(draft.street) && draft.street !== "river") {
        const next = STREETS[STREETS.indexOf(draft.street) + 1];
        draft.street = next;
        draft.actor = firstToAct(next) || draft.actor;
        openBoard = next;
      } else if (draft.mode !== "table") {
        draft.actor = nextActorByPos(actor) || nextActorChips(actor);
      }
    });
    if (bothAllin(draft.actions)) {
      hideSheet();
      toast("Both allin — add hole cards to complete the hand");
      return true;
    }
    // Global end-hand rules: one live player remaining (everyone else folded),
    // or river checked/called through with betting closed.
    if (draftParticipants().length >= 2 && liveActors().length < 2) {   // one villain, Hero out: nobody left to fold to
      hideSheet();
      toast("Hand over — one player remaining");
      return true;
    }
    if (draft.street === "river" && streetClosed("river")) {
      hideSheet();
      toast("Hand over — showdown");
      return true;
    }
    if (openBoard && groupSlots(openBoard).some((s) => !s.arr[s.i])) {
      const miss = positionsMissing();
      if (miss.length) toast("Set positions first: " + miss.join(", "));
      else openGroupSheet(openBoard);
    }
    return true;
  }
  if (b.dataset.size) {
    mutate(() => {
      const last = draft.actions[draft.actions.length - 1];
      if (last) last.size = clampSizeToJam(b.dataset.size);
    });
    if (b.dataset.bbsize) recordOpenSize(Number(draft.ante) || 0, Number(b.dataset.bbsize));
    if (bothAllin(draft.actions)) { hideSheet(); toast("Both allin — add hole cards to complete the hand"); }
    return true;
  }
  return false;
}

/* --- hand-entry interactions (delegated, bound once) --- */

function bindHandEntry() {
  $("view-hand").addEventListener("click", (e) => {
    const b = e.target.closest("button, input");
    if (!b) return;

    if (b.dataset.mode) {
      mutate(() => { draft.mode = b.dataset.mode; if (draft.mode === "table") seedTableFromLineup(); });
    } else if (b.dataset.seat) {                 // table: BTN assign or focus a seat
      const pos = b.dataset.seat;
      mutate(() => {
        if (draft.assignBtn) { assignBtnTo(pos); return; }
        draft.focusPos = draft.focusPos === pos ? null : pos;
      });
    } else if (b.dataset.btnmove) {
      mutate(() => moveBtn(b.dataset.btnmove));
    } else if (b.dataset.btnassign !== undefined) {
      mutate(() => { draft.assignBtn = !draft.assignBtn; if (draft.assignBtn) draft.focusPos = null; });
    } else if (b.dataset.adjustall !== undefined) {
      const cur = draft.effStack || "";
      const raw = prompt("Set all stacks to (chips):", cur);
      if (raw != null && raw.trim() !== "") {
        mutate(() => { draft.effStack = raw.trim(); });
      }
    } else if (b.dataset.blindsedit !== undefined) {
      const a = $("he-ante"); if (a) { a.focus(); a.select(); }
    } else if (b.dataset.seatcard !== undefined) {
      openGroupSheet(b.dataset.cardgroup, Number(b.dataset.seatcard));
    } else if (b.dataset.seatchange !== undefined) {
      // clear the seat so the assignment chips re-appear for reassignment
      mutate(() => {
        const pos = draft.focusPos;
        if (draft.heroPos === pos) draft.heroPos = null;
        draft.villains.forEach((v) => { if (v.pos === pos) v.pos = null; });
      });
    } else if (b.dataset.assignHero !== undefined) {
      mutate(() => {
        const pos = draft.focusPos;
        draft.villains.forEach((v) => { if (v.pos === pos) v.pos = null; }); // bump villain off
        draft.heroPos = pos;
      });
    } else if (b.dataset.assignOpp !== undefined) {
      mutate(() => {
        const pos = draft.focusPos, id = b.dataset.assignOpp;
        if (draft.heroPos === pos) draft.heroPos = null;
        draft.villains.forEach((v) => { if (v.pos === pos) v.pos = null; }); // clear the seat
        let v = draft.villains.find((x) => x.opponentId === id);
        if (v) v.pos = pos;                                                  // move existing
        else draft.villains.push({ opponentId: id, pos, cards: [null, null] });
      });
    } else if (b.dataset.seatclear !== undefined) {
      mutate(() => {
        const pos = draft.focusPos;
        if (draft.heroPos === pos) draft.heroPos = null;
        draft.villains.forEach((v) => { if (v.pos === pos) v.pos = null; });
      });
    } else if (b.dataset.heroin !== undefined) { // toggle Hero in/out of the hand
      mutate(() => {
        draft.heroIn = !draft.heroIn;
        if (!draft.heroIn) {                      // pull Hero out cleanly
          draft.heroPos = null;
          draft.heroCards = [null, null];
          draft.actions = draft.actions.filter((a) => a.actor !== "hero");
          if (draft.actor === "hero") draft.actor = draft.villains.length ? "v0" : null;
        }
      });
    } else if (b.dataset.vopp !== undefined) {   // toggle villain selection
      mutate(() => {
        const i = draft.villains.findIndex((v) => v.opponentId === b.dataset.vopp);
        if (i >= 0) removeVillain(i);
        else {
          draft.villains.push({ opponentId: b.dataset.vopp, pos: null, cards: [null, null] });
          autoDeriveLineup();   // if a seat is already anchored, fill this villain in
        }
      });
    } else if (b.dataset.addanon !== undefined) {  // add anonymous villain (no opponent id)
      mutate(() => {
        draft.villains.push({ opponentId: null, pos: null, cards: [null, null] });
      });
    } else if (b.dataset.hpos) {
      mutate(() => {
        const p = b.dataset.hpos;
        if (draft.heroPos === p) { draft.heroPos = null; return; }
        draft.villains.forEach((x) => { if (x.pos === p) x.pos = null; });   // seat is unique
        draft.heroPos = p;
        deriveLineup("hero");                                                // anchor → others follow
        if (!draft.actions.length) draft.actor = firstToAct(draft.street) || draft.actor;
      });
    } else if (b.dataset.vpos) {
      const i = Number(b.dataset.vposi);
      mutate(() => {
        const v = draft.villains[i];
        if (!v) return;
        const p = b.dataset.vpos;
        if (v.pos === p) { v.pos = null; return; }
        draft.villains.forEach((x, j) => { if (j !== i && x.pos === p) x.pos = null; });
        if (draft.heroPos === p) draft.heroPos = null;                       // seat is unique
        v.pos = p;
        deriveLineup("v" + i);                                               // anchor → others follow
        if (!draft.actions.length) draft.actor = firstToAct(draft.street) || draft.actor;
      });
    } else if (handActionClick(b)) {
      // street / actor / act / size — shared with the action sheet
    } else if (b.dataset.squidpick) {
      openSquidPicker(b.dataset.squidpick);
    } else if (b.dataset.vsquid !== undefined) {
      // Cycle this villain's squid count: – → 0 → 1 → 2 → 3 → –
      const i = Number(b.dataset.vsquid);
      mutate(() => {
        const v = draft.villains[i]; if (!v) return;
        const cur = v.squid;
        v.squid = cur == null ? 0 : (cur >= 3 ? null : cur + 1);
      });
    } else if (b.dataset.slot) {
      const g = groupForSlot(b.dataset.slot);
      if (["flop", "turn", "river"].includes(g)) {
        const miss = positionsMissing();
        if (miss.length) { toast("Set positions first: " + miss.join(", ")); return; }
      }
      openGroupSheet(g);
    }
  });

  $("view-hand").addEventListener("change", (e) => {
    if (e.target.dataset?.sizenum !== undefined) {
      const v = e.target.value.trim();
      if (v) {
        const last = draft.actions[draft.actions.length - 1];
        // a custom open-raise chip amount feeds the adaptive BB buttons
        if (isOpenRaise(last) && Number(draft.ante) > 0)
          recordOpenSize(Number(draft.ante), Math.round(Number(v) / Number(draft.ante)));
        mutate(() => { if (last) last.size = clampSizeToJam("$" + v); });
        if (bothAllin(draft.actions)) { hideSheet(); toast("Both allin — add hole cards to complete the hand"); }
      }
    }
  });

  $("he-undo").onclick = undo;
  $("he-lineup-btn").onclick = openLineupSheet;
  $("he-openact").onclick = openActionSheet;
  $("he-notehint-clear").onclick = () => { mutate(() => { draft.note = ""; }); };
  // Custom size input lives inside the action sheet; catch its change there too.
  $("sheet").addEventListener("change", (e) => {
    if (e.target.dataset?.sizenum !== undefined) {
      const v = e.target.value.trim();
      if (v) {
        const last = draft.actions[draft.actions.length - 1];
        if (isOpenRaise(last) && Number(draft.ante) > 0)
          recordOpenSize(Number(draft.ante), Math.round(Number(v) / Number(draft.ante)));
        mutate(() => { if (last) last.size = clampSizeToJam("$" + v); });
        if (bothAllin(draft.actions)) { hideSheet(); toast("Both allin — add hole cards to complete the hand"); }
      }
    }
    if (sheetGroup === "__handimport__" && pendingImport) {
      const row = e.target.closest("[data-hi]");
      if (row) {
        const i = Number(row.dataset.hi);
        if (e.target.dataset.hicreate !== undefined) {
          pendingImport.map[i].create = e.target.checked;
          if (e.target.checked) pendingImport.map[i].matchId = null;
          renderHandImportSheet();
        } else if (e.target.dataset.hisel !== undefined) {
          pendingImport.map[i].matchId = e.target.value || null;
          pendingImport.map[i].create = !e.target.value;
        }
      }
    }
  });
  const persistDraft = () => metaSet("draftHand", JSON.parse(JSON.stringify(draft)));
  $("he-vsearch").oninput = () => { vSearch = $("he-vsearch").value; renderHandEntry(); };
  $("he-effstack").oninput = () => {
    draft.effStack = $("he-effstack").value;
    persistDraft();
    if (sheetGroup === "__act__") renderActionPad();   // Jam / bb-size chips track the stack live
  };
  // Reclamp sized bets that exceed the stack to "Jam" only once typing is
  // done: per keystroke, a half-typed "3" (of 300) turned every earlier bet
  // into Jam for good, outside the undo stack.
  $("he-effstack").onchange = () => {
    if (!draft.actions.some((a) => a.size && clampSizeToJam(a.size) !== a.size)) return;
    mutate(() => draft.actions.forEach((a) => { if (a.size) a.size = clampSizeToJam(a.size); }));
  };
  $("he-ante").oninput = () => setBlind("ante", $("he-ante").value);
  $("he-save").onclick = () => saveHand();
}

/* --- card picker sheet --- */

function usedCards() {
  return new Set([...draft.board, ...draft.heroCards,
    ...draft.villains.flatMap((v) => v.cards || [])].filter(Boolean));
}

/* A card "group" is a set of slots entered together: the flop (3),
   the turn (1), the river (1), or a person's two hole cards. */
function groupForSlot(key) {
  const [zone, iS] = key.split(":");
  if (zone === "board") { const i = Number(iS); return i <= 2 ? "flop" : i === 3 ? "turn" : "river"; }
  return zone;                                   // "hero" | "v0" | "v1" ...
}
function groupSlots(g) {                          // -> [{ arr, i }] in fill order
  if (g === "flop")  return [0, 1, 2].map((i) => ({ arr: draft.board, i }));
  if (g === "turn")  return [{ arr: draft.board, i: 3 }];
  if (g === "river") return [{ arr: draft.board, i: 4 }];
  if (g === "hero")  return [0, 1].map((i) => ({ arr: draft.heroCards, i }));
  const vi = Number(g.slice(1));
  const arr = (draft.villains[vi] || {}).cards;
  return arr ? [0, 1].map((i) => ({ arr, i })) : [];
}
function groupTitle(g) {
  if (g === "flop") return "Flop"; if (g === "turn") return "Turn"; if (g === "river") return "River";
  if (g === "hero") return "Hero cards";
  const nm = oppById(draft.villains[Number(g.slice(1))]?.opponentId)?.name;
  return (nm || "Villain") + " cards";
}
let sheetGroup = null, sheetActive = 0;

function openGroupSheet(g, active) {
  const slots = groupSlots(g);
  if (!slots.length) return;
  sheetGroup = g;
  if (active == null) {                          // default to first empty slot
    const fe = slots.findIndex((s) => !s.arr[s.i]);
    active = fe >= 0 ? fe : 0;
  }
  sheetActive = active;
  const used = usedCards();
  const cur = slots[sheetActive].arr[slots[sheetActive].i];
  const preview = slots.length > 1 ? `<div class="gcslots">` + slots.map((s, idx) => {
    const c = s.arr[s.i];
    return `<button class="gcslot${c ? " filled" : ""}${idx === sheetActive ? " active" : ""}" data-gslot="${idx}">`
      + (c ? cardHTML(c) : `<span class="lbl">?</span>`) + `</button>`;
  }).join("") + `</div>` : "";
  let grid = "";
  for (const s of SUITS) {
    grid += RANKS.split("").map((r) => {
      const c = r + s.id;
      const dis = used.has(c) && c !== cur;
      return `<button class="${s.cls}${c === cur ? " picked" : ""}" data-card="${c}" ${dis ? "disabled" : ""}>${r}${s.sym}</button>`;
    }).join("");
  }
  showSheet(`<div class="sheethead"><span class="t">${groupTitle(g)}</span>
    <button data-clearcard>Clear</button><button data-closesheet>Done</button></div>
    ${preview}<div class="cardgrid">${grid}</div>`);
}

function sheetClick(e) {
  if (sheetGroup === "__handimport__") {
    if (e.target.closest("[data-hisave]")) { commitHandImport(); return; }
  }
  if (sheetGroup === "__bulkimport__") {
    if (e.target.closest("[data-bulksave]")) { commitBulkImport(); return; }
  }
  if (sheetGroup === "__ptype__") {
    const b = e.target.closest("[data-ptype-set]");
    if (b) {
      const o = oppById(b.dataset.ptypeOpp); if (!o) return;
      const t = b.dataset.ptypeSet;
      o.type = t || null;
      if (!o.type) delete o.type;
      o.updatedAt = Date.now();
      dbPut("opponents", o).then(() => { hideSheet(); renderOpponents(); renderTableTab(); });
      return;
    }
  }
  if (sheetGroup === "__rgcell__") {
    const r = e.target.closest("[data-hand]");
    if (r) {
      if (proofReel && proofReel.ids.includes(r.dataset.hand))
        handPlay = { oppId: proofReel.oppId, ids: proofReel.ids.slice(), label: proofReel.label };
      hideSheet(); location.hash = "#handview/" + r.dataset.hand; return;
    }
  }
  if (sheetGroup === "__notereview__") {
    const nb = e.target.closest("[data-nrconvert]");
    if (nb && curOppId) {
      const noteId = nb.dataset.noteid;
      const o = oppById(curOppId);
      const n = (o?.notes || []).find((x) => x.id === noteId);
      if (n) {
        draft = parseNoteToDraft(n.text, curOppId);
        autoDeriveLineup();
        metaSet("draftHand", JSON.parse(JSON.stringify(draft)));
        hideSheet();
        location.hash = "#hand";
      }
      return;
    }
  }
  const b = e.target.closest("button");
  if (!b || sheetGroup == null) return;
  if (b.dataset.closesheet !== undefined) { hideSheet(); return; }

  if (sheetGroup === "__act__") {
    // street/actor/act/size buttons are inside the sheet, outside #view-hand,
    // so route them through the shared hand-button dispatcher.
    if (handActionClick(b)) return;
    return;
  }

  if (sheetGroup === "__seat__") {
    if (b.dataset.assignHero !== undefined) {
      mutate(() => {
        const pos = draft.focusPos;
        draft.villains.forEach((v) => { if (v.pos === pos) v.pos = null; });
        draft.heroPos = pos;
        draft.heroIn = true;
      });
      renderSeatSheet(draft.focusPos);
      return;
    }
    if (b.dataset.assignOpp !== undefined) {
      mutate(() => {
        const pos = draft.focusPos, id = b.dataset.assignOpp;
        if (draft.heroPos === pos) draft.heroPos = null;
        draft.villains.forEach((v) => { if (v.pos === pos) v.pos = null; });
        let v = draft.villains.find((x) => x.opponentId === id);
        if (v) v.pos = pos;
        else draft.villains.push({ opponentId: id, pos, cards: [null, null] });
      });
      renderSeatSheet(draft.focusPos);
      return;
    }
    if (b.dataset.seatchange !== undefined) {
      mutate(() => {
        const pos = draft.focusPos;
        if (draft.heroPos === pos) draft.heroPos = null;
        draft.villains.forEach((v) => { if (v.pos === pos) v.pos = null; });
      });
      renderSeatSheet(draft.focusPos);
      return;
    }
    if (b.dataset.seatclear !== undefined) {
      mutate(() => {
        const pos = draft.focusPos;
        if (draft.heroPos === pos) draft.heroPos = null;
        draft.villains.forEach((v) => { if (v.pos === pos) v.pos = null; });
        draft.focusPos = null;
      });
      hideSheet();
      return;
    }
    if (b.dataset.seatcard !== undefined) {
      openGroupSheet(b.dataset.cardgroup, Number(b.dataset.seatcard));
      return;
    }
    return;
  }

  if (b.dataset.gslot !== undefined) {           // pick which slot in the group to fill
    openGroupSheet(sheetGroup, Number(b.dataset.gslot));
  } else if (b.dataset.card) {
    const emptyBefore = groupSlots(sheetGroup).filter((s) => !s.arr[s.i]).length;
    mutate(() => {
      const s = groupSlots(sheetGroup)[sheetActive];
      s.arr[s.i] = b.dataset.card;
      if (sheetGroup === "flop" || sheetGroup === "turn" || sheetGroup === "river")
        advanceStreetFromBoard();
    });
    const slots = groupSlots(sheetGroup);
    const nextEmpty = slots.findIndex((s) => !s.arr[s.i]);
    if (nextEmpty >= 0) openGroupSheet(sheetGroup, nextEmpty);      // keep going within the group
    else if (emptyBefore === 0) openGroupSheet(sheetGroup, sheetActive); // replaced in a full group — stay
    else if (sheetGroup === "flop" || sheetGroup === "turn" || sheetGroup === "river")
      openActionSheet();                                           // chain into action pad on the new street
    else hideSheet();                                              // just completed the group
  } else if (b.dataset.clearcard !== undefined) {
    mutate(() => { const s = groupSlots(sheetGroup)[sheetActive]; s.arr[s.i] = null; });
    openGroupSheet(sheetGroup, sheetActive);
  }
}

function advanceStreetFromBoard() {
  const b = draft.board;
  let target = null;
  if (b[4]) target = "river";
  else if (b[3]) target = "turn";
  else if (b[0] && b[1] && b[2]) target = "flop";
  if (target && STREETS.indexOf(target) > STREETS.indexOf(draft.street)) {
    draft.street = target;
    const f = firstToAct(target);
    if (f) draft.actor = f;
  }
}

/* --- save --- */

function draftHasContent(d) {
  return d.villains.some((v) => v.opponentId) || d.actions.length || d.note.trim() ||
    d.board.some(Boolean) || d.heroCards.some(Boolean);
}

async function saveHand() {
  const d = draft;
  if (!draftHasContent(d)) { toast("Nothing to save"); return; }
  const hIn = heroPresent(d);
  const rec = {
    id: d.id || uid(), ts: d.ts || Date.now(), updatedAt: Date.now(),
    hero: hIn,
    heroPos: hIn ? d.heroPos : null,
    heroCards: hIn && d.heroCards.some(Boolean) ? d.heroCards : null,
    villains: d.villains.map((v) => ({ opponentId: v.opponentId, pos: v.pos || null,
      cards: (v.cards || []).some(Boolean) ? v.cards : null,
      squid: v.squid == null ? null : Number(v.squid) })),
    villainIds: d.villains.map((v) => v.opponentId).filter(Boolean),
    board: d.board, actions: d.actions,
    effStack: d.effStack ? Number(d.effStack) : null,
    blinds: d.ante ? { ante: Number(d.ante) } : null,
    seats: effectiveSeats(),
    squid: (d.squidHave || d.squidLeft)
      ? { have: d.squidHave ? Number(d.squidHave) : null, left: d.squidLeft ? Number(d.squidLeft) : null }
      : null,
    note: d.note.trim(),
  };
  fixCallOffs(rec);
  const win = handWinner(rec);                 // result is inferred, never entered
  rec.showdown = !!win && win.how === "showdown";
  rec.result = hIn ? heroResult(rec) : null;
  await dbPut("hands", rec);
  const i = HANDS.findIndex((h) => h.id === rec.id);
  if (i >= 0) HANDS[i] = rec; else HANDS.push(rec); _statsCache = null;

  undoStack = [];
  const primary = oppById(rec.villainIds[0]);
  // stash the pre-save draft so an accidental Save can be undone with one tap
  lastSaveUndo = { draft: JSON.parse(JSON.stringify(d)), handId: rec.id, ts: Date.now() };
  draft = newDraft();
  vSearch = "";
  await metaSet("draftHand", null);
  showSaveToast(primary ? `Saved vs ${primary.name} · tap to undo` : "Hand saved · tap to undo");
  renderHandEntry();
}

/* Fire a one-tap backup prompt if the last export is >24h old. Only once per app
   session per day so a rush of saves doesn't spam. */
let _backupNaggedAt = 0;
async function maybeNagBackup() {
  const now = Date.now();
  if (now - _backupNaggedAt < 3600e3) return;                 // hourly re-nag cap
  const t0 = $("toast");
  if (t0.onclick && !t0.classList.contains("hidden")) return; // don't stomp a live save-undo / SW-update toast — retry next route
  const ts = await metaGet("lastExportAt");
  if (ts && now - ts < 864e5) return;                         // backed up <24h ago
  _backupNaggedAt = now;
  const t = $("toast");
  const msg = ts ? "Back up? Last file save >24h ago." : "Back up? No file save yet — data lives only on this phone.";
  t.textContent = msg + " · tap";
  t.classList.add("wide");
  t.classList.remove("hidden");
  t.style.cursor = "pointer";
  clearTimeout(toast._t);
  const clear = () => {
    t.classList.add("hidden"); t.style.cursor = ""; t.onclick = null;
    t.classList.remove("wide");
  };
  toast._t = setTimeout(clear, 6000);
  t.onclick = async () => {
    clear();
    try {
      const snap = await metaGet("autoSnapshot");
      if (snap?.data ? await shareBackupData(snap.data) : await exportJSON())
        toast("Backed up ✓");
    } catch (e) { if (e?.name !== "AbortError") toast("Backup failed: " + e.message); }
  };
}
/* One-tap undo after Save: within 12s of a save, tapping the toast restores
   the pre-save draft and deletes the just-saved hand. */
let lastSaveUndo = null;
function showSaveToast(msg) {
  const t = $("toast");
  // Explicit Undo button — the whole toast is still tappable, but a visible
  // button makes the affordance obvious.
  t.innerHTML = `<span class="toastmsg">${esc(msg.replace(" · tap to undo", ""))}</span><button class="toastbtn" data-undo>Undo</button>`;
  t.classList.add("wide");
  t.classList.remove("hidden");
  t.style.cursor = "pointer";
  const start = Date.now();
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.classList.add("hidden"); t.style.cursor = ""; t.classList.remove("wide"); t.textContent = ""; }, 12000);
  const doUndo = async () => {
    if (!lastSaveUndo || Date.now() - lastSaveUndo.ts > 15000 || Date.now() - start > 12000) return;
    const { draft: prev, handId } = lastSaveUndo;
    lastSaveUndo = null;
    await dbDel("hands", handId);
    HANDS = HANDS.filter((h) => h.id !== handId); _statsCache = null;
    draft = prev;
    t.classList.add("hidden"); t.style.cursor = ""; t.onclick = null; t.classList.remove("wide"); t.textContent = "";
    await metaSet("draftHand", JSON.parse(JSON.stringify(draft)));
    renderHandEntry();
    toast("Restored");
  };
  t.onclick = doUndo;
}

/* --- edit an existing hand: load into draft --- */

function loadHandIntoDraft(h) {
  const streets = (h.actions || []).map((a) => STREETS.indexOf(a.street));
  draft = {
    id: h.id, ts: h.ts,
    villains: (h.villains || []).map((v) => ({ opponentId: v.opponentId, pos: v.pos,
      cards: v.cards ? [...v.cards] : [null, null],
      squid: v.squid == null ? null : Number(v.squid) })),
    heroPos: h.heroPos || null,
    heroCards: h.heroCards ? [...h.heroCards] : [null, null],
    heroIn: h.hero !== undefined ? h.hero : true,
    mode: "chips", focusPos: null,
    board: [...(h.board || [])].concat([null, null, null, null, null]).slice(0, 5),
    actions: (h.actions || []).map((a) => ({ ...a })),
    street: STREETS[Math.max(0, ...streets)] || "pre",
    actor: null, lastV: "v0",
    note: h.note || "",
    effStack: h.effStack != null ? String(h.effStack) : "",
    ante: h.blinds?.ante != null ? String(h.blinds.ante) : "",
    squidHave: h.squid?.have != null ? String(h.squid.have) : "",
    squidLeft: h.squid?.left != null ? String(h.squid.left) : "",
  };
  undoStack = [];
}

/* ================= static bindings + boot ================= */

function bindStatic() {
  document.querySelectorAll("#tabbar button").forEach((b) =>
    b.onclick = () => { location.hash = "#" + b.dataset.tab; });
  // ‹ is an up-button, not a history button: from a player it always reaches the
  // list, however he got here — a hand, a reload, a link.
  document.querySelectorAll("[data-back]").forEach((b) =>
    b.onclick = () => navUp("#opponents"));
  $("hv-back").onclick = hvBack;

  // opponents list
  $("opp-search").oninput = renderOpponents;
  $("opp-edit").onclick = () => { oppEditMode = !oppEditMode; renderOpponents(); };
  $("opp-add").onclick = () => { $("opp-new").classList.toggle("hidden"); $("opp-new-name").focus(); };
  $("opp-new-save").onclick = async () => {
    const name = $("opp-new-name").value.trim();
    if (!name) return;
    const o = await createOpponent(name, $("opp-new-group").value.trim());
    $("opp-new-name").value = ""; $("opp-new-group").value = "";
    $("opp-new").classList.add("hidden");
    location.hash = "#opp/" + o.id;
  };
  $("opp-list").onclick = (e) => {
    if (e.target.closest(".draghandle")) return;                    // drag, not navigate
    const ptype = e.target.closest("[data-ptype-open]");
    if (ptype) { e.stopPropagation(); openPlayerTypeSheet(ptype.dataset.ptypeOpen); return; }
    const card = e.target.closest(".excard");
    if (card) { toast(card.getAttribute("title") || card.textContent); return; }   // full text, no nav
    const gc = e.target.closest("[data-groupcollapse]");
    if (gc) { toggleGroupCollapse(gc.dataset.groupcollapse); return; }
    const gpin = e.target.closest("[data-grouppin]");
    if (gpin) {
      const g = gpin.dataset.grouppin;
      pinnedGroup = pinnedGroup === g ? null : g;
      metaSet("pinnedGroup", pinnedGroup);
      renderOpponents();
      return;
    }
    const groupadd = e.target.closest("[data-groupadd]");
    if (groupadd) { openGroupAddSheet(groupadd.dataset.groupadd); return; }
    const mv = e.target.closest("[data-move]");
    if (mv) { openMoveSheet(mv.dataset.move); return; }
    const r = e.target.closest("[data-opp]");
    if (r && !oppEditMode) location.hash = "#opp/" + r.dataset.opp;
  };

  // Table tab — same lineup as hand entry's Lineup sheet
  $("tbl-edit").onclick = openLineupSheet;
  $("tbl-list").onclick = (e) => {
    const ptype = e.target.closest("[data-ptype-open]");
    if (ptype) { e.stopPropagation(); openPlayerTypeSheet(ptype.dataset.ptypeOpen); return; }
    const card = e.target.closest(".excard");
    if (card) { toast(card.getAttribute("title") || card.textContent); return; }
    const r = e.target.closest("[data-opp]");
    if (r) location.hash = "#opp/" + r.dataset.opp;
  };

  // opponent detail
  $("od-edit").onclick = () => {
    const f = $("od-editform");
    f.classList.toggle("hidden");
    if (!f.classList.contains("hidden")) { f.scrollIntoView({ block: "center", behavior: "smooth" }); $("od-e-group").focus({ preventScroll: true }); }
  };
  $("od-card-edit").onclick = openCardSheet;
  $("od-handfilters").onclick = (e) => {
    const c = e.target.closest("[data-hf]"); if (!c) return;
    const dim = c.dataset.hf, v = c.dataset.hfv;
    if (dim === "sd") handFilters.sd = !handFilters.sd;
    else { const s = handFilters[dim]; if (s.has(v)) s.delete(v); else s.add(v); }
    if (curOppId) renderOppDetail(curOppId);
  };
  bindRangeGrid();
  /* Debounced: re-rendering the whole detail on every keystroke is wasted work.
     The box itself is static markup, so focus survives the re-render. */
  let hqT = 0;
  $("od-hfind").oninput = () => {
    clearTimeout(hqT);
    hqT = setTimeout(() => {
      const q = hqParse($("od-hfind").value);
      handFilters.q = q.text ? q : null;
      $("od-hfind-read").innerHTML = hqReadHTML(q);
      if (curOppId) renderOppDetail(curOppId);
    }, 220);
  };
  $("od-hfind-help").onclick = () => $("od-hfind-words").classList.toggle("hidden");
  $("od-hf-clear").onclick = () => { resetHandFilters(); if (curOppId) renderOppDetail(curOppId); };
  $("od-exploit-tmpl").onclick = openTemplateSheet;
  $("od-e-save").onclick = async () => {
    const o = oppById(curOppId);
    o.name = $("od-e-name").value.trim() || o.name;
    o.group = $("od-e-group").value.trim();
    o.physical = $("od-e-physical").value.trim();
    o.updatedAt = Date.now();
    await dbPut("opponents", o);
    renderOppDetail(curOppId);
  };
  $("od-e-del").onclick = async () => {
    const o = oppById(curOppId);
    if (!confirm(`Delete ${o.name}? Their hands stay but lose the name.`)) return;
    await dbDel("opponents", o.id);
    OPP = OPP.filter((x) => x.id !== o.id);
    location.hash = "#opponents";
  };
  $("od-e-merge").onclick = () => {
    const cur = oppById(curOppId);
    const others = OPP.filter((o) => o.id !== curOppId).sort((a, b) => a.name.localeCompare(b.name));
    if (!others.length) { toast("No other opponent to merge into."); return; }
    const handCount = (id) => HANDS.filter((h) => (h.villainIds || []).includes(id)).length;
    sheetGroup = null; // not a card sheet
    showSheet(`<div class="sheethead"><span class="t">Merge ${esc(cur.name)} into…</span>
        <button data-sheetclose>Close</button></div>
      <div class="sheetnote">Pick the profile to keep — ${esc(cur.name)}'s hands, reads, notes &amp; exploits move there, then ${esc(cur.name)} is deleted.</div>
      <div class="mergelist">${others.map((o) =>
        `<button class="mergeitem" data-mergeinto="${o.id}"><span class="mnm">${esc(o.name)}</span>` +
        `<span class="msub muted">${[esc(o.group), handCount(o.id) + "h"].filter(Boolean).join(" · ")}</span></button>`).join("")}</div>`);
  };
  $("sheet").addEventListener("click", async (e) => {
    if (e.target.closest("[data-sheetclose]")) { hideSheet(); return; }
    const b = e.target.closest("[data-mergeinto]");
    if (!b) return;
    const intoId = b.dataset.mergeinto, from = oppById(curOppId), into = oppById(intoId);
    if (!from || !into) return;
    if (!confirm(`Merge "${from.name}" into "${into.name}"?\n\n${from.name}'s hands, reads, notes and exploits move to ${into.name}, then "${from.name}" is deleted.`)) return;
    hideSheet();
    await mergeOpponents(curOppId, intoId);
    toast(`Merged into ${into.name}`);
    location.hash = "#opp/" + intoId;
    renderOppDetail(intoId);
  });
  $("od-ptype").onclick = async (e) => {
    const b = e.target.closest("[data-ptype]");
    if (!b) return;
    const o = oppById(curOppId); if (!o) return;
    const t = b.dataset.ptype;
    o.type = t || null;
    if (!o.type) delete o.type;
    o.updatedAt = Date.now();
    await dbPut("opponents", o);
    renderOppDetail(curOppId);
  };
  $("od-tags").onclick = async (e) => {
    const sk = e.target.closest("[data-stk]");
    if (sk) { openStatSheet(sk); return; }
    const clr = e.target.closest("[data-scaleclear]");
    if (clr) {
      const o = oppById(curOppId);
      const id = clr.dataset.scaleclear;
      delete oppReads(o)[id];
      o.updatedAt = Date.now();
      await dbPut("opponents", o);
      renderOppDetail(curOppId);
      return;
    }
    const tclr = e.target.closest("[data-tallyclear]");
    if (tclr) {
      const o = oppById(curOppId);
      const id = tclr.dataset.tallyclear;
      delete oppReads(o)[id];
      o.updatedAt = Date.now();
      await dbPut("opponents", o);
      renderOppDetail(curOppId);
      return;
    }
    const tl = e.target.closest("[data-tally]");
    if (tl) {
      const o = oppById(curOppId);
      const reads = oppReads(o);
      const id = tl.dataset.tally, v = tl.dataset.val;
      const counts = reads[id] && typeof reads[id] === "object" ? reads[id] : (reads[id] = {});
      counts[v] = (counts[v] || 0) + 1;
      o.updatedAt = Date.now();
      await dbPut("opponents", o);
      renderOppDetail(curOppId);
      return;
    }
    const ch = e.target.closest("[data-choice]");
    if (ch) {
      const o = oppById(curOppId);
      const reads = oppReads(o);
      const id = ch.dataset.choice, v = ch.dataset.val;
      if (reads[id] === v) delete reads[id]; else reads[id] = v;   // same option again = clear
      o.updatedAt = Date.now();
      await dbPut("opponents", o);
      renderOppDetail(curOppId);
      return;
    }
    const b = e.target.closest("[data-tag]");
    if (!b) return;
    const o = oppById(curOppId);
    const reads = oppReads(o);
    const id = b.dataset.tag;
    const ns = nextReadState(id, reads[id]);
    if (ns) reads[id] = ns;
    else delete reads[id];
    o.updatedAt = Date.now();
    await dbPut("opponents", o);
    renderOppDetail(curOppId);
  };
  $("od-tags").addEventListener("change", async (e) => {
    const ps = e.target.closest("[data-posselect]");
    if (!ps) return;
    const o = oppById(curOppId);
    const id = ps.dataset.posselect;
    const v = ps.value;
    if (v) oppReads(o)[id] = v;
    else delete oppReads(o)[id];
    o.updatedAt = Date.now();
    await dbPut("opponents", o);
    renderOppDetail(curOppId);
  });
  $("od-tags").addEventListener("input", async (e) => {
    const s = e.target.closest("[data-scaleinput]");
    if (!s) return;
    const o = oppById(curOppId);
    const id = s.dataset.scaleinput;
    const v = Math.max(0, Math.min(100, Number(s.value) || 0));
    oppReads(o)[id] = v;
    o.updatedAt = Date.now();
    // Cheap live update: just refresh the visible readout, don't full-rerender on every drag tick.
    const row = s.closest(".scaleread");
    if (row) {
      row.classList.add("on");
      const rd = row.querySelector(".scaleval");
      if (rd) rd.textContent = v + " · " + scaleBucket(v);
    }
    // Short debounce + a "pending" reference so pagehide can flush before Safari suspends us.
    clearTimeout($("od-tags")._scaleT);
    pendingReadWrite = o;
    $("od-tags")._scaleT = setTimeout(() => {
      dbPut("opponents", o);
      if (pendingReadWrite === o) pendingReadWrite = null;
    }, 50);
  });
  // Also save on 'change' — fires when the drag ends, guarantees a write even if
  // the debounce timer hasn't fired yet.
  $("od-tags").addEventListener("change", (e) => {
    const s = e.target.closest("[data-scaleinput]");
    if (!s) return;
    const o = oppById(curOppId);
    clearTimeout($("od-tags")._scaleT);
    dbPut("opponents", o);
    if (pendingReadWrite === o) pendingReadWrite = null;
  });
  $("od-note-add").onclick = async () => {
    const text = $("od-note").value.trim();
    if (!text) return;
    const o = oppById(curOppId);
    const note = { id: uid(), ts: Date.now(), text, handId: null };
    (o.notes = o.notes || []).unshift(note);
    const asHand = isHandHistoryNote(text);
    if (asHand) await noteToHand(note, curOppId);
    o.updatedAt = Date.now();
    await dbPut("opponents", o);
    $("od-note").value = "";
    if (asHand) toast("Saved as a hand", 2500);
    renderOppDetail(curOppId);
  };
  $("od-notes-convert").onclick = async () => {
    const o = oppById(curOppId);
    const allNotes = o.notes || [];
    const unconverted = allNotes.filter((n) => !n.handId);
    if (!allNotes.length) { toast("No notes to convert"); return; }
    if (!unconverted.length) { toast(`All ${allNotes.length} notes already converted`); return; }
    // only hand-shaped notes qualify — pure tendency comments ("Clairvoyance",
    // "Loves to bluff") stay as notes. A note is hand-shaped if the parser
    // extracts a position, hole cards, a board, or an action.
    const candidates = unconverted.map((n) => ({ n, d: parseNoteToDraft(n.text, curOppId) }))
      .filter(({ d }) => d.villains[0].pos || d.villains[0].cards.some(Boolean) || d.board.some(Boolean) || d.actions.length);
    const tendency = unconverted.length - candidates.length;
    if (!candidates.length) {
      toast(`No hand-shaped notes to convert · ${tendency} tendency note${tendency > 1 ? "s" : ""} left alone`, 4200);
      return;
    }
    if (!confirm(`Create ${candidates.length} hand${candidates.length > 1 ? "s" : ""} from your shorthand notes? ${tendency ? tendency + " tendency-only note" + (tendency > 1 ? "s" : "") + " will be left alone." : ""}`)) return;
    for (const { n, d } of candidates) await noteToHand(n, curOppId, d);
    o.updatedAt = Date.now();
    await dbPut("opponents", o);
    toast(`Created ${candidates.length} hand${candidates.length > 1 ? "s" : ""}${tendency ? ` · ${tendency} tendency note${tendency > 1 ? "s" : ""} left alone` : ""}`, 4200);
    renderOppDetail(curOppId);
  };
  $("od-notes").onclick = async (e) => {
    if (e.target.closest("[data-toggle-convnotes]")) {
      showConvertedNotes[curOppId] = !showConvertedNotes[curOppId];
      renderOppDetail(curOppId);
      return;
    }
    const item = e.target.closest("[data-note]");
    if (!item) return;
    const id = item.dataset.note;
    const o = oppById(curOppId);
    if (e.target.closest("[data-notehand]")) {
      const n = (o.notes || []).find((x) => x.id === id);
      if (!n) return;
      // parse as much of the shorthand as we can into a fresh draft
      draft = parseNoteToDraft(n.text, curOppId);
      autoDeriveLineup();                                       // seat via today's lineup if anchored
      await metaSet("draftHand", JSON.parse(JSON.stringify(draft)));
      location.hash = "#hand";
      return;
    }
    if (e.target.closest("[data-notegohand]")) {
      const n = (o.notes || []).find((x) => x.id === id);
      if (n?.handId) { location.hash = "#handview/" + n.handId; return; }
    }
    if (e.target.closest("[data-notereview]")) {
      const n = (o.notes || []).find((x) => x.id === id);
      if (n) openNoteReviewSheet(n, curOppId);
      return;
    }
    if (e.target.closest("[data-notedel]")) {
      if (!confirm("Delete this note?")) return;
      o.notes = (o.notes || []).filter((n) => n.id !== id);
      o.updatedAt = Date.now();
      await dbPut("opponents", o);
      renderOppDetail(curOppId);
    } else if (e.target.closest("[data-noteedit]")) {
      editNoteId = id; renderOppDetail(curOppId);
    } else if (e.target.closest("[data-notecancel]")) {
      editNoteId = null; renderOppDetail(curOppId);
    } else if (e.target.closest("[data-notesave]")) {
      const txt = item.querySelector("textarea").value.trim();
      const n = (o.notes || []).find((x) => x.id === id);
      if (n && txt) { n.text = txt; n.ts = Date.now(); o.updatedAt = Date.now(); await dbPut("opponents", o); }
      editNoteId = null; renderOppDetail(curOppId);
    }
  };
  $("od-exploit-add").onclick = async () => {
    const text = $("od-exploit").value.trim();
    if (!text) return;
    const o = oppById(curOppId);
    (o.exploits = o.exploits || []).unshift({ id: uid(), ts: Date.now(), text });
    o.updatedAt = Date.now();
    await dbPut("opponents", o);
    $("od-exploit").value = "";
    renderOppDetail(curOppId);
  };
  $("od-exploits").onclick = async (e) => {
    const item = e.target.closest("[data-exp]");
    if (!item) return;
    const id = item.dataset.exp;
    const o = oppById(curOppId);
    if (e.target.closest("[data-expadj]")) {
      const n = (o.exploits || []).find((x) => x.id === id);   // villain adjusts to this exploit
      if (n) { n.adj = !n.adj; o.updatedAt = Date.now(); await dbPut("opponents", o); }
      renderOppDetail(curOppId);
    } else if (e.target.closest("[data-exphide]")) {
      const n = (o.exploits || []).find((x) => x.id === id);   // toggle: show/hide on opponent list card
      if (n) { n.hideFront = !n.hideFront; o.updatedAt = Date.now(); await dbPut("opponents", o); }
      renderOppDetail(curOppId);
    } else if (e.target.closest("[data-expconfcycle]")) {
      const n = (o.exploits || []).find((x) => x.id === id);   // cycle 0→1→2→3→4→5→0 confidence
      if (n) { n.conf = (((n.conf ?? 0) + 1) % 6); o.updatedAt = Date.now(); await dbPut("opponents", o); }
      renderOppDetail(curOppId);
    } else if (e.target.closest("[data-expdel]")) {
      if (!confirm("Delete this exploit?")) return;
      o.exploits = (o.exploits || []).filter((n) => n.id !== id);
      o.featured = featuredItems(o).filter((it) => !(it.type === "exploit" && it.id === id));
      o.updatedAt = Date.now();
      await dbPut("opponents", o);
      renderOppDetail(curOppId);
    } else if (e.target.closest("[data-expedit]")) {
      editExploitId = id; renderOppDetail(curOppId);
    } else if (e.target.closest("[data-expcancel]")) {
      editExploitId = null; renderOppDetail(curOppId);
    } else if (e.target.closest("[data-expsave]")) {
      const txt = item.querySelector("textarea").value.trim();
      const n = (o.exploits || []).find((x) => x.id === id);
      if (n && txt) { n.text = txt; o.updatedAt = Date.now(); await dbPut("opponents", o); }
      editExploitId = null; renderOppDetail(curOppId);
    }
  };
  $("od-exsugg").onclick = async (e) => {
    if (e.target.closest("[data-toggle-sugg]")) {
      showSuggestedExploits[curOppId] = !showSuggestedExploits[curOppId];
      renderOppDetail(curOppId);
      return;
    }
    const item = e.target.closest("[data-key]");
    if (!item) return;
    const key = item.dataset.key;
    const o = oppById(curOppId);
    const sugg = suggestedExploits(o).find((s) => s.key === key);
    (o.exploitDismissed = o.exploitDismissed || []).push(key); // hide from suggestions either way
    if (e.target.closest("[data-exacc]") && sugg) {
      (o.exploits = o.exploits || []).unshift({ id: uid(), ts: Date.now(), text: sugg.text, src: key });
    }
    o.updatedAt = Date.now();
    await dbPut("opponents", o);
    renderOppDetail(curOppId);
  };
  $("od-readsugg").onclick = async (e) => {
    const tg = e.target.closest("[data-toggle]");
    if (tg) {
      const k = tg.dataset.toggle;
      const store = k === "dreads" ? showDerivedReads : k === "revid" ? showReadEvid : showExploitSignals;
      store[curOppId] = !store[curOppId];
      renderOppDetail(curOppId);
      return;
    }
    const o = oppById(curOppId);
    if (!o) return;
    const sig = e.target.closest("[data-swhy]");
    if (sig) {
      const s = exploitSignals(oppFacts(o))[Number(sig.dataset.swhy)];
      if (s) openReadProof(`${s.label} · ${o.name}`, s.detail, s.hands,
        s.miss.length ? { ids: s.miss, yes: "Did this", no: "Had the chance, didn't" } : null, o.id);
      return;
    }
    const ev = e.target.closest("[data-ewhy]");
    if (ev) {
      const r = setReadEvidence(o, oppFacts(o)).find((x) => x.tagId === ev.dataset.ewhy);
      if (r) openReadProof(`${r.label} · ${o.name}`,
        `${r.hands.length} of ${r.chances} chance${r.chances === 1 ? "" : "s"}`, r.hands,
        { ids: r.miss, yes: r.yes, no: r.no }, o.id);
      return;
    }
    const item = e.target.closest("[data-dtag]");
    if (!item) return;
    const tag = item.dataset.dtag;
    const state = item.dataset.dstate || "yes";
    const dkey = item.dataset.dkey || tag;                   // per-direction dismiss key
    if (e.target.closest("[data-dwhy]")) {
      const s = derivedReads(o).find((x) => x.key === dkey);
      if (s) openReadProof(`${s.label} · ${o.name}`,
        `${s.count} of ${s.chances} chance${s.chances === 1 ? "" : "s"}`, s.hands,
        { ids: s.miss, yes: s.yes, no: s.no }, o.id);
      return;
    }
    if (e.target.closest("[data-dacc]")) oppReads(o)[tag] = state;            // accept → set the read
    else if (e.target.closest("[data-ddismiss]")) (o.readDismissed = o.readDismissed || []).push(dkey);
    else return;                                   // a tap on the row itself is not a dismissal
    o.updatedAt = Date.now();
    await dbPut("opponents", o);
    renderOppDetail(curOppId);
  };
  $("od-hands").onclick = handListClick;
  $("od-play").onclick = () => {
    if (!handPlayIds.length) return;
    handPlay = { oppId: curOppId, ids: handPlayIds.slice() };
    location.hash = "#handview/" + handPlayIds[0];
  };
  bindStats();
  bindSizing();
  bindSeq();
  bindFolds();

  // hand detail
  $("hv-felt").onclick = (e) => {
    const st = e.target.closest("[data-rst]"), sp = e.target.closest("[data-rstep]"), go = e.target.closest("[data-rgo]");
    const hs = e.target.closest("[data-hvstep]"), jp = e.target.closest("[data-rjump]");
    if (e.target.closest("[data-rplay]")) return replayToggle();
    replayStop();
    if (hs) return hs.disabled ? null : handStep(Number(hs.dataset.hvstep));
    if (jp) return replayGo(Number(jp.dataset.rjump));
    if (sp) return replayGo(replayStep + Number(sp.dataset.rstep));
    if (go) return replayGo(0);
    if (st) {                                                // jump to the first action of that street
      const h = HANDS.find((x) => x.id === curHandId), acts = h?.actions || [];
      const i = acts.findIndex((a) => a.street === st.dataset.rst);
      if (i >= 0) replayGo(i + 1);
    }
  };
  $("hv-nav").onclick = (e) => {
    const b = e.target.closest("[data-hvstep]");
    if (b && !b.disabled) handStep(Number(b.dataset.hvstep));
  };
  $("hv-reads").onclick = () => { splitWant = !splitWant; splitSync(); };
  $("hv-split-close").onclick = () => { splitWant = false; splitSync(); };
  $("hv-split-vill").onclick = (e) => {
    const b = e.target.closest("[data-splitopp]");
    // The felt is anchored on whoever is being read, so switching player moves him
    // down to the bottom seat too. The step is untouched.
    if (b) { splitSync(b.dataset.splitopp); renderReplay(); }
  };
  bindSplitGrab();
  $("hv-pager").onclick = (e) => {
    const b = e.target.closest("[data-hvgo]");
    if (b && b.dataset.hvgo !== curHandId) location.hash = "#handview/" + b.dataset.hvgo;
  };
  $("hv-log").onclick = (e) => {
    const b = e.target.closest("[data-rjump]");
    if (b) { replayStop(); replayGo(Number(b.dataset.rjump)); }
  };
  /* The written hand is still the fastest read of a line you already know,
     so it stays one tap under the history rather than going away. */
  $("hv-textbtn").onclick = () => {
    const on = $("hv-text").classList.toggle("hidden");
    $("hv-textbtn").textContent = on ? "Show the written hand" : "Hide the written hand";
  };
  // Swipe the hand itself (left = next), and arrow keys on a desktop.
  let swX = 0, swY = 0;
  $("view-handview").addEventListener("touchstart", (e) => {
    const t = e.changedTouches[0]; swX = t.clientX; swY = t.clientY;
  }, { passive: true });
  $("view-handview").addEventListener("touchend", (e) => {
    const t = e.changedTouches[0], dx = t.clientX - swX, dy = t.clientY - swY;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 2) handStep(dx < 0 ? 1 : -1);
  }, { passive: true });
  document.addEventListener("keydown", (e) => {
    if ($("view-handview").classList.contains("hidden")) return;
    if (e.key === "Escape" && hvWide() && $("sheet").classList.contains("hidden")) return hvBack();
    if ($("hv-nav").classList.contains("hidden")) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.key === "ArrowLeft") handStep(-1);
    else if (e.key === "ArrowRight") handStep(1);
  });
  $("hv-edit").onclick = () => {
    const h = HANDS.find((x) => x.id === curHandId);
    if (h) { loadHandIntoDraft(h); location.hash = "#hand"; }
  };
  $("hv-delete").onclick = async () => {
    if (!confirm("Delete this hand?")) return;
    await dbDel("hands", curHandId);
    HANDS = HANDS.filter((h) => h.id !== curHandId); _statsCache = null;
    hvBack();
  };

  // data / backup
  $("data-export").onclick = async () => {
    try {
      if (await exportJSON()) { toast("Exported"); renderData(); }
    } catch (e) { toast("Export failed: " + e.message); }
  };
  $("data-autosave").onclick = async () => {
    try {
      const snap = await metaGet("autoSnapshot");
      if (!snap?.data) { toast("No auto-backup yet"); return; }
      await shareBackupData(snap.data);
      toast("Saved auto-backup");
      renderData();
    } catch (e) { if (e?.name !== "AbortError") toast("Save failed: " + e.message); }
  };
  $("data-imports").onclick = async (e) => {
    const btn = e.target.closest("[data-undoimport]");
    if (!btn) return;
    const b = (await importLog()).find((x) => x.id === btn.dataset.undoimport);
    if (!b) return;
    if (!confirm(`Undo "${b.label}"?\n\nHands, opponents and sessions it added are removed, and anything it overwrote goes back to how it was. Records you've edited since the import are kept.`)) return;
    try {
      const r = await undoImport(b.id);
      await refreshCache();
      toast(`Undone · ${r.removed} removed · ${r.restored} restored` + (r.kept ? ` · ${r.kept} kept (edited since)` : "")
        + (r.inUse ? ` · ${r.inUse} opp kept (has other hands)` : ""));
      renderData();
    } catch (err) { toast("Undo failed: " + err.message); }
  };
  $("data-import").onclick = () => $("data-importfile").click();
  $("data-importfile").onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const counts = await importJSON(JSON.parse(await f.text()));
      await refreshCache();
      await fixDxSeats();
      await recordImport(f.name, counts);
      toast(`Imported ${counts.opponents} opp` + (counts.merged ? ` · ${counts.merged} merged` : "") + ` · ${counts.hands} hands` + (counts.nlhe ? ` · rejected ${counts.nlhe} NLHE hand${counts.nlhe === 1 ? "" : "s"}` : ""));
      renderData();
    } catch (err) { toast("Import failed: " + err.message); }
    e.target.value = "";
  };

  // sheets
  $("sheet").addEventListener("click", sheetClick);
  $("sheet-backdrop").onclick = hideSheet;

  bindHandEntry();
}

function handListClick(e) {
  if (e.target.closest("[data-nocards]")) { noCardsOpen = !noCardsOpen; if (curOppId) renderOppDetail(curOppId); return; }
  const r = e.target.closest("[data-hand]");
  if (!r) return;
  // Tapping a row browses the same filtered set the Play button would, so the
  // stepper and the hand list are there without going back first.
  if (handPlayIds.includes(r.dataset.hand)) handPlay = { oppId: curOppId, ids: handPlayIds.slice() };
  location.hash = "#handview/" + r.dataset.hand;
}

async function loadBlindsDefault() {
  const b = await metaGet("defaultBlinds");
  if (b) blindsDefault = { ante: b.ante || "" };
}
/* Blinds are sticky: whatever you type becomes the default for future hands. */
function setBlind(key, val) {
  draft[key] = val;
  blindsDefault[key] = val;
  metaSet("draftHand", JSON.parse(JSON.stringify(draft)));
  metaSet("defaultBlinds", { ...blindsDefault });
}

async function requestDurableStorage() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      storageDurable = await navigator.storage.persisted();
      if (!storageDurable) storageDurable = await navigator.storage.persist();
    }
  } catch (e) { /* storage API unavailable — nothing we can do */ }
}

/* Surface silent JS errors on the phone — cheaper than "why did nothing happen?" */
window.addEventListener("error", (e) => {
  const msg = e.error?.message || e.message || "unknown error";
  try { toast("⚠︎ crash: " + msg, 6000); } catch {}
});
window.addEventListener("unhandledrejection", (e) => {
  const msg = e.reason?.message || String(e.reason || "unknown promise rejection");
  try { toast("⚠︎ crash: " + msg, 6000); } catch {}
});

async function boot() {
  await openDB();
  await requestDurableStorage();
  await refreshCache();
  await migrateLegacyReads();
  await migrateNoteConvertedSquid();
  await migrateDupBoardCards();
  await fixDxSeats();
  await loadBlindsDefault();
  metaGet("hvSplitH").then((h) => { if (h) document.documentElement.style.setProperty("--hvsplit-h", h); });
  collapsedGroups = new Set((await metaGet("collapsedGroups")) || []);
  pinnedGroup = (await metaGet("pinnedGroup")) ?? null;
  tableLineup = (await metaGet("tableLineup")) || [];
  lineupSeats = (await metaGet("lineupSeats")) || 9;
  openSizeStats = (await metaGet("openSizeStats")) || {};
  // migrate old {bb:{size:count}} → recency picks {bb:[{size,ts}]}
  for (const bb of Object.keys(openSizeStats)) {
    const v = openSizeStats[bb];
    if (!Array.isArray(v)) {
      const picks = [];
      for (const [size, count] of Object.entries(v || {}))
        for (let i = 0; i < count; i++) picks.push({ size: Number(size), ts: Date.now() });
      openSizeStats[bb] = picks;
    }
  }
  const saved = await metaGet("draftHand");
  draft = saved ? Object.assign(newDraft(), saved) : newDraft();
  bindStatic();
  window.addEventListener("hashchange", route);
  // Flush any pending scale-read write before Safari suspends the tab so
  // slider changes are never lost when the user backgrounds the app.
  const flushPendingRead = () => {
    if (!pendingReadWrite) return;
    const o = pendingReadWrite;
    pendingReadWrite = null;
    clearTimeout($("od-tags")?._scaleT);
    dbPut("opponents", o);
  };
  // On suspend, flush every debounced write at once: scale-read, hand draft, snapshot.
  const flushOnHide = () => { flushPendingRead(); flushDraft(); flushAutoSnapshot(); };
  window.addEventListener("pagehide", flushOnHide);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushOnHide();
  });
  route();
  // ensure an auto-backup exists on first boot (or if it's stale)
  const snap = await metaGet("autoSnapshot");
  if (!snap || Date.now() - snap.ts > 60000) scheduleAutoSnapshot();
  if ("serviceWorker" in navigator) {
    // Was a SW already controlling this page at load? If so, a later
    // controllerchange is a real update; if not, the first one is just this
    // page's own SW taking control on first install — not an "update".
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register("sw.js").then((reg) => {
      // Installed iOS PWAs resume from background rather than cold-loading, so
      // poll for a fresh service worker each time the app returns to the front.
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") reg.update().catch(() => {});
      });
    }).catch(() => {});
    // A new SW took control. controllerchange can land mid-hand; the draft is
    // persisted but scroll/nav state isn't, so offer a one-tap reload rather
    // than forcing one out from under Phil.
    let _swUpdated = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hadController || _swUpdated) return;   // first-install control-grab isn't an update
      _swUpdated = true;
      const t = $("toast");
      toast("Updated — tap to reload", 3600000);
      t.style.cursor = "pointer";                 // set AFTER toast() (which clears stale handlers)
      t.onclick = () => location.reload();
    });
  }
}
boot();
