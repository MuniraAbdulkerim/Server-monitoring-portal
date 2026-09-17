/**
 * Centralized API service.
 *
 * All backend communication goes through these functions.
 * The JWT is injected automatically by passing a getToken() callback.
 *
 * Usage in components:
 *   const { getToken } = useAuth();
 *   const servers = await fetchServers(getToken);
 *
 * The raw `request()` helper is also exported so pages can call
 * arbitrary endpoints without duplicating fetch logic.
 */

const BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:4000/api/v1";

/**
 * Core fetch wrapper.
 *
 * @param {string}   path      - API path, e.g. "/servers"
 * @param {object}   options   - fetch options (method, body, headers, …)
 * @param {function} getToken  - () => string | null  (from AuthContext)
 */
export async function request(path, options = {}, getToken = null) {
  const headers = { "Content-Type": "application/json", ...options.headers };

  // Attach JWT when a token getter is supplied and we have a token
  const token = getToken ? getToken() : null;
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(`${BASE_URL}${path}`, { ...options, headers });

  const contentType = res.headers.get("content-type") || "";
  const body = contentType.includes("application/json") ? await res.json() : null;

  if (!res.ok) {
    const message = body?.message || `Request failed (${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    err.body   = body;
    throw err;
  }

  return body;
}

// ---------------------------------------------------------------------------
// Auth  (no token needed — these are the public login endpoints)
// ---------------------------------------------------------------------------

export function login(email, password) {
  return request("/auth/login", {
    method: "POST",
    body:   JSON.stringify({ email, password }),
  });
}

export function fetchMe(getToken) {
  return request("/auth/me", {}, getToken);
}

// ---------------------------------------------------------------------------
// Health  (JWT required)
// ---------------------------------------------------------------------------

export function fetchLatestHealth(getToken) {
  return request("/health", {}, getToken);
}

export function fetchServerHistory(serverId, getToken) {
  return request(`/health/${encodeURIComponent(serverId)}`, {}, getToken);
}

// ---------------------------------------------------------------------------
// Servers  (JWT required; write operations also need admin role)
// ---------------------------------------------------------------------------

export function fetchServers(getToken) {
  return request("/servers", {}, getToken);
}

export function fetchServer(serverId, getToken) {
  return request(`/servers/${encodeURIComponent(serverId)}`, {}, getToken);
}

export function createServer(data, getToken) {
  return request("/servers", { method: "POST", body: JSON.stringify(data) }, getToken);
}

export function updateServer(serverId, data, getToken) {
  return request(
    `/servers/${encodeURIComponent(serverId)}`,
    { method: "PUT", body: JSON.stringify(data) },
    getToken
  );
}

export function deleteServer(serverId, getToken) {
  return request(`/servers/${encodeURIComponent(serverId)}`, { method: "DELETE" }, getToken);
}

export function regenerateToken(serverId, getToken) {
  return request(
    `/servers/${encodeURIComponent(serverId)}/regenerate-token`,
    { method: "POST" },
    getToken
  );
}

// ---------------------------------------------------------------------------
// Alerts  (JWT required; resolve needs admin role)
// ---------------------------------------------------------------------------

export function fetchAlerts(getToken, all = false) {
  return request(`/alerts${all ? "?all=true" : ""}`, {}, getToken);
}

export function resolveAlert(alertId, getToken) {
  return request(`/alerts/${alertId}/resolve`, { method: "PUT" }, getToken);
}

// ---------------------------------------------------------------------------
// System metrics  (JWT required — reports health of the backend host)
// ---------------------------------------------------------------------------

export function fetchSystemStatus(getToken) {
  return request("/system/status", {}, getToken);
}

export function fetchSystemMetrics(getToken) {
  return request("/system/metrics", {}, getToken);
}
