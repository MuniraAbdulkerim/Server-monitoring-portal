import { pool } from "../db.js";
import { sendAlertEmail } from "./emailer.js";

const THRESHOLDS = {
  cpu: { warning: 70, critical: 90 },
  memory: { warning: 75, critical: 90 },
  disk: { warning: 80, critical: 90 },
};

const BACKUP_STALE_HOURS = 24;

/**
 * Compares one health reading against the configured thresholds and
 * creates/resolves alerts as needed. Called right after a reading is saved.
 */
export async function checkThresholds(payload) {
  const { serverId, cpuUsage, memoryUsage, diskUsage, backupStatus } = payload;

  const diskMax = Math.max(0, ...(diskUsage || []).map((d) => d.usedPercent));

  await evaluateMetric(serverId, "high_cpu", cpuUsage, THRESHOLDS.cpu, `CPU usage is at ${cpuUsage}%`);
  await evaluateMetric(serverId, "high_memory", memoryUsage, THRESHOLDS.memory, `Memory usage is at ${memoryUsage}%`);
  await evaluateMetric(serverId, "high_disk", diskMax, THRESHOLDS.disk, `Disk usage is at ${diskMax}%`);

  await evaluateBackup(serverId, backupStatus);
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

async function evaluateBackup(serverId, backupStatus) {
  if (!backupStatus) return;

  if (backupStatus.status === "failed") {
    await raiseAlertIfNew(serverId, "backup_failed", "critical", `Backup failed for ${serverId}`);
  } else {
    await resolveAlertIfActive(serverId, "backup_failed");
  }

  if (backupStatus.lastBackupTime) {
    const hoursSince = (Date.now() - new Date(backupStatus.lastBackupTime).getTime()) / 3600000;
    if (hoursSince > BACKUP_STALE_HOURS) {
      await raiseAlertIfNew(
        serverId,
        "backup_stale",
        "warning",
        `Last backup for ${serverId} was ${Math.floor(hoursSince)}h ago (over ${BACKUP_STALE_HOURS}h threshold)`
      );
    } else {
      await resolveAlertIfActive(serverId, "backup_stale");
    }
  }
}

async function raiseAlertIfNew(serverId, alertType, severity, message) {
  const existing = await pool.query(
    `SELECT id FROM alerts WHERE server_id = $1 AND alert_type = $2 AND resolved = false`,
    [serverId, alertType]
  );

  if (existing.rows.length > 0) return;

  await pool.query(
    `INSERT INTO alerts (server_id, alert_type, severity, message) VALUES ($1,$2,$3,$4)`,
    [serverId, alertType, severity, message]
  );

  await sendAlertEmail({ subject: `${severity.toUpperCase()}: ${alertType} on ${serverId}`, message });
}

async function resolveAlertIfActive(serverId, alertType) {
  await pool.query(
    `UPDATE alerts SET resolved = true, resolved_at = now()
     WHERE server_id = $1 AND alert_type = $2 AND resolved = false`,
    [serverId, alertType]
  );
}