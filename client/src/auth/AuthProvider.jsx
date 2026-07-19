import { useEffect, useMemo, useState, useCallback } from 'react';
import { onAuthStateChanged, signOut as fbSignOut } from 'firebase/auth';

import { auth, currentIdToken } from './firebase.js';
import { getMe, setTokenProvider, ApiError } from '../api/index.js';
import { STATUS } from './authStatus.js';
import { AuthContext } from './authContext.js';

/**
 * Auth state for the whole app.
 *
 * There are TWO independent facts here and screens need both:
 *
 *   firebaseUser  the phone number is verified (Firebase knows who you are)
 *   profile       a user document exists in our backend
 *
 * They are not the same, and the gap between them is a real state, not an error:
 * a player who has just completed OTP for the first time is authenticated but
 * has no profile. `getMe` answers that with a 403 carrying
 * "no user record for this account", which routes to profile setup.
 *
 * Collapsing the two would either lock a new player out of signup or let a
 * profile-less user reach screens that assume one.
 */


export function AuthProvider({ children }) {
  const [firebaseUser, setFirebaseUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [status, setStatus] = useState(STATUS.LOADING);
  const [error, setError] = useState(null);

  // Wire the API client to the SDK once. The client asks for a token per
  // request; it never holds one.
  useEffect(() => {
    setTokenProvider(currentIdToken);
  }, []);

  /** Load the backend profile for an already-verified Firebase user. */
  const loadProfile = useCallback(async () => {
    try {
      const me = await getMe();
      setProfile(me);
      setStatus(STATUS.READY);
      setError(null);
      return me;
    } catch (err) {
      if (err instanceof ApiError && err.isMissingProfile) {
        // Expected for a first-time player — not an error.
        setProfile(null);
        setStatus(STATUS.NEEDS_PROFILE);
        setError(null);
        return null;
      }
      // A real failure (network, 500). Keep the user signed in — signing them
      // out because the API hiccuped would be wrong and infuriating.
      setProfile(null);
      setStatus(STATUS.NEEDS_PROFILE);
      setError(err);
      return null;
    }
  }, []);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth(), async (user) => {
      setFirebaseUser(user);
      if (!user) {
        setProfile(null);
        setStatus(STATUS.SIGNED_OUT);
        return;
      }
      setStatus(STATUS.LOADING);
      await loadProfile();
    });
    return unsubscribe;
  }, [loadProfile]);

  const signOut = useCallback(async () => {
    await fbSignOut(auth());
    setProfile(null);
    setFirebaseUser(null);
    setStatus(STATUS.SIGNED_OUT);
  }, []);

  const value = useMemo(
    () => ({
      firebaseUser,
      profile,
      status,
      error,
      loading: status === STATUS.LOADING,
      isSignedIn: Boolean(firebaseUser),
      /** Re-check the backend profile — call after completing profile setup. */
      refreshProfile: loadProfile,
      signOut,
    }),
    [firebaseUser, profile, status, error, loadProfile, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

