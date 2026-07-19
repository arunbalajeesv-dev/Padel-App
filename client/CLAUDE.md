# CLAUDE.md — Padel App Client

Fixed rules for the **frontend**. The backend has its own `CLAUDE.md` at the repo
root; that one is authoritative for rating math, API contracts and data shape.
**This file never restates a backend rule — it records what the client must and
must not do.** Where the two touch, the root file wins.

Follow these in every session. If a change appears to require breaking a rule
here, stop and raise it — do not work around it.

---

## Stack

React SPA in `/client`, alongside the Express backend in the same repo.

- **Vite + React, plain JavaScript.** No TypeScript — matches the backend.
- **React Router** for navigation.
- **Firebase web SDK** for phone authentication only.
- Bottom-tab layout: **Home, Log Match, Leaderboard, Profile**, matching the
  wireframes at the repo root.

---

## 1. The client never computes ratings

**The client renders exactly what the API returns.** It does not compute, derive,
adjust, round or re-scale any rating value.

Specifically, none of the following may ever appear in this folder:

- Glicko-2 math of any kind — no `µ`, `φ`, `σ`, no `toMu`/`toRating`, no
  `GLICKO_SCALE` (173.7178).
- Any multiplier — `M_format`, `M_margin`, `M_repeat`, the `2r` responsibility
  factor, `λ`, synergy.
- **Display-scale math.** `ratingDisplay` is computed server-side from
  `config.displayScale`. The client shows the number it is given.
- Tier logic. Whether a player is `placement`, `provisional` or `established` is
  a server decision that arrives as a field.

**Why:** the server owns all rating logic, and a second implementation in the
browser is a second source of truth that will drift. It would also ship the
formula to every user, which the root `CLAUDE.md` forbids outright — no rating
formula, constant, or intermediate value goes to the browser.

**The client's job is render and confirm.** If a screen seems to need a rating
computed, the answer is a new API field, not arithmetic here.

---

## 2. The client holds no secrets

**Everything in this folder is public.** It ships in a bundle that anyone can
read. Design accordingly.

- **The Firebase *web* config is public by design** — `apiKey`, `authDomain`,
  `projectId` and friends identify the project; they authorise nothing. Access is
  enforced by Firebase Auth and Firestore security rules. Committing the web
  config to `.env.example` is fine and intended.
- **The Admin SDK service account must never come near the browser.**
  `FIREBASE_PRIVATE_KEY` and `FIREBASE_CLIENT_EMAIL` live in the *backend* `.env`
  only. That credential bypasses every security rule in the project; in a client
  bundle it is a total compromise, not a leak to tidy up later.
- **`apiKey` is not a password.** Do not "protect" it by moving it out of the
  bundle — that achieves nothing and suggests a misunderstanding worth
  correcting in review.
- No admin-only data belongs in the client. `trustScore`, rating internals
  (`value`, `rd`, `sigma`), and the weekly-gain alert are admin-surface only.

Local and deployed builds differ **only by environment variables** — never by a
code branch on hostname or `NODE_ENV`. `VITE_API_BASE_URL` points at the Express
API; see `.env.example`.

---

## 3. Auth is phone OTP → ID token → bearer token

The only authentication flow:

1. **Firebase phone OTP in the browser** (Firebase web SDK).
2. Firebase returns an **ID token**.
3. The client sends that token to the Express API as
   `Authorization: Bearer <idToken>`.
4. The API verifies it with the Admin SDK and derives `req.uid`.

**The client never talks to Firestore directly.** All reads and writes go through
the Express API. The rating engine, the anti-abuse rules and the allowlists all
live behind that API; a direct Firestore read would bypass every one of them.
Firebase in this app is Auth-in-the-browser and nothing else.

ID tokens expire (~1 hour). The API distinguishes an expired token from an
invalid one precisely so the client can refresh silently rather than dumping the
player back to a login screen — use that distinction.

---

## 4. `pending` must never look finished

**A match awaiting confirmation must be visually distinct from a rated one.** In
every list, card, detail view and notification — whatever the design system ends
up being.

**Why this is a hard rule and not a styling preference:** the entire rating
system depends on players confirming matches. A match needs one confirmation from
**each** team before it affects any rating. **An unconfirmed match that looks
finished never gets confirmed** — the player who should act sees a completed
result and does nothing, and the match silently never counts.

So a `pending` match must carry an unmistakable, non-decorative signal of
incompleteness, and — where there is room — say who it is waiting on. The API
returns `status`, `confirmation` and `awaitingConfirmationFrom` for exactly this.

**Colour alone is not sufficient.** It fails for colour-blind users and vanishes
in dark mode, screenshots and notifications. Pair it with a label, an icon, or a
distinct card treatment.

> The same reasoning applies to a **disputed** match, and to the difference
> between "your rating moved" and "your rating will move once X confirms". Never
> show a rating change as settled when it is not.

---

## Code conventions

- **ES modules**, `async/await`, matching the backend.
- **Components in `src/pages` and `src/layout`**; shared API access in `src/api`;
  configuration in `src/config`.
- **Placeholders stay inert.** A not-yet-built screen renders an honest stub — no
  mock match cards, no fake ratings. Plausible fake data hides which screens
  actually work, and this project has repeatedly paid for values that looked real
  and were not.
