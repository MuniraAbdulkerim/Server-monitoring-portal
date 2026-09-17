/**
 * LoginPage — email + password form.
 *
 * On success:  navigates to the dashboard (/).
 * On failure:  shows the error message from the backend.
 *
 * Uses AuthContext.login() which POSTs to /api/v1/auth/login,
 * stores the JWT, and returns the user object.
 */
import { useState } from "react";
import { useNavigate, Navigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";

export default function LoginPage() {
  const { login, isAuth } = useAuth();
  const navigate           = useNavigate();

  const [email,    setEmail]    = useState("");
  const [password, setPassword] = useState("");
  const [error,    setError]    = useState(null);
  const [loading,  setLoading]  = useState(false);

  // Already logged in — skip to dashboard
  if (isAuth) return <Navigate to="/" replace />;

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      await login(email, password);
      navigate("/", { replace: true });
    } catch (err) {
      setError(err.message || "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        {/* Logo / title */}
        <div className="login-card__header">
          <div className="login-logo" aria-hidden="true">
            <span className="pulse-dot" style={{ width: 12, height: 12 }} />
          </div>
          <h1 className="login-card__title">Server Monitoring Portal</h1>
          <p className="login-card__subtitle">Sign in to continue</p>
        </div>

        <form className="login-form" onSubmit={handleSubmit} noValidate>
          <label className="login-label">
            Email address
            <input
              type="email"
              className="login-input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@example.com"
              autoComplete="email"
              required
              disabled={loading}
              aria-describedby={error ? "login-error" : undefined}
            />
          </label>

          <label className="login-label">
            Password
            <input
              type="password"
              className="login-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
              required
              disabled={loading}
            />
          </label>

          {error && (
            <div id="login-error" className="login-error" role="alert">
              {error}
            </div>
          )}

          <button
            type="submit"
            className="btn btn--primary login-submit"
            disabled={loading || !email || !password}
          >
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
