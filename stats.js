/* Per-opponent stats (HUD) counted from the hands Phil logged. Loaded after app.js:
   uses its globals (isAgg, handWinner, rangeBucketOf, RANGE_BUCKETS, esc, $) at call time.
   A stat is always [hits, chances]; the UI shows the raw x/y next to every percentage,
   because the sample is only the hands he chose to log. */

const SD_VOL = new Set(["limp", "call", "raise", "3bet", "4bet", "5bet", "jam", "bet"]);

/* One villain's hand → tallies. put(key, cols, hit) adds a chance (and a hit) to each column. */
function sdHandEvents(h, idx, put) {
  const me = "v" + idx;
  const parts = (h.villains || []).map((_, i) => "v" + i);
  if (h.hero !== false) parts.unshift("hero");
  const posOf = (a) => a === "hero" ? h.heroPos : h.villains?.[Number(a.slice(1))]?.pos;
  const board = (h.board || []).filter(Boolean);

  // one walk: every action tagged with what was already out on its street
  const seq = { pre: [], flop: [], turn: [], river: [] };
  const cnt = { pre: { agg: 0, last: null, limps: 0 }, flop: { agg: 0, last: null, limps: 0 }, turn: { agg: 0, last: null, limps: 0 }, river: { agg: 0, last: null, limps: 0 } };
  const foldSt = {};
  for (const a of h.actions || []) {
    const s = seq[a.street];
    if (!s) continue;
    const c = cnt[a.street];
    s.push({ actor: a.actor, act: a.act, aggBefore: c.agg, limpsBefore: c.limps, i: s.length });
    if (isAgg(a.act)) { c.agg++; c.last = a.actor; }
    else if (a.act === "limp") c.limps++;
    if (a.act === "fold" && !(a.actor in foldSt)) foldSt[a.actor] = STREETS.indexOf(a.street);
  }
  const mine = (st) => seq[st].filter((x) => x.actor === me);

  // ---- preflop: from his first action, by seat ----
  const pre = mine("pre");
  const bkt = rangeBucketOf(h.villains[idx].pos);
  const pc = bkt ? ["all", bkt] : ["all"];
  if (pre.length) {
    const f = pre[0];
    put("vpip", pc, pre.some((x) => SD_VOL.has(x.act)));
    put("pfr", pc, pre.some((x) => isAgg(x.act)));
    if (f.aggBefore === 0) {
      put("limp", pc, f.act === "limp");
      if (f.limpsBefore > 0) put("iso", pc, isAgg(f.act));
    } else {
      put("cc", pc, f.act === "call");
      if (f.aggBefore === 1) put("3bet", pc, isAgg(f.act));
    }
    if (f.act === "limp") {
      const r = pre.slice(1).find((x) => x.aggBefore > 0);          // his answer to a raise behind his limp
      if (r) { put("limpRR", pc, isAgg(r.act)); put("limpFold", pc, r.act === "fold"); put("limpCall", pc, r.act === "call"); }
    }
    if (f.aggBefore === 0 && isAgg(f.act)) {
      const r = pre.slice(1).find((x) => x.aggBefore >= 2);         // his answer to a 3bet over his raise
      if (r) put("f3bet", pc, r.act === "fold");
    }
  }

  // ---- postflop ----
  const liveAt = (si) => parts.filter((p) => !(p in foldSt) || foldSt[p] >= si);     // still in when street `si` begins
  const segAt = (si) => {
    const live = liveAt(si);
    if (!live.includes(me) || live.length < 2) return null;
    if (live.length > 2) return "mw";
    const other = live.find((p) => p !== me);
    const a = POSITIONS.indexOf(posOf(me)), b = POSITIONS.indexOf(posOf(other));
    if (a >= 0 && b >= 0) return a > b ? "ip" : "oop";
    const first = seq[STREETS[si]].find((x) => x.actor === me || x.actor === other);   // no seats logged: first to act is out of position
    return first ? (first.actor === me ? "oop" : "ip") : null;
  };
  const colsAt = (si) => { const s = segAt(si); return s ? ["all", s] : ["all"]; };
  const pfa = cnt.pre.last;
  const F = seq.flop, mf = mine("flop");
  if (mf.length) {
    const cols = colsAt(1), f1 = mf[0];
    if (pfa === me && f1.aggBefore === 0) {
      put("cbetF", cols, isAgg(f1.act));
      if (isAgg(f1.act)) {
        const t1 = mine("turn")[0];
        if (t1 && t1.aggBefore === 0) put("cbetT", colsAt(2), isAgg(t1.act));
      }
    }
    if (pfa && pfa !== me) {
      const A = F.find((x) => isAgg(x.act));
      if (A && A.actor === pfa) {                                    // the first flop bet was the raiser's: a cbet
        const r = F.find((x) => x.actor === me && x.i > A.i);
        if (r) { put("fcb", cols, r.act === "fold"); put("ccb", cols, r.act === "call"); put("rcb", cols, isAgg(r.act)); }
      }
      const fp = F.find((x) => x.actor === pfa);
      if (fp && f1.i < fp.i && f1.aggBefore === 0) put("donk", cols, isAgg(f1.act));
    }
    const ci = mf.findIndex((x) => x.act === "check");
    if (ci >= 0 && mf[ci + 1] && mf[ci + 1].aggBefore > 0) put("cr", cols, isAgg(mf[ci + 1].act));
  }
  for (const st of ["flop", "turn", "river"])
    for (const x of mine(st)) if (isAgg(x.act) || x.act === "call") put("afq", ["all"], isAgg(x.act));

  // ---- showdown: only hands that ran their course ----
  const liveEnd = parts.filter((p) => !(p in foldSt));
  const complete = liveEnd.length < 2 || board.length === 5 || seq.river.length > 0;
  const sawFlop = !(me in foldSt && foldSt[me] === 0) && (seq.flop.length > 0 || board.length >= 3);
  if (sawFlop && complete) {
    const sd = liveEnd.length >= 2 && liveEnd.includes(me);
    put("wtsd", ["all"], sd);
    if (sd) { const w = handWinner(h); if (w && w.how === "showdown") put("wsd", ["all"], w.winners.includes(me)); }
  }
}

