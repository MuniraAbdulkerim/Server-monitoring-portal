/**
 * AppLayout — persistent shell used by all authenticated pages.
 *
 * Renders:
 *  - Top header bar with portal name, logged-in user, and Logout button
 *  - Horizontal nav tabs (Live Monitoring | Servers | Alerts | System)
 *  - <Outlet /> for the routed page content below the nav
 */
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";

export default function AppLayout() {
  const { user, logout, isAdmin } = useAuth();
  const navigate = useNavigate();

  async function handleLogout() {
    await logout();
    navigate("/login", { replace: true });
  }

  return (
    <div className="app">
      {/* ------------------------------------------------------------------ */}
      {/* Header                                                              */}
      {/* ------------------------------------------------------------------ */}
      <header className="app-header">
        <div>
          <h1>Server Monitoring Portal</h1>
          <p className="app-subtitle">Infrastructure health &amp; backup status</p>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          {/* User badge */}
          <div className="user-badge">
            <span className="user-badge__name">{user?.name || user?.email}</span>
            <span className={`role-chip role-chip--${user?.role}`}>{user?.role}</span>
          </div>

          {/* Logout */}
          <button
            className="btn btn--ghost"
            onClick={handleLogout}
            style={{ padding: "6px 14px", fontSize: "0.8rem" }}
          >
            Sign out
          </button>
        </div>
      </header>

      {/* ------------------------------------------------------------------ */}
      {/* Navigation tabs                                                     */}
      {/* ------------------------------------------------------------------ */}
      <nav className="view-tabs" aria-label="Main navigation">
        <NavLink
          to="/"
          end
          className={({ isActive }) =>
            `view-tab ${isActive ? "view-tab--active" : ""}`
          }
        >
          Live Monitoring
        </NavLink>

        {/* Servers tab — admin sees "Manage Servers", viewer sees "Servers" */}
        <NavLink
          to="/servers"
          className={({ isActive }) =>
            `view-tab ${isActive ? "view-tab--active" : ""}`
          }
        >
          {isAdmin ? "Manage Servers" : "Servers"}
        </NavLink>

        <NavLink
          to="/alerts"
          className={({ isActive }) =>
            `view-tab ${isActive ? "view-tab--active" : ""}`
          }
        >
          Alerts
        </NavLink>

        <NavLink
          to="/system"
          className={({ isActive }) =>
            `view-tab ${isActive ? "view-tab--active" : ""}`
          }
        >
          System
        </NavLink>
      </nav>

      {/* ------------------------------------------------------------------ */}
      {/* Routed page content                                                 */}
      {/* ------------------------------------------------------------------ */}
      <main>
        <Outlet />
      </main>
    </div>
  );
}
