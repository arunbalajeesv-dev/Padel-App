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

### One latent scale

There is a single latent rating scale for all players regardless of gender.

- Gender is handled by **separate leaderboards only**: men's, women's, mixed.
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
- `λ` = 0.12 for same-gender pairs, 0.20 for mixed pairs.

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

```
M_margin = 0.8 + 0.4 · √ratio

ratio = (games_won − games_lost) / total_games_played
```

Computed across all games in the match.

> **Open — must be resolved before implementing.** `ratio` is negative from the
> losing team's perspective, and `√negative` is undefined. See *Open Questions*.

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

## Anti-Abuse Rules

**These must never be weakened.** They are the integrity core of the system.

1. A match requires **confirmation from at least one player on each team** before
   it affects any rating.
2. The **court must exist** in the `courts` collection.
3. **One account per phone number**, enforced via Firebase phone auth.
4. **`M_repeat`** applies diminishing returns for repeated identical matchups.
5. There is a **weekly rating gain cap**.
6. Players in **placement status never appear on the public leaderboard**.

---

## Peer Feedback

Peer feedback covers **sportsmanship only, never skill.**

- It feeds a **trust score and RD only**.
- It **must never touch the skill rating.**

This is deliberate: it prevents the ladder becoming a popularity contest.

---

## Configuration and Auditability

- **All tuning constants** — `λ`, `D`, the synergy term, `M_format` values, and
  all caps — live in a **Firestore config document**. They are **never hardcoded.**
- **Every `ratingHistory` entry is stamped with the config version that produced
  it**, so past ratings can be audited and replayed.

---

## Code Conventions

- **ES modules.** No CommonJS.
- **async/await.** No callbacks.
- **Pure functions for all rating math**, kept free of any database or HTTP calls
  so they stay unit-testable. Rating math takes values in, returns values out.
- **Vitest** for tests.
- **Every rating math function must have tests.**

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
| `lambdaMixed` | 0.20 | Mixed pairs |
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
| `maxDeltaPerMatch` | 150 | Anti-abuse cap |
| `weeklyGainCap` | 200 | Anti-abuse cap |
| `rdThresholds.placement` | 200 | RD above this = placement (hidden from public leaderboard) |
| `rdThresholds.provisional` | 100 | RD above this = provisional; at or below = established |

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
| Placement exit rule | Partly defined by `rdThresholds.placement` (RD ≤ 200 leaves placement). Whether a **minimum match count** also gates exit is undecided. |

---

## Open Questions

**1. `M_margin` for the losing team.** `ratio = (games_won − games_lost) / total`
is negative for the loser, making `√ratio` undefined. Three readings:

- **(a)** Margin is a per-*match* property: compute `ratio` once from the winner's
  perspective and apply the same `M_margin` to all four players. A decisive match
  carries more information about everyone in it.
- **(b)** Use `|ratio|`, which is arithmetically identical to (a).
- **(c)** Margin is per-*player-perspective*, requiring a different formula for
  the losing side.

(a) is the reading consistent with `M_margin` sitting alongside `M_format` as a
match-level multiplier. **Unconfirmed — must be settled before implementation.**

**2. Weaker/stronger by which quantity?** `w` is defined via `d`, the gap in
Glicko-2 internal units, so "weaker" and "stronger" presumably order by µ
(rating), ignoring RD. A high-RD player with a high µ is uncertain, not
established. Unconfirmed.
