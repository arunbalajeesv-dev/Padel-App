/**
 * Padel Chennai admin panel — plain HTML/JS, no build step, served as static
 * files by the same Express app the API runs on (see src/app.js).
 *
 * Auth is the SAME phone-OTP → Firebase ID token flow the player app uses,
 * because the admin API (src/routes/admin.js) is gated by `requireAdmin`,
 * which verifies a real Firebase token server-side. There is no separate
 * admin login mechanism, and this page does not invent one — it just drives
 * the same sign-in by hand, without React.
 *
 * Tier 1 only: Disputes (+ history), Weekly-gain alerts, Stats.
 * Anchors/invite-codes/court creation are not built here yet — see the
 * conversation this was scoped in.
 *
 * A dispute can only ever be raised against a match that was never rated —
 * confirming a match closes the door on disputing it (see
 * src/services/disputesService.js). So resolving one has exactly two clean
 * outcomes, never a "ratings already applied" case to worry about:
 *   approve — no wrongdoing. Match goes back to `pending`; normal
 *             confirmation proceeds as if never disputed.
 *   cancel  — wrongdoing found. Match is rejected permanently.
 */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js';
import {
  getAuth,
  RecaptchaVerifier,
  signInWithPhoneNumber,
  onAuthStateChanged,
  signOut,
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js';

// Public web config — not a secret, same values the React client ships with
// (client/.env). Identifies the Firebase project; grants nothing on its own.
const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyCMVFa07H6GI2KHKODBL_xMcNbNLHUlbZw',
  authDomain: 'chennai-padel.firebaseapp.com',
  projectId: 'chennai-padel',
  storageBucket: 'chennai-padel.firebasestorage.app',
  messagingSenderId: '600681459321',
  appId: '1:600681459321:web:3c4cabfc0723f9c5dfaea8',
};

const firebaseApp = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(firebaseApp);

// Same-origin: this page is served by the same Express app the API runs on.
const API_BASE = '';

// --- DOM refs ---------------------------------------------------------------

const $ = (id) => document.getElementById(id);

const signOutBtn = $('signOutBtn');
const signInView = $('signInView');
const notAdminView = $('notAdminView');
const dashboardView = $('dashboardView');
const phoneStep = $('phoneStep');
const codeStep = $('codeStep');
const phoneInput = $('phoneInput');
const codeInput = $('codeInput');
const sendCodeBtn = $('sendCodeBtn');
const verifyCodeBtn = $('verifyCodeBtn');
const restartBtn = $('restartBtn');
const signInError = $('signInError');
const disputeBadge = $('disputeBadge');

// --- Small helpers -----------------------------------------------------------

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value ?? '';
  return div.innerHTML;
}

function showError(el, message) {
  el.textContent = message;
  el.hidden = !message;
}

function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** The one path any authenticated call goes through — mirrors client/src/api/client.js. */
async function apiFetch(path, { method = 'GET', body } = {}) {
  const user = auth.currentUser;
  if (!user) throw new Error('Not signed in.');
  const token = await user.getIdToken();

  const res = await fetch(API_BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  if (res.status === 204) return null;
  const text = await res.text();
  const payload = text ? JSON.parse(text) : null;

  if (!res.ok) {
    const reason = payload?.reason || payload?.errors?.join(', ') || payload?.error || `Request failed (${res.status})`;
    throw new Error(reason);
  }
  return payload;
}

// --- Sign-in (phone OTP) -----------------------------------------------------

let verifier = null;
let confirmationResult = null;

function getVerifier() {
  if (!verifier) {
    verifier = new RecaptchaVerifier(auth, 'recaptcha-container', { size: 'invisible' });
  }
  return verifier;
}

function clearVerifier() {
  try {
    verifier?.clear();
  } catch {
    // Already torn down.
  }
  verifier = null;
}

sendCodeBtn.addEventListener('click', async () => {
  showError(signInError, '');
  sendCodeBtn.disabled = true;
  try {
    confirmationResult = await signInWithPhoneNumber(auth, phoneInput.value.trim(), getVerifier());
    phoneStep.hidden = true;
    codeStep.hidden = false;
  } catch (err) {
    showError(signInError, err.message || 'Could not send the code. Check the number and try again.');
    clearVerifier();
  } finally {
    sendCodeBtn.disabled = false;
  }
});

verifyCodeBtn.addEventListener('click', async () => {
  showError(signInError, '');
  verifyCodeBtn.disabled = true;
  try {
    await confirmationResult.confirm(codeInput.value.trim());
    // Success: onAuthStateChanged below takes over.
  } catch (err) {
    showError(signInError, err.message || 'That code did not work. Try again or restart.');
  } finally {
    verifyCodeBtn.disabled = false;
  }
});

restartBtn.addEventListener('click', () => {
  clearVerifier();
  confirmationResult = null;
  codeInput.value = '';
  codeStep.hidden = true;
  phoneStep.hidden = false;
  showError(signInError, '');
});

signOutBtn.addEventListener('click', () => signOut(auth));

// --- Auth state → view switching --------------------------------------------

onAuthStateChanged(auth, async (user) => {
  signInView.hidden = Boolean(user);
  signOutBtn.hidden = !user;
  notAdminView.hidden = true;
  dashboardView.hidden = true;

  if (!user) return;

  try {
    const me = await apiFetch('/users/me');
    if (!me?.isAdmin) {
      notAdminView.hidden = false;
      return;
    }
    dashboardView.hidden = false;
    initDashboard();
  } catch (err) {
    showError(signInError, err.message || 'Could not verify this account.');
    signInView.hidden = false;
  }
});

// --- Dashboard: tabs ---------------------------------------------------------

let dashboardInitialised = false;

function initDashboard() {
  loadStats();
  loadDisputes();
  loadHistory();
  loadAlerts();

  if (dashboardInitialised) return;
  dashboardInitialised = true;

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => selectTab(btn.dataset.tab));
  });
  selectTab('stats');
}

