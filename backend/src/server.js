import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createServer } from "http";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { z } from "zod";
import { pool } from "./db.js";
import serversRouter from "./routes/servers.js";
import alertsRouter  from "./routes/alerts.js";
import authRouter    from "./routes/auth.js";
import systemRouter  from "./routes/system.js";
import { requireAgentToken } from "./middleware/auth.js";
import { requireUser } from "./middleware/requireUser.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { checkThresholds } from "./alerts/checkThresholds.js";
import { attachMetricsSocket } from "./services/metricsSocket.js";

dotenv.config();

const app = express();

// ---------------------------------------------------------------------------
// CORS — restrict to configured origins only
// ---------------------------------------------------------------------------
const allowedOrigins = (process.env.CORS_ORIGIN || "http://localhost:5173")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow server-to-server (no origin header) or known browser origins
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`CORS: origin ${origin} not allowed`));
      }
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json({ limit: "1mb" }));

// Trust proxy headers (needed for accurate req.ip behind reverse proxies)
app.set("trust proxy", 1);

const PORT = Number(process.env.PORT) || 4000;

// ---------------------------------------------------------------------------
// Health check for the API itself (not the monitored servers)
// ---------------------------------------------------------------------------
app.get("/", (_req, res) => {
  res.json({ success: true, message: "server-monitor backend running" });
});

// ---------------------------------------------------------------------------
// Health data submission — POST /api/v1/health
// Requires per-server Bearer token authentication.
// The server identity is taken from the authenticated token, NOT from the
// request body, preventing a client from impersonating another server.
// ---------------------------------------------------------------------------
const HealthSchema = z.object({
  // serverId in the body is still accepted (for logging/debug) but the
  // authoritative identity comes from req.authenticatedServer.server_id
  serverId:      z.string().min(1).max(64).optional(),
  hostname:      z.string().max(253).optional(),
  os:            z.enum(["windows", "linux"]).optional(),
  cpuUsage:      z.number().min(0).max(100),
  memoryUsage:   z.number().min(0).max(100),
  diskUsage:     z
    .array(
      z.object({
        mount:       z.string(),
        usedPercent: z.number().min(0).max(100),
      })
    )
    .optional()
    .default([]),
  uptimeSeconds: z.number().int().min(0).optional(),
  lastBootTime:  z.string().datetime({ offset: true }).optional(),
  networkStatus: z.string().max(32).optional(),
  backupStatus:  z
    .object({
      lastBackupTime: z.string().nullable().optional(),
      status:         z.string().max(32).optional(),
      sizeBytes:      z.number().nullable().optional(),
      source:         z.string().max(64).optional(),
    })
    .optional()
    .default({}),
});

