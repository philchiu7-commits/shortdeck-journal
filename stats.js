/* Per-opponent stats (HUD) counted from the hands Phil logged. Loaded after app.js:
   uses its globals (isAgg, handWinner, rangeBucketOf, RANGE_BUCKETS, esc, $) at call time.
   A stat is always [hits, chances]; the UI shows the raw x/y next to every percentage,
   because the sample is only the hands he chose to log. */

const SD_MINR_X = 2;                             // a raise up to this many times the bet it raises is a min-raise — the same 2× the sizing table's Min rung uses
const SD_MINR = new Set(["minOpen", "min3bet"]);
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
  const ante = Number(h.blinds?.ante) || 0;
  const to = estimatePot(h, h.actions).perAct;   // resolved raise-to amounts, one per action
  let lastTo = ante;                             // the preflop bet a raise is raising: one ante until someone raises
  for (const [ai, a] of (h.actions || []).entries()) {
    const s = seq[a.street];
    if (!s) continue;
    const c = cnt[a.street];
    const min = a.street === "pre" && isAgg(a.act) && !!a.size && lastTo > 0 && to[ai] > 0 && to[ai] <= SD_MINR_X * lastTo + 1e-9;
    s.push({ actor: a.actor, act: a.act, aggBefore: c.agg, aggBy: c.last, limpsBefore: c.limps, i: s.length, min });
    if (a.street === "pre" && isAgg(a.act) && to[ai] > 0) lastTo = to[ai];
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
    if (f.aggBefore === 0) {
      if (f.act !== "check" && posOf(me) !== "BN") put("limp", pc, f.act === "limp");   // the button's double ante is already in: he checks, he can't limp
      put("minOpen", pc, isAgg(f.act) && f.min);                 // min opens and min isos together — neither counts in Open or Iso
      if (f.limpsBefore > 0) put("iso", pc, isAgg(f.act) && !f.min);
      else put("open", pc, isAgg(f.act) && !f.min);
    } else {
      if (f.aggBefore === 1) { put("cc", pc, f.act === "call"); put("3bet", pc, isAgg(f.act) && !f.min); put("min3bet", pc, isAgg(f.act) && f.min); }
    }
    if (f.act === "limp") {
      const r = pre.slice(1).find((x) => x.aggBefore > 0);          // his answer to a raise behind his limp
      if (r) { put("limpRR", pc, isAgg(r.act) && !r.min); put("limpCall", pc, r.act === "call"); }   // a min re-raise isn't a limp-reraise
    }
    if (f.aggBefore === 0 && isAgg(f.act)) {
      const r = pre.slice(1).find((x) => x.aggBefore >= 2);         // his answer to a 3bet over his raise
      if (r) {
        if (!f.min) put("f3bet", pc, r.act === "fold");            // a min-open folds to a 3bet far less often; it would blur the number
        if (f.limpsBefore > 0 && !f.min) put("isoFold", pc, r.act === "fold");   // the same answer, counted only where his raise was an iso
      }
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
  const colsAt = (si) => { const s = segAt(si); return s ? (s === "mw" ? ["all", "mw"] : ["all", "hu", s]) : ["all"]; };   // "hu" is IP and OOP together
  const pfa = cnt.pre.last;
  const F = seq.flop, mf = mine("flop");
  if (mf.length) {
    const cols = colsAt(1), f1 = mf[0];
    if (pfa === me && f1.aggBefore === 0) {
      put("cbetF", cols, isAgg(f1.act));
      const raisedAfter = (st, x) => seq[st].some((y) => y.i > x.i && y.actor !== me && isAgg(y.act));   // his bet got raised: no longer his barrel to fire
      if (isAgg(f1.act)) {
        const t1 = mine("turn")[0];
        if (t1 && t1.aggBefore === 0 && !raisedAfter("flop", f1)) {
          put("cbetT", colsAt(2), isAgg(t1.act));
          if (isAgg(t1.act)) {
            const v1 = mine("river")[0];
            if (v1 && v1.aggBefore === 0 && !raisedAfter("turn", t1)) put("cbetR", colsAt(3), isAgg(v1.act));
          }
        }
        const R = F.find((x) => x.i > f1.i && x.actor !== me && isAgg(x.act));      // his cbet got raised
        const r = R && F.find((x) => x.actor === me && x.i > R.i);
        if (r) put("fxr", cols, r.act === "fold");
      }
    }
    if (pfa && pfa !== me) {
      const A = F.find((x) => isAgg(x.act));
      if (A && A.actor === pfa) {                                    // the first flop bet was the raiser's: a cbet
        const r = F.find((x) => x.actor === me && x.i > A.i);
        if (r) put("fcb", cols, r.act === "fold");
        if (r && r.act === "call") {                                 // called the flop cbet: his answer to the raiser's turn barrel
          const T = seq.turn, B = T.find((x) => isAgg(x.act));
          const r2 = B && B.actor === pfa && T.find((x) => x.actor === me && x.i > B.i);
          if (r2) {
            put("fcbT", colsAt(2), r2.act === "fold");
            if (r2.act === "call") {                                 // and called the turn barrel: his answer to the river one
              const V = seq.river, B2 = V.find((x) => isAgg(x.act));
              const r3 = B2 && B2.actor === pfa && V.find((x) => x.actor === me && x.i > B2.i);
              if (r3) put("fcbR", colsAt(3), r3.act === "fold");
            }
          }
        }
      }
      const fp = F.find((x) => x.actor === pfa);
      if (fp && f1.i < fp.i && f1.aggBefore === 0) put("donk", cols, isAgg(f1.act));
    }
    const ci = mf.findIndex((x) => x.act === "check");
    if (ci >= 0 && mf[ci + 1] && mf[ci + 1].aggBefore > 0) put("cr", cols, isAgg(mf[ci + 1].act));
  }
  for (const [st, si, key] of [["flop", 1, "rcb"], ["turn", 2, "rT"], ["river", 3, "rR"]]) {    // his first answer to someone else's bet on the street
    const x = mine(st).find((y) => y.aggBefore === 1 && y.aggBy !== me);
    if (x) put(key, colsAt(si), isAgg(x.act));
  }
  for (const st of ["flop", "turn", "river"])
    for (const x of mine(st)) if (isAgg(x.act) || x.act === "call") put("afq", ["all"], isAgg(x.act));
  for (const x of mine("river")) if (isAgg(x.act) || x.act === "call") put("afR", ["all"], isAgg(x.act));

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
  let cur = null;                                // r[2] / r[3] = ids of the hands that hit / had the chance and didn't
  const put = (key, cols, hit) => {
    for (const c of cols) {
      const r = T[key + "|" + c] || (T[key + "|" + c] = [0, 0, [], []]);
      r[1]++; if (hit) r[0]++;
      (hit ? r[2] : r[3]).push(cur);
    }
  };
  let n = 0;
  for (const h of hands) {
    const i = (h.villains || []).findIndex((v) => v.opponentId === oppId);
    if (i < 0) continue;
    n++;
    cur = h.id;
    sdHandEvents(h, i, put);
  }
  return { T, n };
}

/* ---------- rendering ---------- */

let statsTab = "pre";
let sdMinHide = localStorage.getItem("sd-minhide") === "1";   // MinO/Iso and Min 3bet are noise once you've read them; the chip stays so they can come back
/* Two blocks, not one wall: a preflop number and a river number answer
   different questions and were being read off one grid. WTSD/W$SD are
   showdown, which is where the postflop block ends. */
/* Two questions, one row each: how he enters a pot, then how the raising war goes. */
const SD_HUD_PRE = [["VPIP", "vpip"], ["Limp", "limp"], ["Limp-call", "limpCall"], ["Iso", "iso"], ["MinO/Iso", "minOpen"], ["CC", "cc"], ["3bet", "3bet"], ["Min 3bet", "min3bet"], ["Fold 3bet", "f3bet"]];
const SD_HUD_POST = [["Cbet HU", "cbetF", "hu"], ["Cbet MW", "cbetF", "mw"], ["Cbet turn", "cbetT"], ["Fold cbet HU", "fcb", "hu"], ["Fold cbet MW", "fcb", "mw"], ["Fold T-cbet", "fcbT"], ["Raise flop", "rcb"], ["Raise turn", "rT"], ["Raise river", "rR"], ["Check-raise", "cr"], ["AFq", "afq"], ["WTSD", "wtsd"], ["W$SD", "wsd"]];
const SD_HUD = [...SD_HUD_PRE, ...SD_HUD_POST];
const SD_PRE_ROWS = [["VPIP", "vpip"], ["Iso", "iso"], ["Iso fold", "isoFold"], ["MinO/Iso", "minOpen"], ["Limp", "limp"], ["CC", "cc"], ["LRR", "limpRR"], ["Limp-call", "limpCall"], ["3bet", "3bet"], ["Min 3bet", "min3bet"]];
const SD_POST_ROWS = [["Cbet flop", "cbetF"], ["Cbet turn", "cbetT"], ["Cbet river", "cbetR"], ["Fold to cbet", "fcb"], ["Fold to turn cbet", "fcbT"], ["Fold to river cbet", "fcbR"], ["Raise flop", "rcb"], ["Raise turn", "rT"], ["Raise river", "rR"], ["Check-raise", "cr"], ["Donk lead", "donk"]];
const SD_POST_COLS = [["all", "All"], ["ip", "HU IP"], ["oop", "HU OOP"], ["mw", "MW"]];
const SD_DEFS = [
  ["VPIP", "VPIP: put chips in at any point preflop, out of the hands where he acted preflop."],
  ["Limp", "First action was a limp, out of hands where no raise was out before he acted. Not counted on the button: his double ante is already in, so he can only check or raise."],
  ["CC", "Cold call: his first action was flat-calling a single raise, out of hands where exactly one raise was in front of him. Calls of a 3bet or squeeze don't count."],
  ["MinO/Iso", "A raise of at most 2× the ante when no one had raised yet — first in, or over limpers. Out of every hand where he acted with no raise in front of him. These never count in Open or Iso."],
  ["3bet · Min 3bet", "Re-raised a single open, out of hands where he faced one. A min 3bet is at most double the open; those are counted only in Min 3bet, never in 3bet. A raise with no size logged counts as a normal raise."],
  ["Iso", "Raised over one or more limpers, out of hands with limpers and no raise yet. A min raise doesn't count — it goes to MinO/Iso."],
  ["Iso fold", "He isolated and someone re-raised behind him: folded, out of the isos that got re-raised. Any re-raise counts — a min 3bet or a jam the same as a normal one. The base is the Iso row's raises, so a min iso isn't in it."],
  ["LRR · Limp-call", "After he limped and a raise came behind: re-raised / called, out of limps that faced a raise (his answer must be logged). A min re-raise (at most double the raise he faced) doesn't count as an LRR."],
  ["Fold 3bet", "After he raised first and got 3bet: folded. Min-opens and min isos are left out — he defends those far more."],
  ["Cbet flop", "The last preflop raiser bet the flop when nobody had bet before him."],
  ["Cbet turn / river", "Kept barrelling after his own cbet, out of the streets where nobody had bet before him and his last bet wasn't raised. Cbet river counts only hands he cbet the flop and the turn."],
  ["Fold to cbet", "His first answer to a flop bet from the preflop raiser: folded. Calls and raises are the rest."],
  ["Fold to turn / river cbet", "He called the raiser's cbet, the raiser barrelled again: folded, out of those barrels he faced. The river one counts only hands he called the flop and the turn."],
  ["Raise flop / turn / river", "His first action facing someone else's single bet on that street — anyone's bet, not just a cbet: raised, out of the times he faced one (folds and calls are the rest). Includes check-raises."],
  ["Check-raise", "Checked the flop, faced a bet, raised."],
  ["Donk lead", "Bet the flop into the preflop raiser before they acted."],
  ["HU / MW", "Heads-up against one other player who saw that street, or three-plus. The Cbet and Fold cbet chips are split this way because a cbet into one player and a cbet into three are different bets; the same stat's All number is the Postflop table's first column."],
  ["HU IP / HU OOP / MW", "Heads-up in or out of position against the one other player who saw that street, or three-plus players. Only players you logged in the hand are counted."],
  ["AFq", "Postflop bets and raises out of bets, raises and calls."],
  ["WTSD / W$SD", "Went to showdown out of flops seen / won it (needs both hands and the board logged). Hands still unfinished are skipped."],
];

let sdStatT = {};                                // the tallies behind the stats now on screen
let sdSzT = {};                                  // same for the sizing grid: "sz|flop-v|B50" → [n, n, handIds, []]
const SD_EXTRA_ROWS = [["Fold to flop raise", "fxr"], ["River AF", "afR"]];
const SD_COL_LBL = { all: "", hu: "heads-up", mw: "multiway", ip: "HU IP", oop: "HU OOP" };

function statCell(r, k, c) {
  if (!r || !r[1]) return `<div class="stc none">–</div>`;
  return `<div class="stc stk${r[1] < 5 ? " thin" : ""}" data-stk="${k}|${c}"><b>${Math.round((100 * r[0]) / r[1])}</b><i>${r[0]}/${r[1]}</i></div>`;
}

/* Tap a stat → the hands behind it, split into "did it" and "had the chance, didn't". */
function statProof(el) {
  const key = el.dataset.stk;
  if (key.startsWith("sq|")) {                   // the sequence grid carries its own label
    const s = sdSeqT[key];
    return s && curOppId ? { r: s.r, sizing: !s.r[3].length, label: s.label } : null;
  }
  const r = sdStatT[key] || sdSzT[key];
  if (!r || !curOppId) return null;
  const [k, c, step] = key.split("|");
  if (k === "sz") {
    const [st, kind] = c.split("-"), rz = kind[0] === "r", vb = kind.slice(-1) === "v" ? "value" : "bluff";
    const split = r[4] && ["flop", "turn", "river"].map((x) => `${x[0].toUpperCase() + x.slice(1)} ${r[4][x] || 0}`).join(" · ");
    const what = st === "all" ? vb[0].toUpperCase() + vb.slice(1) : `${st[0].toUpperCase() + st.slice(1)} ${vb}`;
    return { r, sizing: true, split, label: `${what} ${rz ? "raise" : "bet"} · ${step} · ${r[0]} ${rz ? "raise" : "bet"}${r[0] === 1 ? "" : "s"}` };
  }
  const all = [...SD_HUD, ...SD_PRE_ROWS, ...SD_POST_ROWS, ...SD_EXTRA_ROWS];
  const name = (all.find(([, kk, cc]) => kk === k && !cc) || all.find(([, kk]) => kk === k))?.[0] || k;
  const col = SD_COL_LBL[c] ?? c;
  return { r, label: `${name}${col ? " · " + col : ""} · ${r[0]}/${r[1]}` };
}
function openStatSheet(el) {
  const p = statProof(el);
  if (!p) return;
  openReadProof(p.label + (p.split ? " (" + p.split + ")" : ""), "Showdowns first, then newest. Tap a hand to open it.", p.r[2], p.sizing ? null : { ids: p.r[3], yes: "Did it", no: "Had the chance, didn't" }, curOppId);
}

/* Hover: preflop stats show the hands on the range chart by his hole cards (only hands where
   his cards were logged can go on it); postflop stats and sizings list the hands. */
const SD_PRE_KEYS = new Set(["vpip", "iso", "open", "minOpen", "limp", "cc", "3bet", "min3bet", "f3bet", "limpRR", "limpCall"]);
const SD_HOV_C = { did: "#4fbf5a", didnt: "#5a6068" };
function sdRangeMini(p) {
  const byId = new Map(HANDS.map((h) => [h.id, h]));
  const ev = {};
  let known = 0, total = 0;
  const add = (ids, act) => {
    for (const id of new Set(ids || [])) {
      const h = byId.get(id);
      if (!h) continue;
      total++;
      const v = (h.villains || []).find((x) => x.opponentId === curOppId);
      const hc = v && handClass(v.cards);
      if (!hc) continue;
      known++;
      ((ev[hc] ||= {})[act] = (ev[hc][act] || 0) + 1);
    }
  };
  add(p.r[2], "did");
  if (!p.sizing) add(p.r[3], "didnt");
  if (!known) return { known, total, html: "" };
  const cells = [];
  for (let i = 0; i < RANKS.length; i++) for (let j = 0; j < RANKS.length; j++) {
    const hi = RANKS[i], lo = RANKS[j];
    const cls = i === j ? hi + hi : (i < j ? hi + lo + "s" : lo + hi + "o");
    const e = ev[cls];
    const acts = e ? ["did", "didnt"].filter((a) => e[a]) : [];
    const bg = !acts.length ? "background:#1a1d23;color:#6b7078;"
      : `background:${acts.length > 1 ? `linear-gradient(90deg,${SD_HOV_C.did} 0 50%,${SD_HOV_C.didnt} 50% 100%)` : SD_HOV_C[acts[0]]};color:#fff;text-shadow:0 0 2px rgba(0,0,0,.6);`;
    const n = e ? (e.did || 0) + (e.didnt || 0) : 0;
    cells.push(`<div class="rgcell" style="${bg}">${cls}${n ? `<span class="rgn">${n}</span>` : ""}</div>`);
  }
  const key = `<div class="spkey"><span><span class="rgswatch" style="background:${SD_HOV_C.did}"></span> ${p.sizing ? "Bet it" : "Did it"}</span>${
    p.sizing ? "" : `<span><span class="rgswatch" style="background:${SD_HOV_C.didnt}"></span> Had the chance, didn't</span>`}</div>`;
  return { known, total, html: `<div class="rggrid spgrid">${cells.join("")}</div>${key}` };
}

/* ---------- model range: a frequency read as a range width ----------
   One ordering per stat, not one ladder for all of them: each is the order a
   7-max short-deck solution takes that action in, averaged over the seats, ties
   broken by hot-and-cold equity. They disagree on purpose — 3bets are ace-heavy
   with no connectors, cold-calls are pairs and suited playability with AA
   nowhere near the top, isos are suited-led (JTs over QQ). One equity ladder
   ordered every one of them wrong. */
const SD_ORDER = {
  vpip: "AA KK QQ JJ TT AKs AJs AKo KQs AQo KJs ATs QJs KQo KTs QTs A9s 99 KJo QJo "
    + "ATo QTo JTo KTo A8s A7s T9s K9s J9s A6s 88 98s K8s T8s 77 66 AQs AJo JTs "
    + "Q9s T9o 97s K6s K7s A9o J8s Q8s T7s K9o A8o J9o Q9o T8o Q7s Q6s T6s A7o "
    + "87s J7s A6o 98o J8o K8o Q8o K7o 96s J6s 86s T7o 97o K6o Q7o J7o 87o Q6o "
    + "96o J6o T6o 76s 86o 76o",
  limp: "A6s 88 K8s 77 66 99 JJ Q9s T8s JTo TT 97s 98s T9o QTs QJo KJo A7s QTo KQo "
    + "J9s QJs KQs AJs K7s ATo QQ AJo K6s J8s AQo 87s T9s T7s KTo K9s Q8s 96s KJs "
    + "AKo AQs A9s ATs 86s 98o T8o J9o KK A9o T6s JTs KTs Q9o Q7s A8o Q6s A8s A7o "
    + "J7s K9o J6s 76s 97o AA K8o AKs J8o A6o Q8o K7o T7o 87o K6o 96o J7o 86o Q6o "
    + "J6o Q7o T6o 76o",
  iso: "AKs AA A8s JTs KTs KK ATs AQs A9s K9s AKo KJs KTo T9s AQo AJo QQ ATo AJs "
    + "K9o KQs QJs A9o KQo J9s QTo A7s KJo QJo QTs K7s K6s Q6s J8o T6o A8o K7o "
    + "98s Q7o T8s TT T9o Q7s JTo J8s 96o K6o Q8s T7o T6s T8o Q8o J6o 98o 97o T7s "
    + "K8o JJ Q6o J6s Q9s 99 J9o K8s A6s Q9o A7o 88 A6o 97s J7s 77 87s 96s J7o "
    + "87o 86s 66 76s 86o 76o",
  "3bet": "AA AKs AKo KK A7s AQs QJs ATo K7s A8s QQ KJo KTs A8o A9o K8s ATs KTo JTs "
    + "Q8s QTs QJo JTo AJo K6s KJs T8o JJ TT AJs KQs AQo KQo A9s 99 QTo T9s K9s "
    + "Q9s J9s A6s K9o T9o J9o Q9o A7o 88 98s J8s T8s A6o 98o J8o K8o Q8o 97s K7o "
    + "J7s T7s Q7s 77 97o 87s K6o Q6s 96s Q7o J7o T7o J6s 87o Q6o T6s 96o 86s J6o "
    + "T6o 66 76s 86o 76o",
  limpRR: "AA AKs AKo KK JTs ATo AJo KTo AQo A8s T9s K9s AQs KJo A6s QJs QQ A9o T9o "
    + "A7s QTs JJ TT AJs KQs KJs ATs KQo KTs A9s 99 QJo QTo JTo A8o Q9s J9s K9o "
    + "J9o Q9o A7o 88 98s K8s J8s T8s A6o Q8s K7s 98o T8o J8o K8o Q8o 97s K6s K7o "
    + "J7s T7s Q7s 77 97o 87s K6o Q6s 96s Q7o J7o T7o J6s 87o Q6o T6s 96o 86s J6o "
    + "T6o 66 76s 86o 76o",
  cc: "JJ TT AJs KQs AQo KQo A9s 99 QTo T9s J9s 98s KJs AJo JTo QTs JTs QJo KTs "
    + "ATs KTo QQ A8s ATo T8s QJs AQs KJo T9o KK K9s Q9s A6s 88 J8s 97s AKo A7s "
    + "66 AKs T7s 87s Q8s J9o K8s A9o 96s T8o AA A8o K9o Q9o A7o A6o K7s 98o J8o "
    + "K8o Q8o K6s K7o J7s Q7s 77 97o K6o Q6s Q7o J7o T7o J6s 87o Q6o T6s 96o 86s "
    + "J6o T6o 76s 86o 76o",
  limpCall: "KQs KJs KTs A9s QTo JJ QTs JTo TT QJs QQ AJs T8s ATs T9s AQs AQo KQo KJo "
    + "ATo AJo 99 QJo J9s JTs KTo A8s Q9s KK A7s J8s AKo T9o 98s K9s AA AKs A9o "
    + "A8o A6s K9o J9o Q9o A7o 88 K8s A6o Q8s K7s 98o T8o J8o K8o Q8o 97s K6s K7o "
    + "J7s T7s Q7s 77 97o 87s K6o Q6s 96s Q7o J7o T7o J6s 87o Q6o T6s 96o 86s J6o "
    + "T6o 66 76s 86o 76o",
};
const SD_ORDER_VERB = { vpip: "plays", limp: "limps", iso: "isos", "3bet": "3bets", limpRR: "limp-reraises", cc: "cold-calls", limpCall: "limp-calls" };
const SD_COMBOS = (c) => (c[0] === c[1] ? 6 : c[2] === "s" ? 4 : 12);
const SD_COMBOS_ALL = 630;
function sdTopRange(pct, order) {
  const hi = SD_COMBOS_ALL * Math.min(1, pct);
  const set = new Set();
  let cum = 0;
  for (const c of order) {
    if (cum >= hi) break;
    set.add(c);
    cum += SD_COMBOS(c);
  }
  return set;
}
/* The grid the stat implies, next to the grid of what he actually showed. */
function sdModelGrid(key, col) {
  if (!(key in SD_ORDER)) return null;
  const r = sdStatT[key + "|" + col];
  if (!r || !r[1]) return null;
  const pct = r[0] / r[1];
  const set = sdTopRange(pct, SD_ORDER[key].split(" "));
  const cells = [];
  for (let i = 0; i < RANKS.length; i++) for (let j = 0; j < RANKS.length; j++) {
    const hi = RANKS[i], lo = RANKS[j];
    const cls = i === j ? hi + hi : (i < j ? hi + lo + "s" : lo + hi + "o");
    cells.push(`<div class="rgcell${set.has(cls) ? " mdon" : ""}">${cls}</div>`);
  }
  const p = Math.round(100 * pct);
  return { cap: `Widest ${p}%`,
    note: `the ${p}% a solver ${SD_ORDER_VERB[key]} here, widest first`,
    html: `<div class="rggrid spgrid mdgrid">${cells.join("")}</div>` };
}

/* Hover strength strip: what he turned over at showdown, graded on the street the
   stat is about (the last street he played for the whole-hand ones), stopped at the
   street he went all in on. One slim bar for "did it", one for "didn't". */
const SD_ST_OF = { cbetF: "flop", fcb: "flop", rcb: "flop", fxr: "flop", cbetT: "turn", fcbT: "turn", rT: "turn", cbetR: "river", fcbR: "river", rR: "river", afR: "river" };
const SD_HS_BK = [["Air", "#4a4f57"], ["Draw", "#7d6a45"], ["Weak pair", "#a8843c"], ["Top pair+", "#d4a843"], ["Two pair", "#b3c24a"], ["Trips", "#55b85a"], ["Straight+", "#4a8fdc"]];
function sdHsBucket(h, oppId, key) {
  const i = (h.villains || []).findIndex((v) => v.opponentId === oppId), me = "v" + i;
  if (i < 0 || !hqSD(h, me)) return null;
  const hole = (h.villains[i].cards || []).filter(Boolean), board = (h.board || []).filter(Boolean);
  if (hole.length !== 2 || board.length < 3) return null;
  const ORD = ["flop", "turn", "river"], N = { flop: 3, turn: 4, river: 5 };
  let k = Math.min(ORD.indexOf(SD_ST_OF[key] || "river"), board.length - 3);
  const shut = hqAllInStreet(h, me);
  if (shut === "pre") return null;
  if (shut) k = Math.min(k, ORD.indexOf(shut));
  const b = board.slice(0, N[ORD[k]]), T = sdHsRank(hole, b);
  if (!T) return null;
  if (T.r === 0) { const d = sdDraws(hole, b); return b.length < 5 && (d.fd || d.oesd || d.gut) ? 1 : 0; }
  return T.r <= 2 ? 2 : T.r <= 4 ? 3 : T.r === 5 ? 4 : T.r === 6 ? 5 : 6;
}
function sdHsStrip(p, key) {
  const byId = new Map(HANDS.map((h) => [h.id, h]));
  const row = (ids, lbl) => {
    const n = SD_HS_BK.map(() => 0);
    for (const id of new Set(ids || [])) { const h = byId.get(id), b = h && sdHsBucket(h, curOppId, key); if (b != null) n[b]++; }
    const tot = n.reduce((a, x) => a + x, 0);
    if (!tot) return "";
    const seg = n.map((x, j) => x ? `<span style="flex:${x};background:${SD_HS_BK[j][1]}"></span>` : "").join("");
    const leg = n.map((x, j) => x ? `<span><i style="background:${SD_HS_BK[j][1]}"></i>${SD_HS_BK[j][0]} ${x}</span>` : "").join("");
    return `<div class="sphs"><div class="sphsl">${lbl} <em>${tot} shown</em></div><div class="sphsbar">${seg}</div><div class="sphsleg">${leg}</div></div>`;
  };
  return row(p.r[2], "Did it") + row(p.r[3], "Didn't");
}

/* Desktop hover: a small popover with the hands that hit, showdowns first. Touch has no hover, so it taps into the sheet. */
let stPop = null;
function stPopHide() { if (stPop) stPop.classList.add("hidden"); }
function stPopShow(el) {
  const p = statProof(el);
  if (!p) return;
  if (!stPop) { stPop = document.createElement("div"); stPop.id = "stpop"; document.body.appendChild(stPop); }
  const [sk, sc] = el.dataset.stk.split("|");
  const R = SD_PRE_KEYS.has(sk) ? sdRangeMini(p) : null;
  const M = sdModelGrid(sk, sc);
  const modelCol = M ? `<div class="spcol"><div class="spcap">${esc(M.cap)}</div>${M.html}<div class="spn">${esc(M.note)}</div></div>` : "";
  stPop.classList.toggle("wide", !!(M && R && R.known));
  if (R && R.known) {
    stPop.innerHTML = `<div class="sph"><b>${esc(p.label)}</b></div>
      <div class="spgrids"><div class="spcol"><div class="spcap">What he showed</div>${R.html}</div>${modelCol}</div>
      <div class="spn">${R.known < R.total ? `${R.known} of ${R.total} hands had his cards · ` : ""}click for the hands</div>`;
    return stPopPlace(el);
  }
  if (M) {
    stPop.innerHTML = `<div class="sph"><b>${esc(p.label)}</b></div>${modelCol}
      <div class="spn">${R ? "No hand here has his cards logged" : ""}${R ? " · " : ""}click for the hands</div>`;
    return stPopPlace(el);
  }
  const byId = new Map(HANDS.map((h) => [h.id, h]));
  const pick = (l) => [...new Set(l)].map((x) => byId.get(x)).filter(Boolean).sort(showdownFirst(curOppId));
  const hit = pick(p.r[2]), miss = pick(p.r[3]);
  const HS = p.sizing || sk === "sq" || SD_PRE_KEYS.has(sk) ? "" : sdHsStrip(p, sk);
  const show = HS ? [] : (hit.length ? hit : miss).slice(0, 4);
  const more = hit.length + miss.length - show.length;
  stPop.innerHTML = `<div class="sph"><b>${esc(p.label)}</b></div>
    ${p.split ? `<div class="spsplit">${esc(p.split)}</div>` : ""}
    ${R ? `<div class="spn">No hand here has his cards logged, so no range to show.</div>` : ""}
    ${HS}
    ${hit.length || HS ? "" : `<div class="spn">Never did it, had the chance in:</div>`}
    ${show.map((h) => handRowHTML(h, curOppId)).join("")}
    <div class="spn">${HS ? `His cards at showdown, on the ${SD_ST_OF[sk] || "last street he played"} · ` : more > 0 ? `+${more} more · ` : ""}click for all${p.sizing ? "" : ", split by did / didn't"}</div>`;
  stPopPlace(el);
}
/* Never cover the stat being read: below it, else above, else beside it — and if
   nothing fits, the roomier vertical gap with the popover clipped to that gap. */
function stPopPlace(el) {
  stPop.classList.remove("hidden");
  stPop.style.maxHeight = "";
  const M = 8, G = 6;
  const put = () => {
    const b = el.getBoundingClientRect(), w = stPop.offsetWidth, h = stPop.offsetHeight;
    const clip = (v, lim) => Math.max(0, Math.min(lim, v));        // a half-scrolled stat anchors to its visible edge
    const bt = clip(b.top, innerHeight), bb = clip(b.bottom, innerHeight);
    const bl = clip(b.left, innerWidth), br = clip(b.right, innerWidth);
    const below = innerHeight - bb - G - M, above = bt - G - M;
    const right = innerWidth - br - G - M, left = bl - G - M;
    const mid = (c, s, lim) => Math.max(M, Math.min(lim - s - M, c - s / 2));
    let x, y;
    if (h <= below || h <= above) {
      y = h <= below ? bb + G : bt - h - G;
      x = mid(b.left + b.width / 2, w, innerWidth);
    } else if (w <= right || w <= left) {
      x = w <= right ? br + G : bl - w - G;
      y = mid(b.top + b.height / 2, h, innerHeight);
    } else {
      stPop.style.maxHeight = Math.max(below, above) + "px";
      y = below >= above ? bb + G : Math.max(M, bt - stPop.offsetHeight - G);
      x = mid(b.left + b.width / 2, w, innerWidth);
    }
    stPop.style.left = x + "px"; stPop.style.top = y + "px";
  };
  put(); put();                                                   // the grids settle a few px taller once laid out
}

function renderStats(oppId, hands) {
  const host = $("od-stats");
  if (!host) return;
  const { T, n } = sdStats(oppId, hands);
  sdStatT = T;
  stPopHide();
  const g = (key, col) => T[key + "|" + col];
  $("od-statshint").textContent = n ? `${n} logged hand${n === 1 ? "" : "s"}` : "";
  if (!n) { host.innerHTML = `<div class="empty">No hands logged for this player yet.</div>`; return; }
  const hasMin = [...SD_MINR].some((k) => (g(k, "all")?.[0] || 0) > 0);
  const used = ([, k]) => !SD_MINR.has(k) || (!sdMinHide && (g(k, "all")?.[0] || 0) > 0);   // min-raise stats show only for players who do it, and only while un-hidden
  const hudBlock = (rows) => rows.filter(used).map(([l, k, c = "all"]) => {
    const r = g(k, c);
    return `<div class="stchip${r && r[1] ? " stk" : ""}${!r || r[1] < 5 ? " thin" : ""}"${r && r[1] ? ` data-stk="${k}|${c}"` : ""}><label>${esc(l)}</label><b>${r && r[1] ? Math.round((100 * r[0]) / r[1]) : "–"}</b><i>${r && r[1] ? `${r[0]}/${r[1]}` : "no data"}</i></div>`;
  }).join("");
  const seats = ["all", ...RANGE_BUCKETS];
  const table = (rows, cols, cw) => {
    const head = `<div class="strow sthead" style="--cols:${cols.length}"><div></div>${cols.map(([, l]) => `<div>${esc(l)}</div>`).join("")}</div>`;
    return head + rows.filter(used).map(([l, k]) =>
      `<div class="strow" style="--cols:${cols.length}"><div class="stlbl">${esc(l)}</div>${cols.map(([c]) => statCell(g(k, c), k, c)).join("")}</div>`).join("");
  };
  const body = statsTab === "pre"
    ? table(SD_PRE_ROWS, seats.map((s) => [s, s === "all" ? "All" : s]))
    : table(SD_POST_ROWS, SD_POST_COLS);
  host.innerHTML = `
    <div class="sthudlbl">Preflop</div>
    <div class="sthud pre4">${hudBlock(SD_HUD_PRE)}</div>
    <div class="sthudlbl">Postflop</div>
    <div class="sthud">${hudBlock(SD_HUD_POST)}</div>
    <div class="chiprow tight sttabs">
      <button class="chip mini${statsTab === "pre" ? " on" : ""}" data-sttab="pre">Preflop by seat</button>
      <button class="chip mini${statsTab === "post" ? " on" : ""}" data-sttab="post">Postflop</button>
      ${hasMin ? `<button class="ghostbtn" data-minr>${sdMinHide ? "show" : "hide"} min raises</button>` : ""}
    </div>
    <div class="sttable${statsTab === "post" ? " wlbl" : ""}">${body}</div>
    <div class="stnote">Counted only from hands you logged, so read these as tendencies, not true frequencies. Faded = under 5 chances. U8/U9 count as U7.</div>
    <details class="stdefs"><summary>How these are counted</summary>${SD_DEFS.map(([a, b]) => `<p><b>${esc(a)}</b> — ${esc(b)}</p>`).join("")}</details>`;
}

function bindStats() {
  const host = $("od-stats");
  if (matchMedia("(hover: hover)").matches) {
    for (const hh of [host, $("od-sizing")]) {
      hh.addEventListener("mouseover", (e) => { const c = e.target.closest("[data-stk]"); if (c) stPopShow(c); else stPopHide(); });
      hh.addEventListener("mouseleave", stPopHide);
    }
    addEventListener("scroll", stPopHide, { passive: true });
  }
  host.onclick = (e) => {
    const c = e.target.closest("[data-stk]");
    if (c) { stPopHide(); openStatSheet(c); return; }
    const b = e.target.closest("[data-sttab]"), m = e.target.closest("[data-minr]");
    if ((!b && !m) || !curOppId) return;
    if (m) { sdMinHide = !sdMinHide; localStorage.setItem("sd-minhide", sdMinHide ? "1" : "0"); }
    else statsTab = b.dataset.sttab;
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
  const m = madeTier(hole, board);                     // one ladder for the whole app — see app.js
  return m ? (m.value ? "V" : "B") : null;
}

const SD_SZ_STEPS = ["B33", "B50", "B66", "B75", "B100", "B150", "Jam"];
const SD_SZ_CUTS = [[0.415, "B33"], [0.58, "B50"], [0.705, "B66"], [0.875, "B75"], [1.25, "B100"], [1.6, "B150"], [Infinity, "Jam"]]   // bigger than B150 counts as a jam; a logged jam is Jam at any size;
const sdStepFor = (r) => SD_SZ_CUTS.find((c) => r < c[0])[1];
/* A raise as a share of the pot: what he put in beyond calling ÷ the pot after his call
   (so a pot-size raise is B100). → number | {skip} */
function sdRaiseRatio(h, i) {
  const a = h.actions[i];
  if (!/^\$?\d+(\.\d+)?\s*k?$/i.test(String(a.size || "").trim())) return { skip: "noAmount" };
  for (let j = 0; j < i; j++) {
    const b = h.actions[j];
    if (AGG_ACTS.includes(b.act) && b.act !== "jam" && !SD_SZ_KNOWN.test(String(b.size || "").trim())) return { skip: "noPot" };
  }
  const pe = estimatePot(h, h.actions.slice(0, i)), to = estimatePot(h, h.actions.slice(0, i + 1)).perAct;
  let faced = 0, own = 0;
  for (let j = 0; j < i; j++) {
    const b = h.actions[j];
    if (b.street !== a.street) continue;
    if (AGG_ACTS.includes(b.act)) faced = to[j] || faced;
    if (b.actor === a.actor) own = to[j] || own;
  }
  if (!(faced > 0) || !(to[i] > faced) || !(pe.now > 0)) return { skip: faced > 0 ? "badAmount" : "noPot" };
  const r = (to[i] - faced) / (pe.now + faced - own);
  return r > 0 ? r : { skip: "badAmount" };
}
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
  if (m) { const p = parseFloat(m[1]) / 100; return p > 0 ? p : { skip: "badAmount" }; }
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
  return r > 0 ? r : { skip: "badAmount" };
}

function sdSizingAuto(oppId, hands) {
  const rows = {}, ids = {}, skipped = {}, why = {};
  for (const [k] of SD_SZ_SKIPS) { skipped[k] = 0; why[k] = []; }
  let n = 0, nR = 0;
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
      const raise = acts.slice(0, i).some((b) => b.street === a.street && AGG_ACTS.includes(b.act));   // a bet already in on this street
      let step;
      if (a.act === "jam" || /^jam$/i.test(String(a.size || ""))) step = "Jam";
      else {
        const r = raise ? sdRaiseRatio(h, i) : sdBetRatio(h, i);
        if (typeof r !== "number") { miss(r.skip); continue; }
        step = sdStepFor(r);
      }
      if (raise) nR++;
      const rid = a.street + "-" + (raise ? "r" : "") + k.toLowerCase();
      const cell = (rows[rid] = rows[rid] || {});
      cell[step] = (cell[step] || 0) + 1;
      (ids[rid + "|" + step] ||= []).push(h.id);
      n++;
    }
  }
  return { rows, ids, n: n - nR, nR, skipped, why };
}

