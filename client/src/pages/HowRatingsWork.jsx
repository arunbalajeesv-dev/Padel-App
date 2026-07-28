import { useNavigate } from 'react-router-dom';

import { useAuth } from '../auth/authContext.js';
import BackButton from './BackButton.jsx';

/**
 * A plain-language explainer for how the rating system works, linked from the
 * Home rating card ("How is this calculated?").
 *
 * ---------------------------------------------------------------------------
 * CONTENT RULE: CONCEPTS ONLY, NEVER THE MATH.
 *
 * This page explains BEHAVIOUR ("beating a stronger team counts for more"),
 * never the FORMULA that produces it. No constant from config/rating (λ, D,
 * synergy, margin coefficients, the delta cap, RD thresholds…) appears here,
 * and none should be added. That is the same rule client/CLAUDE.md states for
 * the rest of the app — the copy below is hand-written explanatory prose, not
 * derived from any config value, and it stays that way even as the numbers
 * behind it get retuned.
 * ---------------------------------------------------------------------------
 */

const TIERS = [
  {
    key: 'placement',
    label: 'Placement',
    blurb: 'Brand new. Hidden from the leaderboard while the system learns your level.',
  },
  {
    key: 'provisional',
    label: 'Provisional',
    blurb: 'On the board — but your rating is still settling in.',
  },
  {
    key: 'established',
    label: 'Established',
    blurb: 'A proven regular. Your rating has been tested across enough matches to trust.',
  },
];

const PRINCIPLES = [
  {
    title: 'Everyone starts level',
    body: "Every new player starts at exactly the same rating. Nobody picks their own starting point, and there's no skill question at signup — it's earned entirely from how your matches go.",
  },
  {
    title: 'Win, and your rating rises. Lose, and it falls.',
    body: "That's the whole engine. Nothing else feeds into the number — not how long you've played, not how popular you are, just results.",
  },
  {
    title: 'Beating a stronger team counts for more',
    body: 'An upset win over higher-rated players moves your rating more than beating players below you — and losing to a stronger team costs you less than losing to a weaker one. Every result is judged against what was expected.',
  },
  {
    title: "In doubles, your partner's level matters too",
    body: "A team's rating leans a bit toward whichever partner is currently rated lower — that's usually who opponents target on court. So carrying a weaker partner to a win is stronger proof of your own game than winning alongside an equally strong partner would be.",
  },
  {
    title: 'A bigger scoreline is stronger evidence',
    body: 'A 6-0, 6-0 win tells the system a lot more than a tight three-setter, so a convincing scoreline moves ratings a little further than a nail-biter — for both teams.',
  },
  {
    title: 'A full match tells the system more than a single set',
    body: 'A quick single set still counts, but a complete match is more information, so it moves your rating — and how confident the system is in it — a bit further.',
  },
  {
    title: 'Beating the same four people again and again teaches less',
    body: 'The first time you and your partner face a given pair of opponents, that\'s fresh information. Play that exact matchup over and over in a short span, though, and each repeat counts for less — mixing up who you play keeps your rating moving at full strength.',
  },
  {
    title: 'A match only counts once the other team agrees it happened',
    body: 'After a result is logged, someone from the OTHER team has to confirm it before it touches anyone\'s rating. That keeps the whole system honest.',
  },
  {
    title: 'New ratings move fast, settled ones move slowly',
    body: "Early on, the system isn't sure about you yet, so a handful of matches can swing your rating a lot while it finds your level. The more you play, the more confidence it builds, and the less any single match moves you — which is exactly why new players stay off the leaderboard until their rating has had a chance to settle.",
  },
];

export default function HowRatingsWork() {
  const navigate = useNavigate();
  const { profile } = useAuth();

  return (
    <div className="confirm-page">
      <header className="confirm-header">
        <BackButton onClick={() => navigate('/')} />
        <h1 className="confirm-title">How ratings work</h1>
      </header>

      <div className="confirm-body">
        <p className="explainer-intro">
          Padel Chennai ranks players using match results only — no self-ratings,
          no guessing your level. Here's the plain-English version of how your
          number moves.
        </p>

        <section className="profile-section">
          <h2 className="section-title">Where you are</h2>
          <div className="tier-journey">
            {TIERS.map((tier) => {
              const isMine = tier.key === profile?.status;
              return (
                <div
                  key={tier.key}
                  className={isMine ? 'tier-step tier-step-active' : 'tier-step'}
                >
                  <div className="tier-step-label">{tier.label}</div>
                  <p className="tier-step-blurb">{tier.blurb}</p>
                  {isMine && <div className="tier-step-you">You are here</div>}
                </div>
              );
            })}
          </div>
        </section>

        <section className="profile-section">
          <h2 className="section-title">The rules it plays by</h2>
          <div className="principle-list">
            {PRINCIPLES.map((p) => (
              <div key={p.title} className="principle-card">
                <h3 className="principle-title">{p.title}</h3>
                <p className="principle-body">{p.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="profile-section">
          <h2 className="section-title">What never affects your rating</h2>
          <p className="confirm-note">
            Sportsmanship feedback from other players is tracked separately and
            never touches your rating. Your gender only decides which
            leaderboard tab you appear on (Men's or Women's) — everyone,
            including the Open board, is ranked on the exact same scale. And
            nothing about how long you've been a member counts, beyond the
            matches you've actually played.
          </p>
        </section>
      </div>
    </div>
  );
}
