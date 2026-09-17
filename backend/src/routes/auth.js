/**
 * Dashboard user authentication routes.
 *
 * POST /api/v1/auth/login   — validate email + password, return JWT
 * POST /api/v1/auth/logout  — stateless acknowledgement (client clears token)
 * GET  /api/v1/auth/me      — return current user (requires valid JWT)
 *
 * These routes are completely separate from the collector agent-token system.
 * Never mix JWT user auth with the per-server agent token auth.
 */
import express from "express";
import bcrypt  from "bcryptjs";
import jwt     from "jsonwebtoken";
import { z }   from "zod";
import { pool } from "../db.js";
import { auditLog } from "../services/audit.js";
import { requireUser } from "../middleware/requireUser.js";

const router = express.Router();

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------
const LoginSchema = z.object({
  email:    z.string().email().max(254),
  password: z.string().min(1).max(128),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** How long JWTs are valid. Configurable; defaults to 8 hours. */
function jwtExpiresIn() {
  return process.env.JWT_EXPIRES_IN || "8h";
}

/** Sign a JWT for a user row. Never include the password hash. */
function signToken(user) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not configured");

  return jwt.sign(
    { userId: user.id, email: user.email, role: user.role },
    secret,
    { expiresIn: jwtExpiresIn() }
  );
}

/** Safe user object — strips password_hash before sending to the client. */
function publicUser(user) {
  const { password_hash, ...safe } = user; // eslint-disable-line no-unused-vars
  return safe;
}

// ---------------------------------------------------------------------------
// POST /api/v1/auth/login
// ---------------------------------------------------------------------------
router.post("/login", async (req, res, next) => {
  // Validate input
  let parsed;
  try {
    parsed = LoginSchema.parse(req.body);
  } catch (err) {
    return next(err); // ZodError → 400
  }

  const { email, password } = parsed;

  try {
    // Look up user by email — always case-insensitive
    const { rows } = await pool.query(
      `SELECT id, name, email, password_hash, role, created_at, updated_at
       FROM users
       WHERE lower(email) = lower($1)
       LIMIT 1`,
      [email]
    );

    // Use a constant-time comparison path even for "user not found"
    // to prevent timing-based user enumeration attacks.
    const user           = rows[0] ?? null;
    const hashToCompare  = user?.password_hash ?? "$2b$12$invalidhashfortimingprotection00000000000000000";

    const passwordOk = await bcrypt.compare(password, hashToCompare);

    if (!user || !passwordOk) {
      // Audit the failure — no user detail in metadata, no password anywhere
      await auditLog({
        action:     "LOGIN_FAILURE",
        targetType: "user",
        targetId:   null,
        metadata:   { email },   // email only — no password, no hash
        ipAddress:  req.ip,
      });

      // Identical response for "no such user" and "wrong password"
      return res.status(401).json({ success: false, message: "Invalid email or password" });
    }

    // Sign JWT
    const token = signToken(user);

    // Audit success
    await auditLog({
      userId:     user.id,
      action:     "LOGIN_SUCCESS",
      targetType: "user",
      targetId:   String(user.id),
      metadata:   { email: user.email },
      ipAddress:  req.ip,
    });

    return res.json({
      success: true,
      token,
      user: publicUser(user),
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/auth/logout
// ---------------------------------------------------------------------------
// JWTs are stateless — the server has nothing to invalidate.
// The client removes the token from storage on receipt of this response.
router.post("/logout", requireUser, async (req, res) => {
  await auditLog({
    userId:     req.user.id,
    action:     "LOGOUT",
    targetType: "user",
    targetId:   String(req.user.id),
    ipAddress:  req.ip,
  }).catch(() => {}); // fire-and-forget

  return res.json({ success: true, message: "Logged out" });
});

// ---------------------------------------------------------------------------
// GET /api/v1/auth/me
// ---------------------------------------------------------------------------
// Returns the authenticated user's public info.
// Used by the frontend to restore session on page refresh.
router.get("/me", requireUser, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, email, role, created_at, updated_at
       FROM users WHERE id = $1`,
      [req.user.id]
    );

    if (rows.length === 0) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    return res.json({ success: true, user: rows[0] });
  } catch (err) {
    next(err);
  }
});

export default router;
