/* db.js — promise-wrapped IndexedDB + JSON export/import (the only backup path). */

const DB_NAME = "shortdeck-journal";
const DB_VERSION = 1;
let _db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const opp = db.createObjectStore("opponents", { keyPath: "id" });
      opp.createIndex("name", "name");
      const hands = db.createObjectStore("hands", { keyPath: "id" });
      hands.createIndex("sessionId", "sessionId");
      hands.createIndex("ts", "ts");
      hands.createIndex("villainIds", "villainIds", { multiEntry: true });
      const ses = db.createObjectStore("sessions", { keyPath: "id" });
      ses.createIndex("startedAt", "startedAt");
      db.createObjectStore("meta", { keyPath: "key" });
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function _tx(store, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = _db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/* Stores whose writes trigger an auto-backup snapshot. */
const AUTOSNAP_STORES = new Set(["opponents", "hands", "sessions"]);
const dbPut = async (store, obj) => {
  const r = await _tx(store, "readwrite", (s) => s.put(obj));
  if (AUTOSNAP_STORES.has(store)) scheduleAutoSnapshot();
  return r;
};
const dbGet = (store, id) => _tx(store, "readonly", (s) => s.get(id));
const dbAll = (store) => _tx(store, "readonly", (s) => s.getAll());
const dbDel = async (store, id) => {
  const r = await _tx(store, "readwrite", (s) => s.delete(id));
  if (AUTOSNAP_STORES.has(store)) scheduleAutoSnapshot();
  return r;
};
const dbByIndex = (store, index, value) =>
  _tx(store, "readonly", (s) => s.index(index).getAll(value));

/* Small-meta values (blinds default, lineup, seats, collapsed groups, last export)
   also mirror to localStorage as a survival copy — if iOS Safari nukes IDB,
   the app still boots with the user's live-game context intact. Big values
   (autoSnapshot with full JSON dump) skip the mirror to stay under the quota. */
const META_MIRROR_MAX_BYTES = 8000;
const _mirrorKey = (k) => "sdj.meta." + k;
function _mirrorSet(key, value) {
  try {
    const s = JSON.stringify(value);
    if (s.length > META_MIRROR_MAX_BYTES) { localStorage.removeItem(_mirrorKey(key)); return; }
    localStorage.setItem(_mirrorKey(key), s);
  } catch {}
}
function _mirrorGet(key) {
  try { const s = localStorage.getItem(_mirrorKey(key)); return s == null ? null : JSON.parse(s); }
  catch { return null; }
}
const metaGet = async (key) => {
  const idbVal = (await dbGet("meta", key))?.value;
  if (idbVal != null) return idbVal;
  const mirror = _mirrorGet(key);
  if (mirror != null) { dbPut("meta", { key, value: mirror }).catch(() => {}); return mirror; }
  return null;
};
const metaSet = (key, value) => { _mirrorSet(key, value); return dbPut("meta", { key, value }); };

const uid = () => (crypto.randomUUID ? crypto.randomUUID()
  : Date.now().toString(36) + Math.random().toString(36).slice(2));

/* ---------- export / import ---------- */

/* At-table context worth restoring onto a fresh/second device (lineup, seats,
   ante default, group UI state). Deliberately EXCLUDES autoSnapshot (a full DB
   dump — would nest) and draftHand (transient crash-recovery only). */
const EXPORT_META_KEYS = ["tableLineup", "lineupSeats", "defaultBlinds", "pinnedGroup", "collapsedGroups", "openSizeStats"];
async function exportData() {
  const [opponents, hands, sessions, metaRows] = await Promise.all(
    ["opponents", "hands", "sessions", "meta"].map(dbAll));
  const meta = metaRows.filter((r) => EXPORT_META_KEYS.includes(r.key));
  return { app: "shortdeck-journal", version: 1, exportedAt: Date.now(), opponents, hands, sessions, meta };
}

/* Silent auto-backup: after any mutation, stash a fresh full export snapshot
   into meta.autoSnapshot. Debounced so rapid edits don't hammer IDB. Doesn't
   write a file (iOS Safari can't without a tap) — that's what "Save auto-
   backup" does. */
let _snapPending = null;   // debounce timer id
let _snapArmed = false;    // a mutation is waiting for its snapshot
async function autoSnapshot() {
  const data = await exportData();
  const meta = { ts: Date.now(), counts: { opponents: data.opponents.length, hands: data.hands.length, sessions: data.sessions.length } };
  try {
    await metaSet("autoSnapshot", { ...meta, data });
  } catch (e) {
    // The whole-DB snapshot is the first write to fail under storage pressure.
    // The mutation's own dbPut already persisted the real data, so don't crash —
    // warn so Phil exports a real backup before a genuine journal write throws.
    if (e && e.name === "QuotaExceededError" && typeof toast === "function")
      toast("Storage full — export a backup now", 6000);
  }
}
/* Run at idle so the whole-DB serialize never blocks a table interaction; fall
   back to a microtask-ish timeout where requestIdleCallback is unavailable. */
const _idle = typeof requestIdleCallback === "function"
  ? (fn) => requestIdleCallback(fn, { timeout: 2000 })
  : (fn) => setTimeout(fn, 0);
/* Take the queued snapshot exactly once: whoever reaches here first — the idle
   callback or a pagehide flush — claims it by clearing _snapArmed; the loser no-ops. */
function _runSnap() {
  if (!_snapArmed) return;
  _snapArmed = false;
  return autoSnapshot().catch(() => {});
}
function scheduleAutoSnapshot() {
  _snapArmed = true;
  clearTimeout(_snapPending);
  // Long debounce (~2.5s): the snapshot is only a redundant restore copy — the
  // mutation's dbPut already persisted the data, and boot re-arms if it's >60s stale.
  _snapPending = setTimeout(() => { _snapPending = null; _idle(_runSnap); }, 2500);
}
/* Force a queued snapshot to run now — called from the app's pagehide/hidden
   flush so a pending snapshot isn't lost when the PWA is backgrounded. _snapArmed
   stays set until the snapshot actually runs, so a flush landing in the post-debounce
   idle window still catches it (the idle callback then finds nothing to do). */
function flushAutoSnapshot() {
  if (!_snapArmed) return;
  clearTimeout(_snapPending); _snapPending = null;
  return _runSnap();
}
/* Share/download an already-prepared export blob. Returns false on user cancel.
   Tries Web Share (iOS/Android native sheet) first, falls back to an <a download>
   anchor click for any non-cancel error — some installed PWAs report canShare
   as true but block the actual share call. Final fallback: open the JSON in a
   new tab so the user can save it manually (works even when downloads are
   blocked in the standalone PWA context). */
async function shareBackupData(data) {
  const stamp = new Date().toISOString().slice(0, 10);
  const name = `shortdeck-journal-${stamp}.json`;
  const json = JSON.stringify(data);
  const file = new File([json], name, { type: "application/json" });
  const downloadAnchor = () => {
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url; a.download = name; a.rel = "noopener";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };
  let shared = false;
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); shared = true; }
    catch (e) {
      if (e && e.name === "AbortError") return false;
      // Any other share failure (NotAllowed, permission, unsupported host):
      // fall through to the classic download anchor.
    }
  }
  if (!shared) {
    try { downloadAnchor(); }
    catch (e) {
      // Last resort: open the JSON in a new tab as a blob URL so the user
      // can manually save it with Cmd/Ctrl+S. Some standalone PWAs disable
      // both the share sheet and blob-anchor downloads.
      const url = URL.createObjectURL(file);
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
  }
  await metaSet("lastExportAt", Date.now());
  return true;
}
async function exportJSON() { return shareBackupData(await exportData()); }