/* Columns Phil has hidden — sizes this player never uses just eat width. Kept per device. */
let sdSzHide = new Set((() => { try { return JSON.parse(localStorage.getItem("sd-szhide")) || []; } catch { return []; } })());
function sdSzSteps() {
  const s = SD_SZ_STEPS.filter((x) => !sdSzHide.has(x));
  return s.length ? s : SD_SZ_STEPS;                             // never hide everything
}
function renderSizing(oppId, hands) {
  const host = $("od-sizing");
  if (!host) return;
  const A = sdSizingAuto(oppId, hands);
  sdSzT = {};
  stPopHide();
  const skips = SD_SZ_SKIPS.filter(([k]) => A.skipped[k]).map(([k, l]) => `${A.skipped[k]} bet${A.skipped[k] === 1 ? "" : "s"}: ${l}`);
  const STS = ["flop", "turn", "river"];
  // streets: one row per street, or null = one row summing flop+turn+river (the split kept for hover / the sheet)
  const grid = (steps, pre, streets) => {
    const cols = steps.length;
    const row = (kind, sts, lbl, rid) => {
      const cell = {}, ids = {}, split = {};
      for (const st of sts) for (const x of steps) {
        const c = A.rows[st + "-" + pre + kind]?.[x] || 0;
        if (!c) continue;
        cell[x] = (cell[x] || 0) + c;
        (split[x] ||= {})[st] = c;
        (ids[x] ||= []).push(...(A.ids[st + "-" + pre + kind + "|" + x] || []));
      }
      const top = Math.max(0, ...steps.map((x) => cell[x] || 0));
      return `<div class="strow" style="--cols:${cols}"><div class="stlbl">${lbl}</div>${steps.map((x) => {
        const c = cell[x] || 0;
        if (!c) return `<div class="stc none">–</div>`;
        const key = "sz|" + rid + "|" + x;
        sdSzT[key] = [c, c, [...new Set(ids[x])], [], streets ? null : split[x]];
        return `<div class="stc stk szF sz${kind.toUpperCase()}" style="--f:${(c / top).toFixed(2)}" data-stk="${key}"><b>${c}</b></div>`;
      }).join("")}</div>`;
    };
    const K = (k) => (k === "v" ? "Value" : "Bluff");
    const head = `<div class="strow sthead" style="--cols:${cols}"><div></div>${steps.map((s) => `<div>${s}</div>`).join("")}</div>`;
    return head + (streets                                        // value next to its own bluff row, street by street
      ? STS.map((st) => ["v", "b"].map((k) => row(k, [st], `${st[0].toUpperCase() + st.slice(1)} ${K(k)}`, st + "-" + pre + k)).join("")).join(`<div class="szgap"></div>`)
      : ["v", "b"].map((k) => row(k, STS, `${K(k)} <span class="muted">F+T+R</span>`, "all-" + pre + k)).join(""));
  };
  const steps = sdSzSteps();
  const hidden = SD_SZ_STEPS.filter((x) => !steps.includes(x));
  host.innerHTML = `
    <div class="szcols">${SD_SZ_STEPS.map((x) => {
      const on = steps.includes(x);
      return `<button class="chip mini szcol${on ? " on" : ""}" data-szcol="${x}" title="${on ? "Hide" : "Show"} ${x}">${x}</button>`;
    }).join("")}${hidden.length ? `<span class="muted szcolhint">${hidden.length} hidden</span>` : ""}</div>
    <div class="szsub">His bets · % of pot${A.n ? ` · ${A.n} bet${A.n === 1 ? "" : "s"}` : ""}</div>
    <div class="sttable">${grid(steps, "", true)}</div>
    <div class="szsub">His raises · % of pot after calling${A.nR ? ` · ${A.nR} raise${A.nR === 1 ? "" : "s"}` : ""}</div>
    <div class="sttable">${grid(steps, "r", false)}</div>
    <div class="stnote">Only sizes he chose himself — a bet or raise of his own. A bet he called is the other player's sizing and isn't counted. From hands where his cards were logged, so bluffs he never showed aren't here — read the Bluff rows as a floor. Value = trips+ with his own cards, an overpair, or two pair with both his cards. On a flush board (3+ of a suit) or a four-to-a-straight board only trips+ is value, and on a paired board two pair isn't. Everything else, draws and top pair included, counts as a bluff.${
      skips.length ? `<br>Left out — ${esc(skips.join("; "))}.` : ""}</div>`;
}

