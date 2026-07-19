import { createContext, useContext } from 'react';

/**
 * The context object and its hook, kept apart from the provider component.
 *
 * React Fast Refresh only hot-reloads modules that export components and
 * nothing else, so the provider lives in AuthProvider.jsx and the non-component
 * exports live here.
 */
export const AuthContext = createContext(null);

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>.');
  return ctx;
}
