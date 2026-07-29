# CLAUDE.md — Padel Rating App

This file is the project's locked specification. Follow it in every session without
deviating. If a change appears to require breaking a rule here, stop and raise it —
do not work around it.

---

## Project

A padel player rating app for a Chennai community of roughly 100 players.

- **Frontend:** mobile web.
- **API:** Express, hosted on Render.
- **Firebase:** used *only* as backend-as-a-service — Auth, Firestore, Storage.
- **All rating math runs server-side only and is never exposed to the client.**
  No rating formula, constant, or intermediate value ships to the browser.

---

## Rating Engine

Glicko-2, adapted for doubles.

- Each of the four players is updated **individually**, against the opposing team
  treated as a **single opponent entity**.
- **Teammates are never opponents to each other.**
- Everyone starts at the same rating with a high RD.
- **No self-assessment, no onboarding skill question.** Ratings are earned purely
  from match results.

### Stored scale vs internal scale — `rating.value`, never `mu`

**The user document stores `rating: { value, rd, sigma }`.** `value` is a
**display-scale** number (everyone starts at 1500). It is **NOT** a Glicko-2
internal µ.

**Glicko-2 internal µ exists only inside `glicko2.js`.** The engine converts the
stored `value` into internal µ via `toMu()` at the start of an update and back via
`toRating()` at the end. **Internal µ never touches storage, a response, or an
index.** The boundary is `confirmationService.enginePlayer`, which reads
`user.rating.value` and hands the engine a plain `rating` number.

> **`mu` is a RETIRED field name. Do not reintroduce it as a stored field.**
> The stored field was once called `rating.mu`, which was a misnomer — it held a
> display-scale value, not a µ. That name actively invited a future session to
> "fix" it by dividing by `GLICKO_SCALE` (173.7178) and corrupt every rating. It
> was renamed to `rating.value` before any data existed. If you see `rating.mu`
> anywhere, it is a bug: the stored scalar is `rating.value`, and `mu` lives only
> as a local inside the Glicko math.

### One latent scale

There is a single latent rating scale for all players regardless of gender.

- Gender is handled by **leaderboard filters only**: men's, women's, open.
  These filter the `users` collection; they read no match data. See
  *Leaderboards*.
- **There must never be a gender term anywhere in the rating math.**

The one permitted use of gender in computation is selecting `λ` (same-gender vs
mixed pair) in the team-combination weight below. This is a property of the
*pairing*, not of a player, and does not place a gender term on the latent scale.

---

## Team Combination — Weak-Link Weighting

Never a flat average.

```
w = 0.5 + λ · tanh(d / D)
```

- `d` — the rating gap between teammates, in **Glicko-2 internal units** (µ-scale).
- `D` = 1.15
- `λ` = `lambdaSame` for same-gender pairs, `lambdaMixed` for mixed pairs.

> **At launch `lambdaMixed` = `lambdaSame` = 0.12** — mixed and same-gender pairs
> get an identical `w`, team rating, and credit split. This is a deliberate
> starting position, not the final value; see *Resolved* below. The code path
> that selects `λ` by pairing type stays, because Step 9 must be able to sweep it.

### Ordering teammates — by µ alone

**The weaker player is the one with the lower µ. Full stop.**

**Do not** use RD, φ, or any conservative lower-bound estimate such as `µ − k·φ`
to decide who is the weak link. This is settled — see *Resolved* for the full
reasoning, and do not revisit it.

```
weaker   = teammate with lower µ
stronger = teammate with higher µ
d        = |µ_stronger − µ_weaker|
```

**Team rating:**

```
team_rating = w · rating_weaker + (1 − w) · rating_stronger
```

Since `λ > 0` and `d ≥ 0`, `w ≥ 0.5` — the weaker player always carries at least
half the weight. This is the point: the weak link drags the team.

**Team uncertainty** is variance-aware with a **synergy term** added.
It is **never** an average of the two RDs.

### Credit split

The same `w` splits credit after the match:

```
r_weak   = w
r_strong = 1 − w
```

---

## `pairingType` — Per Team, and the Only Gender-Derived Field

**There is no `matchPool`. There is no match-level gender classification of any
kind.** Do not create one. See *Resolved* for why.

### `pairingType` — a property of ONE team

- Derived from **that team's two players**.
- Values: `same` | `mixed`.
- **Drives `λ` and `synergy` selection** in `combineTeam`.
- **The two teams in a match routinely have different `pairingType`s.** This is
  normal, not an edge case: M+F vs M+M will happen most weeks in a casual group.
  Team A takes `lambdaMixed`, Team B takes `lambdaSame`. Both are correct.
  `combineTeam`'s per-team signature already handles this — keep it that way.
- **Stored on the match document, and never recomputed.** It is an audit record
  of what fed an already-applied delta. Recomputing it after a player edits their
  profile would produce a record that contradicts the rating it explains.

### The bug this prevents

Deriving **one match-level `isMixed`** and applying it to **both teams**. Team B
would then receive mixed-pairing targeting because *their opponents* happened to
be a mixed pair. That is wrong on its own terms — and at launch config, where
`lambdaMixed == lambdaSame`, it is **invisible in the ratings**: `w` comes out
identical either way, and only `synergy` diverges, at ~0.3% of update magnitude.

A bug that changes no rating anyone can see is a bug that survives to production.

### Auditability requirement (Step 8)

Because this class of bug is numerically near-silent at launch config, **the
match document must store the derived values, not merely the inputs.** Alongside
the multipliers already recorded (`M_format`, `M_margin`, `M_repeat`, config
version), store **per team**:

- `pairingType`
- `w`
- `weakLink`

Then an inverted or always-`false` flag is **visible in the data** even while it
is invisible in the rating. Without this, the only witness to the seam being
wired correctly is a constant that is deliberately inert.

---

## Tiers and Placement

A player's tier is decided by **RD and games played together**. Both conditions
must hold — they are **ANDed, never ORed**.

| Tier | Condition | On the leaderboard? |
|------|-----------|---------------------|
| **placement** | `RD >= 250` **or** `gamesPlayed < 3` | **No — hidden** |
| **provisional** | `RD < 250` **and** `gamesPlayed >= 3` | Yes |
| **established** | `RD < 100` **and** `gamesPlayed >= 10` | Yes |

**Bounds are strict.** A player at exactly RD 250 is still in placement; at
exactly RD 100 they are provisional, not established.

### ⚠ Launch adjustment — loosened placement exit for a populated board

**The placement-exit bounds above (`RD < 250 AND >= 3 games`) are a deliberate
launch-experience decision, not the Step-9 values.** They replace the original
`RD < 150 AND >= 8 games`.

**Why it was changed.** At ~3 confirmed matches a player's RD sits around 245, so
the old `RD < 150` bound was the binding constraint and essentially *nobody*
crossed it early — the launch leaderboard would have been empty. Lowering only
the games floor would not have helped, because RD, not games, was gating.

**What it trades.** A visible board at the cost of rating stability. Players now
appear with **higher RD and less-settled ratings**, so **early leaderboard
positions near the top will shuffle noticeably as ratings converge.** That is
expected behaviour under this config, not a bug — the ranks are genuinely
uncertain and honestly say so via a high RD.

**Why we accepted the trade.** For a new community, a visible board matters more
to adoption than early-rank precision. An empty launch board — technically more
"correct" — tells a prospective player nothing and gives no reason to return. A
sparse, slightly noisy board tells them the system is live and they can climb it.

**This is reversible.** Tighten back toward the Step-9 values (`RD < 150`,
`>= 8 games`) once match volume is high enough that an empty board is no longer a
risk. It is a config edit plus a status recompute (see below), nothing structural.

> **Only the tier thresholds changed. The rating math is untouched.** RD, µ and
> the deltas are computed exactly as before; these bounds only decide which tier
> a given (RD, games) lands in, and therefore who the leaderboard shows.

### Changing tier thresholds requires a status recompute

`status` is **stored** on each user document and written by `tierFor` at
confirmation time — it is not recomputed on read. So changing these thresholds in
config does **not** retroactively re-tier existing players; their stored `status`
is stale until their next confirmation, and the leaderboard filters on the stored
value. **After any tier-threshold change, run `scripts/recomputeStatus.js`** to
re-derive and rewrite every user's `status` from the new bounds. Without it, the
change has no visible effect on players who have already been rated.

> **No config version bump for this change.** Per the operational-keys precedent,
> a config change that does not enter the **delta** computation does not
> invalidate `ratingHistory` replay and needs no new version. Tier thresholds
> feed `status`, leaderboard visibility, and `maxDeltaPerMatch` cap exemption —
> none of which alters a delta in normal play (the cap does not fire below ~300).
> Past history stamped version 1 replays to identical deltas under the new bounds.

### The games floor is not redundant with the RD bound

RD is the usual binding constraint — from RD 350 a player is still around RD 245
at 3 matches, so the RD bound (`RD < 250` at launch, `RD < 150` originally) is
what gates early, not the games floor. The floor is **not** there to gate.

**It exists so the UI can name a threshold a player can act on.**

The Leaderboard wireframe already contains the copy *"3 more matches to appear on
the leaderboard."* That sentence is only true if a match count is part of the
rule. An RD-only config would make that screen **state something false** — there
would be no defined number of matches to count down, and the honest version would
read *"your RD is 162,"* which means nothing to a player.

A player can act on "3 more matches." Nobody can act on an RD figure.

**Consequence:** any UI that counts down matches must read the floor from
`config.gamesPlayedFloors`, never hardcode it.

### The leaderboard countdown

**Show a number only when it is guaranteed. Never estimate.**

Implemented in `src/lib/placement.js` as `placementCountdown`.

Here `placement` is `config.rdThresholds.placement` (250 at launch), and `floor`
is `config.gamesPlayedFloors.provisional` (3 at launch) — both read from config,
never hardcoded.

| Player state | Show | Copy |
|---|---|---|
| `RD < placement` **and** `games >= floor` | nothing | *(on the leaderboard)* |
| `RD < placement` **and** `games < floor` | **the number** | *"N more matches to appear on the leaderboard"* |
| `RD >= placement` | **no number** | *"Your rating is still settling — keep playing."* |

**Never take the max of the floor condition and the RD condition.**

The floor side is arithmetic: `floor − gamesPlayed` is a fact. **The RD side is
not computable.** How fast RD falls depends on opponent RD and match outcomes, so
any RD-based countdown is a **forecast presented as a fact**. A countdown that
promises "one more match" and then fails to deliver breaks trust on the exact
screen where we are asking players to trust the ratings.

So when RD is still outstanding we show **no number at all** — even if the games
floor is also unmet and that difference happens to be computable. Clearing the
floor would not put the player on the leaderboard, so the number would be a lie
by implication.

#### Known corner (accepted)