/* ---------- preflop sizing: iso vs open ----------
   What he raises to when limpers are in, beside what he raises to first in. Both
   sit on the pot-relative rungs — chips beyond the call ÷ the pot once he has
   called — so a 14a iso over three limpers and a 12a over one both land on B100,
   and a rung means the same shape in either column. A raise to exactly twice the
   standing bet gets its own rung. Action pattern only: reads every hand. */
let sdSeqT = {};                                 // "sq|iso|B100" → {r:[n, of, ids, []], label}
const SD_SEQ_RUNGS = ["Min", "B33", "B50", "B66", "B75", "B100", "B150", "Jam"];

function sdOpenRatio(h, i) {
  const acts = h.actions || [], a = acts[i];
  for (let j = 0; j < i; j++) {
    const b = acts[j];                           // an earlier action with no size makes the pot a guess
    if (b.street === "pre" && AGG_ACTS.includes(b.act) && b.act !== "jam" && !SD_SZ_KNOWN.test(String(b.size || "").trim())) return null;
  }
  const pe = estimatePot(h, acts.slice(0, i)), to = estimatePot(h, acts.slice(0, i + 1)).perAct;
  const faced = pe.curBet;                       // the live ante, or the limp price
  let own = 0;
  for (let j = 0; j < i; j++) if (acts[j].street === "pre" && acts[j].actor === a.actor) own = to[j] || own;
  const amt = to[i] || 0;
  if (!(pe.now > 0) || !(faced > 0) || !(amt > faced)) return null;
  return { r: (amt - faced) / (pe.now + faced - own), min: amt <= 2 * faced + 1e-9 };
}

