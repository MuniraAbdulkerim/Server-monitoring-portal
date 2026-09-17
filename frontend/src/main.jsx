import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";

import { AuthProvider } from "./context/AuthContext.jsx";
import ProtectedRoute   from "./components/ProtectedRoute.jsx";
import AppLayout        from "./components/AppLayout.jsx";

import LoginPage        from "./pages/LoginPage.jsx";
import App              from "./App.jsx";               // Dashboard  →  /
import ServersPage      from "./pages/ServersPage.jsx"; // Servers    →  /servers
import AlertsPage       from "./pages/AlertsPage.jsx";  // Alerts     →  /alerts
import SystemMetricsPage from "./pages/SystemMetricsPage.jsx"; // System → /system

import "./index.css";

// All routes that live inside the authenticated shell share one
// <ProtectedRoute> + <AppLayout> parent.  Any unauthenticated access
// is redirected to /login by ProtectedRoute.
createRoot(document.getElementById("root")).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          {/* ── Public ─────────────────────────────────────────────── */}
          <Route path="/login" element={<LoginPage />} />

          {/* ── Protected shell ────────────────────────────────────── */}
          <Route
            element={
              <ProtectedRoute>
                <AppLayout />
              </ProtectedRoute>
            }
          >
            <Route index        element={<App />} />
            <Route path="servers" element={<ServersPage />} />
            <Route path="alerts"  element={<AlertsPage />} />
            <Route path="system"  element={<SystemMetricsPage />} />
          </Route>

          {/* ── Fallback ────────────────────────────────────────────── */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>
);
