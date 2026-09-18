/* vocab.js — shared vocabulary: short-deck (6+) positions, streets, action
   tokens, sizes, cards, and the curated reads/exploits lists.

   ADDING A READ (Phil's workflow):
     1. Add one line to TENDENCY_TAGS: { id, cat, label }.
        id     = stable kebab-case, NEVER renamed once used (saved on opponents).
        cat    = "preflop" | "postflop" | "sizing" | "live".
        label  = short display text (≤ 22 chars fits the chip rows).
        kind   = optional: "scale" (0–100 slider) | "position" (pick a seat).
     2. Optionally list it in READ_SUBCATS so it sits in a named row.
     3. Optionally add EXPLOIT_RULES[id] = { yes: "…", no: "…" } for an
        auto-suggested exploit, and/or a PILL_READS entry for a felt pill.
   Street triads (F/T/R bubbles) live in READ_GROUPS in app.js. */

/* Short deck is ante-only: every seat antes, the button posts a double ante.
   No blinds. UTG (left of the button) acts first on EVERY street, BN last.
   Ring labels: U9…U4 = UTG seats numbered from table size, then HJ/CO/BN. */
const POSITIONS = ["U9", "U8", "U7", "U6", "U5", "U4", "HJ", "CO", "BN"];
const STREETS = ["pre", "flop", "turn", "river"];
const ACTS = ["fold", "check", "call", "bet", "raise", "3bet", "limp", "jam"];
const ACTS_POST = ["fold", "check", "call", "bet", "raise"];
const SIZED_ACTS = ["bet", "raise", "3bet", "4bet", "5bet"];
const SIZES_OPEN = ["3a", "4a", "5a", "6a", "Jam"];        // open raise: in antes (fallback when no ante set)
const SIZES_3BET = ["2.5x", "3x", "4x", "Jam"];            // 3bet: multipliers
const SIZES_4BET = ["2x", "2.5x", "3x", "Jam"];            // 4bet/5bet: multipliers
const SIZES_POST = ["33%", "50%", "66%", "75%", "pot", "Jam"];

/* 36-card deck: 2–5 removed. Order high → low drives the range grid axes. */
const RANKS = "AKQJT9876";
const SUITS = [
  { id: "s", sym: "♠", cls: "cs" },   // spade  — white
  { id: "h", sym: "♥", cls: "ch" },   // heart  — red
  { id: "d", sym: "♦", cls: "cd" },   // diamond— blue
  { id: "c", sym: "♣", cls: "cc" },   // club   — green
];

/* Starter reads for short deck. Three-state toggles (yes / yes! / no / no!)
   unless `kind` says otherwise. Keep this list small — add as real reads come up. */
