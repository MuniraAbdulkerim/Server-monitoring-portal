/**
 * AlertsPage — wraps the alerts list so it has its own route (/alerts).
 * Reuses all existing alert-fetching logic from App.jsx,
 * extracted here to give it a dedicated routed page.
 */
import { useEffect, useState, useCallback } from "react";
import { useAuth } from "../context/AuthContext.jsx";
import { fetchAlerts, resolveAlert } from "../services/api.js";

const POLL_MS = 15_000;

function formatTimeAgo(isoString) {
  if (!isoString) return "never";
  const diffMs = Date.now() - new Date(isoString).getTime();
  const mins   = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default function AlertsPage() {
  const { getToken, isAdmin } = useAuth();
  const [alerts,   setAlerts]   = useState([]);
  const [showAll,  setShowAll]  = useState(false);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await fetchAlerts(getToken, showAll);
      setAlerts(res.data ?? res);
      setError(null);
    } catch (err) {
      setError(err.message || "Failed to load alerts");
    } finally {
      setLoading(false);
    }
  }, [getToken, showAll]);

  useEffect(() => {
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  async function handleResolve(alertId) {
    try {
      await resolveAlert(alertId, getToken);
      setAlerts((prev) => prev.filter((a) => a.id !== alertId));
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h2 className="page-title">Alerts</h2>
          <p className="page-subtitle">
            {showAll ? "All alerts including resolved" : "Active (unresolved) alerts"}
          </p>
        </div>
        <button
          className="btn btn--ghost"
          onClick={() => setShowAll((v) => !v)}
        >
          {showAll ? "Show active only" : "Show all"}
        </button>
      </div>

      {error && <div className="error-banner" role="alert">{error}</div>}
      {loading && <div className="loading-state" aria-busy="true">Loading alerts…</div>}

      {!loading && alerts.length === 0 && (
        <div className="empty-state">
          {showAll ? "No alerts recorded yet." : "No active alerts — all clear."}
        </div>
      )}

      <div className="alerts-list" style={{ marginTop: 12 }}>
        {alerts.map((alert) => (
          <div key={alert.id} className={`alert-item alert-item--${alert.severity}`}>
            <span className={`alert-dot alert-dot--${alert.severity}`} aria-hidden="true" />
            <span className="alert-server">{alert.server_id}</span>
            <span className="alert-message">{alert.message}</span>
            <span className="alert-time">{formatTimeAgo(alert.created_at)}</span>
            {alert.resolved && (
              <span style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginLeft: 8 }}>
                resolved
              </span>
            )}
            {!alert.resolved && isAdmin && (
              <button
                className="btn btn--small"
                onClick={() => handleResolve(alert.id)}
                aria-label={`Resolve: ${alert.message}`}
                style={{ marginLeft: "auto" }}
              >
                Resolve
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
