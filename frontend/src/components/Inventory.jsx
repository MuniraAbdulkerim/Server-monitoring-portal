import { useEffect, useState, useCallback } from "react";

const API_URL = "http://localhost:4000/api/v1/servers";

const emptyForm = {
  serverId: "",
  name: "",
  ipOrHostname: "",
  serverType: "Web",
  os: "linux",
  location: "",
  criticality: "medium",
  owner: "",
};

export default function Inventory() {
  const [servers, setServers] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState(null); // server_id currently being edited, or null = adding new
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchServers = useCallback(async () => {
    try {
      const res = await fetch(API_URL);
      if (!res.ok) throw new Error(`Backend responded ${res.status}`);
      setServers(await res.json());
      setError(null);
    } catch (err) {
      setError(err.message || "Could not reach backend");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchServers();
  }, [fetchServers]);

  function handleChange(e) {
    setForm({ ...form, [e.target.name]: e.target.value });
  }

  function startEdit(server) {
    setEditingId(server.server_id);
    setForm({
      serverId: server.server_id,
      name: server.name,
      ipOrHostname: server.ip_or_hostname || "",
      serverType: server.server_type || "Web",
      os: server.os || "linux",
      location: server.location || "",
      criticality: server.criticality || "medium",
      owner: server.owner || "",
    });
  }

  function cancelEdit() {
    setEditingId(null);
    setForm(emptyForm);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);

    try {
      let res;
      if (editingId) {
        res = await fetch(`${API_URL}/${editingId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(form),
        });
      } else {
        res = await fetch(API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(form),
        });
      }

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Request failed (${res.status})`);
      }

      setForm(emptyForm);
      setEditingId(null);
      await fetchServers();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleDelete(serverId) {
    if (!window.confirm(`Remove ${serverId} from inventory? This does not delete its health history.`)) return;
    try {
      const res = await fetch(`${API_URL}/${serverId}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`Delete failed (${res.status})`);
      await fetchServers();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="inventory">
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
            />
          </label>
          <label>
            Display Name
            <input name="name" value={form.name} onChange={handleChange} placeholder="Finance Database Server" required />
          </label>
          <label>
            IP / Hostname
            <input name="ipOrHostname" value={form.ipOrHostname} onChange={handleChange} placeholder="192.168.1.50" />
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
            <input name="location" value={form.location} onChange={handleChange} placeholder="Finance Department" />
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
            <input name="owner" value={form.owner} onChange={handleChange} placeholder="Ahmed" />
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

      <div className="inventory-list">
        <h2>Registered servers ({servers.length})</h2>
        {loading && <p className="loading-state">Loading…</p>}
        {!loading && servers.length === 0 && (
          <p className="empty-state">No servers registered yet. Add one above.</p>
        )}
        {servers.length > 0 && (
          <table className="inventory-table">
            <thead>
              <tr>
                <th>Server ID</th>
                <th>Name</th>
                <th>Type</th>
                <th>OS</th>
                <th>Criticality</th>
                <th>Owner</th>
                <th></th>
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
                    <span className={`criticality-badge criticality-badge--${s.criticality}`}>{s.criticality}</span>
                  </td>
                  <td>{s.owner}</td>
                  <td className="row-actions">
                    <button className="btn btn--small" onClick={() => startEdit(s)}>Edit</button>
                    <button className="btn btn--small btn--danger" onClick={() => handleDelete(s.server_id)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
