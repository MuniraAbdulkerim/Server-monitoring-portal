/**
 * App.jsx — Live Monitoring dashboard page (route: /).
 *
 * All existing server-card, gauge, alert-banner, and summary logic is
 * preserved exactly. The only change is that API calls now pass getToken()
 * so the JWT is attached automatically.
 *
 * The outer shell (header, nav, logout) lives in AppLayout.jsx.
 */
import { useEffect, useState, useCallback } from "react";
import Inventory from "./components/Inventory.jsx";
import { useAuth } from "./context/AuthContext.jsx";
import { fetchLatestHealth, fetchAlerts, fetchServers, resolveAlert } from "./services/api.js";
import "./App.css";

const POLL_MS = 10_000;

// ---------------------------------------------------------------------------
// Utility functions (unchanged from Phase 1)
// ---------------------------------------------------------------------------

function formatUptime(seconds) {
  const s = Number(seconds);
  if (!s || s < 0) return "—";
  const days  = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  if (days > 0) return `${days}d ${hours}h`;
  const mins = Math.floor((s % 3600) / 60);
  return `${hours}h ${mins}m`;
}

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

// ---------------------------------------------------------------------------
// Sub-components (unchanged)
// ---------------------------------------------------------------------------

function Gauge({ label, value }) {
  const pct  = Math.min(100, Math.max(0, Number(value) || 0));
  let tone    = "ok";
  if (pct >= 90) tone = "critical";
  else if (pct >= 70) tone = "warning";

  return (
    <div className="gauge">
      <div className="gauge-labels">
        <span className="gauge-label">{label}</span>
        <span className="gauge-value">{pct.toFixed(1)}%</span>
      </div>
      <div className="gauge-track">
        <div className={`gauge-fill gauge-fill--${tone}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function ServerCard({ server, health }) {
  const status  = server.status || "offline";
  const diskMax = health
    ? Math.max(0, ...(health.disk_usage || []).map((d) => d.usedPercent))
    : 0;
  const backup  = health?.backup_status || {};

  return (
    <div className={`server-card server-card--${status}`}>
      <div className="server-card__header">
        <div className={`status-dot status-dot--${status}`} aria-hidden="true" />
        <div>
          <div className="server-card__hostname">{server.name || server.server_id}</div>
          <div className="server-card__id">
            {server.server_id}
            {server.os       ? ` · ${server.os}`       : ""}
            {server.location ? ` · ${server.location}` : ""}
          </div>
        </div>
        <span
          className={`criticality-badge criticality-badge--${server.criticality}`}
          style={{ marginLeft: "auto" }}
        >
          {server.criticality}
        </span>
      </div>

      {health ? (
        <div className="server-card__gauges">
          <Gauge label="CPU"    value={health.cpu_usage} />
          <Gauge label="Memory" value={health.memory_usage} />
          <Gauge label="Disk"   value={diskMax} />
        </div>
      ) : (
        <div className="server-card__no-data">No health data received yet</div>
      )}

      <div className="server-card__meta">
        {health && (
          <div className="meta-row">
            <span className="meta-label">Uptime</span>
            <span className="meta-value">{formatUptime(health.uptime_seconds)}</span>
          </div>
        )}
        <div className="meta-row">
          <span className="meta-label">Status</span>
          <span className={`meta-value status-text status-text--${status}`}>{status}</span>
        </div>
        <div className="meta-row">
          <span className="meta-label">Backup</span>
          <span className={`meta-value backup-status backup-status--${backup.status || "unknown"}`}>
            {backup.status || "unknown"}
          </span>
        </div>
        <div className="meta-row">
          <span className="meta-label">Last seen</span>
          <span className="meta-value">{formatTimeAgo(server.last_seen_at)}</span>
        </div>
        {server.ip_or_hostname && (
          <div className="meta-row">
            <span className="meta-label">IP/Host</span>
            <span className="meta-value">{server.ip_or_hostname}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function AlertsBanner({ alerts, onResolve }) {
  if (alerts.length === 0) return null;
  return (
    <section className="alerts-banner" aria-label="Active alerts">
      <h2 className="alerts-banner__title">Active Alerts ({alerts.length})</h2>
      <div className="alerts-list">
        {alerts.map((alert) => (
          <div key={alert.id} className={`alert-item alert-item--${alert.severity}`}>
            <span className={`alert-dot alert-dot--${alert.severity}`} aria-hidden="true" />
            <span className="alert-server">{alert.server_id}</span>
            <span className="alert-message">{alert.message}</span>
            <span className="alert-time">{formatTimeAgo(alert.created_at)}</span>
            {onResolve && (
              <button
                className="btn btn--small"
                onClick={() => onResolve(alert.id)}
                aria-label={`Resolve alert: ${alert.message}`}
              >
                Resolve
              </button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Dashboard page (default export — rendered at route "/")
// ---------------------------------------------------------------------------
export default function App() {
  const { getToken } = useAuth();

  const [view,     setView]     = useState("dashboard");
  const [servers,  setServers]  = useState([]);
  const [health,   setHealth]   = useState({});
  const [alerts,   setAlerts]   = useState([]);
  const [lastSync, setLastSync] = useState(null);
  const [error,    setError]    = useState(null);
  const [loading,  setLoading]  = useState(true);

  const loadDashboard = useCallback(async () => {
    try {
      const [serversRes, healthRes, alertsRes] = await Promise.allSettled([
        fetchServers(getToken),
        fetchLatestHealth(getToken),
        fetchAlerts(getToken),
      ]);

      if (serversRes.status === "fulfilled") {
        setServers(serversRes.value.data ?? serversRes.value);
        setError(null);
      } else {
        setError(serversRes.reason?.message || "Could not reach backend");
      }

      if (healthRes.status === "fulfilled") {
        const rows = healthRes.value.data ?? healthRes.value;
        const map  = Object.fromEntries(rows.map((h) => [h.server_id, h]));
        setHealth(map);
      }

      if (alertsRes.status === "fulfilled") {
        setAlerts(alertsRes.value.data ?? alertsRes.value);
      }

      setLastSync(new Date());
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  useEffect(() => {
    loadDashboard();
    const id = setInterval(loadDashboard, POLL_MS);
    return () => clearInterval(id);
  }, [loadDashboard]);

  async function handleResolveAlert(alertId) {
    try {
      await resolveAlert(alertId, getToken);
      setAlerts((prev) => prev.filter((a) => a.id !== alertId));
    } catch (err) {
      console.error("Failed to resolve alert:", err.message);
    }
  }

  const counts = servers.reduce(
    (acc, s) => {
      const st = s.status || "offline";
      if (st === "online")   acc.online++;
      if (st === "offline")  acc.offline++;
      if (st === "warning")  acc.warning++;
      if (st === "critical") acc.critical++;
      return acc;
    },
    { online: 0, offline: 0, warning: 0, critical: 0 }
  );

  return (
    <>
      {/* Sync indicator row */}
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 16 }}>
        <div className="sync-indicator" aria-live="polite">
          <span className="pulse-dot" aria-hidden="true" />
          {lastSync ? `Synced ${formatTimeAgo(lastSync.toISOString())}` : "Connecting…"}
        </div>
      </div>

      {/* Sub-nav: Live / Inventory (kept from Phase 1) */}
      <div className="view-tabs" style={{ marginBottom: 24 }}>
        <button
          className={`view-tab ${view === "dashboard" ? "view-tab--active" : ""}`}
          onClick={() => setView("dashboard")}
        >
          Live Monitoring
        </button>
        <button
          className={`view-tab ${view === "inventory" ? "view-tab--active" : ""}`}
          onClick={() => setView("inventory")}
        >
          Manage Servers
        </button>
      </div>

      {view === "inventory" ? (
        <Inventory />
      ) : (
        <>
          <AlertsBanner alerts={alerts} onResolve={handleResolveAlert} />

          <section className="summary-bar" aria-label="Server status summary">
            <div className="summary-chip summary-chip--online">
              <span className="summary-count">{counts.online}</span> Online
            </div>
            <div className="summary-chip summary-chip--offline">
              <span className="summary-count">{counts.offline}</span> Offline
            </div>
            <div className="summary-chip summary-chip--warning">
              <span className="summary-count">{counts.warning}</span> Warning
            </div>
            <div className="summary-chip summary-chip--critical">
              <span className="summary-count">{counts.critical}</span> Critical
            </div>
            <div className="summary-chip summary-chip--total">
              <span className="summary-count">{servers.length}</span> Total
            </div>
          </section>

          {error && (
            <div className="error-banner" role="alert">
              Cannot reach the backend. Is it running?
              <br />
              <small>{error}</small>
            </div>
          )}

          {loading && !error && (
            <div className="loading-state" aria-busy="true">Loading server data…</div>
          )}

          {!loading && !error && servers.length === 0 && (
            <div className="empty-state">
              No servers registered yet. Go to <strong>Manage Servers</strong> to add one.
            </div>
          )}

          <section className="server-grid" aria-label="Server cards">
            {servers.map((server) => (
              <ServerCard
                key={server.server_id}
                server={server}
                health={health[server.server_id] || null}
              />
            ))}
          </section>
        </>
      )}
    </>
  );
}
