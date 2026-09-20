/* vocab.js — shared vocabulary: short-deck (6+) positions, streets, action
   tokens, sizes, cards, and the curated reads/exploits lists.

   ADDING A READ (Phil's workflow):
     1. Add one line to TENDENCY_TAGS: { id, cat, label }.
        id     = stable kebab-case, NEVER renamed once used (saved on opponents).
        cat    = "preflop" | "postflop" | "sizing" | "live".
        label  = short display text (≤ 22 chars fits the chip rows).
        kind   = optional: "scale" (0–100 slider) | "position" (pick a seat)
                 | "choice" (pick one of `options`, e.g. ["tight","normal","wide"])
                 | "tally" (pick one of `options` repeatedly; each tap increments
                   that option's count, e.g. tracking which bet size he uses most).
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
const SIZES_POST = ["33%", "50%", "66%", "100%", "Jam"];        // postflop bet/raise: pot-% shown as B33…B100, Jam = all-in

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
  { id: "limp-width",        cat: "preflop",  label: "Limp", kind: "choice", options: ["tight", "normal", "wide"] },
  { id: "lc-width",          cat: "preflop",  label: "Lc",   kind: "choice", options: ["tight", "normal", "wide"] },  // limps then calls a raise over his limp: how wide — graded version of retired limp-caller
  { id: "lrr-bluff",         cat: "preflop",  label: "Has LRR bluff?" },        // yes = limp-reraises light too; no = LRR only AA/KK/AK
  { id: "can-ls-light",      cat: "preflop",  label: "Can limp-shove light" },  // limps then jams all-in over a raise light, not just AA/KK
  { id: "lrr-latest-v",      cat: "preflop",  label: "Latest LRR value", kind: "position" },   // seat of his last value limp-reraise
  { id: "lrr-latest-b",      cat: "preflop",  label: "Latest LRR bluff", kind: "position" },   // seat of his last bluff limp-reraise
  { id: "opens-premium",     cat: "preflop",  label: "Raises = premium" },      // yes = first-in raise is AA–JJ/AK; no = raises wide
  { id: "raise-earliest-v",  cat: "preflop",  label: "Earliest raise value", kind: "position" },  // earliest seat he open-raises for value
  { id: "raise-earliest-b",  cat: "preflop",  label: "Earliest raise bluff", kind: "position" },  // earliest seat he open-raises as a bluff (steal)
  { id: "iso-raises-limps",  cat: "preflop",  label: "Iso-raises limps" },
  { id: "iso-width",         cat: "preflop",  label: "Iso",  kind: "choice", options: ["tight", "normal", "wide"] },  // how wide he iso-raises a limper
  { id: "iso-earliest-v",    cat: "preflop",  label: "Earliest iso value", kind: "position" },  // earliest seat he iso-raises a limper for value
  { id: "iso-earliest-b",    cat: "preflop",  label: "Earliest iso bluff", kind: "position" },  // earliest seat he iso-raises a limper as a bluff
  { id: "limp-caller",       cat: "preflop",  label: "Limps then calls" },      // limps, then calls any iso/raise
  { id: "lc-pp",             cat: "preflop",  label: "Limp-calls PP" },         // limps then calls a raise with pocket pairs → set-mining (SD flops a set ~17%)
  { id: "cc-width",          cat: "preflop",  label: "CC", kind: "choice", options: ["tight", "normal", "wide"] },  // cold-calls a raise (facing an open): how wide
  { id: "calls-raises-wide", cat: "preflop",  label: "Calls raises wide" },     // RETIRED (kept for label) — superseded by cc-width's graded tight/normal/wide
  { id: "3bets-light",       cat: "preflop",  label: "3bets light" },
  { id: "over-folds-3bet",   cat: "preflop",  label: "Over-folds to 3bet" },
  { id: "jams-pre-light",    cat: "preflop",  label: "Jam over Raise light" },        // gets it in pre with AK / TT+ / any pair
  // postflop — grouped bubbles (Station / Lead / Raise nuts / Bluff till / Bluff raise / Bluff XT / Range)
  { id: "station-f",         cat: "postflop", label: "Station F" },
  { id: "station-t",         cat: "postflop", label: "Station T" },
  { id: "station-r",         cat: "postflop", label: "Station R" },
  { id: "ld-draws",          cat: "postflop", label: "Lead draws" },
  { id: "ld-tp",             cat: "postflop", label: "Lead TP" },
  { id: "ld-2p",             cat: "postflop", label: "Lead 2P+" },
  { id: "lead-nut-f",        cat: "postflop", label: "Lead nut F" },            // leads out with the nuts on this street (no slowplay)
  { id: "lead-nut-t",        cat: "postflop", label: "Lead nut T" },
  { id: "lead-nut-r",        cat: "postflop", label: "Lead nut R" },
  { id: "call-nut-ip-f",     cat: "postflop", label: "Can call nut IP F" },     // flat-calls with the nuts in position (slowplay) on this street
  { id: "call-nut-ip-t",     cat: "postflop", label: "Can call nut IP T" },
  { id: "call-nut-ip-r",     cat: "postflop", label: "Can call nut IP R" },
  { id: "call-nut-oop-f",    cat: "postflop", label: "Can call nut OOP F" },    // flat-calls with the nuts out of position on this street
  { id: "call-nut-oop-t",    cat: "postflop", label: "Can call nut OOP T" },
  { id: "call-nut-oop-r",    cat: "postflop", label: "Can call nut OOP R" },
  { id: "raise-nuts-f",      cat: "postflop", label: "Raise nuts F" },
  { id: "raise-nuts-t",      cat: "postflop", label: "Raise nuts T" },
  { id: "raise-nuts-r",      cat: "postflop", label: "Raise nuts R" },
  { id: "bluff-till-f",      cat: "postflop", label: "Bluff till F" },
  { id: "bluff-till-t",      cat: "postflop", label: "Bluff till T" },
  { id: "bluff-till-r",      cat: "postflop", label: "Bluff till R" },
  { id: "bluff-raise-f",     cat: "postflop", label: "Bluff raise F" },
  { id: "bluff-raise-t",     cat: "postflop", label: "Bluff raise T" },
  { id: "bluff-raise-r",     cat: "postflop", label: "Bluff raise R" },
  { id: "br-fdsd",           cat: "postflop", label: "Bluff raise FD/SD" },  // bluff-raises with a flush/straight draw (semi-bluff, has equity)
  { id: "br-worst",          cat: "postflop", label: "Bluff raise worst" },  // bluff-raises his worst hands / pure air (no equity)
  { id: "bluff-xt-f",        cat: "postflop", label: "Bluff XT F" },
  { id: "bluff-xt-t",        cat: "postflop", label: "Bluff XT T" },
  { id: "bluff-xt-r",        cat: "postflop", label: "Bluff XT R" },
  { id: "xr-value-f",        cat: "postflop", label: "xR value F" },            // check-raises strong hands on this street
  { id: "xr-value-t",        cat: "postflop", label: "xR value T" },
  { id: "xr-value-r",        cat: "postflop", label: "xR value R" },
  { id: "xr-bluff-f",        cat: "postflop", label: "xR bluff F" },            // check-raises as a bluff on this street
  { id: "xr-bluff-t",        cat: "postflop", label: "xR bluff T" },
  { id: "xr-bluff-r",        cat: "postflop", label: "xR bluff R" },
  { id: "flop-vmw-lead",     cat: "postflop", label: "Flop V mw lead" },  // multiway: leads out with a value hand on the flop
  { id: "flop-vmw-xr",       cat: "postflop", label: "Flop V mw xR" },    // multiway: check-raises a value hand on the flop
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
  { id: "checks-range-oop",  cat: "postflop", label: "Checks range OOP?" },     // yes = never leads OOP, check is uncapped; no = leads strong, checks are weak
  { id: "xr-oop-v",          cat: "postflop", label: "Has xR OOP value?" },     // check-raises strong hands OOP
  { id: "xr-oop-b",          cat: "postflop", label: "Has xR OOP bluff?" },     // check-raises as a bluff OOP
  { id: "barrels-light",     cat: "postflop", label: "Can barrel light" },      // fires turn/river bluffs without equity
  // postflop — bluff lines he takes (bet/check per street: B = bet, X = check)
  { id: "bluff-line-bxb",    cat: "postflop", label: "BXB" },                   // bet flop, check turn, bet river as a bluff
  { id: "bluff-line-xb",     cat: "postflop", label: "XB" },                    // check flop, bet turn as a bluff
  { id: "bluff-line-xxb",    cat: "postflop", label: "XXB" },                   // check flop, check turn, bet river as a bluff
  { id: "bluff-missed-draws", cat: "postflop", label: "Bluffs missed draws" },  // fires when his draw bricks instead of giving up
  { id: "bluffs-air",         cat: "postflop", label: "Bluffs air" },           // bluffs with zero equity, never had a draw to begin with
  // sizing — preflop
  { id: "open-big-strong",   cat: "sizing",   label: "Open big = strong" },     // bigger open (5a–6a) = premium; small = speculative
  { id: "3bet-big-strong",   cat: "sizing",   label: "3bet big = strong" },     // bigger 3bet = nuts; small 3bet = light / bluff
  // sizing — postflop
  { id: "size-up-draws",     cat: "sizing",   label: "Size up with draws" },    // 3-colour read (green/yellow/red)
  { id: "small-with-weak",   cat: "sizing",   label: "Small = weak" },
  { id: "overbets-nuts",     cat: "sizing",   label: "Sizes up with nuts" },
  // sizing — tally which pot-% size he uses, per street, value vs bluff
  { id: "size-flop-v",       cat: "sizing",   label: "Flop V",  kind: "tally", options: ["B33", "B50", "B66", "B100", "B150"] },
  { id: "size-turn-v",       cat: "sizing",   label: "Turn V",  kind: "tally", options: ["B33", "B50", "B66", "B100", "B150"] },
  { id: "size-river-v",      cat: "sizing",   label: "River V", kind: "tally", options: ["B33", "B50", "B66", "B100", "B150"] },
  { id: "size-flop-b",       cat: "sizing",   label: "Flop B",  kind: "tally", options: ["B33", "B50", "B66", "B100", "B150"] },
  { id: "size-turn-b",       cat: "sizing",   label: "Turn B",  kind: "tally", options: ["B33", "B50", "B66", "B100", "B150"] },
  { id: "size-river-b",      cat: "sizing",   label: "River B", kind: "tally", options: ["B33", "B50", "B66", "B100", "B150"] },
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
  { id: "reg",        label: "Loose reg",  icon: "🃏", color: "#4f7fdf" },
  { id: "good-reg",   label: "Good reg",   icon: "🦈", color: "#d64848" },
  { id: "tight-reg",  label: "Tight reg",  icon: "🔒", color: "#7a8496" },
];
const PLAYER_TYPE_BY_ID = Object.fromEntries(PLAYER_TYPES.map((t) => [t.id, t]));
const TAG_CATS = ["preflop", "postflop", "sizing", "live"];
/* Retired reads: no longer offered, but an opponent who still holds one sees
   it under "Other" as "(retired)" so it can be cleared — never silently dropped. */
