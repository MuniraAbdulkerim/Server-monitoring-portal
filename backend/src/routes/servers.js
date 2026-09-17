/**
 * Server inventory routes.
 *
 * GET    /api/v1/servers          — list all registered servers (with live status)
 * GET    /api/v1/servers/:id      — get one server
 * POST   /api/v1/servers          — register a new server (returns plaintext token ONCE)
 * PUT    /api/v1/servers/:id      — update server details
 * DELETE /api/v1/servers/:id      — remove a server
 *
 * Security: agent_token_hash and password_hash are NEVER returned in API responses.
 */
import express from "express";
import { randomBytes } from "crypto";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { pool } from "../db.js";
import { auditLog } from "../services/audit.js";
import { computeStatus } from "../services/status.js";
import { requireRole } from "../middleware/requireUser.js";

const router = express.Router();

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------
const ServerCreateSchema = z.object({
  serverId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-_]+$/i, "serverId may only contain letters, numbers, hyphens, and underscores"),
  name:        z.string().min(1).max(120),
  ipOrHostname: z.string().max(253).optional(),
  serverType:   z.enum(["Web", "Database", "File", "Application", "Other"]).optional(),
  os:           z.enum(["windows", "linux"]).optional(),
  location:     z.string().max(120).optional(),
  criticality:  z.enum(["high", "medium", "low"]).optional().default("medium"),
  owner:        z.string().max(120).optional(),
});

