import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';

import TabLayout from './layout/TabLayout.jsx';
import Home from './pages/Home.jsx';
import LogMatch from './pages/log/LogMatch.jsx';
import ConfirmMatch from './pages/ConfirmMatch.jsx';
import DisputeMatch from './pages/DisputeMatch.jsx';
import Leaderboard from './pages/Leaderboard.jsx';
import Profile from './pages/Profile.jsx';
import ProfileSetup from './pages/ProfileSetup.jsx';
import Splash from './pages/Splash.jsx';
import { AuthProvider } from './auth/AuthProvider.jsx';
import { useAuth } from './auth/authContext.js';
import { STATUS } from './auth/authStatus.js';
import RequireAuth from './auth/RequireAuth.jsx';
import SignIn from './auth/SignIn.jsx';

/** Keeps a signed-in user off the sign-in screen. */
function SignInRoute() {
  const { status } = useAuth();
  if (status === STATUS.LOADING) return <Splash />;
  if (status === STATUS.READY) return <Navigate to="/" replace />;
  if (status === STATUS.NEEDS_PROFILE) return <Navigate to="/setup" replace />;
  return <SignIn />;
}

/** Profile setup, gated so only the verified-but-profile-less state sees it. */
function SetupRoute() {
  const { status } = useAuth();
  if (status === STATUS.LOADING) return <Splash />;
  if (status === STATUS.SIGNED_OUT) return <Navigate to="/signin" replace />;
  if (status === STATUS.READY) return <Navigate to="/" replace />;
  return <ProfileSetup />;
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/signin" element={<SignInRoute />} />
          <Route path="/setup" element={<SetupRoute />} />

          <Route
            element={
              <RequireAuth>
                <TabLayout />
              </RequireAuth>
            }
          >
            <Route index element={<Home />} />
            <Route path="log" element={<LogMatch />} />
            <Route path="leaderboard" element={<Leaderboard />} />
            <Route path="profile" element={<Profile />} />
          </Route>

          {/* Focused sub-screens: their own back button, no tab bar. */}
          <Route
            path="/matches/:id/confirm"
            element={
              <RequireAuth>
                <ConfirmMatch />
              </RequireAuth>
            }
          />
          <Route
            path="/matches/:id/dispute"
            element={
              <RequireAuth>
                <DisputeMatch />
              </RequireAuth>
            }
          />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