const RETIRED_TAG_IDS = new Set(["limp-caller", "calls-raises-wide", "lrr-bluff", "iso-raises-limps", "iso-earliest-v", "iso-earliest-b", "over-folds-3bet", "tilts"]);   // too general / cluttered picker
const TAG_BY_ID = Object.fromEntries(TENDENCY_TAGS.map((t) => [t.id, t]));

/* Sub-cluster single-read chips within each category. Any tag not listed
   drops into an "Other" row at the end of its category. Grouped bubbles
   (READ_GROUPS in app.js) and scale reads render separately. */
const READ_SUBCATS = {
  preflop: [
    { label: "Limping",   ids: ["limp-width", "lc-width", "iso-width", "can-ls-light", "lrr-latest-v", "lrr-latest-b", "lc-pp"] },
    { label: "Raising",   ids: ["opens-premium", "raise-earliest-v", "raise-earliest-b", "cc-width", "3bets-light", "jams-pre-light"] },
  ],
  postflop: [
    { label: "Cbet & Float", ids: ["over-cbet", "floats-wide", "barrels-off"] },
    { label: "Hand strength", ids: ["chases-draws", "overplays-tp", "pays-off-fh", "bluffs-rivers", "protected-block"] },
    { label: "OOP",           ids: ["checks-range-oop", "xr-oop-v", "xr-oop-b"] },
    { label: "Bluff lines",   ids: ["bluff-line-bxb", "bluff-line-xb", "bluff-line-xxb", "barrels-light", "bluff-missed-draws", "bluffs-air"] },
  ],
  sizing: [
    { label: "Preflop sizing",  ids: ["open-big-strong", "3bet-big-strong"] },
    { label: "Postflop sizing", ids: ["size-up-draws", "small-with-weak", "overbets-nuts"] },
    { label: "Sizings", ids: ["size-flop-v", "size-turn-v", "size-river-v", "size-flop-b", "size-turn-b", "size-river-b"] },
  ],
  live: [
    { label: "Physical / timing", ids: ["timing-tells", "snap-call-weak", "talks-when-strong"] },
  ],
};

