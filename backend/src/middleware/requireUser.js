/**
 * JWT authentication middleware for dashboard/human-user routes.
 *
 * Reads:  Authorization: Bearer <jwt>
 * Verifies the JWT against JWT_SECRET from .env.
 * Attaches req.user = { id, email, role } on success.
 * Returns 401 on any failure — no detail leaked to the client.
 *
 * This is entirely separate from requireAgentToken (collector auth).
 * The two middleware functions must never be mixed.
 */
import jwt from "jsonwebtoken";

export function requireUser(req, res, next) {
  const authHeader = req.headers["authorization"];

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }

  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }

  const secret = process.env.JWT_SECRET;
  if (!secret) {
    // Configuration error — never expose internal detail
    console.error("[AUTH] JWT_SECRET is not set in environment");
    return res.status(500).json({ success: false, message: "Server configuration error" });
  }

  try {
    const payload = jwt.verify(token, secret);
    // Attach safe user info — never attach the raw token or hashes
    req.user = {
      id:    payload.userId,
      email: payload.email,
      role:  payload.role,
    };
    return next();
  } catch (err) {
    // TokenExpiredError, JsonWebTokenError, etc. — all become 401
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
}

/**
 * Role-based access control middleware.
 * Must be used AFTER requireUser.
 *
 * Usage:
 *   router.delete("/:id", requireUser, requireRole("admin"), handler)
 *
 * @param {...string} roles - allowed roles, e.g. "admin"
 */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: "Forbidden: insufficient permissions",
      });
    }
    return next();
  };
}
