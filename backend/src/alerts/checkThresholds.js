/**
 * Threshold evaluation service.
 *
 * After each health reading is saved, this function:
 *   1. Loads the effective thresholds (per-server override, or global default).
 *   2. Evaluates CPU, memory, disk, and backup metrics.
 *   3. Creates new alerts (without duplicates) or resolves existing ones.
 *   4. Optionally sends an email notification.
 */
import { pool } from "../db.js";
import { sendAlertEmail } from "./emailer.js";

/**
 * Fetch the effective threshold row for a given server.
 * Falls back to the global default (server_id IS NULL) if no per-server row exists.
 */
async function getThresholds(serverId) {
  // Try per-server first, then global default
  const { rows } = await pool.query(
    `SELECT * FROM thresholds
     WHERE server_id = $1
     UNION ALL
     SELECT * FROM thresholds WHERE server_id IS NULL
     ORDER BY server_id NULLS LAST
     LIMIT 1`,
    [serverId]
  );

  if (rows.length > 0) return rows[0];

  // Absolute fallback (should not happen if schema seed ran correctly)
  return {
    cpu_warning: 70, cpu_critical: 90,
    memory_warning: 75, memory_critical: 90,
    disk_warning: 80, disk_critical: 90,
    backup_stale_hours: 24,
  };
}

export async function checkThresholds(payload) {
  const { serverId, cpuUsage, memoryUsage, diskUsage, backupStatus } = payload;

  const t = await getThresholds(serverId);

  const diskMax = Math.max(0, ...(diskUsage || []).map((d) => d.usedPercent));

  await evaluateMetric(
    serverId, "high_cpu", cpuUsage,
    { warning: t.cpu_warning, critical: t.cpu_critical },
    `CPU usage is at ${cpuUsage}%`
  );
  await evaluateMetric(
    serverId, "high_memory", memoryUsage,
    { warning: t.memory_warning, critical: t.memory_critical },
    `Memory usage is at ${memoryUsage}%`
  );
  await evaluateMetric(
    serverId, "high_disk", diskMax,
    { warning: t.disk_warning, critical: t.disk_critical },
    `Disk usage is at ${diskMax.toFixed(1)}%`
  );

  await evaluateBackup(serverId, backupStatus, Number(t.backup_stale_hours));
}

async function evaluateMetric(serverId, alertType, value, thresholds, messageIfBad) {
  const numeric = Number(value);
  let severity = null;

  if (numeric >= thresholds.critical) severity = "critical";
  else if (numeric >= thresholds.warning) severity = "warning";

  if (severity) {
    await raiseAlertIfNew(serverId, alertType, severity, messageIfBad);
  } else {
    await resolveAlertIfActive(serverId, alertType);
  }
}

async function evaluateBackup(serverId, backupStatus, staleHours) {
  if (!backupStatus) return;

  if (backupStatus.status === "failed") {
    await raiseAlertIfNew(
      serverId, "backup_failed", "critical",
      `Backup failed for ${serverId}`
    );
  } else {
    await resolveAlertIfActive(serverId, "backup_failed");
  }

  if (backupStatus.lastBackupTime) {
    const hoursSince =
      (Date.now() - new Date(backupStatus.lastBackupTime).getTime()) / 3_600_000;
    if (hoursSince > staleHours) {
      await raiseAlertIfNew(
        serverId, "backup_stale", "warning",
        `Last backup for ${serverId} was ${Math.floor(hoursSince)}h ago (>${staleHours}h threshold)`
      );
    } else {
      await resolveAlertIfActive(serverId, "backup_stale");
    }
  }
}

async function raiseAlertIfNew(serverId, alertType, severity, message) {
  // Check for an existing open alert of the same type to avoid duplicates
  const { rows } = await pool.query(
    `SELECT id FROM alerts
     WHERE server_id = $1 AND alert_type = $2 AND resolved = false`,
    [serverId, alertType]
  );

  if (rows.length > 0) return; // already open — skip

  await pool.query(
    `INSERT INTO alerts (server_id, alert_type, severity, message)
     VALUES ($1, $2, $3, $4)`,
    [serverId, alertType, severity, message]
  );

  // Email is best-effort — never let it crash the health write
  sendAlertEmail({
    subject: `${severity.toUpperCase()}: ${alertType} on ${serverId}`,
    message,
  }).catch(() => {});
}

async function resolveAlertIfActive(serverId, alertType) {
  await pool.query(
    `UPDATE alerts
     SET resolved = true, resolved_at = now()
     WHERE server_id = $1 AND alert_type = $2 AND resolved = false`,
    [serverId, alertType]
  );
}