/* Auto-suggested exploits: tag id → { yes, no }. "yes" = tendency present,
   "no" = confirmed absent (only where the absence is itself exploitable).
   Suggestions surface in the Exploits panel; Phil accepts or dismisses each. */
const EXPLOIT_RULES = {
  "limp-width":        { wide:  "Iso-raise his limps big with hands that dominate a wide limping range (AK, AQ, KQ, TT+) — he limps trash and folds or calls light.",
                         tight: "His limps are strong — don't iso light; limp behind with playable hands and fold junk to his limp-raise." },
  "lrr-bluff":         { yes: "His limp-reraise is not always the nuts — call in position with pairs and suited broadways, or 4-bet AK/QQ+.",
                         no:  "Fold everything but AA/KK to his limp-reraise — it's the top of his range every time." },
  "opens-premium":     { yes: "Only continue vs his raise with hands that flop big against AA–JJ/AK (pairs to set-mine, suited connectors); fold AQ/KQ-type hands.",
                         no:  "He raises wide first-in — 3-bet him with AK/AQ/TT+ and call with anything suited-connected in position." },
  "iso-raises-limps":  { yes: "Limp-reraise your strong hands behind his iso; limp only hands that can stand a raise.",
                         no:  "He never punishes limps — over-limp wide and see cheap multiway flops." },
  "lc-pp":             { yes: "His limp-call range is pocket pairs set-mining — cbet flops freely to fold out the ~83% that whiffed a set, but shut down and fold to a check-raise on low/paired boards: that's the set." },
  "cc-width":          { wide:  "He cold-calls raises with a wide, capped range (suited/connected junk, weak broadways, small pairs — no premiums, those 3-bet). Size your opens up: he flats and pays off dominated. Postflop he's a value target, not a bluff target — bet bigger and thinner, but don't run big bluffs into a range this wide; it just calls.",
                         tight: "His cold-call range is tight and strong (pairs to set-mine, AK, big broadways) — steal more preflop (a narrow calling range over-folds to iso/3bet) but believe his postflop continues; don't stack off into a low/paired board that hits his set-miners." },
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
  "checks-range-oop":  { yes: "His OOP check is his whole range, not weakness — don't auto-stab; bet for value, check back medium hands.",
                         no:  "He leads his strong hands OOP, so his checks are weak — stab them with any two." },
  "lead-nut-f":        { yes: "His flop lead is the nuts, never a slowplay — fold marginal hands to it; when he checks the flop, he doesn't have it." },
  "lead-nut-t":        { yes: "His turn lead is the nuts — fold to it without a big hand; his turn check caps his range." },
  "lead-nut-r":        { yes: "His river lead is the nuts — fold everything but a near-nutted hand." },
  "barrels-light":     { yes: "Call down lighter vs his turn/river barrels — he fires without equity.",
                         no:  "His second and third barrels are real — fold marginal hands to turn/river bets." },
  "bluff-line-bxb":    { yes: "His bet-check-bet line is often a bluff — call rivers with bluff-catchers after he checks the turn." },
  "bluff-line-xb":     { yes: "His check-then-bet on the turn is often a bluff — call or raise with medium hands." },
  "bluff-line-xxb":    { yes: "His check-check-bet river is often a bluff — bluff-catch rivers after two checks." },
  "xr-oop-v":          { yes: "Bet-fold marginal hands when he checks OOP — he check-raises his strong hands rather than leading." },
  "xr-oop-b":          { yes: "He check-raise bluffs OOP — call his check-raises with top pair+ and strong draws, 3-bet flop with big hands.",
                         no:  "His OOP check-raises are always value — fold one pair to them." },
  "open-big-strong":   { yes: "His open size leaks his hand — fold to his big opens without a premium, attack his small opens with 3-bets." },
  "3bet-big-strong":   { yes: "His 3-bet size leaks his hand — fold to his big 3-bets, call or 4-bet his small ones." },
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
  { id: "cc-width",          state: "wide", pill: "Wide caller",  tone: "red"    },
  { id: "lc-pp",             state: "yes", pill: "Set-miner",     tone: "purple" },
  { id: "limp-width",        state: "wide", pill: "Wide limper",  tone: "purple" },
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
  { id: "lrr-bluff",         state: "yes", pill: "LRR bluffs",    tone: "teal"   },
  { id: "xr-oop-b",          state: "yes", pill: "xR bluffer",    tone: "teal"   },
  { id: "barrels-light",     state: "yes", pill: "Barrels light", tone: "teal"   },
  { id: "barrels-off",       state: "yes", pill: "Barrels off",   tone: "teal"   },
  { id: "opens-premium",     state: "yes", pill: "Nit raiser",    tone: "gray"   },
  { id: "lrr-bluff",         state: "no",  pill: "LRR = nuts",    tone: "gray"   },
  { id: "limp-width",        state: "tight", pill: "Tight limper", tone: "gray"   },
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
