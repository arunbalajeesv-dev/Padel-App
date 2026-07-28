import logo from '../assets/logo.png';

/**
 * Full-screen branded loading state.
 *
 * Shown while auth status is LOADING — i.e. Firebase is still resolving the
 * session, or `getMe` hasn't answered yet. It replaces a bare "Loading…" so
 * that gap reads as the app starting up, not as a blank or broken screen.
 *
 * Inert on purpose, like Placeholder: no data, no timers. It disappears the
 * moment `status` moves off LOADING — there is no fixed display duration.
 */
export default function Splash() {
  return (
    <div className="splash" role="status" aria-live="polite">
      <img className="splash-logo" src={logo} alt="Padel Chennai Community" />
      <span className="sr-only">Loading…</span>
      <div className="spinner" aria-hidden="true" />
    </div>
  );
}