function sdStats(oppId, hands) {
  const T = Object.create(null);
  const put = (key, cols, hit) => {
    for (const c of cols) { const r = T[key + "|" + c] || (T[key + "|" + c] = [0, 0]); r[1]++; if (hit) r[0]++; }
  };
  let n = 0;
  for (const h of hands) {
    const i = (h.villains || []).findIndex((v) => v.opponentId === oppId);
    if (i < 0) continue;
    n++;
    sdHandEvents(h, i, put);
  }
  return { T, n };
}

/* ---------- rendering ---------- */

let statsTab = "pre";
const SD_HUD = [["VPIP", "vpip"], ["PFR", "pfr"], ["Limp", "limp"], ["CC", "cc"], ["3bet", "3bet"], ["Fold 3bet", "f3bet"], ["Iso", "iso"], ["Limp-fold", "limpFold"],
  ["Cbet flop", "cbetF"], ["Cbet turn", "cbetT"], ["Fold cbet", "fcb"], ["Raise flop", "rcb"], ["Check-raise", "cr"], ["AFq", "afq"], ["WTSD", "wtsd"], ["W$SD", "wsd"]];
const SD_PRE_ROWS = [["VPIP", "vpip"], ["PFR", "pfr"], ["Limp", "limp"], ["CC", "cc"], ["LRR", "limpRR"], ["Limp-fold", "limpFold"], ["Limp-call", "limpCall"], ["Iso", "iso"], ["3bet", "3bet"]];
const SD_POST_ROWS = [["Cbet flop", "cbetF"], ["Cbet turn", "cbetT"], ["Fold to cbet", "fcb"], ["Call cbet", "ccb"], ["Raise flop", "rcb"], ["Check-raise", "cr"], ["Donk lead", "donk"]];
const SD_POST_COLS = [["all", "All"], ["ip", "HU IP"], ["oop", "HU OOP"], ["mw", "MW"]];
const SD_DEFS = [
  ["VPIP / PFR", "Put chips in / raised at any point preflop, out of the hands where he acted preflop."],
  ["Limp", "First action was a limp, out of hands where no raise was out before he acted."],
  ["CC", "Cold call: his first action was calling a raise, out of hands where a raise was out first."],
  ["3bet", "Re-raised a single open, out of hands where he faced one."],
  ["Iso", "Raised over one or more limpers, out of hands with limpers and no raise yet."],
  ["LRR · Limp-fold · Limp-call", "After he limped and a raise came behind: re-raised / folded / called, out of limps that faced a raise (his answer must be logged)."],
  ["Fold 3bet", "After he raised first and got 3bet: folded."],
  ["Cbet flop", "The last preflop raiser bet the flop when nobody had bet before him."],
  ["Cbet turn", "Bet the turn after cbetting the flop, out of turns where he acted first."],
  ["Fold / Call / Raise vs cbet", "His first answer to a flop bet from the preflop raiser (Raise flop = the raise)."],
  ["Check-raise", "Checked the flop, faced a bet, raised."],
  ["Donk lead", "Bet the flop into the preflop raiser before they acted."],
  ["HU IP / HU OOP / MW", "Heads-up in or out of position against the one other player who saw that street, or three-plus players. Only players you logged in the hand are counted."],
  ["AFq", "Postflop bets and raises out of bets, raises and calls."],
  ["WTSD / W$SD", "Went to showdown out of flops seen / won it (needs both hands and the board logged). Hands still unfinished are skipped."],
];

