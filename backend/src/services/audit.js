/**
 * Audit logging service.
 *
 * Records important administrative and security events.
 * NEVER store secrets, passwords, or tokens in audit metadata.
 */
import { pool } from "../db.js";

/**
 * @param {object} params
 * @param {number|null}  params.userId     - authenticated user id (if any)
 * @param {string}       params.action     - e.g. SERVER_CREATED, TOKEN_GENERATED
 * @param {string|null}  params.targetType - e.g. 'server', 'threshold', 'user'
 * @param {string|null}  params.targetId   - the affected record identifier
 * @param {object|null}  params.metadata   - arbitrary safe JSON — NO secrets
 * @param {string|null}  params.ipAddress  - request IP
 */
export async function auditLog({
  userId = null,
  action,
  targetType = null,
  targetId = null,
  metadata = null,
  ipAddress = null,
} = {}) {
  try {
    await pool.query(
      `INSERT INTO audit_logs (user_id, action, target_type, target_id, metadata, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        userId,
        action,
        targetType,
        targetId,
        metadata ? JSON.stringify(metadata) : null,
        ipAddress,
      ]
    );
  } catch (err) {
    // Audit logging must never crash the main request
    console.error("[AUDIT] Failed to write audit log:", err.message);
  }
}