In the `COUNTING` branch the promise is exact in every realistic case, but not
provably so in one pathological corner. RD normally falls when a match is played,
but it **rises** when a match is uninformative: as `E` approaches 0 or 1,
`E(1−E)` collapses, `v` explodes, `φ'` approaches `φ*`, and `φ* > φ`.

Measured: against an RD-50 opponent, a player at RD 149 sees RD **rise** once the
rating gap exceeds **~876 points**, and even then only by ~0.18 RD.

So the promise can break only if a player sits within ~0.2 RD of the threshold
**and** their next match is a ~900-point mismatch. This is accepted rather than
patched — adding a safety margin would mean inventing a constant to defend
against a case narrower than the rounding on the number we display. If the beta
surfaces it, revisit.

---

## Leaderboards

Three tabs: **Men's | Women's | Open.**

All three are **simple queries against the `users` collection**, with
**placement players excluded**:

| Tab | Query |
|-----|-------|
| Men's | `users` where gender = male |
| Women's | `users` where gender = female |
| Open | `users`, unfiltered — every player |

**Leaderboards are user-level filters. They read no match data at all.**

### Sort by the STORED rating, never by the display value

The query orders by `rating.value` descending. It must **not** order by
`ratingDisplay`, for two reasons:

1. **`ratingDisplay` is derived-never-stored**, so Firestore has no field to sort
   on — see *Open Question 1* and `displayRating.js`.
2. **Even if it were stored, it would be wrong**: `toDisplayRating` **clamps** to
   `[0, maxUnits]`, so every player above `ratingAtMax` displays the same 7.0.
   Sorting by the display value would tie the entire top of the ladder and order
   them arbitrarily — precisely where ordering matters most and where the
   community's own knowledge of the true order is strongest. **The clamp destroys
   monotonicity; the stored rating preserves it.**

> An earlier version of this section said "sorted by `ratingDisplay` descending".
> That was wrong on both counts above. Sort by `rating.value`. Implemented in
> `leaderboardService.js`.

### Placement exclusion is an allowlist, not a `!=`

The query filters `status in [provisional, established]`, **not**
`status != placement`. A `!=` is an inequality, and Firestore forces an
inequality to be the first `orderBy` field — which would make ordering by
`rating.value` impossible. The allowlist keeps the rating as the sort key and states
the rule positively: exactly the two visible tiers appear.

### `period`, `area`, and the movement indicator

`GET /leaderboard` takes `pool` (men/women/open), an optional `area`, and an
optional `period` (7d/30d/all).

- **`area`** filters the same `users` query by the stored `area` field.
- **`period`** sets the window the **movement indicator** compares against —
  up/down/flat since the start of the window. It does **not** change who appears
  or how they rank: the board always answers "who is best right now", and a
  player who stops playing does not fall off it.
- **Movement reads each listed player's own `ratingHistory`**, which is user
  data, not match data — the leaderboard still reads no `matches` document. No
  history in the window means the rating has not moved: **flat**, which is a fact,
  not an estimate. One small subcollection read per listed player; at ~100
  players this is cheap, and if the club outgrows it the fix is to precompute
  movement, never to show an arrow nobody can trust.

### Accepted limitation — no mixed ranking

**We cannot rank mixed-specific skill. This is a known and accepted cost of the
one-latent-rating decision.**

We keep **one latent rating per player**, so no mixed-specific rating exists to
rank. A "Mixed" tab sorted by `ratingDisplay` would be ranking **overall ability
among people who happen to play mixed**, while presenting itself as a mixed
ranking. That is a worse outcome than not shipping the tab: it looks like
information and is not.

The alternative — a second, mixed-only rating — would **halve every player's
effective data** and roughly **double time-to-calibration**. For a community of
~100 players that is clearly the worse trade. We accept the limitation.

### If mixed recognition is wanted later

It belongs in a **stats feature**, not a ranking: *mixed match count*, *mixed win
rate*, or similar.

- **Computed on read**, from the four players' gender fields.
- **Never a rating.**
- **Never a stored classification.**

A derived-on-read stat can be changed, corrected, or dropped. A stored
classification becomes a permanent field on every match document that must then
be kept honest forever.

---

## Formats

The format is **derived from the number of sets in the submitted score** and is
**never selected by the player** — a selectable multiplier is a gaming vector.

| Sets submitted | Format         | `M_format` |
|----------------|----------------|------------|
| 1              | Single set     | 0.65       |
| 2              | Best-of-three, straight sets | 1.0 |
| 3              | Best-of-three, full distance | 1.0 |

A straight-sets 2–0 win still counts **1.0×**. It is not discounted for brevity.

**There is no championship tiebreak and no ten-point tiebreak in this system.**
The validator must **reject any third set that is not a real set** — a third set
must satisfy the same legal set endings as any other set.

---

## Scores and Tiebreaks

Players enter **games only**.

**Legal set endings:** `6-0`, `6-1`, `6-2`, `6-3`, `6-4`, `7-5`, `7-6`
(and their mirrors). Anything else is rejected.

**Tiebreak points are deliberately not collected and not modelled.** They are
noise. A `7-6` set records only `7-6`.

---

## Margin Multiplier

**`M_margin` is a match-level scalar, not a per-player or per-team value.** It is
computed **once per match** and the **same value applies to all four players**.

```
M_margin = marginBase + marginCoefficient · √( |gamesA − gamesB| / (gamesA + gamesB) )
```

with `marginBase` = 0.8 and `marginCoefficient` = 0.4 from `config/rating`.
`gamesA` and `gamesB` are total games across every set in the match.

The ratio is built from an **absolute difference**, so it is always in `[0, 1]`.
**There is no signed or per-team ratio, so `√negative` cannot arise.** Do not
introduce a per-team margin — the sign is not this term's to carry.

Range: `M_margin` = 0.8 at a dead-even match, rising to 1.2 at a 6-0 6-0 whitewash.

### Why it is match-level

A blowout is **equally strong evidence for both teams** — it says as much about
the losers as the winners. The information content of a match is therefore a
property of *the match*, not of a player, and `M_margin` scales how much the
result moves everyone in it.

The other two jobs belong to other terms, and `M_margin` must not duplicate them:

- **Direction** is carried by the **sign of the Glicko-2 delta** — winners move
  up, losers move down.
- **Credit** is split by the **`2r` responsibility factor** — the weak link and
  the strong link absorb different shares.

`M_margin` answers only *how much did this match tell us*. Not who won, and not
whose fault it was.

---

## Final Delta

```
final_delta = glicko2_delta · 2r · M_format · M_margin · M_repeat
```

where `r` is that player's responsibility (`r_weak = w`, `r_strong = 1 − w`).

Note `2r` is a neutral multiplier at `d = 0`: `w = 0.5`, so `2r = 1.0` for both
players. The factor of 2 exists so the credit split re-weights rather than
uniformly shrinks.

---

## Rating and Confidence Move Together

**The principle:**

> Any multiplier that expresses **how informative a match was** must scale
> **both** the rating delta **and** the RD shrinkage. Multipliers that express
> **direction** or **credit allocation** scale the **delta only.**

| Multiplier | Expresses | Scales delta | Scales RD |
|---|---|---|---|
| `M_format` | how much of an observation this match is | yes | **yes** |
| `M_repeat` | how much *new* information this match carries | yes | **yes** |
| `M_margin` | how decisive the result was | yes | **no** |
| `2r` | whose fault it was | yes | **no** |

Updating a rating and its confidence inconsistently leaves a player **confident
in a rating we refused to let move**. That is strictly worse than either moving
the rating fully or not moving it at all. Three rules follow.

### 1. Placement players are exempt from `maxDeltaPerMatch`

The cap clamps the rating delta but cannot clamp `φ`. A capped newcomer therefore
ends up with RD falling from 350 toward ~250 while their rating sits frozen at
the cap — we became confident in a number we prevented from being correct.

**With placement exempt, the cap only ever sees provisional and established
players.** Their deltas run ~26–53 in typical play. The cap is sized against the
**worst legitimate case**, not the typical one — see *Resolved* > `maxDeltaPerMatch`.

Exemption is by **tier**, not by RD alone: a player at RD 140 with 2 games is
still in placement, and still exempt.

> **`maxDeltaPerMatch` is the only cap in this system.** A weekly gain cap was
> built and deleted — it could not be sized at any value, and when it fired it
> reintroduced this very defect at a third layer. See *Resolved* > `weeklyGainCap`.

### 2. `M_format` scales RD shrinkage

`M_format = 0.65` means *a single set is 0.65 of an observation*. A fractional
observation must scale **both** the rating movement and the confidence gained.
Scaling only the rating was incoherent — 0.65 of an observation for rating, 1.0
for confidence — and it let a player **grinding single sets reach established on
the same schedule** as one playing full matches, on noisier evidence.

### 3. `M_repeat` scales RD shrinkage

Repeatedly beating the same opponent shrinks RD to established today while
providing information about **only one opponent**. That is an abuse vector.

### Implementation

Interpolate between `φ*` (what RD would be had the match taught us nothing) and
`φ'` (the full Glicko result):

```
adjusted_phi = φ* − informativeness · (φ* − φ')

informativeness = M_format · M_repeat
```

At `informativeness = 1` this returns `φ'` exactly — the unmodified Glicko
result. Applying the interpolation once per multiplier is algebraically identical
to applying it once with their product, so the factors are composed and applied
once.

**Do not scale `σ`.** Volatility peaks at ~0.0603 even under maximum surprise, so
the correction would be second-order.

### Consequence for Step 9

**These changes alter matches-to-RD-crossing**, which *Open Question 1* depends on
for setting `gamesPlayedFloors.provisional`. **The Step 9 simulator must run
against the corrected engine.** Any distribution measured against the old
behaviour is void — RD now falls more slowly for single sets and repeat matchups,
and placement ratings now move further per match.

---

## Anti-Abuse Rules

**These must never be weakened.** They are the integrity core of the system.

1. A match requires **confirmation from at least one player on each team** before
   it affects any rating.
2. The **court must exist** in the `courts` collection.
3. **One account per phone number**, enforced via Firebase phone auth.
4. **`M_repeat`** applies diminishing returns for repeated identical matchups.
5. Players in **placement status never appear on the public leaderboard**.

> **There is no weekly gain cap.** One was built and deleted — see *Resolved* >
> `weeklyGainCap`. Do not add it back.

### What actually defends against collusion

**A winning streak and a collusion ring are identical in the data.** No rule that
reads only the match record can separate them, because a ring reports matches
that — as far as the system can see — happened exactly as described. Every
defence below therefore works by **raising the cost of fabricating a match**, not
by detecting a suspicious rating curve.

**Built, and doing the work:**

- **Both-team confirmation** — a fabricated match needs a real accomplice on the
  other side. This is the load-bearing one.
- **`M_repeat`** — a ring is, by construction, the same few people playing each
  other. Diminishing returns hit that pattern directly, and unlike a rating cap it
  fires on the *structure* of the abuse rather than on its *magnitude*.