function sdSeqAuto(oppId, hands) {
  const out = {};                                // col → rung → ids
  const add = (col, rung, id) => ((out[col] ||= {})[rung] ||= []).push(id);
  for (const h of hands) {
    const acts = h.actions || [], V = h.villains || [];
    const i = acts.findIndex((a) => a.street === "pre" && AGG_ACTS.includes(a.act));
    if (i < 0) continue;                         // only the first raise: a size he chose freely
    const a = acts[i], m = /^v(\d+)$/.exec(String(a.actor || ""));
    const v = m && V[Number(m[1])];
    if (!v || v.opponentId !== oppId) continue;
    let rung = "Jam";
    if (!(a.act === "jam" || /^jam$/i.test(String(a.size || "")))) {
      const o = sdOpenRatio(h, i);
      if (!o) continue;
      rung = o.min ? "Min" : sdStepFor(o.r);
    }
    const limps = acts.slice(0, i).filter((x) => x.street === "pre" && x.act === "limp").length;
    if (!limps) { add("open", rung, h.id); continue; }
    add("iso", rung, h.id);
  }
  return out;
}

let sdSeqCol = "iso";
const SD_SEQ_C = { Min: "#8a93a3", B33: "#5b9fe6", B50: "#3fb3ad", B66: "#5cbf5c", B75: "#b3c24a", B100: "#e0a93e", B150: "#e46e3e", Jam: "#d8475c" };
/* A hand chart per column: every iso (or open) whose hole cards are on record, the cell
   painted in the size he chose — split when one hand class went in at two sizes. */