function statCell(r) {
  if (!r || !r[1]) return `<div class="stc none">–</div>`;
  return `<div class="stc${r[1] < 5 ? " thin" : ""}"><b>${Math.round((100 * r[0]) / r[1])}</b><i>${r[0]}/${r[1]}</i></div>`;
}

function renderStats(oppId, hands) {
  const host = $("od-stats");
  if (!host) return;
  const { T, n } = sdStats(oppId, hands);
  const g = (key, col) => T[key + "|" + col];
  $("od-statshint").textContent = n ? `${n} logged hand${n === 1 ? "" : "s"}` : "";
  if (!n) { host.innerHTML = `<div class="empty">No hands logged for this player yet.</div>`; return; }
  const hud = SD_HUD.map(([l, k]) => {
    const r = g(k, "all");
    return `<div class="stchip${!r || r[1] < 5 ? " thin" : ""}"><label>${esc(l)}</label><b>${r && r[1] ? Math.round((100 * r[0]) / r[1]) : "–"}</b><i>${r && r[1] ? `${r[0]}/${r[1]}` : "no data"}</i></div>`;
  }).join("");
  const seats = ["all", ...RANGE_BUCKETS];
  const table = (rows, cols, cw) => {
    const head = `<div class="strow sthead" style="--cols:${cols.length}"><div></div>${cols.map(([, l]) => `<div>${esc(l)}</div>`).join("")}</div>`;
    return head + rows.map(([l, k]) =>
      `<div class="strow" style="--cols:${cols.length}"><div class="stlbl">${esc(l)}</div>${cols.map(([c]) => statCell(g(k, c))).join("")}</div>`).join("");
  };
  const body = statsTab === "pre"
    ? table(SD_PRE_ROWS, seats.map((s) => [s, s === "all" ? "All" : s]))
    : table(SD_POST_ROWS, SD_POST_COLS);
  host.innerHTML = `
    <div class="sthud">${hud}</div>
    <div class="chiprow tight sttabs">
      <button class="chip mini${statsTab === "pre" ? " on" : ""}" data-sttab="pre">Preflop by seat</button>
      <button class="chip mini${statsTab === "post" ? " on" : ""}" data-sttab="post">Postflop</button>
    </div>
    <div class="sttable">${body}</div>
    <div class="stnote">Counted only from hands you logged, so read these as tendencies, not true frequencies. Faded = under 5 chances. U8/U9 count as U7.</div>
    <details class="stdefs"><summary>How these are counted</summary>${SD_DEFS.map(([a, b]) => `<p><b>${esc(a)}</b> — ${esc(b)}</p>`).join("")}</details>`;
}

