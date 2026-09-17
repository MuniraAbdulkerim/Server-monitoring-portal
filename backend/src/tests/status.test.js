/**
 * Unit tests for server status computation.
 * No database required.
 */
import { describe, it, expect } from "vitest";
import { computeStatus, defaultThresholds } from "../services/status.js";

const t = defaultThresholds();

describe("computeStatus", () => {
  it("returns offline when lastSeenAt is null", () => {
    expect(computeStatus({ lastSeenAt: null, cpuUsage: 10, memoryUsage: 10, diskMax: 10, thresholds: t }))
      .toBe("offline");
  });

  it("returns offline when lastSeenAt is far in the past", () => {
    const ancient = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago
    // Override timeout to 5 min via env — but we can pass a direct old timestamp
    // Default timeout is 300 s (5 min), so 10 min ago is stale
    expect(computeStatus({ lastSeenAt: ancient, cpuUsage: 5, memoryUsage: 5, diskMax: 5, thresholds: t }))
      .toBe("offline");
  });

  it("returns online for a recent report with healthy metrics", () => {
    const recent = new Date().toISOString();
    expect(computeStatus({ lastSeenAt: recent, cpuUsage: 30, memoryUsage: 40, diskMax: 50, thresholds: t }))
      .toBe("online");
  });

  it("returns warning when CPU is at warning threshold", () => {
    const recent = new Date().toISOString();
    expect(computeStatus({ lastSeenAt: recent, cpuUsage: 75, memoryUsage: 40, diskMax: 50, thresholds: t }))
      .toBe("warning");
  });

  it("returns critical when CPU is at critical threshold", () => {
    const recent = new Date().toISOString();
    expect(computeStatus({ lastSeenAt: recent, cpuUsage: 95, memoryUsage: 40, diskMax: 50, thresholds: t }))
      .toBe("critical");
  });

  it("returns critical when memory is at critical threshold", () => {
    const recent = new Date().toISOString();
    expect(computeStatus({ lastSeenAt: recent, cpuUsage: 30, memoryUsage: 92, diskMax: 50, thresholds: t }))
      .toBe("critical");
  });

  it("returns warning when disk is at warning threshold", () => {
    const recent = new Date().toISOString();
    expect(computeStatus({ lastSeenAt: recent, cpuUsage: 30, memoryUsage: 40, diskMax: 82, thresholds: t }))
      .toBe("warning");
  });

  it("critical takes priority over warning", () => {
    const recent = new Date().toISOString();
    // disk at warning, cpu at critical → critical
    expect(computeStatus({ lastSeenAt: recent, cpuUsage: 95, memoryUsage: 40, diskMax: 81, thresholds: t }))
      .toBe("critical");
  });
});