function renderSeq(oppId, hands) {
  const host = $("od-seq");
  if (!host) return;
  const A = sdSeqAuto(oppId, hands);
  sdSeqT = {};
  stPopHide();
  const tot = (k) => SD_SEQ_RUNGS.reduce((n, x) => n + (A[k]?.[x]?.length || 0), 0);
  if (!tot("iso") && !tot("open")) { host.innerHTML = `<div class="stnote">No isos or opens logged yet.</div>`; return; }
  if (!tot(sdSeqCol)) sdSeqCol = tot("iso") ? "iso" : "open";
  const k = sdSeqCol, T = tot(k), lbl = k === "iso" ? "Iso" : "Open";
  const byId = new Map(hands.map((h) => [h.id, h]));
  const cell = {};
  let known = 0;
  for (const x of SD_SEQ_RUNGS) for (const id of A[k]?.[x] || []) {
    const v = (byId.get(id)?.villains || []).find((y) => y.opponentId === oppId), hc = v && handClass(v.cards);
    if (!hc) continue;
    known++;
    const c = cell[hc] ||= { n: 0, r: {}, ids: [] };
    c.n++; c.r[x] = (c.r[x] || 0) + 1; c.ids.push(id);
  }
  const tabs = [["iso", "Iso"], ["open", "Open"]].map(([c, l]) =>
    `<button class="chip mini${c === k ? " on" : ""}" data-sqcol="${c}"${tot(c) ? "" : " disabled"}>${l} · ${tot(c)}</button>`).join("");
  const leg = SD_SEQ_RUNGS.filter((x) => A[k]?.[x]?.length).map((x) => {
    const ids = A[k][x], key = `sq|${k}|${x}`;
    sdSeqT[key] = { r: [ids.length, T, ids, []], label: `${lbl} · ${x} · ${ids.length}/${T}` };
    return `<button class="sqleg stk" data-stk="${key}"><i style="background:${SD_SEQ_C[x]}"></i>${x} <b>${Math.round((100 * ids.length) / T)}%</b><em>${ids.length}</em></button>`;
  }).join("");
  const cells = [];
  for (let i = 0; i < RANKS.length; i++) for (let j = 0; j < RANKS.length; j++) {
    const hi = RANKS[i], lo = RANKS[j];
    const cls = i === j ? hi + hi : (i < j ? hi + lo + "s" : lo + hi + "o");
    const c = cell[cls];
    if (!c) { cells.push(`<div class="rgcell">${cls}</div>`); continue; }
    const rs = SD_SEQ_RUNGS.filter((x) => c.r[x]);
    let at = 0;
    const bg = rs.length === 1 ? SD_SEQ_C[rs[0]]
      : `linear-gradient(90deg,${rs.map((x) => { const s = at; at += (100 * c.r[x]) / c.n; return `${SD_SEQ_C[x]} ${s}% ${at}%`; }).join(",")})`;
    const key = `sq|${k}|${cls}`;
    sdSeqT[key] = { r: [c.n, c.n, c.ids, []], label: `${lbl} with ${cls} · ${rs.map((x) => `${x}${c.r[x] > 1 ? " ×" + c.r[x] : ""}`).join(", ")}` };
    cells.push(`<div class="rgcell on stk" data-stk="${key}" style="background:${bg}">${cls}${c.n > 1 ? `<span class="rgn">${c.n}</span>` : ""}</div>`);
  }
  host.innerHTML = `<div class="chiprow tight sttabs">${tabs}</div>
    <div class="sqlegs">${leg}</div>
    <div class="rggrid sqgrid">${cells.join("")}</div>
    <div class="stnote">${known < T ? `${known} of ${T} ${k === "iso" ? "isos" : "opens"} had his cards logged — only those are on the chart; the shares above count all ${T}. ` : ""}<b>Iso</b> is his raise over limpers, <b>Open</b> his raise first in. Sizes are pot-relative — chips beyond the call ÷ the pot once he has called — and <b>Min</b> is exactly twice the standing bet. Only the first raise of the hand counts. Tap a cell or a size for the hands.</div>`;
}

