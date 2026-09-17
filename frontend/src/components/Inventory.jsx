/**
 * Inventory — server CRUD table.
 *
 * - Admin users: see the registration form, Edit / New Token / Delete buttons.
 * - Viewer users: see the read-only table only.
 *
 * All API calls pass getToken() so the JWT is attached automatically.
 */
import { useEffect, useState, useCallback } from "react";
import { useAuth } from "../context/AuthContext.jsx";
import {
  fetchServers,
  createServer,
  updateServer,
  deleteServer,
  regenerateToken,
} from "../services/api.js";

const emptyForm = {
  serverId:     "",
  name:         "",
  ipOrHostname: "",
  serverType:   "Web",
  os:           "linux",
  location:     "",
  criticality:  "medium",
  owner:        "",
};

function formatTimeAgo(isoString) {
  if (!isoString) return "never";
  const diffMs = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default function Inventory() {
  const { getToken, isAdmin } = useAuth();

  const [servers,   setServers]   = useState([]);
  const [form,      setForm]      = useState(emptyForm);
  const [editingId, setEditingId] = useState(null);
  const [error,     setError]     = useState(null);
  const [loading,   setLoading]   = useState(true);
  const [newToken,  setNewToken]  = useState(null); // shown once after create/regenerate

  // ------------------------------------------------------------------
  // Data loading
  // ------------------------------------------------------------------
  const loadServers = useCallback(async () => {
    try {
      const res = await fetchServers(getToken);
      setServers(res.data ?? res);
      setError(null);
    } catch (err) {
      setError(err.message || "Could not reach backend");
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  useEffect(() => { loadServers(); }, [loadServers]);

  // ------------------------------------------------------------------
  // Form handlers  (admin only — buttons are hidden for viewers)
  // ------------------------------------------------------------------
  function handleChange(e) {
    setForm({ ...form, [e.target.name]: e.target.value });
  }

  function startEdit(server) {
    setEditingId(server.server_id);
    setNewToken(null);
    setForm({
      serverId:     server.server_id,
      name:         server.name,
      ipOrHostname: server.ip_or_hostname || "",
      serverType:   server.server_type || "Web",
      os:           server.os || "linux",
      location:     server.location || "",
      criticality:  server.criticality || "medium",
      owner:        server.owner || "",
    });
  }

  function cancelEdit() {
    setEditingId(null);
    setNewToken(null);
    setForm(emptyForm);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setNewToken(null);

    try {
      if (editingId) {
        await updateServer(editingId, form, getToken);
        setEditingId(null);
        setForm(emptyForm);
      } else {
        const res = await createServer(form, getToken);
        if (res.agentToken) {
          setNewToken({ serverId: form.serverId, token: res.agentToken });
        }
        setForm(emptyForm);
      }
      await loadServers();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleDelete(serverId) {
    if (!window.confirm(`Remove ${serverId} from inventory?\nThis does not delete its health history.`)) return;
    try {
      await deleteServer(serverId, getToken);
      await loadServers();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleRegenerateToken(serverId) {
    if (!window.confirm(`Regenerate the agent token for ${serverId}?\nThe current collector will stop authenticating until updated.`)) return;
    try {
      const res = await regenerateToken(serverId, getToken);
      if (res.agentToken) {
        setNewToken({ serverId, token: res.agentToken });
      }
    } catch (err) {
      setError(err.message);
    }
  }

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------
  return (
    <div className="inventory">

      {/* One-time agent token reveal */}
      {newToken && (
        <div className="token-reveal">
          <div className="token-reveal__header">
            <strong>Agent Token for {newToken.serverId}</strong>
            <span>Copy this now — it will not be shown again.</span>
          </div>
          <code className="token-reveal__value">{newToken.token}</code>
          <div className="token-reveal__instructions">
            Set this as <code>AGENT_API_TOKEN</code> in the collector's <code>.env</code> file.
          </div>
          <button className="btn btn--ghost" onClick={() => setNewToken(null)}>Dismiss</button>
        </div>
      )}

      {/* Registration form — admin only */}
      {isAdmin && (
        <form className="inventory-form" onSubmit={handleSubmit}>
          <h2>{editingId ? `Edit ${editingId}` : "Register a new server"}</h2>

          <div className="form-grid">
            <label>
              Server ID
              <input
                name="serverId"
                value={form.serverId}
                onChange={handleChange}
                placeholder="srv-db01"
                required
                disabled={!!editingId}
                pattern="[a-zA-Z0-9\-_]+"
                title="Letters, numbers, hyphens, and underscores only"
              />
            </label>
            <label>
              Display Name
              <input name="name" value={form.name} onChange={handleChange}
                placeholder="Finance Database Server" required />
            </label>
            <label>
              IP / Hostname
              <input name="ipOrHostname" value={form.ipOrHostname}
                onChange={handleChange} placeholder="192.168.1.50" />
            </label>
            <label>
              Server Type
              <select name="serverType" value={form.serverType} onChange={handleChange}>
                <option>Web</option>
                <option>Database</option>
                <option>File</option>
                <option>Application</option>
                <option>Other</option>
              </select>
            </label>
            <label>
              OS
              <select name="os" value={form.os} onChange={handleChange}>
                <option value="linux">Linux</option>
                <option value="windows">Windows</option>
              </select>
            </label>
            <label>
              Location / Department
              <input name="location" value={form.location}
                onChange={handleChange} placeholder="Finance Department" />
            </label>
            <label>
              Criticality
              <select name="criticality" value={form.criticality} onChange={handleChange}>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </label>
            <label>
              Owner
              <input name="owner" value={form.owner}
                onChange={handleChange} placeholder="Ahmed" />
            </label>
          </div>

          {error && <div className="error-banner">{error}</div>}

          <div className="form-actions">
            <button type="submit" className="btn btn--primary">
              {editingId ? "Save changes" : "Add server"}
            </button>
            {editingId && (
              <button type="button" className="btn btn--ghost" onClick={cancelEdit}>
                Cancel
              </button>
            )}
          </div>
        </form>
      )}

      {/* Error (viewer path) */}
      {!isAdmin && error && <div className="error-banner">{error}</div>}

      {/* Server table */}
      <div className="inventory-list">
        <h2>Registered servers ({servers.length})</h2>
        {loading && <p className="loading-state">Loading…</p>}
        {!loading && servers.length === 0 && (
          <p className="empty-state">No servers registered yet.</p>
        )}
        {servers.length > 0 && (
          <table className="inventory-table">
            <thead>
              <tr>
                <th>Server ID</th>
                <th>Name</th>
                <th>Type</th>
                <th>OS</th>
                <th>Status</th>
                <th>Criticality</th>
                <th>Last Seen</th>
                <th>Owner</th>
                {/* Only show actions column for admins */}
                {isAdmin && <th></th>}
              </tr>
            </thead>
            <tbody>
              {servers.map((s) => (
                <tr key={s.server_id}>
                  <td className="mono">{s.server_id}</td>
                  <td>{s.name}</td>
                  <td>{s.server_type}</td>
                  <td>{s.os}</td>
                  <td>
                    <span className={`status-badge status-badge--${s.status || "offline"}`}>
                      {s.status || "offline"}
                    </span>
                  </td>
                  <td>
                    <span className={`criticality-badge criticality-badge--${s.criticality}`}>
                      {s.criticality}
                    </span>
                  </td>
                  <td className="mono">{formatTimeAgo(s.last_seen_at)}</td>
                  <td>{s.owner}</td>
                  {isAdmin && (
                    <td className="row-actions">
                      <button className="btn btn--small" onClick={() => startEdit(s)}>Edit</button>
                      <button
                        className="btn btn--small"
                        onClick={() => handleRegenerateToken(s.server_id)}
                        title="Generate a new agent token"
                      >
                        New Token
                      </button>
                      <button
                        className="btn btn--small btn--danger"
                        onClick={() => handleDelete(s.server_id)}
                      >
                        Delete
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
