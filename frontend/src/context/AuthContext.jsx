/**
 * AuthContext — manages JWT storage and current user state.
 *
 * Responsibilities:
 *  - Persist the JWT in localStorage (survives page refresh)
 *  - Expose user info, login(), logout() to every component
 *  - Provide getToken() so the API client can attach the Bearer header
 *  - On startup, call GET /api/v1/auth/me to re-validate a stored token
 */
import { createContext, useContext, useState, useEffect, useCallback } from "react";

// ---------------------------------------------------------------------------
// Storage keys — centralised so they never drift
// ---------------------------------------------------------------------------
const TOKEN_KEY = "smp_jwt";
const USER_KEY  = "smp_user";

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------
const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  // Initialise from localStorage so a page refresh keeps the user logged in
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) || null);
  const [user,  setUser]  = useState(() => {
    try {
      const raw = localStorage.getItem(USER_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  });
  const [loading, setLoading] = useState(true); // true while /me is in-flight

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  /** Persist token + user and update state. */
  function persist(newToken, newUser) {
    localStorage.setItem(TOKEN_KEY, newToken);
    localStorage.setItem(USER_KEY, JSON.stringify(newUser));
    setToken(newToken);
    setUser(newUser);
  }

  /** Clear everything. */
  function clear() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    setToken(null);
    setUser(null);
  }

  // ------------------------------------------------------------------
  // On mount: validate any token that was in localStorage
  // ------------------------------------------------------------------
  useEffect(() => {
    if (!token) {
      setLoading(false);
      return;
    }

    const BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:4000/api/v1";

    fetch(`${BASE_URL}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => {
        if (!res.ok) throw new Error("Token invalid");
        return res.json();
      })
      .then((data) => {
        // Token still valid — refresh user object from server
        if (data.success && data.user) {
          localStorage.setItem(USER_KEY, JSON.stringify(data.user));
          setUser(data.user);
        } else {
          clear();
        }
      })
      .catch(() => {
        // Expired / invalid token — clear silently
        clear();
      })
      .finally(() => setLoading(false));
  }, []); // run once on mount

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  /**
   * Log in with email + password.
   * Stores the returned JWT and user object.
   * Throws on failure so the login form can show the error.
   */
  const login = useCallback(async (email, password) => {
    const BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:4000/api/v1";

    const res = await fetch(`${BASE_URL}/auth/login`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ email, password }),
    });

    const data = await res.json();

    if (!res.ok || !data.success) {
      throw new Error(data.message || "Login failed");
    }

    persist(data.token, data.user);
    return data.user;
  }, []);

  /**
   * Log out — clears local state and notifies the server (fire-and-forget).
   */
  const logout = useCallback(async () => {
    if (token) {
      const BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:4000/api/v1";
      // Best-effort — don't block UI on network failure
      fetch(`${BASE_URL}/auth/logout`, {
        method:  "POST",
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {});
    }
    clear();
  }, [token]);

  /**
   * Returns the current JWT string, or null if not logged in.
   * Used by the API service to attach the Authorization header.
   */
  const getToken = useCallback(() => token, [token]);

  const value = {
    user,       // { id, name, email, role } | null
    token,      // raw JWT string | null
    loading,    // true during initial /me check
    isAuth:     !!token && !!user,
    isAdmin:    user?.role === "admin",
    login,
    logout,
    getToken,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** Hook — use inside any component under <AuthProvider>. */
export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