- **One account per phone number** — a ring needs real people, not sock puppets.
- **The court directory** — a match must name a venue that exists.

**Built at Step 15 — and the only thing that can tell the two apart:**

- **`GET /admin/alerts/weekly-gain`** — the admin alert on unusual weekly gain.
  It works precisely because it does **not** try to decide: it puts a human who
  knows the players in the loop, and returns the context the data-blind cap
  lacked — `distinctOpponents` and `matchCount` beside the gain, so a ring
  (few opponents) reads differently from a streak (many). **Detection belongs to
  a person; the system's job is to surface the candidates.** See *Admin Surface*.

---

## Peer Feedback

Peer feedback covers **sportsmanship only, never skill.**

- It feeds the **trust score only**.
- It **must never touch the skill rating, and must never move RD or any other
  rating-confidence value.**

This is deliberate: it prevents the ladder becoming a popularity contest. The
moment sportsmanship moves the ladder, every rating encodes "who is liked"
alongside "who is good", inseparably.

### RD is off-limits to feedback, for the same reason the rating is

**RD is confidence in a skill estimate, and it may move only on match evidence.**
Routing social sentiment into RD would make a well-liked player's rating be
treated as **more certain purely because people like them** — and a disliked
player's as less certain. That is the *same* popularity-contest failure that
keeps feedback out of the skill rating itself; RD is not a safe side door for it.
Confidence and the rating are two coordinates of one skill estimate, and **both
are earned from results, neither from sentiment.**

**The trust score is a separate, non-rating signal.** It lives beside the rating,
never inside it — not in `µ`, not in RD, not in σ. There is no path by which a
`trustLogs` entry reaches any rating-confidence value.

> **Superseded wording — do NOT reinstate.** An earlier version of this section
> read *"feeds a trust score and RD only."* That "and RD" was wrong and is
> withdrawn. It must **not** be read as authorization to wire social signal into
> rating confidence: feedback feeds the trust score and nothing on the rating
> estimate. `feedbackService.js` enforces this — it writes only `feedback` and
> `trustLogs`, and touches no rating field.

`POST /feedback` takes a `matchId` and a `ratings` map covering the caller's
**other three** players; it validates the caller played in the match and has not
already submitted, then writes a `feedback` document and appends one `trustLogs`
entry per recipient. Implemented in `feedbackService.js`.

### The never-touch-skill rule is asserted in the code

`feedbackService.js` carries a header comment stating it must never read or write
`rating`, `ratingHistory`, or import the rating engine — with the reasoning,
**so a future session cannot re-derive a clever exception.** The specific
exception to refuse: "it only nudges RD, not the rating." CLAUDE.md does say
feedback may feed RD, but **that path is not built**, and letting social signal
move rating confidence needs its own argument, not an inference from one line of
spec during a feedback change.

### `trustScore` — defined at Step 15, against a real consumer

**`trustScore` is a shrunk mean of the 1–5 sportsmanship scores, derived on read
from `trustLogs`, in `[0,1]`, neutral at 0.5.** It was deliberately left
undefined until Step 15 gave it a consumer (admin visibility, and later
reporter-weighting) — because choosing a formula and a threshold with no data and
no consumer is exactly the failure that produced `weeklyGainCap = 200`. Now there
is a consumer, so it is defined. Implemented pure in `src/lib/trustScore.js`,
read in `trustService.js`.

```
normalise each 1-5 score to [0,1]:   (score - 1) / 4
trustScore = (Σ normalised + k · 0.5) / (n + k)      k = trustScorePriorWeight = 5
```

- **Neutral at 0.5 with no feedback.** A player is never punished for lack of
  data, and raw volume of neutral reviews cannot inflate the score. One bad
  review nudges rather than condemns; the score only nears the raw mean once
  enough reviews overcome the prior.
- **Collected on a 1–5 scale** because 5 collapses to 3 later but 3 never expands
  to 5 — store the finest resolution honestly collected, coarsen at display.
- **`k = 5`**: roughly five reviews to move halfway from neutral to the raw mean.
  Reachable in a few weeks in a 100-person club; stable early, responsive later.

### DERIVED ON READ. NEVER STORED. There is no `trustScore` field.

**The user document has no `trustScore` field, and nothing may add one.** The
source of truth is `trustLogs` (append-only, complete), so any future re-tuning of
`k` or the formula recomputes retroactively over the full history for free — the
same discipline as `ratingDisplay`.

A stored copy would be a **stale-derived-field trap**, and specifically a nasty
one: **0 is not a value this formula can return** (the minimum is `0.5·k/(n+k)`,
approached only under sustained 1-star feedback). So a stored `trustScore: 0`
default reads as *"this player is maximally untrusted"* when it actually means
*"nobody has computed anything"*. A future session reading `user.trustScore`,
getting 0, and treating it as a real low-trust signal is not a hypothetical — it
is the obvious misreading.

> **A field was removed for exactly this.** `trustScore: 0` was written at signup
> and read by nothing. It is now gone from `createUser`, from the document shape,
> and from every fixture. This is the same class as the fields already removed
> for `ratingDisplay`, `confirmationState` and `matchPool`: **a derived value with
> a stored copy is a second source of truth that drifts.** The rule generalises —
> if a value is computed from other data, do not persist it "for convenience."
>
> `POST /users` has a test pinning that signup writes no `trustScore`. The view
> allowlists strip it even if one somehow appears, and there are tests for that
> too.

**Two hard constraints, from CLAUDE.md and enforced in code:**

- **Never touches the skill rating or RD.** It is sportsmanship, not skill —
  `trustScore.js` and `trustService.js` read only `trustLogs` and touch no rating
  field. See *Peer Feedback* above.
- **Internal only.** Admin visibility now, reporter-weighting later. The raw score
  is **never rendered to players** — a visible sportsmanship number is a shaming
  and brigading vector. Exposed only under `/admin`.

---

## Disputes

`POST /matches/:id/dispute` takes a `reason` and an optional `evidenceUrl`, and
records a `disputes` document. Implemented in `disputesService.js`.

### A dispute can only be raised against a `pending` match

**Once a match is `confirmed`, it can never be disputed — the request 409s.**
This is a settled design choice, not a limitation to work around.

Both-team confirmation is already defined, elsewhere in this document, as the
system's trust checkpoint — CLAUDE.md's Anti-Abuse Rules calls it *"the
load-bearing"* anti-collusion defence. Closing the dispute window at the same
point extends that same idea one step further: the moment each team has
confirmed, the result is final, by the same logic that made confirmation mean
something in the first place.

**The alternative was tried in reasoning and rejected.** Allowing a dispute
after ratings are already applied means one of two bad outcomes: reverse the
rating (which cascades into every match those four players played afterward,
and every player downstream of *them* — a full, correct replay is a
fundamentally different and much larger engineering problem than anything else
in this system), or leave the rating standing with an open dispute that has no
clean resolution (the previous design: a `needsAdminReview` status and a
`ratingReversalRequiredManually` flag that no code path ever acted on). Closing
the door at confirmation avoids both by construction — nothing is ever
disputed once it has already moved a rating.

**One status check is the only guard needed**, and it covers three cases at
once: a match's status and "does it have a live dispute" are always in sync,
because every path that opens a dispute sets status to `disputed` in the same
transaction, and every path that resolves one moves it to `pending` or
`rejected` in the same transaction. So `raiseDispute` rejects on
`status !== pending` full stop — covering already-confirmed, already-disputed,
and already-rejected with one check, not three.

### The disputed match stays visible — to the player, and to admin

**A disputed match is never a silent disappearance.** `listPendingForPlayer`
includes `disputed` matches specifically so a player who raised (or is party
to) a dispute keeps seeing it — rendered inert (no confirm, no dispute-again),
labelled "Under review by an admin," in the same Home section a pending match
lives in. See `client/CLAUDE.md` rule 4 — the same "pending must never look
finished" principle extends to "disputed must never look gone."

### Admin resolution — two clean outcomes, because there is only one case

`POST /admin/disputes/:id/resolve` records the human decision and closes the
dispute. It takes `action` (`approve` | `cancel`) and a `note`.

- **`approve`** — no wrongdoing found. The match is restored to `pending`,
  exactly as if the dispute had never been raised, and re-enters normal
  confirmation — it still needs a real confirmation from each team before it
  can ever rate. Admin approval is never a substitute confirmation; it only
  removes the block. This is why the confirmation rule (one per team, never
  admin, never all four) stays the single path into the rating engine.
- **`cancel`** — wrongdoing found. The match is rejected permanently
  (`status: rejected`) and can never be confirmed.

Neither action ever touches a rating, because — per the rule above — a
dispute can only exist against a match where no rating was ever applied.

### The player sees the outcome either way

- **Approved** → the match reappears in the ordinary pending flow (it is,
  again, just a pending match) and can be confirmed like any other.
- **Cancelled** → the match moves into recent activity, tagged "Cancelled"
  rather than "Rated" — `listRecentForPlayer` includes `rejected` matches for
  exactly this reason. The outcome is a real, visible fact, not a status the
  player has to go ask an admin about.

### The admin panel keeps a history, not just a live queue

`GET /admin/disputes` is the live queue (open disputes only).
`GET /admin/disputes/history` lists resolved ones — resolution, resolution
note, who resolved it, when — so a past decision is auditable, not only the
in-flight state.

---

## Admin Surface

All admin routes live under **`/admin`** and are behind `requireAdmin`, in
`src/routes/admin.js`. The first admin is still made by hand in the Firebase
console; there is no API path to `isAdmin`. See *Resolved* > "isAdmin bootstrap".

### Guard mounting — a router-level guard MUST be path-scoped

**A guard runs before routing resolves whether a path exists.** So a router-level
`.use(guard)` on an *unprefixed* router runs for **every** request and converts an
unknown path's 404 into the guard's own rejection. `adminRouter` is therefore
mounted at **`/admin`**, not unprefixed — the blanket `requireAdmin` then guards
only the admin subtree.

> **This was a real bug, caught by the health test.** With `adminRouter` mounted
> unprefixed, an authenticated non-admin got **403 on every unknown path**,
> including non-admin ones. That contradicts the Step 10 decision below and leaks
> nothing useful while making the API lie about what exists.

**The rule:** router-level guards must be path-scoped (`app.use('/admin', r)`).
Per-route guards (`router.post('/courts', requireAdmin, …)`) are always safe,
because they only run when the route matches. `adminRouter` is currently the
**only** router-level guard in the app; every other guard is per-route.

### The unknown-path matrix, and why it is not uniform

| Caller | Path | Status | Why |
|---|---|---|---|
| anonymous | any non-health path | **401** | Step 10: an anonymous caller must not be able to enumerate routes |
| member | unknown, outside `/admin` | **404** | truthful — the member is authenticated and the path really does not exist |
| member | anything under `/admin` | **403** | uniform whether or not the route exists, so admin routes are not enumerable |
| admin | unknown, anywhere | **404** | truthful |

