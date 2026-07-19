import { Navigate, useLocation } from 'react-router-dom';

import { useAuth } from './authContext.js';
import { STATUS } from './authStatus.js';

/**
 * The single place that decides what an authenticated user is allowed to see.
 *
 * Four states, four destinations — the middle one is the point:
 *
 *   loading       render nothing decisive; bouncing a signed-in user to the
 *                 sign-in screen while their token resolves is the classic
 *                 flash-of-logout bug
 *   signedOut     → /signin
 *   needsProfile  → /setup   (verified phone, no profile document yet)
 *   ready         → the requested screen
 */
export default function RequireAuth({ children }) {
  const { status } = useAuth();
  const location = useLocation();

  if (status === STATUS.LOADING) {
    return <div className="page page-loading">Loading…</div>;
  }

  if (status === STATUS.SIGNED_OUT) {
    return <Navigate to="/signin" state={{ from: location }} replace />;
  }

  if (status === STATUS.NEEDS_PROFILE) {
    return <Navigate to="/setup" replace />;
  }

  return children;
}