function bindSeq() {
  $("od-seq").onclick = (e) => {
    const t = e.target.closest("[data-sqcol]");
    if (t && curOppId) { sdSeqCol = t.dataset.sqcol; renderSeq(curOppId, HANDS.filter((h) => (h.villainIds || []).includes(curOppId))); return; }
    const c = e.target.closest("[data-stk]");
    if (c) { stPopHide(); openStatSheet(c); }
  };
  if (matchMedia("(hover: hover)").matches) {
    const hh = $("od-seq");
    hh.addEventListener("mouseover", (e) => { const c = e.target.closest("[data-stk]"); if (c) stPopShow(c); else stPopHide(); });
    hh.addEventListener("mouseleave", stPopHide);
  }
}

function bindSizing() {
  $("od-sizing").onclick = (e) => {
    const pc = e.target.closest("[data-stk]");
    if (pc) { stPopHide(); openStatSheet(pc); return; }
    const cb = e.target.closest("[data-szcol]");
    if (!cb || !curOppId) return;
    const x = cb.dataset.szcol;
    if (sdSzHide.has(x)) sdSzHide.delete(x);
    else if (sdSzSteps().length > 1) sdSzHide.add(x);              // the last column stays
    else return;
    try { localStorage.setItem("sd-szhide", JSON.stringify([...sdSzHide])); } catch {}
    stPopHide();
    renderSizing(curOppId, HANDS.filter((h) => (h.villainIds || []).includes(curOppId)));
  };
}