**The asymmetry is deliberate.** `requireAuth` is app-level (so anonymous callers
get 401 everywhere, hiding the route table); `requireAdmin` is scoped to `/admin`
(so members get a uniform 403 there and honest 404s elsewhere). Both guards hide
existence from callers who should not know it, and tell the truth to callers who
should. `tests/routes/health.test.js` pins every cell of this table.

| Route | Purpose |
|---|---|
| `GET /admin/disputes` | Live dispute queue, each joined to its match for context |
| `GET /admin/disputes/history` | Resolved disputes — resolution, note, who, when |
| `POST /admin/disputes/:id/resolve` | Approve or cancel — see *Disputes* |
| `POST /admin/anchors` | Set/unset `isAnchor`. Server-owned, one writer (`usersService.setAnchor`), never client-settable |
| `POST /admin/courts` | Create a court (same service as the public admin-only `POST /courts`) |
| `GET/POST/PATCH/DELETE /admin/invite-codes[/:id]` | Invite-code CRUD — `code`, `phase`, `active` |
| `GET /admin/stats` | Totals + RD histogram for charting |
| `GET /admin/alerts/weekly-gain` | Collusion lens — see below |
| `GET /admin/trust[/:id]` | trustScore visibility, lowest first |

### The weekly-gain alert presents; it never adjudicates

`GET /admin/alerts/weekly-gain` reads the write-only `ratingHistory`, sums each
player's **upward** rating moves over `weeklyGainAlertWindowDays` (7), and returns
those at or above `weeklyGainAlertThreshold` (**200**).

**This is the one mechanism that can tell a streak from a ring** — because it
does not try to. A genuine streak and a collusion ring are identical in the data;
software cannot separate them, which is why the weekly gain *cap* was deleted. So
this endpoint surfaces the pattern for a **human who knows the players**, with the
context that actually discriminates: it returns `distinctOpponents` and
`matchCount` alongside the gain. Many distinct opponents = a player beating the
field; few = a ring farming each other. The human reads that; the endpoint never
decides. See *Resolved* > `weeklyGainCap` and *Anti-Abuse Rules*.

**Why the threshold is 200.** It is deliberately the value that was too low to
*cap* — 200 fired on legitimate 6-0 6-0 upsets, which is why it failed as a cap.
As an *alert* that is exactly right: a week that would have hit the old cap is a
week worth a human glance, and firing on legitimate play costs only that glance
(the endpoint presents, it does not punish). Sums are gains only — a loss never
offsets a gain, or a ring could interleave real losses to mask farmed wins.
Configurable; tune against real data.

### The admin panel UI is a separate hand-rolled app, not part of the React client

**`admin-panel/` at the repo root** — plain HTML/CSS/JS, no build step, no
framework. Served as static files by the same Express app the API runs on
(`src/app.js`), at `/admin-panel`, entirely separate from the React client's
Vercel deployment. Reachable at `<render-url>/admin-panel`.

**Why not add it to the React client:** it is a different audience (1-2
admins, not players) with a different deploy story. Keeping it out of the
client means no Vercel deploy is needed to ship an admin fix, and no admin
code ships in the player bundle.

**Auth is the SAME phone-OTP → Firebase ID token flow, driven by hand.** The
admin API is gated by `requireAdmin`, which verifies a real Firebase token
server-side — there is no separate admin login mechanism, and this page does
not invent one. It signs in via the Firebase Auth SDK directly (loaded from
the `gstatic.com` CDN, since there is no bundler here), gets an ID token, and
sends it as a bearer header on every `/admin/*` call, exactly like the React
client does.

**`toSelfView` now exposes `isAdmin`.** It did not before — there was no
consumer, and a stray leak of "am I admin" was never a security concern (the
real gate is server-side `requireAdmin`, checked on every request regardless
of what the client believes). The admin panel calls `GET /users/me` after
sign-in and checks `isAdmin` before showing anything. **It must still never
appear in `toPublicView`/`toPlayerView`** — seeing *who else* is an admin is a
real leak (a map of who to target); seeing your own flag is not.

**`/admin-panel`'s static files are served UNAUTHENTICATED, before the blanket
`requireAuth`.** This is not a gap: the HTML/JS/CSS themselves carry no data,
same as the React client's bundle is publicly fetchable on Vercel with no
token. The token gates the *data* — every `/admin/*` call the page's own JS
makes — never the page shell itself.

**Helmet's CSP is relaxed, but ONLY for `/admin-panel`.** The default policy
(`script-src 'self'`, no `connect-src` override) blocks Firebase Auth outright:
the SDK loads from `gstatic.com`, phone sign-in calls
`identitytoolkit.googleapis.com` / `securetoken.googleapis.com`, and the
invisible reCAPTCHA runs in a `google.com`/`recaptcha.net` iframe. `src/app.js`
picks between a strict `helmet()` and a relaxed one per-request based on
`req.path`, rather than loosening the policy app-wide — the rest of the JSON
API keeps the strict default untouched.

**Scope so far — Tier 1 only:** Disputes (list + Dismiss/Void), Weekly-gain
alerts, and the stats dashboard. `GET /admin/disputes` was extended to return
`{ disputes, players }` — a uid-to-name map (via `matchesService.resolveNames`,
now exported for this) — so the panel never has to render a raw uid.

**Not built into the panel yet:** anchor management, invite-code CRUD, court
creation. All three already have working, tested API routes
(`POST /admin/anchors`, the invite-codes CRUD, `POST /admin/courts`) — the gap
is UI only. Invite codes specifically are lower priority: nothing in signup
consumes them yet, so a management screen would gate a feature that does not
functionally exist.

---

## Inactivity Decay

`src/jobs/decayRatings.js` grows the RD of players unseen for longer than
`inactivityThresholdDays` (30), by one Glicko-2 inactivity step per run
(`glicko2.applyInactivity`). We are less certain about someone we have not watched
play.

- **Only RD moves, and only upward.** Rating (µ) and volatility are untouched.
- **Capped at `defaultRd` (350).** Absence returns a player toward newcomer
  uncertainty, never past it.
- **`lastActiveAt` is never touched.** Decaying is not activity; resetting the
  clock would stop a player ever decaying again.
- **Every change writes a `ratingHistory` entry** (`reason: 'inactivity'`,
  `matchId: null`, rating unchanged) so an RD move is as auditable as a match
  move. These entries contribute zero to the weekly-gain alert, since
  `ratingAfter == ratingBefore`.

**Two run modes, one code path, chosen by env var.** Standalone via
`node src/jobs/decayRatings.js` (for an external scheduler), or in-process: set
`DECAY_SCHEDULE` to a cron expression and the Express app schedules it via
node-cron (lazy-imported). Render's cron pricing may push us to the in-process
option; the same `runDecay` runs either way.

---

## Configuration and Auditability

- **All tuning constants** — `λ`, `D`, the synergy term, `M_format` values, and
  all caps — live in a **Firestore config document**. They are **never hardcoded.**
- **Every `ratingHistory` entry is stamped with the config version that produced
  it**, so past ratings can be audited and replayed.

---

## Firestore Indexes

**Every Firestore index lives in `firestore.indexes.json` at the repo root and is
deployed from that file.** `firebase.json` points at it.

```
firebase deploy --only firestore:indexes
```

### Never create an index in the Firebase console

**A console-created index is undocumented infrastructure that exists in exactly
one place.** It cannot be code-reviewed, it does not appear in any diff, and
nothing in the repo records that the app depends on it. It gets rediscovered
painfully — when a second environment is set up, when the project is restored,
or when someone deletes it because nobody can say what it is for.

**The console's "create index" link in a failed-query error message is a trap.**
It is the fastest way to make the error go away and the fastest way to create
exactly this problem. Read the ordering it suggests, then **write it into
`firestore.indexes.json` and deploy from there.**

### The indexes, and the queries that need them

JSON files cannot carry comments, so the mapping is recorded here. **If a query
below changes, the index changes with it — they are one unit.** Firestore rejects
an unindexed composite query outright, so a missing index is a hard failure at
request time, not a slow query.

**Not every multi-filter query needs a composite index.** Firestore serves
`equality + array-contains` and `equality + in` (with no range or cross-field
`orderBy`) by **merge-join of the automatic single-field indexes**. Verified live
against the project — see *the verification below*. So these need **no composite
index**:

- Confirmation's *pair-together* query: `pairs array-contains X` + `status ==
  confirmed`, `limit 1` (selects `synergy` — *have these two partnered before?*).
- `listPendingForPlayer` / `listRecentForPlayer`: `players array-contains uid` +
  `status in […]` — the Home lists a player's pending-or-disputed and
  confirmed-or-rejected matches. See *Disputes*.

> **A third query used to live here: disputes' "is there already a live
> dispute on this match" guard (`matchId == X` + `status in […]`).** It is
> gone, not just its index note — `raiseDispute` no longer runs it at all.
> Once disputing was restricted to `pending` matches (see *Disputes*), a
> match's status and "does it have a live dispute" became always in sync, so
> the single `status !== pending` check already covers it. One less query,
> not just one less index.

**The composite indexes that ARE required** — each has a range or a cross-field
`orderBy`, which merge-join cannot cover:

| Service | Query | Index fields |
|---|---|---|
| `confirmationService` | `matchupKey ==` + `status ==` + `playedAt` range | `matchupKey` ASC, `status` ASC, `playedAt` ASC |
| `leaderboardService` | open: `status in […]` + orderBy `rating.value` | `status` ASC, `rating.value` DESC |
| `leaderboardService` | men's/women's: `+ gender ==` | `gender` ASC, `status` ASC, `rating.value` DESC |
| `leaderboardService` | open + area: `+ area ==` | `area` ASC, `status` ASC, `rating.value` DESC |
| `leaderboardService` | pool + area: `+ gender == + area ==` | `area` ASC, `gender` ASC, `status` ASC, `rating.value` DESC |

### Field order: pure-equality fields, then `in`, then the range/orderBy

**This is not intuition — it is what Firestore demanded, verified live, and it is
easy to get wrong.** The order within a composite index is:

1. **Pure equality (`==`) fields** — `gender`, `area`.
2. **The `in` field** — `status`. Firestore treats `in` like equality for
   *matching* but orders it **after** the pure-`==` fields.
3. **The range or `orderBy` field, last** — `playedAt` (range) or `rating.value`
   (`orderBy`).

> **A corrected mistake, left as a warning.** These leaderboard indexes were first
> written `status` first — `status, gender, rating.value` — reasoning that the
> `status in` filter was "an equality group" that came first. **Wrong.** Firestore
> rejected the queries and demanded `gender, status, rating.value`: the pure-`==`
> field precedes the `in` field. The error was caught only by running the real
> queries against live Firestore (Step 14 verification), because the mock suite
> cannot see index ordering at all. **Do not reorder these by reasoning; if they
> change, re-run the live check.**

**`ratingHistory` needs no COMPOSITE index today.** The leaderboard's movement
query reads one player's subcollection ordered by `createdAt` — with an optional
`createdAt >=` window — which is a single-field query Firestore indexes
automatically. Add a composite index only when a query filters or orders on more
than that one field.

### The admin surface (Step 15) needs NO composite indexes — verified live

Every admin and job query was run against live Firestore with seeded data and
**all served without an index demand**. That is a design property worth keeping,
not luck: each one is either a full-collection read or a **single**-field
filter, both of which the automatic indexes cover.

| Query | Shape | Why no composite |
|---|---|---|
| `adminStats` | three full-collection reads, counted in memory | no filters at all |
| `weeklyGainAlerts` | `users` full read; per-user `ratingHistory` `createdAt >=`; `matches` `players array-contains` | each is one field |
| `listQueue` (disputes) | full read, `status` filtered **in memory** | deliberately not `status in […]` + `orderBy`, which *would* need a composite |
| `trustLeaderboard` / `trustFor` | full read / `subjectUid ==` | one field |
| `listCodes` | `orderBy('createdAt','desc')` | single-field order |
| decay job | `lastActiveAt <` | single-field range |

**Keep it that way.** If a future change adds an equality filter beside an
`orderBy`, or a range beside anything else, it needs a composite index — and the
mock suite will not tell you. Re-run the live check.

### How these were verified, and who can deploy them

**The test suite mocks Firestore and cannot see index ordering at all** — a wrong
order passes every unit test and fails only in production. The orderings above
were therefore checked against **live Firestore**: run each real query, and a
missing/misordered composite index fails with `FAILED_PRECONDITION` carrying a
`create_composite=` URL that encodes the index Firestore actually wants. Decoding
that and comparing to `firestore.indexes.json` is the only real proof. **Re-run
that check whenever a composite query changes** — reasoning about field order is
exactly what produced the bug above.

**The application's runtime service account cannot deploy indexes.** It has
Firestore *data* access, not *index-admin* — a direct create returns 403, and the
CLI under those credentials returns 401. **Index deployment requires an
owner/editor account**, `firebase deploy --only firestore`. The app credentials
are correctly scoped to data only; do not broaden them to make deployment
convenient.

---

## API Conventions

### Request bodies are allowlisted — unknown fields are a 400

**Every write endpoint declares an allowlist of client-settable fields and
rejects any body containing anything else with a 400 naming the offending
fields.** This applies API-wide: `POST /users`, `PATCH /users/me`,
`PATCH /users/:id`, `POST /matches`, and everything added later.

- **Allowlist, never denylist.** A denylist leaks every field added after it is
  written — the next privileged field would be client-settable until a human
  remembered to update the list.
- **Reject, never strip.** Silently ignoring an unknown field lets a client ship
  believing the value took effect. `format` on `POST /matches` is the case that
  matters: a client that thinks it can select the format is asserting a claim on
  a rating multiplier. Swallowing it means that client ships, and the bug is
  found later — if ever — because nothing failed.
- **Name the rejected fields in the response.** `{ error, reason, rejected[] }`.
  The client author needs to know *which* field, not that something was wrong.

**"Server-owned" and "ignored" are not the same thing.** `format`, `winner`,
`status`, `reportedBy` and `confirmedBy` are derived or server-set — a body
carrying any of them is a 400, not a field that gets quietly overwritten.

### Double-submits are caught by an idempotency key, never a time window

**The client generates a UUID per submit action and sends it as
`idempotencyKey`. The server derives the match document id from it and stores it
on the match. A resend of the same key returns the existing match with a 200.**

- **Required, and validated as a UUID.** Fresh per submit action, not per match
  and not per session.
- **The document id is `sha256(reporterUid + ':' + key)`.** Deriving the id is
  what makes the guard atomic — `create()` throws `ALREADY_EXISTS`, so two
  double-tapped requests in flight at once cannot both pass. A read-then-write
  check would race, and a double-tap arrives milliseconds apart, so that race is
  the expected case rather than a corner.
- **The reporter's uid is hashed in** so a client cannot choose a key that
  collides with another player's match and read it back.
- **200 on a replay, not 201 and not 409.** Nothing was created, and a double-tap
  is not an error to show a player.
- **A repeat of a key returns the stored match even if the body differs.** The
  key names the action; a changed body under a reused key is a client bug.

> **Do not reintroduce a time-window duplicate check.** See *Resolved*.

---

## Code Conventions

- **ES modules.** No CommonJS.
- **async/await.** No callbacks.
- **Pure functions for all rating math**, kept free of any database or HTTP calls
  so they stay unit-testable. Rating math takes values in, returns values out.
- **Vitest** for tests.
- **Every rating math function must have tests.**
- **Route tests share ONE HTTP server per file.** Create it lazily via
  `sharedServer()` and close it in `afterAll` — never one server per request.

> **Why: an observed ~1-in-25 flake.** The route helpers used to `listen(0)` and
> `close()` around every single request. That churns ephemeral ports fast enough
> that a recycled port can serve a request from a different listener — the
> symptom was a test receiving Express's default **HTML** 404 instead of our JSON
> one, so `res.json()` threw `Unexpected token '<'`. It looked like a routing bug
> and was not. One server per file fixed it: 60 consecutive clean runs after,
> versus ~1-in-25 before. **A flaky suite is worse than a missing test** — it
> trains people to re-run instead of read, and this suite is the only thing
> standing between the rating engine and a silent corruption.

---

## Simulator Requirements (Step 9)

The offline replay simulator **must** sweep `λ_mixed` across **0.12, 0.20, and
0.30**, holding everything else fixed, and report the **log-loss difference**
between them at the actual match volume.

### The RD floor — report as a distribution, not a number

The engine uses a rating period of one match, so RD settles at an **equilibrium
floor** rather than approaching zero. **The floor is not a constant** — it is a
function of how informative a player's typical match is, so it varies across the
population. See *Resolved* > "Rating period = one match" for the analysis.

The simulator **must**:

1. **Report the observed RD floor as a distribution across the population** — not
   as a single number. A single number would hide the entire finding.
2. **Report the floor as a function of each player's skill gap from the field
   median.** That is the axis the floor actually varies along.
3. **Explicitly report whether the strongest simulated player ever reaches
   established.**

4. **Report observed floors from REALISTIC play patterns, not theoretical worst
   cases.** The analytical worst cases in this document are asymptotic equilibria
   under conditions the seven-day `M_repeat` window makes unreachable. They bound
   the problem; they do not describe it.
5. **Report the size of the affected population** — how many players, if any,
   actually sit above the established threshold under simulated play. **This is
   currently unverified.** Claims elsewhere about how many players a high floor
   affects are not established and must not be treated as such.

**If the strongest player never reaches established, that is a finding requiring a
product decision.** For example: an escape hatch into established, or accepting
that the top of the ladder displays as provisional.

**Any escape hatch must gate on DISTINCT OPPONENTS FACED, not `gamesPlayed`.** See
*Resolved* > "Rating period = one match". `gamesPlayed` inverts the two
populations — the grinder has more games than the dominant player — so a hatch
sized on it reopens the abuse vector `M_repeat` exists to close.

**Do not fix it by moving `rdThresholds.provisional`.** The threshold is doing its
job correctly — it is reporting genuine uncertainty about a player whose matches
are foregone conclusions. Moving it would suppress the symptom and corrupt the
tier's meaning for everyone else.

The floor and the matches-to-crossing distribution both feed *Open Question 1*.

This is not optional polish. `λ_mixed` is the **only constant in the system whose
value encodes a claim about gender**, and it is currently unevidenced. The sweep
exists to force a verdict:

- **If the three are indistinguishable at our match volume**, the constant does
  not matter yet. That is a genuinely useful result — it means the choice is
  unfalsifiable with the data we have, and nobody should spend further effort
  defending or attacking it.
- **If they diverge sharply**, we are shipping a consequential number we cannot
  justify, and it must be set from data rather than intuition.

Report the result either way. "The sweep was inconclusive" is a finding, not a
failure.

### Related: what `λ_mixed` does and does not control

Setting `λ_mixed = λ_same` makes `w`, team µ, and the `2r` credit split
**identical** for mixed and same-gender pairs. It does **not** remove gender from
the math — `synergy` still branches on pairing type, which flows into `φ_team`
and `g(φ_team)`, damping update magnitude by roughly 0.3%.

The two are different kinds of claim and should be judged separately:

- **`λ_mixed`** asserts *the weak link matters more in mixed pairs* — a claim
  about skill dynamics, affecting the credit split by up to ~11% of a delta.
- **`synergy.mixed`** asserts *we are less certain about an unfamiliar mixed
  pair* — a claim about uncertainty, symmetric across both players, worth ~0.3%.

---

## Deployment (Step 17)

**Not built yet.** Requirements recorded here as they are settled.

### Firestore indexes deploy alongside the security rules

**The indexes and the security rules are one deployment, not two.** Both are
repo-defined, both are Firestore configuration, and both are deployed by the
Firebase CLI from files that `firebase.json` points at:

| Artefact | File | Status |
|---|---|---|
| Composite indexes | `firestore.indexes.json` | **written** — see *Firestore Indexes* |
| Security rules | `firestore.rules` | **not written** — Step 17 |

```
firebase deploy --only firestore          # rules + indexes together
```

**Deploying one without the other is a half-configured database.** Rules without
indexes means every confirmation fails on a missing index; indexes without rules
means the collections are governed by whatever was there before. Neither failure
is visible until a request hits it.

`firebase.json` currently declares only `firestore.indexes`, because
`firestore.rules` does not exist yet — a pointer to a missing file breaks the
whole deploy. **Step 17 adds the `rules` key at the same time it adds the file.**

**Deploy under an owner/editor account, not the app's service account.** The
runtime credentials in `.env` have Firestore data access only and are rejected by
both the CLI and the index API — verified during Step 14 and again when the
client was wired. (The same credentials *can* use the Firebase **Management** API,
which is how the web app was registered; the permissions are not uniform, so test
rather than assume.) This is the correct scoping; deployment is a human-operator
action, not something the running app does.

> ### ⚠ The leaderboard is DEAD until the indexes are deployed
>
> The five composite indexes in `firestore.indexes.json` have their orderings
> validated against live Firestore, but they have **not been created**. Until
> they are, `GET /leaderboard` returns **500** against the real database —
> confirmed live: `9 FAILED_PRECONDITION: The query requires an index`.
>
> This does not show up in the test suite, which mocks Firestore. It is a
> deployment step, not a code defect. Clear it with:
>
> ```
> firebase login
> firebase deploy --only firestore:indexes --project chennai-padel
> ```
>
> The `matchupKey` index matters the same way: match **confirmation** will fail
> the moment a second match between the same four players is confirmed.

**The API deploys separately, to Render.** The Firebase CLI deploys database
configuration only; it is not the app's deployment path.

---

## Constants — Current Values

> **These are reasoned starting estimates, not values derived from real padel
> data.** They must be tuned by **offline replay once roughly 300 real matches
> exist.** Treat every number here as provisional. The config-version stamp on
> `ratingHistory` exists precisely so that retuning can be replayed against
> historical matches.

Live values are in Firestore at `config/rating`, seeded by `scripts/seedConfig.js`.
This table mirrors **version 1** and must be kept in step with it.

| Config key | Value | Notes |
|------------|-------|-------|
| `version` | 1 | Stamped onto every `ratingHistory` entry |
| `tau` | 0.5 | Glicko-2 volatility constraint |
| `defaultRating` | 1500 | Everyone starts here |
| `defaultRd` | 350 | High RD at start |
| `defaultVolatility` | 0.06 | |
| `lambdaSame` | 0.12 | Same-gender pairs |
| `lambdaMixed` | 0.12 | Mixed pairs. **Deliberately equal to `lambdaSame` at launch** — see *Resolved*. Raise only from the Step 9 sweep. |
| `gapScaleD` | 1.15 | Gap scale, Glicko-2 internal units |
| `synergy.same.repeat` | 0.10 | Same-gender, played together before |
| `synergy.same.firstTime` | 0.17 | Same-gender, first pairing |
| `synergy.mixed.repeat` | 0.17 | Mixed, played together before |
| `synergy.mixed.firstTime` | 0.23 | Mixed, first pairing |
| `formatSingleSet` | 0.65 | 1 set submitted |
| `formatThreeSet` | 1.0 | 2 or 3 sets submitted |
| `marginBase` | 0.8 | Floor at zero margin |
| `marginCoefficient` | 0.4 | Max `M_margin` = 1.2 at total blowout |
| `repeatMultipliers` | `[1.0, 0.7, 0.4, 0.2]` | By prior identical matchups in window; index 0 = first meeting, counts past the end clamp to the last entry |
| `repeatWindowDays` | 7 | |
| `maxDeltaPerMatch` | 300 | Bug backstop. Placement players are **exempt**. Sized above the worst legitimate provisional delta on both `lambdaMixed` branches — see *Resolved*. |
| `rdThresholds.placement` | 250 | `RD >= 250` = placement (hidden from leaderboard). Strict bound. **Launch value** — loosened from 150; see *Tiers and Placement > Launch adjustment*. |
| `rdThresholds.provisional` | 100 | `RD < 100` required for established. Strict bound. |
| `gamesPlayedFloors.provisional` | 3 | Minimum games to leave placement. **Launch value** — loosened from the Step-9 value of 8 for a populated board; see *Tiers and Placement > Launch adjustment* and *Resolved*. |
| `gamesPlayedFloors.established` | 10 | Minimum games to reach established |
| `weeklyGainAlertThreshold` | 200 | 7-day gain that surfaces a player on the admin collusion alert. Presents, never caps — see *Admin Surface*. |
| `weeklyGainAlertWindowDays` | 7 | Window for the weekly-gain alert |
| `trustScorePriorWeight` | 5 | Pseudocount `k` in the shrunk-mean trustScore — see *Peer Feedback* |
| `inactivityThresholdDays` | 30 | Days unseen before inactivity decay grows RD — see *Inactivity Decay* |

### Operational keys are not rating-math

`weeklyGainAlertThreshold`, `weeklyGainAlertWindowDays`, `trustScorePriorWeight`
and `inactivityThresholdDays` (Step 15) are operational thresholds — they shape no
rating delta, so adding them does **not** invalidate `ratingHistory` replay and
did not need a new config version. They live in `config/rating` and are still
required (a missing one throws), because a deployment missing an alert or decay
threshold is misconfigured and should fail loudly. **Adding them required
reseeding `config/rating` (`seedConfig.js --force`)** — safe here because zero
matches reference the old config; the rating constants themselves were untouched.

### Config rules

- `configService.getConfig()` has **no fallback defaults.** A missing key throws.
  A silent default would hardcode a constant and stamp history with a version
  that does not describe the values that produced it.
- **To retune, write a new config version.** Never edit an existing version's
  values in place — `ratingHistory` points at versions, and rewriting one breaks
  replay. `scripts/seedConfig.js` refuses to overwrite unless passed `--force`.

### Still not specified

| Constant | Status |
|----------|--------|
| Placement exit rule | **Decided.** `RD < 250` **and** `gamesPlayed >= 3` (launch values). Both gate — see *Tiers and Placement*. Post-launch target is `RD < 150` / `>= 8 games`. |

---

## Open Questions

**1. Display precision overclaims by roughly 10×.** Needs a product decision
before the leaderboard is built. Blocked on nothing.

Step 9 measured the **RD floor at ~62**. That gives a rating a **95% confidence
interval of ±122 rating points**. On a 0–7 display scale spanning ~1500 rating
points (≈214 points per display unit), that is **±0.57 display units**.

**The wireframes show a single decimal — e.g. `3.4`.** That notation claims a
precision of **±0.05 display units**, or ±11 rating points.

**We are overclaiming by a factor of ~11.**

| | Rating points | Display units |
|---|---|---|
| Actual 95% CI | ±122 | **±0.57** |
| Precision `3.4` implies | ±11 | ±0.05 |

**A 3.4 vs 3.5 ordering is noise presented as fact.** The gap between them is 21
rating points; the uncertainty on each is ±122 — the gap is **5.7× smaller than
the error bar**.

### The correct frame is pairwise, not population-level

**Do not use the Spearman resolution limit here.** Step 9's finding that ranks
resolve at ~40 rating points (~0.19 display units) is a **population-level**
threshold: it measures whether the **overall ordering comes out roughly right**.

**A leaderboard makes a different and stronger claim** — that **each adjacent
pair is correctly ordered**. The right statistic for that is the **standard error
of the difference** between two ratings:

```
SE_diff = √(RD_a² + RD_b²)
```

At the RD 62 floor: `√(62² + 62²)` = **87.7 rating points**.

**P(correct pairwise ordering)** — the probability the board puts two players in
the right order:

| Display gap | Rating points | P(correct order) |
|---|---|---|
| 0.19 units (the Spearman threshold) | 41 | **68%** |
| **0.5 (half-point step)** | 107 | **89%** |
| 1.0 (full display unit) | 214 | **99%** |

**This changes the verdict on half-point steps.** They are **defensible at ~89%**,
not marginal. And **0.19 display units is close to a coin flip** — the Spearman
threshold is nowhere near sufficient for a pairwise claim.

> An earlier note in this project's history claimed half-point steps "sit near
> the edge of what the engine can distinguish", reasoning from the 0.19 Spearman
> figure. That was the wrong statistic. Do not reuse it.

**These figures assume the RD 62 floor, which is the BEST case** — it applies to
established players only.

**And RD 100 is not "the provisional case" — it is the BEST provisional case.**
Provisional spans **RD 100–150** (below 100 is established, 150 and above is
placement), so a player who has just cleared placement sits near **150**.

At a **half-point display gap** (107 rating points):

| Comparison | `SE_diff` | P(correct) | Wrong |
|---|---|---|---|
| two established (62 vs 62) | 87.7 | **89%** | 1 in 9 |
| established vs best provisional (62 vs 100) | 117.7 | 82% | 1 in 5.5 |
| two best-provisional (100 vs 100) | 141.4 | 78% | 1 in 4.5 |
| freshly-visible vs established (150 vs 62) | 162.3 | **75%** | 1 in 4 |
| **two freshly-visible (150 vs 150)** | **212.1** | **69%** | **1 in 3.3** |

So among players who have only just appeared on the board, **nearly one adjacent
pair in three is in the wrong order** at half-point display — and those are
exactly the players whose position the community has least independent knowledge
of, and who are most likely to be checking.

Full grid at the two extremes:

| Display gap | RD 62 (established) | RD 150 (freshly visible) |
|---|---|---|
| 0.19 units | 68% | 58% |
| 0.5 units | **89%** | **69%** |
| 1.0 units | 99% | 84% |

**This matters most at the top of the leaderboard**, for two compounding reasons:

- Players there are **closest in skill**, so true gaps are smallest relative to
  the noise.
- The community's **own knowledge of the true order is strongest** there. A
  ranking that contradicts what everyone can see is the fastest way to lose trust
  in the whole system.

### Plausible resolutions — not yet chosen

1. **Half-point display steps** (3.5, 4.0, 4.5) — ~89% pairwise correct for
   established players, ~78% for provisional.
2. **Show the confidence interval** alongside the number.
3. **Skill bands instead of precise ranks.**

### None of the three escapes the problem

**A leaderboard is a total order regardless of display granularity.**

- **Bands still have to be sorted internally** — something decides who appears
  first within a band.
- **The list still reads as a ranking**, whatever the number beside it says.

Coarsening the *number* does not coarsen the *order*, and the order is the claim
players actually read.

**So the real product decision is narrower than "what precision do we show":**

> **Does the top of the board show ranks at all, or does it show a band with
> members listed alphabetically?**

Alphabetical ordering within a band is the only option here that genuinely stops
claiming an order we cannot support. Everything else is presentation.

---

## Resolved

Decisions that are settled. **Do not reopen these.** The reasoning is recorded
because it is worth more than the answer — a future session that re-derives the
answer without the reasoning will get it wrong again.

### `duplicateWindowMinutes` — deleted, replaced by an idempotency key

**There is no time-window duplicate check and no `duplicateWindowMinutes` in
config. Do not reintroduce one.**

**What it was:** a submission with the same four players at the same court and a
`playedAt` within 30 minutes of an existing match was rejected as a double-submit
with a 409.

**Why it was wrong:** **a single set takes 25–40 minutes.** The same four players
playing consecutive single sets therefore fall *inside* a 30-minute window, and
the second set — a real match — was rejected. And single sets are not a corner
case: **Step 9 showed that format wins per court hour**, so the window was
rejecting the most common legitimate submission in the system.

**Why no window can work.** The failure is not the number 30. Widening the window
rejects more real matches; narrowing it stops catching the double-taps it exists
for. The two cases the window is trying to separate — a double-tap and a genuine
consecutive set — **look identical in the data it inspects**, because players,
court and approximate time are the same in both. A window is guessing at *intent*
from *timing*, and there is no threshold that reads intent correctly.

**Why the key works:** the client already knows the answer the window was trying
to infer. One tap on submit is one action, and it carries one key. A double-tap
resends **the same key**, and is caught exactly. Two consecutive sets are two
actions with **two keys**, and both succeed. Nothing is inferred.

**`M_repeat` is the term that handles the same four players playing repeatedly.**
It applies diminishing returns to the *rating*, which is the correct response — a
second set against the same opponents carries less new information. It is not the
duplicate guard's job to decide those matches should not exist, and the window was
quietly making that decision.

See *API Conventions* for the mechanism.

### `M_margin` for the losing team — match-level scalar

`M_margin` is computed once per match from the absolute games difference and
applied to all four players. There is no signed or per-team ratio, so
`√negative` cannot arise. See *Margin Multiplier*.

### `maxDeltaPerMatch` — 300, sized against the worst legitimate delta

**The cap is a bug backstop. It must never fire on legitimate play.** Size it
against the worst *legitimate* delta, not the typical one.

Worst legitimate case: a **provisional** player at RD 149, partnered to maximise
`2r`, winning 6-0 6-0 — e.g. a 1200 partnering a 2000 and beating two 2000s. That
is a real upset the system *should* move fully.

| Population spread | `lambdaMixed` 0.12 | `lambdaMixed` 0.20 |
|---|---|---|
| 1300–1700 (narrow) | 160.5 | 180.6 |
| 1200–2000 (club) | 185.7 | 209.7 |
| 1000–2400 (wide) | 189.0 | 213.4 |

- **150 fired on legitimate play at every spread**, including the narrowest. It
  was already shaping provisional play, not backstopping bugs.
- **200 clears 0.12 but fires at 0.20.** The Step 9 sweep may conclude 0.20 is
  correct, and the test fixture already retains 0.20 for that reason. A cap that
  breaks when a *planned* config change lands is the failure the cap exists to
  avoid.
- **300 clears both branches** with headroom, and still catches a catastrophic
  delta — a runaway value is orders of magnitude out, not 20% over.

**Sizing rule for any future change:** re-measure the worst legitimate delta on
**both** `lambdaMixed` branches before moving this number. A cap validated on one
branch is not validated.

> An earlier figure of **138.9** appears in this project's history as the "worst
> observed" case. It was measured with two identically-rated teammates, so
> `2r = 1.0` — no responsibility amplification. It understates the true worst case
> by ~35%. Do not reuse it.

### `weeklyGainCap` — deleted, not resolved

**There is no weekly gain cap and no `weeklyGainCap` in config. It was built,
measured, and deleted. Do not reintroduce it.**

**The concept was removed rather than its value settled.** This is not "we
haven't picked a number yet" — **no number works**. The cap was squeezed out from
both ends and there is nothing in the middle.

#### Too low: it fires on legitimate play

The worst *legitimate* single match is the case `maxDeltaPerMatch` is already
sized for — a provisional player at RD 149, partnered to maximise `2r`, winning
6-0 6-0. Measured against the real engine:

| Case | Delta | vs. a 200 cap |
|---|---|---|
| Typical provisional win, even match | 52.3 | — |
| Eight straight even-match wins | 203.0 | cap binds |
| Worst legitimate match, `λ_mixed` 0.12, club spread | 184.5 | **92% of the week, in one match** |
| **Worst legitimate match, `λ_mixed` 0.20, club spread** | **208.3** | **exceeds the whole week, in one match** |

At the seeded value of 200, **one honest upset consumed 92% of the week**. On the
**`λ_mixed` = 0.20 branch the fixtures deliberately keep live** for the Step 9
sweep, a single honest match **exceeds the entire weekly allowance** — the cap
would clamp one legitimate result.

**This is the identical failure that pushed `maxDeltaPerMatch` from 200 to 300:**
*a cap that breaks when a planned config change lands is the failure the cap
exists to avoid.*

#### Too high: it is redundant

**`maxDeltaPerMatch` at 300 already catches per-match bugs.** Raise the weekly cap
above the worst legitimate week and the only thing it still catches is **"many
matches, each individually sane."**

That is **not a bug signature.** That is someone playing a lot of padel.

#### Nothing in between: it cannot stop collusion

**Any cap permissive enough to survive a legitimate upset is permissive enough
for a ring to pace itself underneath.** This follows directly from the fact
already recorded here: **a streak and a ring are identical in the data.** The cap
cannot decide which it is looking at, so it fires on both or neither — and at any
value real play survives, a ring simply farms the allowance weekly and arrives at
the same rating a few weeks later.

**It buys time. It never bought safety.**

#### And when it fired, it reintroduced the Step 8 defect — for the third time

A cap clamps the rating but **cannot clamp `φ`**. A capped player's RD shrinks the
full amount while their rating sits frozen, leaving the system **confident in a
number it refused to let move**.

**This is the third layer at which that same defect has appeared** — after
`maxDeltaPerMatch` on placement players, and after `M_format`/`M_repeat` scaling
the delta but not RD. In the first two cases the defect was fixable, because the
term was doing a job worth keeping. Here it was not: **a cap whose only correct
value is "off" is not a cap with a bug, it is a cap with no job.**

#### What replaces it: nothing, because nothing was needed

The anti-collusion defences are **both-team confirmation, `M_repeat`, one account
per phone number, and the court directory** — all already built, and all working
by making a fabricated match *expensive* rather than by policing the rating curve.
Plus the **Step 15 admin alert on unusual weekly gain**, which is the only
mechanism that can actually distinguish a streak from a ring, because it puts a
**human who knows the players** in the loop. See *Anti-Abuse Rules*.

The cap was standing in front of that alert pretending to be it.

#### What survives — the two exemption rules were correct

Both rules were right, and both still apply to **`maxDeltaPerMatch`**, which is
now the only cap:

- **Placement players are exempt.** They are hidden from the leaderboard, so there
  is no position to farm; their purpose is to converge fast; and capping them is
  exactly the Step 8 defect above. Exemption is by **tier**, not RD alone.
- **A cap applies to gains only, never to losses.** Capping a loss would **prop up
  a rating that is falling for a legitimate reason** — the opposite of what an
  anti-abuse rule should do.

Keep both in mind for any future cap. They are the reason this one got as far as
it did before the sizing killed it.

### Rating period = one match

**The engine treats every single match as a rating period.** `φ*` is computed and
applied on every match.

**This is deliberate, not an oversight.**

Glickman designed `φ*` as a *pre-rating-period* inflation representing expected
skill drift since the player was last rated, and recommends rating periods
averaging **10–15 games per player**. We therefore apply the drift allowance
**10–15× more often** than the `σ` scale assumes.

**Why we do it anyway:** batching matches into multi-game rating periods would
leave a player's rating **stale for days after they play**. That is unacceptable
for this product — the rating is the thing players come back to see. Per-match
updating is standard in real-time implementations.

**The consequence — an RD floor.** Because inflation is applied per match rather
than per batch, RD reaches an **equilibrium floor** where per-match inflation
balances per-match shrinkage.

Setting `φ' = φ` and solving gives:

```
v_equilibrium = φ² (φ² + σ²) / σ²
```

Players therefore **do not asymptote toward RD 0** — ratings stay permanently
responsive. **Any RD below the floor is unreachable through real play.** The RD 30
in some test fixtures is reachable in tests only; do not treat fixture RDs as
evidence about production behaviour.

#### The floor clears the established threshold for normal play

An RD of 100 would require `v ≈ 30.8`, which requires an **opposing team RD of
~816**. The maximum individual RD is 350, and team RD is *lower* still under
weak-link weighting. **Unreachable.** Computed floors for an even matchup:

| Play pattern | Floor |
|---|---|
| Three-set matches (informativeness 1.0) | **RD 60.3** |
| Single sets only (informativeness 0.65) | **RD 67.5** |

Both clear the established threshold of 100 comfortably.

#### The floor is NOT a constant — it is a function of informativeness

Because `v = 1 / (g² · E(1−E))`, the floor **rises as E approaches 0 or 1**. The
floor is a property of *how informative a player's typical match is*, not a
property of the engine.

| Skill gap from field median | Floor (three-set) | Floor (single sets) |
|---|---|---|
| level | 60.3 | 67.5 |
| +300 | 71.1 | 79.5 |
| +500 | 89.1 | 99.3 |
| **+600** | **100.8** | **112.1** |
| +700 | 114.2 | 126.6 |

