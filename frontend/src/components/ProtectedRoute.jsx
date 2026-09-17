/**
 * ProtectedRoute — redirects unauthenticated users to /login.
 *
 * While the initial /me check is in-flight we show a loading state
 * rather than flickering to the login page.
 */
import { Navigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";

export default function ProtectedRoute({ children }) {
  const { isAuth, loading } = useAuth();

  if (loading) {
    // Still verifying stored token — don't flash the login page
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          minHeight: "100vh",
          background: "var(--bg)",
          color: "var(--text-muted)",
          fontFamily: "'IBM Plex Sans', sans-serif",
        }}
      >
        Verifying session…
      </div>
    );
  }

  if (!isAuth) {
    return <Navigate to="/login" replace />;
  }

  return children;
}