const TENDENCY_TAGS = [
  // preflop — entering the pot
  { id: "limps-wide",        cat: "preflop",  label: "Limps wide" },            // yes = limps most hands; no = limps are strong
  { id: "limp-raise-nuts",   cat: "preflop",  label: "Limp-raise = nuts" },     // yes = LRR only AA/KK/AK; no = LRR light
  { id: "opens-premium",     cat: "preflop",  label: "Raises = premium" },      // yes = first-in raise is AA–JJ/AK; no = raises wide
  { id: "iso-raises-limps",  cat: "preflop",  label: "Iso-raises limps" },
  { id: "limp-caller",       cat: "preflop",  label: "Limps then calls" },      // limps, then calls any iso/raise
  { id: "calls-raises-wide", cat: "preflop",  label: "Calls raises wide" },     // any suited / connected vs a raise
  { id: "3bets-light",       cat: "preflop",  label: "3bets light" },
  { id: "over-folds-3bet",   cat: "preflop",  label: "Over-folds to 3bet" },
  { id: "jams-pre-light",    cat: "preflop",  label: "Jams pre light" },        // gets it in pre with AK / TT+ / any pair
  // postflop — grouped bubbles (Station / Lead / Raise nuts / Bluff till / Bluff raise / Bluff XT / Range)
  { id: "station-f",         cat: "postflop", label: "Station F" },
  { id: "station-t",         cat: "postflop", label: "Station T" },
  { id: "station-r",         cat: "postflop", label: "Station R" },
  { id: "ld-draws",          cat: "postflop", label: "Lead draws" },
  { id: "ld-tp",             cat: "postflop", label: "Lead TP" },
  { id: "ld-2p",             cat: "postflop", label: "Lead 2P+" },
  { id: "raise-nuts-f",      cat: "postflop", label: "Raise nuts F" },
  { id: "raise-nuts-t",      cat: "postflop", label: "Raise nuts T" },
  { id: "raise-nuts-r",      cat: "postflop", label: "Raise nuts R" },
  { id: "bluff-till-f",      cat: "postflop", label: "Bluff till F" },
  { id: "bluff-till-t",      cat: "postflop", label: "Bluff till T" },
  { id: "bluff-till-r",      cat: "postflop", label: "Bluff till R" },
  { id: "bluff-raise-f",     cat: "postflop", label: "Bluff raise F" },
  { id: "bluff-raise-t",     cat: "postflop", label: "Bluff raise T" },
  { id: "bluff-raise-r",     cat: "postflop", label: "Bluff raise R" },
  { id: "bluff-xt-f",        cat: "postflop", label: "Bluff XT F" },
  { id: "bluff-xt-t",        cat: "postflop", label: "Bluff XT T" },
  { id: "bluff-xt-r",        cat: "postflop", label: "Bluff XT R" },
  { id: "merged",            cat: "postflop", label: "Merged" },
  { id: "polar",             cat: "postflop", label: "Polar" },
  // postflop — singles
  { id: "over-cbet",         cat: "postflop", label: "Over cbet" },             // no = under-cbets / gives up
  { id: "floats-wide",       cat: "postflop", label: "Floats wide" },           // no = fit-or-fold
  { id: "barrels-off",       cat: "postflop", label: "Barrels relentlessly" },  // no = gives up on turn
  { id: "chases-draws",      cat: "postflop", label: "Chases any draw" },       // short deck: OESD ≈ 45% by river, pays any price
  { id: "overplays-tp",      cat: "postflop", label: "Overplays TP / overpair" },
  { id: "pays-off-fh",       cat: "postflop", label: "Pays off FH vs flush" },  // forgets flush > full house
  { id: "bluffs-rivers",     cat: "postflop", label: "Bluffs rivers" },         // no = big river bets = nuts
  { id: "protected-block",   cat: "postflop", label: "Protected block" },       // yes = medium/protection; no = polar
  // sizing
  { id: "size-up-draws",     cat: "sizing",   label: "Size up with draws" },    // 3-colour read (green/yellow/red)
  { id: "small-with-weak",   cat: "sizing",   label: "Small = weak" },
  { id: "overbets-nuts",     cat: "sizing",   label: "Sizes up with nuts" },
  // live
  { id: "tilts",             cat: "live",     label: "Tilts after losses" },
  { id: "timing-tells",      cat: "live",     label: "Timing tells" },
  { id: "snap-call-weak",    cat: "live",     label: "Snap-call = weak" },
  { id: "talks-when-strong", cat: "live",     label: "Chatty = strong" },
];
/* Player archetype — Phil sets it manually and it themes the opponent's row
   on the list plus a pill in the detail header. */
const PLAYER_TYPES = [
  { id: "whale",      label: "Whale",      icon: "🐋", color: "#3ec7c7" },
  { id: "fish",       label: "Fish",       icon: "🐠", color: "#e08a3c" },
  { id: "loose-fish", label: "Loose fish", icon: "🐟", color: "#4fbf5a" },
  { id: "tight-fish", label: "Tight fish", icon: "🎣", color: "#c5c33a" },
  { id: "reg",        label: "Reg",        icon: "🃏", color: "#4f7fdf" },
  { id: "good-reg",   label: "Good reg",   icon: "🦈", color: "#d64848" },
  { id: "tight-reg",  label: "Tight reg",  icon: "🔒", color: "#7a8496" },
];
const PLAYER_TYPE_BY_ID = Object.fromEntries(PLAYER_TYPES.map((t) => [t.id, t]));
const TAG_CATS = ["preflop", "postflop", "sizing", "live"];
/* Retired reads: no longer offered, but an opponent who still holds one sees
   it under "Other" as "(retired)" so it can be cleared — never silently dropped. */
const RETIRED_TAG_IDS = new Set([]);
const TAG_BY_ID = Object.fromEntries(TENDENCY_TAGS.map((t) => [t.id, t]));

/* Sub-cluster single-read chips within each category. Any tag not listed
   drops into an "Other" row at the end of its category. Grouped bubbles
   (READ_GROUPS in app.js) and scale reads render separately. */
const READ_SUBCATS = {
  preflop: [
    { label: "Limping",   ids: ["limps-wide", "limp-raise-nuts", "limp-caller", "iso-raises-limps"] },
    { label: "Raising",   ids: ["opens-premium", "calls-raises-wide", "3bets-light", "over-folds-3bet", "jams-pre-light"] },
  ],
  postflop: [
    { label: "Cbet & Float", ids: ["over-cbet", "floats-wide", "barrels-off"] },
    { label: "Hand strength", ids: ["chases-draws", "overplays-tp", "pays-off-fh", "bluffs-rivers", "protected-block"] },
  ],
  sizing: [
    { label: "Postflop sizing", ids: ["size-up-draws", "small-with-weak", "overbets-nuts"] },
  ],
  live: [
    { label: "Physical / timing", ids: ["timing-tells", "snap-call-weak", "talks-when-strong"] },
    { label: "Mental state",      ids: ["tilts"] },
  ],
};