const normName = (s) => (s || "").trim().toLowerCase();
const dedupeById = (arr) => {   // id-less notes/exploits (hand-authored/legacy JSON) keyed by ts+text so a merge never silently drops them
  const seen = new Set();
  return arr.filter((x) => {
    if (!x) return false;
    const k = x.id || ("ts" + (x.ts || 0) + "|" + (x.text || ""));
    return !seen.has(k) && seen.add(k);
  });
};
const recReads = (o) => o.reads && typeof o.reads === "object" ? o.reads
  : (Array.isArray(o.tags) ? Object.fromEntries(o.tags.map((id) => [id, "yes"])) : {});

/* Ranges used to be keyed by coarse bucket (EP/MP/BTN); now by seat (U7 U6 U5 U4 HJ CO BN).
   EP → U7+U6, MP → U5+U4, BTN → BN, copied without overwriting anything already painted. */
const RANGE_MIGRATE = { EP: ["U7", "U6"], MP: ["U5", "U4"], BTN: ["BN"] };
function migrateRanges(o) {
  if (!o || !o.ranges) return false;
  let changed = false;
  for (const [old, seats] of Object.entries(RANGE_MIGRATE)) {
    const src = o.ranges[old];
    if (!src) continue;
    for (const seat of seats) {
      const dst = (o.ranges[seat] ||= {});
      for (const [sit, cells] of Object.entries(src)) dst[sit] = { ...cells, ...(dst[sit] || {}) };
    }
    delete o.ranges[old];
    changed = true;
  }
  return changed;
}