**The effects compound.** A player who is both strong *and* only logs single sets
hits the wall at a smaller skill gap than either effect alone predicts.

> **Caveat on the low-informativeness figures.** These are **asymptotic
> equilibria under sustained conditions**, not floors anyone reaches. The
> informativeness 0.13 floor of 103.9 assumes 0.13 on *every* match — which is
> **unreachable**, because `M_repeat` resets on a **seven-day window**. Match 1 of
> each week is a fresh meeting at full informativeness regardless of how many
> follow it. Measured worst case for a player grinding the same four-player
> matchup in single sets, forever:
>
> | Identical single sets per week | Floor |
> |---|---|
> | 4 | 78.6 |
> | 8 | 87.7 |
> | 20 | **96.5** |
>
> Even twenty per week indefinitely stays **below** the established threshold.
> Realistic mixed patterns floor at **61–70**. A player who mixes opponents or
> formats floors at a blend well below the worst case.

#### Two populations, one symptom, opposite correct responses

A high floor has two causes. **They look identical in the data and require
opposite responses. Do not merge them.**

| | **Dominant player** | **Single-set repeat grinder** |
|---|---|---|
| Cause of high floor | The **field cannot test them** | They face **one opponent** |
| Opponent diversity | **Wide** | **Narrow** |
| Verdict | **Product failure** | **System working as designed** |
| Correct response | **Get them ranked** | **Leave it alone** |

**The dominant player is a product failure** *in principle*: the field cannot test
them, every match is a foregone conclusion, and they would sit at provisional
permanently, never appearing on the leaderboard they would top.

> **Step 9 finding — the threshold is far higher than this analysis implied.**
> The reasoning above was derived in a **singles-like frame**, and it does not
> transfer cleanly to doubles.
>
> **A dominant player is partnered with a field player every single match**, and
> weak-link weighting drags their team down into contention. Measured: an outlier
> **+600 above a clustered field** produces a team gap of only **228**, not 600.
> E(win) = 0.79, which is plenty informative.
>
> | Outlier gap above field | Team gap | E(win) | Equilibrium floor |
> |---|---|---|---|
> | 600 | 228 | 0.786 | 66.4 |
> | 900 | 342 | 0.875 | 74.1 |
> | 1200 | 456 | 0.931 | 84.6 |
> | 1500 | 570 | 0.963 | 97.9 |
> | **2000** | **760** | **0.987** | **126.8 — stuck** |
>
> Simulated: an outlier +600 above a clustered field reached established in
> **8 of 8 runs**, median floor **68.1** against a field floor of 62.1 — a penalty
> of just **6 RD**.
>
> **The failure requires an outlier ~1500–2000 above the field**, which is not
> plausible in a padel club. **Doubles is self-mitigating here**, and structurally
> so: there is no partner for the dominant player *except* a field player.
>
> This is recorded as **not currently a live risk**, not as disproven in
> principle. If the pool ever stratifies enough that a player is 1500+ clear,
> revisit.

**The grinder is the system working exactly as designed.** `M_repeat` exists
*precisely* to stop someone reaching established on a rating built from one
opponent. A floor above 100 in that case is **that abuse vector closing, not a
bug.** Nothing needs fixing.

