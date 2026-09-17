/**
 * SystemMetricsPage — real-time CPU, RAM, and uptime for the backend host.
 *
 * Transport: WebSocket via socket.io (event: "system_metrics", every ~2 s).
 * The REST polling fallback is removed; the socket replaces it entirely.
 *
 * Connection lifecycle:
 *   - Socket connects when the component mounts (user navigates to /system).
 *   - JWT is passed in socket.handshake.auth.token — never in the URL.
 *   - Socket disconnects on unmount so there are no dangling connections
 *     when the user navigates away.
 *
 * Static system info (hostname, OS, CPU model) is loaded once via
 * GET /api/v1/system/status at mount; it doesn't need 2-second updates.
 */
import { useEffect, useState, useRef } from "react";
import { io } from "socket.io-client";
import { useAuth } from "../context/AuthContext.jsx";
import { fetchSystemStatus } from "../services/api.js";

// The socket.io server uses a dedicated path to avoid colliding with Express
const WS_URL  = import.meta.env.VITE_API_BASE_URL || "http://localhost:4000";
const WS_PATH = "/ws/socket.io";

// ---------------------------------------------------------------------------
// Gauge (identical to App.jsx design system)
// ---------------------------------------------------------------------------
function Gauge({ label, value }) {
  const pct  = Math.min(100, Math.max(0, Number(value) || 0));
  let tone   = "ok";
  if (pct >= 90)      tone = "critical";
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

function MetricCard({ title, children }) {
  return (
    <div className="metric-card">
      <h3 className="metric-card__title">{title}</h3>
      {children}
    </div>
  );
}

function formatUptime(seconds) {
  const s = Number(seconds);
  if (!s || s < 0) return "—";
  const days  = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins  = Math.floor((s % 3600) / 60);
  if (days > 0)  return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------
export default function SystemMetricsPage() {
  const { getToken } = useAuth();

  const [metrics,    setMetrics]    = useState(null);   // live — from WebSocket
  const [status,     setStatus]     = useState(null);   // static — from REST
  const [connected,  setConnected]  = useState(false);  // socket connection state
  const [error,      setError]      = useState(null);
  const [lastUpdate, setLastUpdate] = useState(null);   // timestamp of last WS push

  const socketRef = useRef(null);

  // ------------------------------------------------------------------
  // Load static system info once (hostname, OS, CPU model)
  // ------------------------------------------------------------------
  useEffect(() => {
    fetchSystemStatus(getToken)
      .then((res) => setStatus(res.data))
      .catch((err) => setError(err.message || "Failed to load system info"));
  }, [getToken]);

  // ------------------------------------------------------------------
  // WebSocket connection — mount → connect, unmount → disconnect
  // ------------------------------------------------------------------
  useEffect(() => {
    const token = getToken();

    // Create socket — JWT is in auth, never in the URL
    const socket = io(WS_URL, {
      path:            WS_PATH,
      auth:            { token },
      transports:      ["websocket", "polling"], // websocket preferred
      reconnectionDelay:      1000,
      reconnectionDelayMax:   10000,
      reconnectionAttempts:   Infinity,
    });

    socketRef.current = socket;

    socket.on("connect", () => {
      setConnected(true);
      setError(null);
      console.log("[WS] Connected:", socket.id);
    });

    // The core event — fires every ~2 seconds from the backend interval
    socket.on("system_metrics", (data) => {
      setMetrics(data);
      setLastUpdate(new Date());
    });

    socket.on("connect_error", (err) => {
      setConnected(false);
      setError(`WebSocket: ${err.message}`);
      console.warn("[WS] Connect error:", err.message);
    });

    socket.on("disconnect", (reason) => {
      setConnected(false);
      console.log("[WS] Disconnected:", reason);
    });

    // Clean up on unmount — prevents memory leaks and orphaned connections
    return () => {
      console.log("[WS] Disconnecting on unmount");
      socket.disconnect();
      socketRef.current = null;
    };
  }, [getToken]); // reconnect if the token changes (e.g. after re-login)

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------
  return (
    <div>
      {/* Page header */}
      <div className="page-header">
        <div>
          <h2 className="page-title">Backend Host Metrics</h2>
          <p className="page-subtitle">
            Real-time health of the machine running this backend server
          </p>
        </div>

        {/* Connection status badge */}
        <div className="sync-indicator" aria-live="polite">
          <span
            className="pulse-dot"
            aria-hidden="true"
            style={{ background: connected ? "var(--healthy)" : "var(--critical)" }}
          />
          {connected
            ? lastUpdate
              ? `Live · ${Math.floor((Date.now() - lastUpdate.getTime()) / 1000)}s ago`
              : "Connected — waiting for data…"
            : "Connecting…"}
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="error-banner" role="alert" style={{ marginBottom: 24 }}>
          {error}
        </div>
      )}

      {/* Loading state */}
      {!metrics && !error && (
        <div className="loading-state" aria-busy="true">
          Connecting to real-time metrics stream…
        </div>
      )}

      {/* Static system info bar */}
      {status && (
        <div className="sys-info-bar">
          <div className="sys-info-item">
            <span className="sys-info-label">Hostname</span>
            <span className="sys-info-value">{status.hostname}</span>
          </div>
          <div className="sys-info-item">
            <span className="sys-info-label">OS</span>
            <span className="sys-info-value">{status.os}</span>
          </div>
          <div className="sys-info-item">
            <span className="sys-info-label">Version</span>
            <span className="sys-info-value">{status.osVersion || "—"}</span>
          </div>
          <div className="sys-info-item">
            <span className="sys-info-label">CPU Model</span>
            <span className="sys-info-value">{status.cpuModel || "—"}</span>
          </div>
          <div className="sys-info-item">
            <span className="sys-info-label">Architecture</span>
            <span className="sys-info-value">{status.arch || "—"}</span>
          </div>
        </div>
      )}

      {/* Live metric cards — update on every WebSocket push */}
      {metrics && (
        <div className="metrics-grid">

          {/* CPU */}
          <MetricCard title="CPU Usage">
            <Gauge label="CPU" value={metrics.cpu.usagePercent} />
            <div className="metric-detail-rows" style={{ marginTop: 12 }}>
              <div className="metric-detail-row">
                <span className="meta-label">Current load</span>
                <span className="meta-value">{metrics.cpu.usagePercent}%</span>
              </div>
            </div>
          </MetricCard>

          {/* RAM */}
          <MetricCard title="Memory (RAM)">
            <Gauge label="RAM Used" value={metrics.ram.usedPercent} />
            <div className="metric-detail-rows" style={{ marginTop: 12 }}>
              <div className="metric-detail-row">
                <span className="meta-label">Total</span>
                <span className="meta-value">{metrics.ram.totalGb} GB</span>
              </div>
              <div className="metric-detail-row">
                <span className="meta-label">Used</span>
                <span className="meta-value">{metrics.ram.usedGb} GB</span>
              </div>
              <div className="metric-detail-row">
                <span className="meta-label">Free</span>
                <span className="meta-value">{metrics.ram.freeGb} GB</span>
              </div>
            </div>
          </MetricCard>

          {/* Uptime — updates every push since the backend includes uptimeSeconds */}
          <MetricCard title="System Uptime">
            <div className="uptime-display">
              {formatUptime(metrics.uptimeSeconds)}
            </div>
            <div className="metric-detail-rows" style={{ marginTop: 12 }}>
              <div className="metric-detail-row">
                <span className="meta-label">Seconds</span>
                <span className="meta-value">
                  {Number(metrics.uptimeSeconds).toLocaleString()}s
                </span>
              </div>
              <div className="metric-detail-row">
                <span className="meta-label">Last update</span>
                <span className="meta-value">
                  {new Date(metrics.timestamp).toLocaleTimeString()}
                </span>
              </div>
            </div>
          </MetricCard>

        </div>
      )}
    </div>
  );
}