const ServerUpdateSchema = z.object({
  name:         z.string().min(1).max(120).optional(),
  ipOrHostname: z.string().max(253).optional(),
  serverType:   z.enum(["Web", "Database", "File", "Application", "Other"]).optional(),
  os:           z.enum(["windows", "linux"]).optional(),
  location:     z.string().max(120).optional(),
  criticality:  z.enum(["high", "medium", "low"]).optional(),
  owner:        z.string().max(120).optional(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip sensitive fields from a server row before sending it to a client. */
function sanitizeServer(row) {
  const { agent_token_hash, ...safe } = row; // eslint-disable-line no-unused-vars
  return safe;
}

/** Compute the derived 'status' field from a server row + its latest health log. */
function enrichWithStatus(serverRow, latestHealth = null) {
  const diskMax = latestHealth
    ? Math.max(0, ...(latestHealth.disk_usage || []).map((d) => d.usedPercent))
    : 0;

  const status = computeStatus({
    lastSeenAt:   serverRow.last_seen_at,
    cpuUsage:     latestHealth?.cpu_usage,
    memoryUsage:  latestHealth?.memory_usage,
    diskMax,
    thresholds:   null, // uses defaults; per-server thresholds loaded in checkThresholds
  });

  return { ...sanitizeServer(serverRow), status };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// GET /api/v1/servers
router.get("/", async (req, res, next) => {
  try {
    const serversResult = await pool.query(
      `SELECT * FROM servers ORDER BY name ASC`
    );

    // Fetch latest health reading per server in one query
    const healthResult = await pool.query(
      `SELECT DISTINCT ON (server_id) server_id, cpu_usage, memory_usage, disk_usage
       FROM health_logs
       ORDER BY server_id, received_at DESC`
    );
    const healthMap = Object.fromEntries(
      healthResult.rows.map((h) => [h.server_id, h])
    );

    const servers = serversResult.rows.map((s) =>
      enrichWithStatus(s, healthMap[s.server_id] || null)
    );

    res.json({ success: true, data: servers });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/servers/:serverId
router.get("/:serverId", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM servers WHERE server_id = $1`,
      [req.params.serverId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: "Server not found" });
    }

    // Latest health reading for status enrichment
    const healthResult = await pool.query(
      `SELECT server_id, cpu_usage, memory_usage, disk_usage
       FROM health_logs
       WHERE server_id = $1
       ORDER BY received_at DESC
       LIMIT 1`,
      [req.params.serverId]
    );

    res.json({
      success: true,
      data: enrichWithStatus(rows[0], healthResult.rows[0] || null),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/servers  — register a new server  [admin only]
// Returns the plaintext agent token ONCE. Store it securely — it cannot be retrieved again.
router.post("/", requireRole("admin"), async (req, res, next) => {
  let parsed;
  try {
    parsed = ServerCreateSchema.parse(req.body);
  } catch (err) {
    return next(err); // ZodError → 400 via errorHandler
  }

  const { serverId, name, ipOrHostname, serverType, os, location, criticality, owner } = parsed;

  // Generate a cryptographically secure random token (32 bytes → 64 hex chars)
  const plaintextToken = randomBytes(32).toString("hex");
  const tokenHash = await bcrypt.hash(plaintextToken, 12);

  try {
    const result = await pool.query(
      `INSERT INTO servers
         (server_id, name, ip_or_hostname, server_type, os, location, criticality, owner, agent_token_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [serverId, name, ipOrHostname, serverType, os, location, criticality, owner, tokenHash]
    );

    const server = result.rows[0];

    // Audit log — do NOT include the token or hash
    await auditLog({
      action:     "SERVER_CREATED",
      targetType: "server",
      targetId:   serverId,
      metadata:   { name, os, location, criticality },
      ipAddress:  req.ip,
    });

    // TOKEN_GENERATED audit event
    await auditLog({
      action:     "TOKEN_GENERATED",
      targetType: "server",
      targetId:   serverId,
      metadata:   { reason: "initial_registration" },
      ipAddress:  req.ip,
    });

    // Return the plaintext token ONCE — it will never be retrievable again
    return res.status(201).json({
      success: true,
      message:
        "Server registered. Save the agentToken — it will not be shown again.",
      agentToken: plaintextToken, // ← shown exactly once
      data: sanitizeServer(server),
    });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({
        success: false,
        message: `A server with serverId "${serverId}" already exists`,
      });
    }
    next(err);
  }
});

// PUT /api/v1/servers/:serverId  — update server details  [admin only]
router.put("/:serverId", requireRole("admin"), async (req, res, next) => {
  let parsed;
  try {
    parsed = ServerUpdateSchema.parse(req.body);
  } catch (err) {
    return next(err);
  }

  const { name, ipOrHostname, serverType, os, location, criticality, owner } = parsed;

  try {
    const result = await pool.query(
      `UPDATE servers
       SET name           = COALESCE($1, name),
           ip_or_hostname = COALESCE($2, ip_or_hostname),
           server_type    = COALESCE($3, server_type),
           os             = COALESCE($4, os),
           location       = COALESCE($5, location),
           criticality    = COALESCE($6, criticality),
           owner          = COALESCE($7, owner),
           updated_at     = now()
       WHERE server_id = $8
       RETURNING *`,
      [name, ipOrHostname, serverType, os, location, criticality, owner, req.params.serverId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Server not found" });
    }

    await auditLog({
      action:     "SERVER_UPDATED",
      targetType: "server",
      targetId:   req.params.serverId,
      metadata:   parsed,
      ipAddress:  req.ip,
    });

    res.json({ success: true, data: sanitizeServer(result.rows[0]) });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/servers/:serverId  [admin only]
router.delete("/:serverId", requireRole("admin"), async (req, res, next) => {
  try {
    const result = await pool.query(
      `DELETE FROM servers WHERE server_id = $1 RETURNING server_id, name`,
      [req.params.serverId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Server not found" });
    }

    await auditLog({
      action:     "SERVER_DELETED",
      targetType: "server",
      targetId:   req.params.serverId,
      metadata:   { name: result.rows[0].name },
      ipAddress:  req.ip,
    });

    res.json({ success: true, deleted: true, serverId: result.rows[0].server_id });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/servers/:serverId/regenerate-token  [admin only]
router.post("/:serverId/regenerate-token", requireRole("admin"), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id FROM servers WHERE server_id = $1`,
      [req.params.serverId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: "Server not found" });
    }

    const plaintextToken = randomBytes(32).toString("hex");
    const tokenHash = await bcrypt.hash(plaintextToken, 12);

    await pool.query(
      `UPDATE servers SET agent_token_hash = $1, updated_at = now() WHERE server_id = $2`,
      [tokenHash, req.params.serverId]
    );

    await auditLog({
      action:     "TOKEN_GENERATED",
      targetType: "server",
      targetId:   req.params.serverId,
      metadata:   { reason: "token_regenerated" },
      ipAddress:  req.ip,
    });

    return res.json({
      success: true,
      message: "New agent token generated. Save it — it will not be shown again.",
      agentToken: plaintextToken,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