/* Fold incoming opponent `from` into existing `into` (union; survivor keeps identity). */
function mergeOppRecords(into, from) {
  const ir = (into.reads = recReads(into)), fr = recReads(from);
  for (const [k, st] of Object.entries(fr)) if (!ir[k]) ir[k] = st;   // survivor wins conflicts
  into.notes = dedupeById([...(into.notes || []), ...(from.notes || [])]).sort((a, b) => (b.ts || 0) - (a.ts || 0));
  into.exploits = dedupeById([...(into.exploits || []), ...(from.exploits || [])]).sort((a, b) => (b.ts || 0) - (a.ts || 0));
  into.exploitDismissed = [...new Set([...(into.exploitDismissed || []), ...(from.exploitDismissed || [])])];
  into.readDismissed = [...new Set([...(into.readDismissed || []), ...(from.readDismissed || [])])];
  if (from.hiddenReads || into.hiddenReads)
    into.hiddenReads = { ...(from.hiddenReads || {}), ...(into.hiddenReads || {}) };
  if (!(into.featured || []).length && (from.featured || []).length) into.featured = from.featured;
  migrateRanges(into); migrateRanges(from);
  if (from.ranges) {                       // per-bucket/situation union; survivor wins painted cells
    into.ranges = into.ranges || {};
    for (const [b, sits] of Object.entries(from.ranges))
      for (const [sit, cells] of Object.entries(sits || {}))
        ((into.ranges[b] ||= {})[sit] = { ...cells, ...(into.ranges[b][sit] || {}) });
  }
  if (!into.group && from.group) into.group = from.group;
  if (!into.physical && from.physical) into.physical = from.physical;
  if (!into.type && from.type) into.type = from.type;
  if (into.aliases || from.aliases) {
    const seen = new Set([normName(into.name)]);
    into.aliases = [...(into.aliases || []), ...(from.aliases || [])]
      .filter((a) => a && !seen.has(normName(a)) && seen.add(normName(a)));
  }
  if (!into.createdAt && from.createdAt) into.createdAt = from.createdAt;
  into.updatedAt = Date.now();
}

/* Merge by id (newer wins); when an incoming opponent's id is new but its NAME
   uniquely matches an existing profile — or a name Phil merged away, kept as an
   alias — fold it in and remap its hands' villain refs, so re-logging hands for
   an existing opponent never spawns a duplicate or brings a merged one back.
   A hand file (no `meta`: extractor output, not another device's backup) never
   renames a profile — the journal's current name stands.
   Never wipes existing data. */
/* Short deck only: a 2–5 anywhere, small/big blinds, or a blind/straddle post means it's NLHE. */
const NLHE_ACTS = new Set(["sb", "bb", "post", "straddle"]);
function isNlheHand(h) {
  const cards = [...(h.heroCards || []), ...(h.board || []), ...(h.villains || []).flatMap((v) => v.cards || []),
    ...(h.hero?.cards || []), ...(h.winners || []).flatMap((w) => w.cards || [])];
  if (cards.some((c) => /^[2-5]/.test(String(c || "").trim()))) return true;
  if (h.blinds && (Number(h.blinds.sb) > 0 || Number(h.blinds.bb) > 0)) return true;
  return (h.actions || []).some((a) => NLHE_ACTS.has(a.act) || a.actor === "straddle");
}

