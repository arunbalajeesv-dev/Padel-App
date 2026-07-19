import { NavLink, Outlet } from 'react-router-dom';

/**
 * The app shell: a scrolling content area with a fixed bottom tab bar.
 *
 * Tabs and their order match the wireframes (Home.html et al). The icon boxes
 * are deliberate grey placeholders, exactly as the wireframes show them — the
 * icon set is not chosen yet, and a placeholder is more honest than a stand-in
 * icon that implies a decision nobody made.
 */

const TABS = [
  { to: '/', label: 'Home', end: true },
  { to: '/log', label: 'Log Match' },
  { to: '/leaderboard', label: 'Leaderboard' },
  { to: '/profile', label: 'Profile' },
];

export default function TabLayout() {
  return (
    <div className="app-shell">
      <main className="app-content">
        <Outlet />
      </main>

      <nav className="tab-bar" aria-label="Main">
        {TABS.map(({ to, label, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) => (isActive ? 'tab tab-active' : 'tab')}
          >
            <span className="tab-icon" aria-hidden="true" />
            <span className="tab-label">{label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