#### Consequence: a `gamesPlayed` escape hatch cannot work

This is a **disqualification, not a tradeoff.**

`gamesPlayed` is **the one signal that cannot separate the two cases** — and it
does not merely fail to separate them, it **inverts** them. The grinder has *more*
games than the dominant player, by construction: grinding is what produces the
volume.

So **any hatch sized to release the dominant player reopens, by construction, the
abuse vector `M_repeat` exists to close.** It would release the grinder first.

**If an escape hatch is ever built, it must gate on the number of DISTINCT
OPPONENTS faced, not games played.** Opponent diversity is what actually differs
between the two cases: wide for the dominant player, narrow for the grinder. It
separates them cleanly on exactly the axis where `gamesPlayed` inverts them.

**Step 9 requirement:** see *Simulator Requirements*. If the strongest simulated
player never reaches established, that is a **finding requiring a product
decision** — not something to fix by moving the threshold.

### The `isAdmin` bootstrap is manual — and stays manual

**There is no API path to `isAdmin`. There must never be one.**

**How the first admin is made:**

1. Sign up through the normal flow (`POST /users`).
2. Set `isAdmin: true` on that user document **directly in the Firebase console**.

Every admin after that is granted via `PATCH /users/:id`.

**Do not add a script or an endpoint to automate step 2.**

Whatever would guard such a script — an env var, a first-user-wins rule, a shared
secret — **becomes a permanent privilege-escalation path in exchange for a
one-time convenience.** The guard is the vulnerability. A first-user-wins rule
races; a shared secret leaks; an env var is readable by anything that reads env
vars.

**Current posture: zero paths to `isAdmin` outside a Google-authenticated
Firebase console session with project-level access.** That is intended, not an
oversight.

> **This is NOT the same class of problem as the `POST /users` signup deadlock.**
>
> That deadlock made an endpoint's *entire purpose* unreachable, and **every user
> would hit it, forever**. It had to be fixed in the code.
>
> This is **a one-time flag on one document**, set by the one person who already
> owns the Firebase project. The asymmetry is the whole argument: a permanent
> attack surface is not a fair price for a step taken once.

### `gender` is mutable — admin only

**`gender` can be changed. It is admin-patchable, never self-patchable, and never
immutable.**

- `PATCH /users/me` — rejects `gender`.
- `PATCH /users/:id` — admin only, accepts `gender`.

**Why it is safe to change:** `pairingType` is **frozen on every match document**
as an audit record and is never recomputed. That rule already protects the past.
So changing gender:

- leaves **past matches untouched** — they keep the `pairingType` that actually
  produced their deltas;
- makes **future matches use the new value**, correctly;
- moves the player to the **correct leaderboard** — which is the *desired
  outcome*, not corruption.

**The audit record is precisely what makes gender safe to change.**

**Why it must not be immutable:** a player who mis-taps at signup would be on the
wrong leaderboard **permanently**. Their only recourse would be a new account,
which **one account per phone forbids** — an unresolvable support ticket. The
same applies to a trans player, where *"your gender is immutable, contact
support"* is not something this app should say to a member of a 100-person
community where everyone knows everyone.

**Why admin-gated rather than self-serve:** self-serve invites nothing malicious
— gender confers **no rating advantage**, since men's, women's and open all read
the same latent scale. Admin-gating buys a **log and a human check**, which is
proportionate for a field that changes which board someone appears on. The change
is logged with the acting admin's uid.

> **The immutability reasoning was WRONG. Do not reintroduce it.**
>
> An earlier version of this project argued that gender must be immutable because
> changing it "would rewrite the basis of matches already played." **It cannot.**
> `pairingType` is stored frozen per match; nothing recomputes it from the user's
> current gender. That argument inverts the actual situation — the frozen audit
> record is the reason the change is safe, not a reason to forbid it.

### `matchPool` — deleted, not resolved

**There is no `matchPool` field and no match-level gender classification.** The
concept was removed rather than its taxonomy settled. Do not reintroduce it.

**Why it existed:** to drive leaderboard eligibility.

**Why that was wrong:** **the leaderboards are user-level filters, not
match-level ones.** The men's leaderboard filters `users` by gender; the women's
leaderboard does the same. Neither ever needed match data. Only the mixed tab
reached for it.

**And the mixed tab cannot work regardless.** We keep one latent rating per
player, so **no mixed-specific rating exists to rank.** A mixed tab sorted by
`ratingDisplay` would rank overall ability among people who play mixed while
presenting itself as a mixed ranking — worse than shipping nothing, because it
looks like information and is not.

So the only consumer of `matchPool` was a feature that could not be built
correctly. Settling the taxonomy of M+F vs M+M would have been solving a
classification problem that existed only to feed a broken view.

**The taxonomy that replaces it:** men's, women's, **open** — where open is every
player, unfiltered. All three are simple `users` queries sorted by
`ratingDisplay` with placement players excluded. See *Leaderboards*.

**The accepted cost:** we cannot rank mixed-specific skill. This is a known and
accepted consequence of the one-latent-rating decision, not an oversight. The
alternative — a second mixed-only rating — would halve every player's effective
data and roughly double time-to-calibration, which is worse for a community of
~100 players.

**What survives:** `pairingType` is unchanged. It is per-team, drives `λ` and
`synergy`, and is stored as an audit record of what fed an already-applied delta
— so the never-recompute rule genuinely applies to it, in a way it never did for
a classification that only powered a view.

### `gamesPlayedFloors.provisional` — Step-9 value 8, OVERRIDDEN to 3 for launch

> **Launch override.** The live value is **3**, not 8. The Step-9 analysis below
> is preserved because it is the number to return to — but for launch the floor
> was lowered to 3 (and `rdThresholds.placement` raised to 250) so players appear
> on the leaderboard after ~3 matches rather than never. This is a deliberate
> board-populated-over-precision trade; see *Tiers and Placement > Launch
> adjustment* for the full reasoning and the plan to tighten back. The Step-9
> derivation of 8 remains correct as the post-launch target.

**The Step-9 value was 8** (was 5 before that), being the **p90 of
matches-to-placement-exit for a clustered population** — exactly what Open
Question 1 specified.

Step 9 measured (400 matches, 20 players):

| Population | Placement exit (RD < 150) |
|---|---|
| Wide spread | min 6, p50 7.5, **p90 10**, max 14 |
| **Clustered (the beta)** | min 6, p50 7, **p90 8**, max 9 |

**The clustered figure is the one used**, per Open Question 1: the beta is
skill-clustered, closer matches are more informative, so RD falls faster than an
open population suggests.

**p90, not the mean** — the floor should bind for nearly everyone. A mean-based
floor would leave the top half of the distribution back on the fallback copy,
which is the outcome the countdown design exists to avoid.

### `lambdaMixed` — closed at 0.12 by the Step 9 sweep

**The sweep was DIVERGENT, not inconclusive.** `lambdaMixed` measurably changes
predictive accuracy. Results at 400 matches, wide spread:

| `lambdaMixed` | log-loss | Spearman |
|---|---|---|
| **0.12** | **0.5586** (best) | 0.9323 |
| 0.20 | 0.5629 | 0.9534 |
| 0.30 | 0.5710 (worst) | 0.9564 (best) |

**The two metrics disagree.** 0.12 gives the best log-loss; 0.30 gives the best
rank correlation.

**Resolved in favour of log-loss. `lambdaMixed` stays at 0.12.** Two reasons:

1. **Log-loss is the only one of the two measurable in production.** Rank
   correlation requires ground truth — a hidden true skill that exists in the
   simulator and nowhere else. We can compute log-loss against real results
   forever; we can never compute Spearman against reality. Optimising a metric we
   cannot observe after launch is optimising a number we will never see again.
2. **0.12 was already the launch value, chosen on independent grounds** — it is
   the only constant encoding a claim about gender, and it was set equal to
   `lambdaSame` because we could not show 0.20 was right. The sweep does not
   overturn that; it supports it.

**The sweep has served its purpose. Do not re-run it to justify raising the
value.** If `lambdaMixed` is ever revisited, it needs a new argument, not this one.

### `lambdaMixed` at launch — equal to `lambdaSame` (0.12)

**Launch with `lambdaMixed` = `lambdaSame` = 0.12.** Confirmed by the Step 9
sweep — see above.

**This is not a judgement that 0.20 is wrong.** It may well be right — targeting
the weaker player is a real tactic, and it is plausibly more pronounced in mixed
play. The problem is that **we cannot yet show it is right.**

The reasoning:

- **It is the least defensible number in an otherwise well-grounded system.**
  Every other constant is either a Glicko-2 standard, a rule of padel, or an
  admitted estimate that the replay will tune. `λ_mixed` at 0.20 was an estimate
  that also happened to encode a claim about gender.
- **It is the one constant with a social cost if challenged.** A player asking
  "why does the system treat mixed pairs differently?" deserves a better answer
  than "it seemed about right." At `λ_mixed = λ_same` the honest answer is "it
  doesn't, until the data says it should."
- **Starting equal is the conservative default**, not the timid one. Treating the
  two identically until evidence separates them is the same discipline applied
  everywhere else in this system.
- **It is cheap to reverse.** The value lives in `config/rating`. Raising it is
  one document edit plus a replay — and by then the sweep will say whether it
  should be raised at all.

**What this does not do:** it does not remove gender from the math. `synergy`
still branches on pairing type. That is a separate and more defensible claim —
see *Simulator Requirements*.

### Weak/strong ordering — by µ alone

**Teammates are ordered by µ. The lower µ is the weak link.** RD, φ, and
conservative bounds like `µ − k·φ` play no part in this ordering.

**Why µ:** µ is our best point estimate of ability, and on-court targeting — the
thing weak-link weighting models — is a function of *ability*. RD is uncertainty
*about* that estimate. It is not a skill adjustment, and treating it as one
conflates two different quantities.

**Why not a conservative bound:** `µ − k·φ` would make **every high-RD newcomer
the weak link by construction**, regardless of actual ability. That is a
systematic bias, not a signal — the ordering would encode "we haven't seen you
play much" as "you are worse," which is precisely the error the rating system
exists to avoid.

**Why not fold RD in at all:** uncertainty already enters the system correctly in
**two** places:

1. **Glicko-2 scales the update magnitude by φ** — uncertain players move more.
2. **`φ_team` combines both players' variances** — uncertain pairs produce
   uncertain team estimates.

A third injection at the ordering step would **double-count** it.

**On being wrong sometimes:** ordering by µ when RD is high will occasionally
pick the wrong weak link. That error is **symmetric noise, not bias** — it is
equally likely in either direction and **self-corrects as RD falls**. Its effect
is bounded by `λ` (0.12–0.20), so a mis-ordering shifts `w` by at most ~0.2 from
the neutral 0.5. A systematic bias has neither of those properties, which is why
it is the worse failure.
