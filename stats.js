/* Per-opponent stats (HUD) counted from the hands Phil logged. Loaded after app.js:
   uses its globals (isAgg, handWinner, rangeBucketOf, RANGE_BUCKETS, esc, $) at call time.
   A stat is always [hits, chances]; the UI shows the raw x/y next to every percentage,
   because the sample is only the hands he chose to log. */

const SD_MINR_X = 2;                             // a raise up to this many times the bet it raises is a min-raise (5% slack for rounded sizes)
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
    const min = a.street === "pre" && isAgg(a.act) && !!a.size && lastTo > 0 && to[ai] > 0 && to[ai] <= SD_MINR_X * lastTo * 1.05;
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
      if (f.limpsBefore > 0) put("iso", pc, isAgg(f.act));
      else { put("open", pc, isAgg(f.act) && !f.min); put("minOpen", pc, isAgg(f.act) && f.min); }
    } else {
      if (f.aggBefore === 1) { put("cc", pc, f.act === "call"); put("3bet", pc, isAgg(f.act) && !f.min); put("min3bet", pc, isAgg(f.act) && f.min); }
    }
    if (f.act === "limp") {
      const r = pre.slice(1).find((x) => x.aggBefore > 0);          // his answer to a raise behind his limp
      if (r) { put("limpRR", pc, isAgg(r.act)); put("limpCall", pc, r.act === "call"); }
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
        const R = F.find((x) => x.i > f1.i && x.actor !== me && isAgg(x.act));      // his cbet got raised
        const r = R && F.find((x) => x.actor === me && x.i > R.i);
        if (r) put("fxr", cols, r.act === "fold");
      }
    }
    if (pfa && pfa !== me) {
      const A = F.find((x) => isAgg(x.act));
      if (A && A.actor === pfa) {                                    // the first flop bet was the raiser's: a cbet
        const r = F.find((x) => x.actor === me && x.i > A.i);
        if (r) { put("fcb", cols, r.act === "fold"); put("ccb", cols, r.act === "call"); put("rcb", cols, isAgg(r.act)); }
        if (r && r.act === "call") {                                 // called the flop cbet: his answer to the raiser's turn barrel
          const T = seq.turn, B = T.find((x) => isAgg(x.act));
          const r2 = B && B.actor === pfa && T.find((x) => x.actor === me && x.i > B.i);
          if (r2) put("fcbT", colsAt(2), r2.act === "fold");
        }
      }
      const fp = F.find((x) => x.actor === pfa);
      if (fp && f1.i < fp.i && f1.aggBefore === 0) put("donk", cols, isAgg(f1.act));
    }
    const ci = mf.findIndex((x) => x.act === "check");
    if (ci >= 0 && mf[ci + 1] && mf[ci + 1].aggBefore > 0) put("cr", cols, isAgg(mf[ci + 1].act));
  }
  for (const [st, si, key] of [["turn", 2, "rT"], ["river", 3, "rR"]]) {    // his first answer to someone else's bet on the street
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
const SD_HUD = [["VPIP", "vpip"], ["Iso", "iso"], ["Min open", "minOpen"], ["Limp", "limp"], ["CC", "cc"], ["3bet", "3bet"], ["Min 3bet", "min3bet"], ["Fold 3bet", "f3bet"], ["Limp-call", "limpCall"],
  ["Cbet flop", "cbetF"], ["Cbet turn", "cbetT"], ["Fold cbet", "fcb"], ["Fold T-cbet", "fcbT"], ["Raise flop", "rcb"], ["Raise turn", "rT"], ["Raise river", "rR"], ["Check-raise", "cr"], ["AFq", "afq"], ["WTSD", "wtsd"], ["W$SD", "wsd"]];
const SD_PRE_ROWS = [["VPIP", "vpip"], ["Iso", "iso"], ["Min open", "minOpen"], ["Limp", "limp"], ["CC", "cc"], ["LRR", "limpRR"], ["Limp-call", "limpCall"], ["3bet", "3bet"], ["Min 3bet", "min3bet"]];
const SD_POST_ROWS = [["Cbet flop", "cbetF"], ["Cbet turn", "cbetT"], ["Fold to cbet", "fcb"], ["Call cbet", "ccb"], ["Fold to turn cbet", "fcbT"], ["Raise flop", "rcb"], ["Raise turn", "rT"], ["Raise river", "rR"], ["Check-raise", "cr"], ["Donk lead", "donk"]];
const SD_POST_COLS = [["all", "All"], ["ip", "HU IP"], ["oop", "HU OOP"], ["mw", "MW"]];
const SD_DEFS = [
  ["VPIP", "VPIP: put chips in at any point preflop, out of the hands where he acted preflop."],
  ["Limp", "First action was a limp, out of hands where no raise was out before he acted. Not counted on the button: his double ante is already in, so he can only check or raise."],
  ["CC", "Cold call: his first action was flat-calling a single raise, out of hands where exactly one raise was in front of him. Calls of a 3bet or squeeze don't count."],
  ["Min open", "First in (nobody had limped or raised) with a raise of at most 2× the ante, out of hands where he was first in."],
  ["3bet · Min 3bet", "Re-raised a single open, out of hands where he faced one. A min 3bet is at most double the open; those are counted only in Min 3bet, never in 3bet. A raise with no size logged counts as a normal raise."],
  ["Iso", "Raised over one or more limpers, out of hands with limpers and no raise yet."],
  ["LRR · Limp-call", "After he limped and a raise came behind: re-raised / called, out of limps that faced a raise (his answer must be logged)."],
  ["Fold 3bet", "After he raised first and got 3bet: folded."],
  ["Cbet flop", "The last preflop raiser bet the flop when nobody had bet before him."],
  ["Cbet turn", "Bet the turn after cbetting the flop, out of turns where he acted first."],
  ["Fold / Call / Raise vs cbet", "His first answer to a flop bet from the preflop raiser (Raise flop = the raise)."],
  ["Fold to turn cbet", "He called the raiser's flop cbet, then the raiser bet the turn too: folded, out of those turn barrels he faced."],
  ["Raise turn / river", "His first action facing someone else's single bet on that street: raised, out of the times he faced one (folds and calls are the rest). Includes check-raises."],
  ["Check-raise", "Checked the flop, faced a bet, raised."],
  ["Donk lead", "Bet the flop into the preflop raiser before they acted."],
  ["HU IP / HU OOP / MW", "Heads-up in or out of position against the one other player who saw that street, or three-plus players. Only players you logged in the hand are counted."],
  ["AFq", "Postflop bets and raises out of bets, raises and calls."],
  ["WTSD / W$SD", "Went to showdown out of flops seen / won it (needs both hands and the board logged). Hands still unfinished are skipped."],
];

let sdStatT = {};                                // the tallies behind the stats now on screen
let sdSzT = {};                                  // same for the sizing grid: "sz|flop-v|B50" → [n, n, handIds, []]
const SD_EXTRA_ROWS = [["Fold to flop raise", "fxr"], ["River AF", "afR"]];
const SD_COL_LBL = { all: "", mw: "multiway", ip: "HU IP", oop: "HU OOP" };

function statCell(r, k, c) {
  if (!r || !r[1]) return `<div class="stc none">–</div>`;
  return `<div class="stc stk${r[1] < 5 ? " thin" : ""}" data-stk="${k}|${c}"><b>${Math.round((100 * r[0]) / r[1])}</b><i>${r[0]}/${r[1]}</i></div>`;
}

/* Tap a stat → the hands behind it, split into "did it" and "had the chance, didn't". */
function statProof(el) {
  const key = el.dataset.stk, r = sdStatT[key] || sdSzT[key];
  if (!r || !curOppId) return null;
  const [k, c, step] = key.split("|");
  if (k === "sz") {
    const [st, kind] = c.split("-"), rz = kind[0] === "r", vb = kind.slice(-1) === "v" ? "value" : "bluff";
    const split = r[4] && ["flop", "turn", "river"].map((x) => `${x[0].toUpperCase() + x.slice(1)} ${r[4][x] || 0}`).join(" · ");
    const what = st === "all" ? vb[0].toUpperCase() + vb.slice(1) : `${st[0].toUpperCase() + st.slice(1)} ${vb}`;
    return { r, sizing: true, split, label: `${what} ${rz ? "raise" : "bet"} · ${step} · ${r[0]} ${rz ? "raise" : "bet"}${r[0] === 1 ? "" : "s"}` };
  }
  const name = [...SD_HUD, ...SD_PRE_ROWS, ...SD_POST_ROWS, ...SD_EXTRA_ROWS].find(([, kk]) => kk === k)?.[0] || k;
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

/* Desktop hover: a small popover with the hands that hit, showdowns first. Touch has no hover, so it taps into the sheet. */
let stPop = null;
function stPopHide() { if (stPop) stPop.classList.add("hidden"); }
function stPopShow(el) {
  const p = statProof(el);
  if (!p) return;
  if (!stPop) { stPop = document.createElement("div"); stPop.id = "stpop"; document.body.appendChild(stPop); }
  const R = SD_PRE_KEYS.has(el.dataset.stk.split("|")[0]) ? sdRangeMini(p) : null;
  if (R && R.known) {
    stPop.innerHTML = `<div class="sph"><b>${esc(p.label)}</b></div>${R.html}
      <div class="spn">${R.known < R.total ? `${R.known} of ${R.total} hands had his cards · ` : ""}click for the hands</div>`;
    return stPopPlace(el);
  }
  const byId = new Map(HANDS.map((h) => [h.id, h]));
  const pick = (l) => [...new Set(l)].map((x) => byId.get(x)).filter(Boolean).sort(showdownFirst(curOppId));
  const hit = pick(p.r[2]), miss = pick(p.r[3]);
  const show = (hit.length ? hit : miss).slice(0, 4);
  const more = hit.length + miss.length - show.length;
  stPop.innerHTML = `<div class="sph"><b>${esc(p.label)}</b></div>
    ${p.split ? `<div class="spsplit">${esc(p.split)}</div>` : ""}
    ${R ? `<div class="spn">No hand here has his cards logged, so no range to show.</div>` : ""}
    ${hit.length ? "" : `<div class="spn">Never did it, had the chance in:</div>`}
    ${show.map((h) => handRowHTML(h, curOppId)).join("")}
    <div class="spn">${more > 0 ? `+${more} more · ` : ""}click for all${p.sizing ? "" : ", split by did / didn't"}</div>`;
  stPopPlace(el);
}
function stPopPlace(el) {
  stPop.classList.remove("hidden");
  const b = el.getBoundingClientRect(), w = stPop.offsetWidth, hgt = stPop.offsetHeight;
  const x = Math.max(8, Math.min(innerWidth - w - 8, b.left + b.width / 2 - w / 2));
  const y = b.bottom + 6 + hgt > innerHeight ? Math.max(8, b.top - hgt - 6) : b.bottom + 6;
  stPop.style.left = x + "px"; stPop.style.top = y + "px";
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
  const used = ([, k]) => !SD_MINR.has(k) || (g(k, "all")?.[0] || 0) > 0;     // min-raise stats only show for players who do it
  const hud = SD_HUD.filter(used).map(([l, k]) => {
    const r = g(k, "all");
    return `<div class="stchip${r && r[1] ? " stk" : ""}${!r || r[1] < 5 ? " thin" : ""}"${r && r[1] ? ` data-stk="${k}|all"` : ""}><label>${esc(l)}</label><b>${r && r[1] ? Math.round((100 * r[0]) / r[1]) : "–"}</b><i>${r && r[1] ? `${r[0]}/${r[1]}` : "no data"}</i></div>`;
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
  const m = madeTier(hole, board);                     // one ladder for the whole app — see app.js
  return m ? (m.value ? "V" : "B") : null;
}

const SD_SZ_STEPS = ["B33", "B50", "B66", "B75", "B100", "B150", "Jam"];
const SD_SZ_CUTS = [[0.415, "B33"], [0.58, "B50"], [0.705, "B66"], [0.875, "B75"], [1.25, "B100"], [Infinity, "B150"]];
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
        return `<div class="stc stk${c === top ? " szTop" : ""}" data-stk="${key}"><b>${c}</b></div>`;
      }).join("")}</div>`;
    };
    const K = (k) => (k === "v" ? "Value" : "Bluff");
    return `<div class="strow sthead" style="--cols:${cols}"><div></div>${steps.map((s) => `<div>${s}</div>`).join("")}</div>` + ["v", "b"].map((k) => streets
      ? STS.map((st) => row(k, [st], `${st[0].toUpperCase() + st.slice(1)} ${K(k)}`, st + "-" + pre + k)).join("")
      : row(k, STS, `${K(k)} <span class="muted">F+T+R</span>`, "all-" + pre + k)).join(streets ? `<div class="szgap"></div>` : "");
  };
  host.innerHTML = `
    <div class="szsub">Bets · % of pot${A.n ? ` · ${A.n} bet${A.n === 1 ? "" : "s"}` : ""}</div>
    <div class="sttable">${grid(SD_SZ_STEPS, "", true)}</div>
    <div class="szsub">Raises · % of pot after calling${A.nR ? ` · ${A.nR} raise${A.nR === 1 ? "" : "s"}` : ""}</div>
    <div class="sttable">${grid(SD_SZ_STEPS, "r", false)}</div>
    <div class="stnote">From hands where his cards were logged, so bluffs he never showed aren't here — read the Bluff rows as a floor. Value = trips+ with his own cards, an overpair, or two pair with both his cards. On a flush board (3+ of a suit) or a four-to-a-straight board only trips+ is value, and on a paired board two pair isn't. Everything else, draws and top pair included, counts as a bluff.${
      skips.length ? `<br>Left out — ${esc(skips.join("; "))}.` : ""}</div>`;
}

function bindSizing() {
  $("od-sizing").onclick = (e) => {
    const pc = e.target.closest("[data-stk]");
    if (pc) { stPopHide(); openStatSheet(pc); }
  };
}