app.post("/api/v1/health", requireAgentToken, async (req, res, next) => {
  // Validate the payload
  let parsed;
  try {
    parsed = HealthSchema.parse(req.body);
  } catch (err) {
    return next(err); // → ZodError → 400
  }

  // Identity comes from the authenticated token — never trust req.body for this
  const serverId = req.authenticatedServer.server_id;

  const {
    hostname,
    os,
    cpuUsage,
    memoryUsage,
    diskUsage,
    uptimeSeconds,
    lastBootTime,
    networkStatus,
    backupStatus,
  } = parsed;

  try {
    const result = await pool.query(
      `INSERT INTO health_logs
         (server_id, hostname, os, cpu_usage, memory_usage, disk_usage,
          uptime_seconds, last_boot_time, network_status, backup_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id, received_at`,
      [
        serverId,
        hostname,
        os,
        cpuUsage,
        memoryUsage,
        JSON.stringify(diskUsage),
        uptimeSeconds ?? null,
        lastBootTime ?? null,
        networkStatus ?? null,
        JSON.stringify(backupStatus),
      ]
    );

    // Update last_seen_at on the server record
    await pool.query(
      `UPDATE servers SET last_seen_at = now(), updated_at = now() WHERE server_id = $1`,
      [serverId]
    );

    // Threshold check is fire-and-forget — don't let it delay the response
    checkThresholds({ serverId, cpuUsage, memoryUsage, diskUsage, backupStatus })
      .catch((err) => console.error("[THRESHOLD] Check failed:", err.message));

    return res.status(201).json({
      success:    true,
      id:         result.rows[0].id,
      receivedAt: result.rows[0].received_at,
    });
  } catch (err) {
    // FK violation: server_id doesn't exist in servers table
    if (err.code === "23503") {
      return res.status(422).json({
        success: false,
        message: "Server not registered in inventory. Register the server first.",
      });
    }
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/health  — latest reading per server (used by the dashboard)
// Protected by dashboard JWT — health data is only visible after login.
// ---------------------------------------------------------------------------
app.get("/api/v1/health", requireUser, async (_req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT ON (server_id) *
       FROM health_logs
       ORDER BY server_id, received_at DESC`
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/health/:serverId  — last 100 readings for one server
// Protected by dashboard JWT.
// ---------------------------------------------------------------------------
app.get("/api/v1/health/:serverId", requireUser, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT * FROM health_logs WHERE server_id = $1 ORDER BY received_at DESC LIMIT 100`,
      [req.params.serverId]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Mounted routers
// ---------------------------------------------------------------------------
app.use("/api/v1/auth",    authRouter);           // login / logout / me (public + JWT)
app.use("/api/v1/servers", requireUser, serversRouter);  // JWT-protected
app.use("/api/v1/alerts",  requireUser, alertsRouter);   // JWT-protected
app.use("/api/v1/system",  systemRouter);                // JWT inside router

// ---------------------------------------------------------------------------
// Production: serve the compiled React SPA
//
// This block only activates when NODE_ENV=production.
// In development the Vite dev server (port 5173) handles the frontend.
//
// Path: <repo-root>/backend/src/server.js → ../../frontend/dist
// ---------------------------------------------------------------------------
const IS_PROD = process.env.NODE_ENV === "production";

// Compute once at module load — used by both the static middleware and the
// SPA fallback handler below.
const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const DIST_PATH  = join(__dirname, "..", "..", "frontend", "dist");

if (IS_PROD) {
  // Serve JS, CSS, images, fonts, etc.
  app.use(express.static(DIST_PATH));
  console.log(`[SERVER] Serving static files from: ${DIST_PATH}`);
}

// ---------------------------------------------------------------------------
// SPA fallback + 404
// In production: non-API paths hand off to index.html so React Router works.
// In development: return JSON 404 (Vite handles the browser).
// ---------------------------------------------------------------------------
app.use((req, res) => {
  if (IS_PROD && !req.path.startsWith("/api/")) {
    return res.sendFile(join(DIST_PATH, "index.html"));
  }
  return res.status(404).json({ success: false, message: "Not found" });
});

// ---------------------------------------------------------------------------
// Centralized error handler — must be last
// ---------------------------------------------------------------------------
app.use(errorHandler);

// ---------------------------------------------------------------------------
// Start — create an explicit http.Server so socket.io can share it
// ---------------------------------------------------------------------------
const httpServer = createServer(app);

// Attach WebSocket server for real-time system metrics
attachMetricsSocket(httpServer, allowedOrigins);

// Only bind the port when this file is the direct entry point.
// When imported by tests (supertest), we skip listen() so there is no
// EADDRINUSE and no port conflict between test runs.
const isEntryPoint = process.argv[1]?.replace(/\\/g, "/").includes("server.js");

if (isEntryPoint) {
  httpServer.listen(PORT, () => {
    console.log(`[SERVER] server-monitor backend listening on http://localhost:${PORT}`);
    console.log(`[SERVER] CORS origins: ${allowedOrigins.join(", ")}`);
    console.log(`[SERVER] WebSocket path: /ws/socket.io`);
    console.log(
      `[SERVER] Server offline timeout: ${process.env.SERVER_OFFLINE_TIMEOUT_SECONDS || 300}s`
    );
  });
}

export default app; // for testing (supertest uses the Express app directly)