/* Fill the stack fields a stored hand lacks from an incoming copy of the same
   hand, and touch nothing else. A stored hand usually wins on updatedAt — an
   opponent merge or a note bumps it — so a corrected file never replaced it and
   its stacks stayed blank. Only empty fields are filled: a value already there
   is never overwritten. Seats pair by position; the action list only when both
   copies have the same street/actor sequence (act names may differ — the
   journal renames an imported first "raise" to "bet"). Returns fields filled. */
const hasVal = (x) => x != null && x !== "";
function fillStacks(h, rec) {
  let n = 0;
  if (!hasVal(h.effStack) && hasVal(rec.effStack)) { h.effStack = rec.effStack; n++; }
  if (!hasVal(h.heroChips) && hasVal(rec.heroChips)) { h.heroChips = rec.heroChips; n++; }
  const hv = h.villains || [], rv = rec.villains || [];
  hv.forEach((v, i) => {
    if (!v || hasVal(v.chips)) return;
    const src = v.pos ? rv.find((r) => r && r.pos === v.pos) : (rv.length === hv.length ? rv[i] : null);
    if (src && hasVal(src.chips)) { v.chips = src.chips; n++; }
  });
  const ha = h.actions || [], ra = rec.actions || [];
  if (ha.length === ra.length && ha.every((a, i) => a && ra[i] && a.street === ra[i].street && a.actor === ra[i].actor))
    ha.forEach((a, i) => { if (!hasVal(a.stack) && hasVal(ra[i].stack)) { a.stack = ra[i].stack; n++; } });
  return n;
}
/* One key per real-world hand, so a hand that came in through the bulk sheet
   (its own id) and again in a DX file (dxh- id) is known to be the same one.
   DX round ids carry the table and second, so they stand alone; others need
   the table too. */
const roundKey = (h) => {
  const im = h && h.imported;
  if (!im || !im.roundId) return null;
  return /^DX/.test(im.roundId) ? im.roundId : `${im.tableId || ""}|${im.roundId}`;
};