/* Auto-suggested exploits: tag id → { yes, no }. "yes" = tendency present,
   "no" = confirmed absent (only where the absence is itself exploitable).
   Suggestions surface in the Exploits panel; Phil accepts or dismisses each. */
const EXPLOIT_RULES = {
  "limps-wide":        { yes: "Iso-raise his limps big with hands that dominate a wide limping range (AK, AQ, KQ, TT+) — he limps trash and folds or calls light.",
                         no:  "His limps are strong — don't iso light; limp behind with playable hands and fold junk to his limp-raise." },
  "limp-raise-nuts":   { yes: "Fold everything but AA/KK to his limp-reraise — it's the top of his range every time.",
                         no:  "His limp-reraise is wide — call in position with pairs and suited broadways, or 4-bet AK/QQ+." },
  "opens-premium":     { yes: "Only continue vs his raise with hands that flop big against AA–JJ/AK (pairs to set-mine, suited connectors); fold AQ/KQ-type hands.",
                         no:  "He raises wide first-in — 3-bet him with AK/AQ/TT+ and call with anything suited-connected in position." },
  "iso-raises-limps":  { yes: "Limp-reraise your strong hands behind his iso; limp only hands that can stand a raise.",
                         no:  "He never punishes limps — over-limp wide and see cheap multiway flops." },
  "limp-caller":       { yes: "Iso his limps with a big size and value-bet thin postflop — he limps then calls with a capped range." },
  "calls-raises-wide": { yes: "Raise bigger for value (5–6 antes) — he pays with suited/connected junk; barrel hard on boards that miss connectors." },
  "3bets-light":       { yes: "4-bet or jam AK/QQ+ vs his 3-bet, flat with pairs to trap — his 3-bets are not the nuts.",
                         no:  "Fold to his 3-bet without AA/KK/AK — he only re-raises premiums." },
  "over-folds-3bet":   { yes: "3-bet his opens wider, especially with blockers (Ax, Kx) — he folds too much preflop." },
  "jams-pre-light":    { yes: "Call his preflop jams with JJ+ and AK; AK vs his range is a coin flip at worst with the antes as overlay." },
  "over-cbet":         { yes: "Float his cbets wide — with draws or overcards — and take it away on the turn when he checks.",
                         no:  "He only cbets strong — respect his flop bet, but stab when he checks (he gives up too much)." },
  "floats-wide":       { yes: "Double-barrel turns — he floats flops light and folds turns without equity.",
                         no:  "One cbet takes it — fire once with your whole range, give up when called." },
  "barrels-off":       { yes: "Call down lighter vs his turn/river barrels — he fires every street.",
                         no:  "Call flop, take the pot when he checks turn — he gives up after one bet." },
  "chases-draws":      { yes: "Charge draws maximally (pot / over-pot) on flop and turn — he chases regardless of price; don't bluff into him on draw-heavy boards." },
  "overplays-tp":      { yes: "Raise his top-pair bets with two pair+ and strong draws — he stacks off with one pair in short deck." },
  "pays-off-fh":       { yes: "Bet full house sized max when you hold a flush on paired boards — he pays off, forgetting flush beats full house." },
  "bluffs-rivers":     { yes: "Bluff-catch rivers wider — his river bets are often air.",
                         no:  "Fold to his big river bets without a near-nutted hand — he doesn't bluff there." },
  "protected-block":   { yes: "Raise his small river bets — they're medium-strength protection bets that fold to pressure." },
  "size-up-draws":     { any: "Sizing tells: big bet on wet boards = draw, small = made hand. Read the size, not the story." },
  "small-with-weak":   { yes: "Raise his small bets — small = weak. Fold to his big bets without the nuts." },
  "overbets-nuts":     { yes: "Fold to his overbets without a nutted hand — big = value, never a bluff." },
  "tilts":             { yes: "After he loses a big pot, tighten up and let him bluff into you — he spews on tilt." },
  "snap-call-weak":    { yes: "Snap-calls = weak/drawing. Barrel the next street when he snap-calls." },
  "talks-when-strong": { yes: "If he starts chatting mid-hand, he's strong — fold marginal hands." },
};

