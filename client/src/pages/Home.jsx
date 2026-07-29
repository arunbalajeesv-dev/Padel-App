import { useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';

import { useAuth } from '../auth/authContext.js';
import { getPendingMatches, getRecentMatches, ApiError } from '../api/index.js';
import { tierLabel, reliability, placementMessage } from './homeView.js';
import MatchCard from './MatchCard.jsx';

/** After this long with no response, assume Render's free tier is cold-starting. */
const COLD_START_MS = 4000;

/**
 * Home. Four sections, top to bottom: greeting, rating card, pending
 * confirmations (the priority), and log + recent activity.
 *
 * Renders what the API returns and computes nothing about ratings. The rating
 * card reads the profile the auth context already loaded via getMe; the two
 * match lists are fetched here.
 */
export default function Home() {
  const navigate = useNavigate();
  const location = useLocation();
  const { profile } = useAuth();

  const [lists, setLists] = useState({ status: 'loading', pending: null, recent: null, error: null });
  const [coldStart, setColdStart] = useState(false);

  // A one-time flash from DisputeMatch, for immediate feedback on the submit
  // itself. The match ALSO stays visible below, in its own "Under review"
  // section — see PendingSection — so this is a confirmation the action
  // worked, not the only trace that it happened.
  const [disputeFlash, setDisputeFlash] = useState(Boolean(location.state?.disputedMatch));
  useEffect(() => {
    if (!disputeFlash) return undefined;
    // Clear the router state so a refresh or back-nav doesn't re-show it, and
    // auto-dismiss so it does not linger indefinitely.
    window.history.replaceState({}, '');
    const timer = setTimeout(() => setDisputeFlash(false), 6000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => alive && setColdStart(true), COLD_START_MS);

    (async () => {
      try {
        const [pending, recent] = await Promise.all([
          getPendingMatches(),
          getRecentMatches({ limit: 8 }),
        ]);
        if (alive) setLists({ status: 'ready', pending, recent, error: null });
      } catch (err) {
        if (alive) setLists({ status: 'error', pending: null, recent: null, error: err });
      } finally {
        clearTimeout(timer);
        if (alive) setColdStart(false);
      }
    })();

    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);

  const rel = reliability(profile?.status);
  const placement = placementMessage(profile?.placement);

  return (
    <section className="home">
      {/* 1. Header */}
      <header className="home-header">
        <h1 className="home-greeting">Hi, {profile?.name ?? 'there'}</h1>
      </header>

      {disputeFlash && (
        <div className="dispute-flash" role="status">
          Match flagged for review. It won't affect anyone's rating unless an
          admin confirms the issue.
        </div>
      )}

      {/* 2. Rating card */}
      <div className="rating-card">
        <div className="rating-number">{profile ? profile.ratingDisplay.toFixed(1) : '—'}</div>
        <div className="rating-tier">{tierLabel(profile?.status)}</div>

        <div className="reliability">
          <span className="reliability-label">Reliability: {rel.label}</span>
          <div className="reliability-track">
            <div className="reliability-fill" style={{ width: `${rel.fill * 100}%` }} />
          </div>
        </div>

        {placement.show && <p className="placement-note">{placement.text}</p>}

        <button
          type="button"
          className="rating-info-link"
          onClick={() => navigate('/how-ratings-work')}
        >
          How is this calculated?
        </button>
      </div>

      {/* 3. Pending confirmations — the priority. Collapses when empty. */}
      <PendingSection
        lists={lists}
        coldStart={coldStart}
        onConfirm={(id) => navigate(`/matches/${id}/confirm`)}
        onDispute={(id) => navigate(`/matches/${id}/dispute`)}
      />

      {/* 4. Log + recent activity */}
      <button className="btn-primary log-btn" type="button" onClick={() => navigate('/log')}>
        Log a match
      </button>

      <RecentSection lists={lists} />
    </section>
  );
}

function PendingSection({ lists, coldStart, onConfirm, onDispute }) {
  if (lists.status === 'loading') {
    return coldStart ? <WakingUp /> : <SkeletonCards label="Waiting on you" count={1} />;
  }

  if (lists.status === 'error') {
    return <LoadError error={lists.error} what="pending confirmations" />;
  }

  const matches = lists.pending?.matches ?? [];
  if (matches.length === 0) return null; // collapse quietly — no empty box

  const names = { players: lists.pending.players, courts: lists.pending.courts };

  // A disputed match is blocked on an admin, not on any player — that split
  // matters more than viewerNeedsToConfirm, which is meaningless once a match
  // is disputed (nobody can act on it either way). Split those out first, then
  // divide the rest exactly as before: who this viewer must act on now, versus
  // who they've already confirmed and are waiting on the other team for.
  const disputed = matches.filter((m) => m.status === 'disputed');
  const awaitingConfirmation = matches.filter((m) => m.status !== 'disputed');
  const action = awaitingConfirmation.filter((m) => m.viewerNeedsToConfirm);
  const waiting = awaitingConfirmation.filter((m) => !m.viewerNeedsToConfirm);

  return (
    <>
      {action.length > 0 && (
        <section className="home-section">
          <h2 className="section-title section-title-urgent">Waiting on you ({action.length})</h2>
          <div className="match-stack">
            {action.map((m) => (
              <MatchCard
                key={m.id}
                match={m}
                names={names}
                mode="action"
                onConfirm={onConfirm}
                onDispute={onDispute}
              />
            ))}
          </div>
        </section>
      )}

      {waiting.length > 0 && (
        <section className="home-section">
          <h2 className="section-title">Pending — waiting on the other team</h2>
          <div className="match-stack">
            {waiting.map((m) => (
              <MatchCard key={m.id} match={m} names={names} mode="waiting" />
            ))}
          </div>
        </section>
      )}

      {disputed.length > 0 && (
        <section className="home-section">
          <h2 className="section-title">Under review</h2>
          <div className="match-stack">
            {disputed.map((m) => (
              <MatchCard key={m.id} match={m} names={names} mode="disputed" />
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function RecentSection({ lists }) {
  if (lists.status === 'loading') return <SkeletonCards label="Recent activity" count={2} />;
  if (lists.status === 'error') return null; // the pending section already surfaced it

  const matches = lists.recent?.matches ?? [];
  const names = { players: lists.recent?.players ?? {}, courts: lists.recent?.courts ?? {} };

  return (
    <section className="home-section">
      <h2 className="section-title">Recent activity</h2>
      {matches.length === 0 ? (
        <p className="empty-note">No rated matches yet. Log one to get started.</p>
      ) : (
        <div className="match-stack">
          {matches.map((m) => (
            <MatchCard key={m.id} match={m} names={names} mode={m.status === 'rejected' ? 'rejected' : 'rated'} />
          ))}
        </div>
      )}
    </section>
  );
}

/** Patient state for Render's cold start — not an error. */
function WakingUp() {
  return (
    <div className="home-section waking">
      <div className="spinner" aria-hidden="true" />
      <p>Waking up the server… the first load after a quiet spell takes a few seconds.</p>
    </div>
  );
}

function LoadError({ error, what }) {
  const offline = error instanceof ApiError && error.status === 0;
  return (
    <div className="home-section load-error" role="alert">
      <p>
        {offline
          ? `Can't reach the server. Check your connection and pull to retry.`
          : `Couldn't load your ${what}. Please try again.`}
      </p>
    </div>
  );
}

function SkeletonCards({ label, count }) {
  return (
    <section className="home-section" aria-hidden="true">
      <h2 className="section-title section-title-skeleton">{label}</h2>
      <div className="match-stack">
        {Array.from({ length: count }).map((_, i) => (
          <div key={i} className="match-card skeleton-card" />
        ))}
      </div>
    </section>
  );
}