function selectTab(name) {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === name);
  });
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.hidden = panel.id !== `${name}Tab`;
  });
}

// --- Stats --------------------------------------------------------------

async function loadStats() {
  const el = $('statsContent');
  try {
    const stats = await apiFetch('/admin/stats');
    el.innerHTML = renderStats(stats);
  } catch (err) {
    el.innerHTML = `<p class="error">Could not load stats: ${escapeHtml(err.message)}</p>`;
  }
}

function renderStats(stats) {
  const cards = [
    ['Total players', stats.totalPlayers],
    [`Active (${stats.activeWindowDays}d)`, stats.activePlayers],
    ['Total matches', stats.totalMatches],
    ['Confirmed matches', stats.confirmedMatches],
    ['Matches this week', stats.matchesThisWeek],
    ['Pending disputes', stats.pendingDisputes],
  ];

  const cardsHtml = cards
    .map(([label, value]) => `
      <div class="stat-card">
        <div class="stat-value">${escapeHtml(String(value))}</div>
        <div class="stat-label">${escapeHtml(label)}</div>
      </div>
    `)
    .join('');

  const maxCount = Math.max(1, ...stats.rdHistogram.map((b) => b.count));
  const bars = stats.rdHistogram
    .map(
      (b) => `<div class="histogram-bar" data-count="${b.count || ''}" style="height:${Math.round((b.count / maxCount) * 100)}%"></div>`,
    )
    .join('');
  const labels = stats.rdHistogram.map((b) => `<span>${b.min}</span>`).join('');

  disputeBadge.hidden = stats.pendingDisputes === 0;
  disputeBadge.textContent = stats.pendingDisputes;

  return `
    <div class="stat-grid">${cardsHtml}</div>
    <h3>RD distribution</h3>
    <div class="histogram">${bars}</div>
    <div class="histogram-labels">${labels}</div>
  `;
}

// --- Disputes -----------------------------------------------------------

async function loadDisputes() {
  const el = $('disputesContent');
  try {
    const { disputes, players } = await apiFetch('/admin/disputes');
    el.innerHTML = renderDisputes(disputes, players);
    wireResolveForms(players);
  } catch (err) {
    el.innerHTML = `<p class="error">Could not load disputes: ${escapeHtml(err.message)}</p>`;
  }
}

function playerName(players, uid) {
  return players[uid] ?? uid;
}

function renderDisputes(disputes, players) {
  if (disputes.length === 0) {
    return '<p class="empty-note">No open disputes.</p>';
  }

  return `<div class="card-list">${disputes.map((d) => renderDisputeCard(d, players)).join('')}</div>`;
}

function renderDisputeCard(dispute, players) {
  const m = dispute.match;
  const teamA = m ? m.teamA.map((uid) => playerName(players, uid)).join(' / ') : '—';
  const teamB = m ? m.teamB.map((uid) => playerName(players, uid)).join(' / ') : '—';
  const score = m?.sets?.map((s) => `${s.teamA}-${s.teamB}`).join(', ') ?? '';

  return `
    <article class="card" data-dispute-id="${escapeHtml(dispute.id)}">
      <div class="card-top">
        <span>${m ? formatDate(m.playedAt) : ''}</span>
        <span class="tag">Not yet rated</span>
      </div>
      <div class="card-teams">
        <span>${escapeHtml(teamA)}</span>
        <span>vs</span>
        <span>${escapeHtml(teamB)}</span>
      </div>
      ${score ? `<div class="card-meta">Score: ${escapeHtml(score)}</div>` : ''}
      <div class="card-reason">
        <strong>${escapeHtml(playerName(players, dispute.raisedBy))} says:</strong>
        ${escapeHtml(dispute.reason)}
      </div>
      ${dispute.evidenceUrl ? `<div class="card-meta"><a href="${escapeHtml(dispute.evidenceUrl)}" target="_blank" rel="noopener noreferrer">Evidence</a></div>` : ''}

      <form class="resolve-form" data-resolve-form>
        <textarea placeholder="Note (required, min 5 characters) — what did you decide and why?" required minlength="5"></textarea>
        <div class="resolve-actions">
          <button type="button" class="btn-small" data-action="approve">Approve — match stands</button>
          <button type="button" class="btn-small btn-small-danger" data-action="cancel">Cancel match</button>
        </div>
        <p class="error" hidden></p>
      </form>
    </article>
  `;
}

