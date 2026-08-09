import { useEffect, useState, useCallback } from "react";
import Inventory from "./components/Inventory.jsx";
import "./App.css";

const API_URL = "http://localhost:4000/api/v1/health";
const ALERTS_URL = "http://localhost:4000/api/v1/alerts";
const POLL_MS = 10000; // refresh dashboard every 10s (collector sends every 60s)

const THRESHOLDS = {
  cpu: { warn: 70, critical: 90 },
  memory: { warn: 75, critical: 90 },
  disk: { warn: 80, critical: 90 },
};

function statusForServer(server) {
  const disk = Math.max(0, ...(server.disk_usage || []).map((d) => d.usedPercent));
  const cpu = Number(server.cpu_usage);
  const mem = Number(server.memory_usage);

  if (cpu >= THRESHOLDS.cpu.critical || mem >= THRESHOLDS.memory.critical || disk >= THRESHOLDS.disk.critical) {
    return "critical";
  }
  if (cpu >= THRESHOLDS.cpu.warn || mem >= THRESHOLDS.memory.warn || disk >= THRESHOLDS.disk.warn) {
    return "warning";
  }
  return "healthy";
}

function formatUptime(seconds) {
  const s = Number(seconds);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  if (days > 0) return `${days}d ${hours}h`;
  const minutes = Math.floor((s % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

function formatTimeAgo(isoString) {
  if (!isoString) return "never";
  const diffMs = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ago`;
}

function Gauge({ label, value }) {
  const pct = Math.min(100, Math.max(0, Number(value) || 0));
  let tone = "ok";
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

function ServerCard({ server }) {
  const status = statusForServer(server);
  const diskMax = Math.max(0, ...(server.disk_usage || []).map((d) => d.usedPercent));
  const backup = server.backup_status || {};

  return (
    <div className={`server-card server-card--${status}`}>
      <div className="server-card__header">
        <div className={`status-dot status-dot--${status}`} />
        <div>
          <div className="server-card__hostname">{server.hostname || server.server_id}</div>
          <div className="server-card__id">{server.server_id} · {server.os}</div>
        </div>
      </div>

      <div className="server-card__gauges">
        <Gauge label="CPU" value={server.cpu_usage} />
        <Gauge label="Memory" value={server.memory_usage} />
        <Gauge label="Disk" value={diskMax} />
      </div>

      <div className="server-card__meta">
        <div className="meta-row">
          <span className="meta-label">Uptime</span>
          <span className="meta-value">{formatUptime(server.uptime_seconds)}</span>
        </div>
        <div className="meta-row">
          <span className="meta-label">Backup</span>
          <span className={`meta-value backup-status backup-status--${backup.status || "unknown"}`}>
            {backup.status || "unknown"}
          </span>
        </div>
        <div className="meta-row">
          <span className="meta-label">Last seen</span>
          <span className="meta-value">{formatTimeAgo(server.received_at)}</span>
        </div>
      </div>
    </div>
  );
}

function AlertsBanner({ alerts }) {
  if (alerts.length === 0) return null;

  return (
    <section className="alerts-banner">
      <h2 className="alerts-banner__title">Active Alerts ({alerts.length})</h2>
      <div className="alerts-list">
        {alerts.map((alert) => (
          <div key={alert.id} className={`alert-item alert-item--${alert.severity}`}>
            <span className={`alert-dot alert-dot--${alert.severity}`} />
            <span className="alert-server">{alert.server_id}</span>
            <span className="alert-message">{alert.message}</span>
            <span className="alert-time">{formatTimeAgo(alert.created_at)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

export default function App() {
  const [view, setView] = useState("dashboard"); // "dashboard" | "inventory"
  const [servers, setServers] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [lastSync, setLastSync] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchServers = useCallback(async () => {
    try {
      const res = await fetch(API_URL);
      if (!res.ok) throw new Error(`Backend responded ${res.status}`);
      const data = await res.json();
      setServers(data);
      setLastSync(new Date());
      setError(null);
    } catch (err) {
      setError(err.message || "Could not reach backend");
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchAlerts = useCallback(async () => {
    try {
      const res = await fetch(ALERTS_URL);
      if (!res.ok) return; // don't break the whole dashboard if this one call fails
      setAlerts(await res.json());
    } catch {
      // silent — alerts are a bonus panel, not critical path
    }
  }, []);

  useEffect(() => {
    fetchServers();
    fetchAlerts();
    const interval = setInterval(() => {
      fetchServers();
      fetchAlerts();
    }, POLL_MS);
    return () => clearInterval(interval);
  }, [fetchServers, fetchAlerts]);

  const counts = servers.reduce(
    (acc, s) => {
      acc[statusForServer(s)] += 1;
      return acc;
    },
    { healthy: 0, warning: 0, critical: 0 }
  );

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1>Server Monitoring Portal</h1>
          <p className="app-subtitle">Government infrastructure — health &amp; backup status</p>
        </div>
        <div className="sync-indicator">
          <span className="pulse-dot" />
          {lastSync ? `Synced ${formatTimeAgo(lastSync.toISOString())}` : "Connecting…"}
        </div>
      </header>

      <nav className="view-tabs">
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
      </nav>

      {view === "inventory" ? (
        <Inventory />
      ) : (
        <>
      <AlertsBanner alerts={alerts} />
      <section className="summary-bar">
        <div className="summary-chip summary-chip--healthy">
          <span className="summary-count">{counts.healthy}</span> Healthy
        </div>
        <div className="summary-chip summary-chip--warning">
          <span className="summary-count">{counts.warning}</span> Warning
        </div>
        <div className="summary-chip summary-chip--critical">
          <span className="summary-count">{counts.critical}</span> Critical
        </div>
        <div className="summary-chip summary-chip--total">
          <span className="summary-count">{servers.length}</span> Total servers
        </div>
      </section>

      {error && (
        <div className="error-banner">
          Can't reach the backend at {API_URL}. Is <code>npm run dev</code> running in <code>backend/</code>?
        </div>
      )}

      {loading && !error && <div className="loading-state">Loading server data…</div>}

      {!loading && !error && servers.length === 0 && (
        <div className="empty-state">
          No servers reporting yet. Start a collector — <code>python collector.py</code> — to see live data here.
        </div>
      )}

      <section className="server-grid">
        {servers.map((server) => (
          <ServerCard key={server.server_id} server={server} />
        ))}
      </section>
        </>
      )}
    </div>
  );
}
