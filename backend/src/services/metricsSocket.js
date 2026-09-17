/**
 * metricsSocket.js — real-time system metrics over WebSocket.
 *
 * Responsibilities:
 *   1. Accept a Node.js http.Server and attach socket.io to it.
 *   2. On each client connection, verify the JWT sent as a handshake
 *      auth token so only logged-in users can receive the stream.
 *   3. Start a single shared background interval that collects metrics
 *      from systeminformation every EMIT_INTERVAL_MS and broadcasts
 *      the "system_metrics" event to all connected clients.
 *   4. Stop the interval when the last client disconnects (saves CPU).
 *
 * Security:
 *   - JWT is validated in the "connection" middleware using the same
 *     JWT_SECRET as the REST middleware. Unauthenticated sockets are
 *     disconnected immediately.
 *   - The token is read from socket.handshake.auth.token (set by the
 *     frontend client options).  No query-string tokens (avoids logging).
 *
 * Usage (called once in server.js):
 *   import { attachMetricsSocket } from "./services/metricsSocket.js";
 *   const httpServer = app.listen(PORT, ...);
 *   attachMetricsSocket(httpServer, allowedOrigins);
 */

import { Server as SocketIOServer } from "socket.io";
import jwt     from "jsonwebtoken";
import si      from "systeminformation";
import os      from "os";

// How often to push a metric reading to clients (ms).
// 2 000 ms matches the prompt requirement; keep >= 1 000 to avoid
// saturating systeminformation's CPU sampler.
const EMIT_INTERVAL_MS = 2_000;

let _io         = null;   // socket.io Server instance (singleton)
let _intervalId = null;   // background setInterval handle
let _clientCount = 0;     // connected + authenticated clients

// ---------------------------------------------------------------------------
// Metric collection (shared — one read per interval regardless of client count)
// ---------------------------------------------------------------------------
async function collectMetrics() {
  try {
    const [load, mem] = await Promise.all([
      si.currentLoad(),
      si.mem(),
    ]);

    const totalRam   = mem.total;
    const freeRam    = mem.available;
    const usedRam    = totalRam - freeRam;
    const ramUsedPct = totalRam > 0
      ? Math.round((usedRam  / totalRam) * 1000) / 10
      : 0;

    return {
      timestamp:  new Date().toISOString(),
      uptimeSeconds: Math.floor(os.uptime()),
      cpu: {
        usagePercent: Math.round(load.currentLoad * 10) / 10,
      },
      ram: {
        totalBytes:  totalRam,
        freeBytes:   freeRam,
        usedBytes:   usedRam,
        usedPercent: ramUsedPct,
        totalGb: Math.round(totalRam / 1073741824 * 100) / 100,
        freeGb:  Math.round(freeRam  / 1073741824 * 100) / 100,
        usedGb:  Math.round(usedRam  / 1073741824 * 100) / 100,
      },
    };
  } catch (err) {
    // Never crash the interval — return null and let the caller skip the emit
    console.error("[WS] Failed to collect metrics:", err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Interval management
// ---------------------------------------------------------------------------
function startInterval() {
  if (_intervalId) return; // already running
  console.log(`[WS] Starting metrics broadcast every ${EMIT_INTERVAL_MS}ms`);

  _intervalId = setInterval(async () => {
    if (!_io || _clientCount === 0) return; // nobody listening
    const data = await collectMetrics();
    if (data) _io.emit("system_metrics", data);
  }, EMIT_INTERVAL_MS);
}

function stopInterval() {
  if (_intervalId) {
    clearInterval(_intervalId);
    _intervalId = null;
    console.log("[WS] Metrics broadcast stopped (no clients)");
  }
}

// ---------------------------------------------------------------------------
// JWT handshake middleware
// ---------------------------------------------------------------------------
function verifyHandshakeToken(socket, next) {
  const token = socket.handshake.auth?.token;

  if (!token) {
    return next(new Error("Authentication required"));
  }

  const secret = process.env.JWT_SECRET;
  if (!secret) {
    return next(new Error("Server configuration error"));
  }

  try {
    const payload = jwt.verify(token, secret);
    // Attach safe user info to the socket for use in event handlers
    socket.user = { id: payload.userId, email: payload.email, role: payload.role };
    return next();
  } catch {
    // Expired, tampered, or invalid token — disconnect cleanly
    return next(new Error("Authentication failed"));
  }
}

// ---------------------------------------------------------------------------
// Public entry point — call once after app.listen()
// ---------------------------------------------------------------------------
export function attachMetricsSocket(httpServer, allowedOrigins) {
  _io = new SocketIOServer(httpServer, {
    // Mirror the Express CORS policy
    cors: {
      origin:  allowedOrigins,
      methods: ["GET", "POST"],
    },
    // Use the /ws path so it never conflicts with Express REST routes
    path: "/ws/socket.io",
  });

  // Apply JWT auth middleware to every incoming connection
  _io.use(verifyHandshakeToken);

  _io.on("connection", (socket) => {
    _clientCount++;
    console.log(
      `[WS] Client connected: ${socket.user?.email ?? "unknown"} ` +
      `(${_clientCount} total)`
    );

    // Start the broadcast loop the moment the first client connects
    startInterval();

    // Send an immediate reading so the UI populates instantly
    collectMetrics().then((data) => {
      if (data) socket.emit("system_metrics", data);
    });

    socket.on("disconnect", (reason) => {
      _clientCount = Math.max(0, _clientCount - 1);
      console.log(
        `[WS] Client disconnected (${reason}). ` +
        `${_clientCount} remaining`
      );
      // Stop the interval when nobody is listening to save CPU
      if (_clientCount === 0) stopInterval();
    });
  });

  console.log("[WS] Socket.io attached (path: /ws/socket.io)");
  return _io;
}

/** Expose the io instance so other modules can emit events if needed. */
export function getIO() {
  return _io;
}