function bindStats() {
  $("od-stats").onclick = (e) => {
    const b = e.target.closest("[data-sttab]");
    if (!b || !curOppId) return;
    statsTab = b.dataset.sttab;
    renderStats(curOppId, HANDS.filter((h) => (h.villainIds || []).includes(curOppId)));
  };
}

/* ---------- sizings: what he bet, and whether the hand was value or a bluff ----------
   Value/bluff is Phil's short-deck line: trips or better with his own cards, an
   overpair, or two pair with both his cards — but on a paired board two pair is
   nothing (anyone can hold one), and on a flush or four-to-a-straight board two
   pair and overpairs both drop to bluff, so only trips+ is value there. Draws,
   top pair and everything below are bluffs, so nothing goes uncounted. */
const SD_CARD = /^[6-9TJQKA][cdhs]$/;
const SD_FLUSH_BOARD = 3;                        // this many of one suit on the board
const SD_BOARD_N = { flop: 3, turn: 4, river: 5 };

function sdBoardTexture(board) {
  const rk = board.map((c) => RVAL[c[0]]);
  const paired = new Set(rk).size < rk.length;
  const suits = {};
  for (const c of board) suits[c[1]] = (suits[c[1]] || 0) + 1;
  const flush = Math.max(...Object.values(suits)) >= SD_FLUSH_BOARD;
  const set = new Set(rk);
  const wins = [[6, 7, 8, 9, 10], [7, 8, 9, 10, 11], [8, 9, 10, 11, 12], [9, 10, 11, 12, 13], [10, 11, 12, 13, 14], [14, 6, 7, 8, 9]];
  const straight4 = wins.some((w) => w.filter((r) => set.has(r)).length >= 4);
  return { paired, flush, straight4 };
}

function sdMadeClass(hole, board) {
  if (!hole || hole.length !== 2 || board.length < 3) return null;
  const all = hole.concat(board);
  if (!all.every((c) => SD_CARD.test(String(c))) || new Set(all).size !== all.length) return null;
  const s = best7(all);
  if (board.length === 5 && cmpScore(s, best7(board)) === 0) return "B";        // playing the board
  const cnt = {};
  for (const c of all) cnt[RVAL[c[0]]] = (cnt[RVAL[c[0]]] || 0) + 1;
  const hv = hole.map((c) => RVAL[c[0]]);
  const mine = hv.filter((v) => cnt[v] >= 2);                                    // his own paired ranks
  if (s[0] >= 4) return "V";                                                     // straight, flush, boat, quads
  if (s[0] === 3) return mine.length ? "V" : "B";                                // trips need one of his cards
  const tex = sdBoardTexture(board);
  if (tex.flush || tex.straight4 || tex.paired) return "B";
  if (s[0] === 2) return new Set(mine).size === 2 ? "V" : "B";                   // two pair, both his cards
  if (s[0] === 1 && hv[0] === hv[1] && hv[0] > Math.max(...board.map((c) => RVAL[c[0]]))) return "V";   // overpair
  return "B";
}