async function importJSON(data) {
  if (data && data.app === "poker-journal")
    throw new Error("that's an NLHE (poker-journal) file — this journal is short deck only");
  if (!data || data.app !== "shortdeck-journal" || !Array.isArray(data.opponents))
    throw new Error("Not a shortdeck-journal export file");
  const counts = { opponents: 0, merged: 0, hands: 0, sessions: 0, nlhe: 0 };
  const nlhe = (data.hands || []).filter(isNlheHand);
  if (nlhe.length) {
    const inSD = new Set((data.hands || []).filter((h) => !isNlheHand(h)).flatMap((h) => h.villainIds || []));
    const onlyNL = new Set(nlhe.flatMap((h) => h.villainIds || []).filter((id) => !inSD.has(id)));
    const known = new Set((await dbAll("opponents")).map((o) => o.id));
    // opponents who only appear in the rejected hands, brought in by this file with nothing of their own, stay out too
    const bare = (o) => !Object.keys(o.reads || {}).length && !(o.exploits || []).length && !(o.notes || []).length;
    data = { ...data, hands: data.hands.filter((h) => !isNlheHand(h)),
      opponents: data.opponents.filter((o) => !(onlyNL.has(o.id) && !known.has(o.id) && bare(o))) };
    counts.nlhe = nlhe.length;
    if (!data.hands.length && !data.opponents.length)
      throw new Error(`${nlhe.length} NLHE hand${nlhe.length === 1 ? "" : "s"} — this journal is short deck only, nothing imported`);
  }

  const log = { opponents: {}, hands: {}, sessions: {}, meta: [] };
  const note = (store, id, prev) => { if (!(id in log[store])) log[store][id] = prev ? structuredClone(prev) : null; };
  const existing = await dbAll("opponents");
  const nameCount = {};
  for (const o of existing) nameCount[normName(o.name)] = (nameCount[normName(o.name)] || 0) + 1;
  const nameToId = {};                       // only NON-BLANK names unique among existing profiles
  for (const o of existing) { const n = normName(o.name); if (n && nameCount[n] === 1) nameToId[n] = o.id; }
  const aliasCount = {}, aliasToId = {};     // names absorbed by a merge, unique ones only
  for (const o of existing)
    for (const a of new Set((o.aliases || []).map(normName).filter(Boolean))) {
      aliasCount[a] = (aliasCount[a] || 0) + 1;
      aliasToId[a] = o.id;
    }
  const matchName = (n) => {
    if (!n) return null;                                   // never name-merge blank-named records
    if (nameCount[n]) return nameToId[n] || null;          // a live profile's name beats any alias
    return aliasCount[n] === 1 ? aliasToId[n] : null;
  };
  const handFile = !data.meta;               // extractor output, not another device's backup
  const existingIds = new Set(existing.map((o) => o.id));
  const remap = {};                          // incoming id -> surviving id

  for (const rec of data.opponents) {
    if (!rec.id) continue;
    if (existingIds.has(rec.id)) {
      // Same profile edited on two devices: the newer record keeps identity
      // fields (name, reads conflicts), but reads/exploits/notes union from
      // both — an import must never drop the other device's additions.
      const cur = await dbGet("opponents", rec.id);
      if (!cur) { note("opponents", rec.id, null); await dbPut("opponents", rec); counts.opponents++; continue; }
      note("opponents", rec.id, cur);
      // A hand file never renames a profile: the journal's current name stands.
      const [into, from] = !handFile && (rec.updatedAt || 0) > (cur.updatedAt || 0) ? [rec, cur] : [cur, rec];
      mergeOppRecords(into, from);
      await dbPut("opponents", into);
      counts.merged++;
      continue;
    }
    const rn = normName(rec.name);
    const matchId = matchName(rn);           // live name, else a name merged away (alias)
    if (matchId) {                           // new id but known name — fold into the existing profile
      const into = await dbGet("opponents", matchId);
      note("opponents", matchId, into);
      mergeOppRecords(into, rec);
      await dbPut("opponents", into);
      remap[rec.id] = matchId;
      counts.merged++;
    } else {                                 // genuinely new opponent
      note("opponents", rec.id, null);
      await dbPut("opponents", rec);
      existingIds.add(rec.id);
      if (rn) nameToId[rn] = rec.id;         // later same-name incoming folds into this one too (blanks never)
      counts.opponents++;
    }
  }

  const hasRemap = Object.keys(remap).length > 0;
  const byRound = new Map();
  for (const h of await dbAll("hands")) { const k = roundKey(h); if (k && !byRound.has(k)) byRound.set(k, h.id); }
  const fillInto = async (h, rec) => {
    const before = structuredClone(h);
    if (!fillStacks(h, rec)) return;
    note("hands", h.id, before);
    await dbPut("hands", h);
    counts.stacks++;
  };
  counts.stacks = 0;
  for (const rec of data.hands || []) {
    if (!rec.id) continue;
    if (hasRemap) {
      for (const v of rec.villains || []) if (remap[v.opponentId]) v.opponentId = remap[v.opponentId];
      if (Array.isArray(rec.villainIds)) rec.villainIds = [...new Set(rec.villainIds.map((x) => remap[x] || x))];
    }
    const cur = await dbGet("hands", rec.id);
    const twinId = !cur && byRound.get(roundKey(rec));
    const twin = twinId && twinId !== rec.id ? await dbGet("hands", twinId) : null;
    if (twin) { await fillInto(twin, rec); continue; }   // same hand under another id: fill, never duplicate
    if (!cur || (rec.updatedAt || rec.ts || 0) > (cur.updatedAt || cur.ts || 0)) { note("hands", rec.id, cur); await dbPut("hands", rec); counts.hands++; }
    else await fillInto(cur, rec);
  }
  for (const rec of data.sessions || []) {
    if (!rec.id) continue;
    const cur = await dbGet("sessions", rec.id);
    if (!cur || (rec.updatedAt || rec.ts || 0) > (cur.updatedAt || cur.ts || 0)) { note("sessions", rec.id, cur); await dbPut("sessions", rec); counts.sessions++; }
  }
  // At-table context (lineup/seats/ante/group UI) — via metaSet so the
  // localStorage survival mirror is seeded too. Only exportData's whitelist appears here.
  // Restore-if-absent: seeds a fresh/second device but never overwrites a device
  // already holding its own live lineup/seats/UI (importJSON "never wipes existing").
  for (const r of data.meta || []) {
    if (!r || !r.key) continue;
    if ((await metaGet(r.key)) != null) continue;
    let value = r.value;
    // tableLineup holds opponent ids; apply the same name-merge remap the hands
    // import uses, so a merged opponent's seat isn't restored under a pre-merge
    // id that now points at nothing.
    if (hasRemap && r.key === "tableLineup" && Array.isArray(value))
      value = value.map((id) => remap[id] || id);
    await metaSet(r.key, value);
    log.meta.push({ key: r.key, value });
  }
  _pendingImport = log;
  return counts;
}

