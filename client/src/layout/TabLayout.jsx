import { NavLink, Outlet } from 'react-router-dom';

import { HomeIcon, RacketIcon, TrophyIcon, UserIcon } from './tabIcons.jsx';

/**
 * The app shell: a scrolling content area with a fixed bottom tab bar.
 *
 * Tabs and their order match the wireframes (Home.html et al). Icons are
 * simple monochrome line icons, filled when active — see tabIcons.jsx.
 */

const TABS = [
  { to: '/', label: 'Home', end: true, Icon: HomeIcon },
  { to: '/log', label: 'Log Match', end: false, Icon: RacketIcon },
  { to: '/leaderboard', label: 'Leaderboard', end: false, Icon: TrophyIcon },
  { to: '/profile', label: 'Profile', end: false, Icon: UserIcon },
];

export default function TabLayout() {
  return (
    <div className="app-shell">
      <main className="app-content">
        <Outlet />
      </main>

      <nav className="tab-bar" aria-label="Main">
        {TABS.map(({ to, label, end, Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) => (isActive ? 'tab tab-active' : 'tab')}
          >
            {({ isActive }) => (
              <>
                <span className="tab-icon">
                  <Icon active={isActive} />
                </span>
                <span className="tab-label">{label}</span>
              </>
            )}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