const SD_SZ_STEPS = ["B25", "B33", "B50", "B66", "B100", "B150", "Jam"];
const SD_SZ_CUTS = [[0.29, "B25"], [0.415, "B33"], [0.58, "B50"], [0.83, "B66"], [1.25, "B100"], [Infinity, "B150"]];
const sdStepFor = (r) => SD_SZ_CUTS.find((c) => r < c[0])[1];
const SD_SZ_SKIPS = [
  ["noCards", "his cards or the board weren't logged"],
  ["badCards", "a card couldn't be read"],
  ["noAmount", "the bet has no size"],
  ["noPot", "the pot can't be rebuilt (no ante, or an earlier bet has no size)"],
  ["badAmount", "the amount can't be true"],
];
const SD_SZ_KNOWN = /^(\$?\d+(\.\d+)?k?|\d+(\.\d+)?[ax%]|Jam|jam)$/;

/* Ratio of a bet to the pot it went into: either the share already written down
   ("66%"), or chip amounts priced through estimatePot. → number | {skip} */
function sdBetRatio(h, i) {
  const a = h.actions[i];
  const t = String(a.size || "").trim();
  let m = /^(\d+(?:\.\d+)?)\s*%$/.exec(t);
  if (m) { const p = parseFloat(m[1]) / 100; return p > 0 && p <= 3 ? p : { skip: "badAmount" }; }
  m = /^\$?(\d+(?:\.\d+)?)\s*k?$/i.exec(t);
  if (!m) return { skip: "noAmount" };
  for (let j = 0; j < i; j++) {
    const b = h.actions[j];
    if (AGG_ACTS.includes(b.act) && b.act !== "jam" && !SD_SZ_KNOWN.test(String(b.size || "").trim())) return { skip: "noPot" };
  }
  const pre = estimatePot(h, h.actions.slice(0, i));
  if (!(pre.now > 0)) return { skip: "noPot" };
  let own = 0;
  for (let j = 0; j < i; j++) if (h.actions[j].street === a.street && h.actions[j].actor === a.actor) own = pre.perAct[j] || own;
  const inc = parseFloat(m[1]) - own;
  const r = inc / pre.now;
  return r > 0 && r <= 3 ? r : { skip: "badAmount" };
}

function sdSizingAuto(oppId, hands) {
  const rows = {}, skipped = {}, why = {};
  for (const [k] of SD_SZ_SKIPS) { skipped[k] = 0; why[k] = []; }
  let n = 0;
  for (const h of hands) {
    const V = h.villains || [];
    const board = (h.board || []).filter(Boolean);
    const acts = h.actions || [];
    const miss = (k) => { skipped[k]++; if (!why[k].includes(h.id)) why[k].push(h.id); };
    for (let i = 0; i < acts.length; i++) {
      const a = acts[i];
      const need = SD_BOARD_N[a && a.street];
      if (!need || !AGG_ACTS.includes(a.act)) continue;
      const m = /^v(\d+)$/.exec(String(a.actor || ""));
      const v = m && V[Number(m[1])];
      if (!v || v.opponentId !== oppId) continue;
      const hole = (v.cards || []).filter(Boolean);
      const vis = board.slice(0, need);
      if (hole.length !== 2 || vis.length < need) { miss("noCards"); continue; }
      const k = sdMadeClass(hole, vis);
      if (!k) { miss("badCards"); continue; }
      let step;
      if (a.act === "jam" || /^jam$/i.test(String(a.size || ""))) step = "Jam";
      else {
        const r = sdBetRatio(h, i);
        if (typeof r !== "number") { miss(r.skip); continue; }
        step = sdStepFor(r);
      }
      const rid = a.street + "-" + k.toLowerCase();
      const cell = (rows[rid] = rows[rid] || {});
      cell[step] = (cell[step] || 0) + 1;
      n++;
    }
  }
  return { rows, n, skipped, why };
}