function wireResolveForms() {
  document.querySelectorAll('[data-resolve-form]').forEach((form) => {
    const card = form.closest('[data-dispute-id]');
    const disputeId = card.dataset.disputeId;
    const textarea = form.querySelector('textarea');
    const errorEl = form.querySelector('.error');
    const buttons = form.querySelectorAll('button[data-action]');

    buttons.forEach((btn) => {
      btn.addEventListener('click', async () => {
        const note = textarea.value.trim();
        if (note.length < 5) {
          showError(errorEl, 'Note must be at least 5 characters.');
          return;
        }
        showError(errorEl, '');
        buttons.forEach((b) => (b.disabled = true));
        try {
          await apiFetch(`/admin/disputes/${encodeURIComponent(disputeId)}/resolve`, {
            method: 'POST',
            body: { action: btn.dataset.action, note },
          });
          await Promise.all([loadDisputes(), loadHistory(), loadStats()]);
        } catch (err) {
          showError(errorEl, err.message || 'Could not resolve this dispute.');
          buttons.forEach((b) => (b.disabled = false));
        }
      });
    });
  });
}

// --- Dispute history -------------------------------------------------------

async function loadHistory() {
  const el = $('historyContent');
  try {
    const { disputes, players } = await apiFetch('/admin/disputes/history');
    el.innerHTML = renderHistory(disputes, players);
  } catch (err) {
    el.innerHTML = `<p class="error">Could not load dispute history: ${escapeHtml(err.message)}</p>`;
  }
}

function renderHistory(disputes, players) {
  if (disputes.length === 0) {
    return '<p class="empty-note">No resolved disputes yet.</p>';
  }

  const rows = disputes
    .map((d) => {
      const m = d.match;
      const teams = m
        ? `${m.teamA.map((uid) => playerName(players, uid)).join('/')} vs ${m.teamB.map((uid) => playerName(players, uid)).join('/')}`
        : '—';
      const outcomeTag =
        d.resolution === 'approve' ? '<span class="tag">Approved</span>' : '<span class="tag tag-review">Cancelled</span>';

      return `
        <tr>
          <td>${formatDate(d.resolvedAt ?? d.createdAt)}</td>
          <td>${escapeHtml(teams)}</td>
          <td>${escapeHtml(playerName(players, d.raisedBy))}</td>
          <td>${outcomeTag}</td>
          <td>${escapeHtml(d.resolutionNote ?? '')}</td>
        </tr>
      `;
    })
    .join('');

  return `
    <table>
      <thead>
        <tr><th>Resolved</th><th>Match</th><th>Raised by</th><th>Decision</th><th>Note</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

// --- Weekly-gain alerts ---------------------------------------------------

async function loadAlerts() {
  const el = $('alertsContent');
  try {
    const { players, threshold, windowDays } = await apiFetch('/admin/alerts/weekly-gain');
    el.innerHTML = renderAlerts(players, threshold, windowDays);
  } catch (err) {
    el.innerHTML = `<p class="error">Could not load alerts: ${escapeHtml(err.message)}</p>`;
  }
}

function renderAlerts(players, threshold, windowDays) {
  const note = `<p class="card-meta">Players gaining ${threshold}+ rating points in the last ${windowDays} days. Many distinct opponents = beating the field; few = worth a closer look.</p>`;

  if (players.length === 0) {
    return `${note}<p class="empty-note">No alerts this week.</p>`;
  }

  const rows = players
    .map(
      (p) => `
        <tr>
          <td>${escapeHtml(p.name ?? p.userId)}</td>
          <td>${escapeHtml(p.status ?? '')}</td>
          <td>+${p.gain}</td>
          <td>${p.matchCount}</td>
          <td>${p.distinctOpponents}</td>
        </tr>
      `,
    )
    .join('');

  return `
    ${note}
    <table>
      <thead>
        <tr><th>Player</th><th>Tier</th><th>7-day gain</th><th>Matches</th><th>Distinct opponents</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}
