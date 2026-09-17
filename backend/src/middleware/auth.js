import bcrypt from "bcryptjs";
import { pool } from "../db.js";

/**
 * Per-server Bearer-token authentication middleware.
 *
 * Each registered server has its own unique agent token whose bcrypt hash
 * is stored in servers.agent_token_hash.  The middleware:
 *   1. Reads the Authorization header.
 *   2. Extracts the Bearer token.
 *   3. Iterates candidate servers (those with a non-null hash) and runs
 *      bcrypt.compare to find a match.
 *   4. Attaches req.authenticatedServer = { id, server_id, ... } for use
 *      by downstream route handlers.
 *   5. Returns 401 on any failure — no distinguishing error detail to avoid
 *      leaking information.
 *
 * NOTE: bcrypt.compare is intentionally slow (security property).  The
 * number of servers with tokens is expected to be small (hundreds at most),
 * so the linear scan is acceptable for Phase 1.  A future optimisation can
 * add a prefix/hint column to narrow the candidates.
 */
export async function requireAgentToken(req, res, next) {
  const authHeader = req.headers["authorization"];

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }

  const token = authHeader.slice("Bearer ".length).trim();

  if (!token) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }

  try {
    const { rows } = await pool.query(
      `SELECT id, server_id, name, agent_token_hash
       FROM servers
       WHERE agent_token_hash IS NOT NULL`
    );

    for (const server of rows) {
      const match = await bcrypt.compare(token, server.agent_token_hash);
      if (match) {
        // Never log the token or the hash
        req.authenticatedServer = {
          id:        server.id,
          server_id: server.server_id,
          name:      server.name,
        };
        return next();
      }
    }

    // Log the failure for audit purposes — no secrets included
    console.warn(
      `[AUTH] Failed authentication attempt from ${req.ip} — no matching server token`
    );

    // Record auth failure in audit_logs (fire-and-forget — don't block response)
    pool.query(
      `INSERT INTO audit_logs (action, metadata, ip_address)
       VALUES ($1, $2, $3)`,
      [
        "AUTH_FAILURE",
        JSON.stringify({ userAgent: req.headers["user-agent"] }),
        req.ip,
      ]
    ).catch(() => {}); // never let audit logging crash the response

    return res.status(401).json({ success: false, message: "Unauthorized" });
  } catch (err) {
    // If the DB is unavailable we cannot verify any token — return 401 rather
    // than 500 to avoid leaking infrastructure details.
    console.error("[AUTH] Middleware error (token verification failed):", err.message);
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
}