function renderSizing(oppId, hands) {
  const host = $("od-sizing");
  if (!host) return;
  const A = sdSizingAuto(oppId, hands);
  const skips = SD_SZ_SKIPS.filter(([k]) => A.skipped[k]).map(([k, l]) => `${A.skipped[k]} bet${A.skipped[k] === 1 ? "" : "s"}: ${l}`);
  const cols = SD_SZ_STEPS.length;
  const headFor = (blankLast) => `<div class="strow sthead" style="--cols:${cols}"><div></div>${SD_SZ_STEPS.map((s) => `<div>${blankLast && s === "Jam" ? "" : s}</div>`).join("")}</div>`;
  const rowLbl = (st, kind) => `<div class="stlbl">${st[0].toUpperCase() + st.slice(1)} ${kind === "V" ? "Value" : "Bluff"}</div>`;
  const grid = (cellFor, tail, blankLast) => headFor(blankLast) + ["V", "B"].map((kind) => ["flop", "turn", "river"].map((st) => {
    const cell = cellFor(st, kind);
    const top = Math.max(0, ...SD_SZ_STEPS.map((x) => cell[x] || 0));
    return `<div class="strow" style="--cols:${cols}">${rowLbl(st, kind)}${SD_SZ_STEPS.map((x, i) => tail(st, kind, x, cell[x] || 0, top, i)).join("")}</div>`;
  }).join("")).join(`<div class="szgap"></div>`);
  const auto = grid((st, k) => A.rows[st + "-" + k.toLowerCase()] || {}, (st, k, x, c, top) =>
    `<div class="stc${c ? "" : " none"}${c && c === top ? " szTop" : ""}">${c ? `<b>${c}</b>` : "–"}</div>`);
  /* Manual taps: the same grid, but every cell is a button that adds one. The
     seventh column has no Jam rung, so it holds the row's clear button. */
  const o = oppById(oppId), reads = o ? oppReads(o) : {};
  const tapId = (st, k) => `size-${st}-${k.toLowerCase()}`;
  let tapped = 0;
  const manual = grid((st, k) => reads[tapId(st, k)] || {}, (st, k, x, c, top, i) => {
    const id = tapId(st, k);
    if (x === "Jam") return (reads[id] && tallyLeader(reads[id]))
      ? `<button class="stc szClr" data-tallyclear="${id}" title="Clear this row" aria-label="Clear this row">✕</button>` : `<div></div>`;
    tapped += c;
    return `<button class="stc szTap${c ? "" : " none"}${c && c === top ? " szTop" : ""}" data-tally="${id}" data-val="${x}" aria-label="${x}">${c ? `<b>${c}</b>` : "+"}</button>`;
  }, true);
  host.innerHTML = `
    <div class="szsub">From hands${A.n ? ` · ${A.n} bet${A.n === 1 ? "" : "s"}` : ""}</div>
    <div class="sttable">${auto}</div>
    <div class="stnote">From hands where his cards were logged, so bluffs he never showed aren't here — read the Bluff rows as a floor. Value = trips+ with his own cards, an overpair, or two pair with both his cards. On a flush board (3+ of a suit) or a four-to-a-straight board only trips+ is value, and on a paired board two pair isn't. Everything else, draws and top pair included, counts as a bluff.${
      skips.length ? `<br>Left out — ${esc(skips.join("; "))}.` : ""}</div>
    <div class="szsub">Your taps${tapped ? ` · ${tapped}` : ""}</div>
    <div class="sttable">${manual}</div>
    <div class="stnote">Tap a size when you see him bet it as value or as a bluff.</div>`;
}

function bindSizing() {
  $("od-sizing").onclick = async (e) => {
    const clr = e.target.closest("[data-tallyclear]"), tap = e.target.closest("[data-tally]");
    if (!clr && !tap || !curOppId) return;
    const o = oppById(curOppId);
    if (!o) return;
    const reads = oppReads(o);
    if (clr) delete reads[clr.dataset.tallyclear];
    else {
      const id = tap.dataset.tally, v = tap.dataset.val;
      const counts = reads[id] && typeof reads[id] === "object" ? reads[id] : (reads[id] = {});
      counts[v] = (counts[v] || 0) + 1;
    }
    o.updatedAt = Date.now();
    await dbPut("opponents", o);
    renderOppDetail(curOppId);
  };
}