/* ---------- import undo ----------
   importJSON notes every record it touched with its pre-import copy (null = new).
   After the caller's post-import fixups, recordImport stamps each record's
   updatedAt so undo can tell "still as imported" from "edited since" — edited
   records are kept, never clobbered. Log lives in IDB meta only (not mirrored,
   not exported). */
const IMPORT_LOG_KEY = "importLog", IMPORT_LOG_MAX = 5;
let _pendingImport = null;
const _stamp = (r) => r ? (r.updatedAt || r.ts || 0) : null;
async function recordImport(label, counts) {
  const log = _pendingImport; _pendingImport = null;
  if (!log) return;
  const batch = { id: uid(), ts: Date.now(), label, counts: { ...counts } };
  let any = log.meta.length > 0;
  for (const store of ["opponents", "hands", "sessions"]) {
    batch[store] = {};
    for (const [id, prev] of Object.entries(log[store])) {
      batch[store][id] = { prev, post: _stamp(await dbGet(store, id)) };
      any = true;
    }
  }
  if (!any) return;
  batch.meta = log.meta;
  const all = (await dbGet("meta", IMPORT_LOG_KEY))?.value || [];
  await dbPut("meta", { key: IMPORT_LOG_KEY, value: [batch, ...all].slice(0, IMPORT_LOG_MAX) });
}
async function importLog() { return (await dbGet("meta", IMPORT_LOG_KEY))?.value || []; }
async function undoImport(batchId) {
  const all = await importLog();
  const b = all.find((x) => x.id === batchId);
  if (!b) throw new Error("import not found");
  const res = { removed: 0, restored: 0, kept: 0, inUse: 0 };
  for (const store of ["hands", "sessions", "opponents"]) {
    const hands = store === "opponents" ? await dbAll("hands") : null;
    const refd = (id) => hands.some((h) => h.opponentId === id || (h.villainIds || []).includes(id)
      || (h.villains || []).some((v) => v.opponentId === id));
    for (const [id, e] of Object.entries(b[store] || {})) {
      const cur = await dbGet(store, id);
      if (!cur) continue;                               // deleted since — leave it gone
      if (_stamp(cur) !== e.post) { res.kept++; continue; }
      if (!e.prev && hands && refd(id)) { res.inUse++; continue; }  // a hand outside this import still uses them
      if (e.prev) { await dbPut(store, e.prev); res.restored++; }
      else { await dbDel(store, id); res.removed++; }
    }
  }
  for (const m of b.meta || []) {
    const cur = (await dbGet("meta", m.key))?.value;
    if (JSON.stringify(cur) === JSON.stringify(m.value)) {
      await dbDel("meta", m.key);
      try { localStorage.removeItem(_mirrorKey(m.key)); } catch {}
    }
  }
  await dbPut("meta", { key: IMPORT_LOG_KEY, value: all.filter((x) => x !== b) });
  return res;
}
