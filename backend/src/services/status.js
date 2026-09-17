/**
 * Server availability status computation.
 *
 * Returns one of: 'online' | 'offline' | 'warning' | 'critical'
 *
 * Logic:
 *   - If last_seen_at is null or older than SERVER_OFFLINE_TIMEOUT_SECONDS → 'offline'
 *   - If any metric exceeds its critical threshold → 'critical'
 *   - If any metric exceeds its warning threshold  → 'warning'
 *   - Otherwise → 'online'
 */

const OFFLINE_TIMEOUT_MS =
  (Number(process.env.SERVER_OFFLINE_TIMEOUT_SECONDS) || 300) * 1000;

/**
 * @param {object} params
 * @param {string|Date|null} params.lastSeenAt
 * @param {number|null}      params.cpuUsage
 * @param {number|null}      params.memoryUsage
 * @param {number|null}      params.diskMax       - highest disk % across all mounts
 * @param {object}           params.thresholds    - from DB row
 */
export function computeStatus({
  lastSeenAt,
  cpuUsage,
  memoryUsage,
  diskMax,
  thresholds,
}) {
  if (!lastSeenAt) return "offline";

  const msSinceSeen = Date.now() - new Date(lastSeenAt).getTime();
  if (msSinceSeen > OFFLINE_TIMEOUT_MS) return "offline";

  const t = thresholds || defaultThresholds();

  const cpu  = Number(cpuUsage)    || 0;
  const mem  = Number(memoryUsage) || 0;
  const disk = Number(diskMax)     || 0;

  if (
    cpu  >= t.cpu_critical    ||
    mem  >= t.memory_critical ||
    disk >= t.disk_critical
  ) return "critical";

  if (
    cpu  >= t.cpu_warning    ||
    mem  >= t.memory_warning ||
    disk >= t.disk_warning
  ) return "warning";

  return "online";
}

export function defaultThresholds() {
  return {
    cpu_warning:     70,
    cpu_critical:    90,
    memory_warning:  75,
    memory_critical: 90,
    disk_warning:    80,
    disk_critical:   90,
    backup_stale_hours: 24,
  };
}