/* Multi-read archetypes: ALL keys (tagId:state) must match and at least one
   must be strong (yes!/no!). None defined yet for short deck — add with
   Phil's sign-off only (see feedback_poker_basics). */
const COMPOUND_EXPLOIT_RULES = [];

/* Felt villain pill: first matching {id, state} → pill/tone on the seat card.
   Keep pill ≤ 14 chars. Tone → colour class in style.css (red=sticky,
   amber=passive/weak, teal=aggro-bluff, purple=target, blue=info, gray=nit). */
const PILL_READS = [
  { id: "station-r",         state: "yes", pill: "R station",     tone: "red"    },
  { id: "station-t",         state: "yes", pill: "T station",     tone: "red"    },
  { id: "station-f",         state: "yes", pill: "F station",     tone: "red"    },
  { id: "chases-draws",      state: "yes", pill: "Chases draws",  tone: "red"    },
  { id: "calls-raises-wide", state: "yes", pill: "Wide caller",   tone: "red"    },
  { id: "limp-caller",       state: "yes", pill: "Limp-caller",   tone: "red"    },
  { id: "limps-wide",        state: "yes", pill: "Wide limper",   tone: "purple" },
  { id: "over-folds-3bet",   state: "yes", pill: "Overfolds 3B",  tone: "purple" },
  { id: "opens-premium",     state: "no",  pill: "Wide raiser",   tone: "purple" },
  { id: "barrels-off",       state: "no",  pill: "Gives up turn", tone: "amber"  },
  { id: "floats-wide",       state: "no",  pill: "Fit-or-fold",   tone: "amber"  },
  { id: "over-cbet",         state: "yes", pill: "Auto-cbetter",  tone: "amber"  },
  { id: "bluff-raise-t",     state: "yes", pill: "Bluff-raiser",  tone: "teal"   },
  { id: "bluff-raise-f",     state: "yes", pill: "Bluff-raiser",  tone: "teal"   },
  { id: "bluff-raise-r",     state: "yes", pill: "River-raiser",  tone: "teal"   },
  { id: "3bets-light",       state: "yes", pill: "Light 3-bettor",tone: "teal"   },
  { id: "jams-pre-light",    state: "yes", pill: "Jams pre",      tone: "teal"   },
  { id: "bluffs-rivers",     state: "yes", pill: "River bluffer", tone: "teal"   },
  { id: "barrels-off",       state: "yes", pill: "Barrels off",   tone: "teal"   },
  { id: "opens-premium",     state: "yes", pill: "Nit raiser",    tone: "gray"   },
  { id: "limp-raise-nuts",   state: "yes", pill: "LRR = nuts",    tone: "gray"   },
  { id: "overbets-nuts",     state: "yes", pill: "Big = value",   tone: "blue"   },
  { id: "small-with-weak",   state: "yes", pill: "Small = weak",  tone: "blue"   },
  { id: "tilts",             state: "yes", pill: "Tilter",        tone: "purple" },
];

/* Reusable exploit archetypes — added onto any opponent from the Exploits
   panel. `abbr` shows on the front-page card; `text` is revealed on tap. */
const EXPLOIT_TEMPLATES = [
  { abbr: "EQF",  name: "Equity Fish",
    text: "Equity Fish — barrels only their real equity (straight draws, flush draws). Lacks SDV bluffs and spew bluffs." },
  { abbr: "MUB",  name: "Monster Under the Bed",
    text: "Monster Under the Bed — scared of scare-card turns; over-folds fearing a monster. Don't bet thin against them; barrel scare cards." },
  { abbr: "DHF",  name: "Draw Hyper-Focus",
    text: "Draw Hyper-Focus — loves bluffing when draws complete and hates bluff-catching then. When draws miss, hates bluffing and turns into a station." },
  { abbr: "UBOC", name: "Underbluff + Overcooler",
    text: "Underbluff + Overcooler — in polarized get-in spots they pure-jam their nutted hands and underbluff with draws. Most players default to this." },
  { abbr: "FL",   name: "Frontloading",
    text: "Frontloading — commits range/info early. Put them in spots where they end up face-up, then exploit the known range." },
  { abbr: "FPS",  name: "Fancy Play Syndrome",
    text: "Fancy Play Syndrome — makes crazy plays way out of the ordinary; over-levels themselves." },
  { abbr: "BBS",  name: "Bad Beat Sizing",
    text: "Bad Beat Sizing — when the story says weak but they rivered a nutted hand, they size up. The sizing is inconsistent with the story — read the tell and fold." },
  { abbr: "TAL",  name: "Truth After Lie",
    text: "Truth After Lie — slow-plays, then suddenly sizes up for value. When a block-bet range instead sizes up, it's the slow-played nutted hand." },
];
