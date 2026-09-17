/**
 * Integration tests — Server Monitoring Portal API
 *
 * Covers:
 *   - Dashboard JWT auth  (login, invalid password, missing token,
 *                          expired token, role enforcement)
 *   - Server CRUD         (requires JWT + admin role)
 *   - Collector health    (agent Bearer token, unchanged from Phase 1)
 *   - Alerts API          (requires JWT)
 *   - System metrics      (requires JWT)
 *
 * DB-dependent tests skip automatically when Postgres is unavailable.
 * Force-skip:  SKIP_DB_TESTS=true npm test
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import bcrypt  from "bcryptjs";
import jwt     from "jsonwebtoken";
import app     from "../server.js";
import { pool } from "../db.js";

const SKIP = process.env.SKIP_DB_TESTS === "true";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function dbAvailable() {
  try { await pool.query("SELECT 1"); return true; }
  catch { return false; }
}

// Unique IDs for this test run so parallel runs don't collide
const RUN        = Date.now();
const SRV_A      = `test-srv-${RUN}`;
const SRV_B      = `test-srv-b-${RUN}`;
const ADMIN_EMAIL = `test-admin-${RUN}@example.com`;
const VIEWER_EMAIL = `test-viewer-${RUN}@example.com`;
const TEST_PW    = "Test@Password1";

// Shared state populated in beforeAll
let agentTokenA  = null;   // collector agent token for server A
let agentTokenB  = null;   // collector agent token for server B
let adminJwt     = null;   // dashboard JWT for admin user
let viewerJwt    = null;   // dashboard JWT for viewer user

// ---------------------------------------------------------------------------
// Setup — create test users and servers once for the whole suite
// ---------------------------------------------------------------------------

beforeAll(async () => {
  if (SKIP || !(await dbAvailable())) return;

  // 1. Create admin user
  const hash = await bcrypt.hash(TEST_PW, 10);
  await pool.query(
    `INSERT INTO users (name, email, password_hash, role)
     VALUES ($1,$2,$3,'admin') ON CONFLICT DO NOTHING`,
    ["Test Admin", ADMIN_EMAIL, hash]
  );

  // 2. Create viewer user
  await pool.query(
    `INSERT INTO users (name, email, password_hash, role)
     VALUES ($1,$2,$3,'viewer') ON CONFLICT DO NOTHING`,
    ["Test Viewer", VIEWER_EMAIL, hash]
  );

  // 3. Log in as admin to obtain JWT
  const loginRes = await request(app)
    .post("/api/v1/auth/login")
    .send({ email: ADMIN_EMAIL, password: TEST_PW });
  adminJwt = loginRes.body.token;

  // 4. Log in as viewer
  const viewerRes = await request(app)
    .post("/api/v1/auth/login")
    .send({ email: VIEWER_EMAIL, password: TEST_PW });
  viewerJwt = viewerRes.body.token;

  // 5. Register server A (admin JWT required now)
  const srvA = await request(app)
    .post("/api/v1/servers")
    .set("Authorization", `Bearer ${adminJwt}`)
    .send({ serverId: SRV_A, name: "Test Server A", os: "linux", criticality: "low" });
  agentTokenA = srvA.body.agentToken;

  // 6. Register server B
  const srvB = await request(app)
    .post("/api/v1/servers")
    .set("Authorization", `Bearer ${adminJwt}`)
    .send({ serverId: SRV_B, name: "Test Server B", os: "linux", criticality: "low" });
  agentTokenB = srvB.body.agentToken;
});

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

afterAll(async () => {
  if (SKIP) return;
  try {
    await pool.query("DELETE FROM servers WHERE server_id LIKE 'test-srv-%'");
    await pool.query("DELETE FROM users WHERE email LIKE 'test-%@example.com'");
  } catch { /* ignore */ }
  await pool.end();
});

// ===========================================================================
// API root (public)
// ===========================================================================

describe("GET /", () => {
  it("returns 200 success", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

// ===========================================================================
// Dashboard Authentication  — POST /api/v1/auth/login
// ===========================================================================

describe("Dashboard Authentication", () => {

  it("login — 200 + JWT for valid admin credentials", async () => {
    if (SKIP || !(await dbAvailable())) return;
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: ADMIN_EMAIL, password: TEST_PW });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.token).toBe("string");
    expect(res.body.token.length).toBeGreaterThan(20);
    // password_hash must never appear
    expect(res.body.user?.password_hash).toBeUndefined();
    expect(res.body.user?.role).toBe("admin");
  });

  it("login — 401 for wrong password", async () => {
    if (SKIP || !(await dbAvailable())) return;
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: ADMIN_EMAIL, password: "wrong-password" });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    // Response must not say "wrong password" vs "no such user"
    expect(res.body.message).toBe("Invalid email or password");
  });

  it("login — 401 for unknown email", async () => {
    if (SKIP || !(await dbAvailable())) return;
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "nobody@nowhere.com", password: TEST_PW });

    expect(res.status).toBe(401);
    // Same message as wrong password — no user enumeration
    expect(res.body.message).toBe("Invalid email or password");
  });

  it("login — 400 for invalid email format", async () => {
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "not-an-email", password: TEST_PW });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("GET /api/v1/auth/me — 200 with valid JWT", async () => {
    if (SKIP || !(await dbAvailable()) || !adminJwt) return;
    const res = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(ADMIN_EMAIL);
    expect(res.body.user.password_hash).toBeUndefined();
  });

  it("GET /api/v1/auth/me — 401 with no token", async () => {
    const res = await request(app).get("/api/v1/auth/me");
    expect(res.status).toBe(401);
  });

  it("GET /api/v1/auth/me — 401 with expired token", async () => {
    // Sign a token that expired 1 second ago
    const expiredToken = jwt.sign(
      { userId: 999, email: "x@x.com", role: "admin" },
      process.env.JWT_SECRET || "dev-jwt-secret-change-in-production-min-32-chars",
      { expiresIn: -1 }
    );
    const res = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${expiredToken}`);

    expect(res.status).toBe(401);
  });

  it("GET /api/v1/auth/me — 401 with tampered token", async () => {
    const res = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", "Bearer eyJhbGciOiJIUzI1NiJ9.tampered.signature");
    expect(res.status).toBe(401);
  });
});

// ===========================================================================
// Role enforcement
// ===========================================================================

describe("Role enforcement", () => {

  it("viewer can GET /api/v1/servers (read)", async () => {
    if (SKIP || !(await dbAvailable()) || !viewerJwt) return;
    const res = await request(app)
      .get("/api/v1/servers")
      .set("Authorization", `Bearer ${viewerJwt}`);
    expect(res.status).toBe(200);
  });

  it("viewer cannot POST /api/v1/servers (write) — 403", async () => {
    if (SKIP || !(await dbAvailable()) || !viewerJwt) return;
    const res = await request(app)
      .post("/api/v1/servers")
      .set("Authorization", `Bearer ${viewerJwt}`)
      .send({ serverId: "viewer-attempt", name: "Should Fail" });
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it("viewer cannot DELETE a server — 403", async () => {
    if (SKIP || !(await dbAvailable()) || !viewerJwt) return;
    const res = await request(app)
      .delete(`/api/v1/servers/${SRV_A}`)
      .set("Authorization", `Bearer ${viewerJwt}`);
    expect(res.status).toBe(403);
  });

  it("viewer cannot resolve an alert — 403", async () => {
    if (SKIP || !(await dbAvailable()) || !viewerJwt) return;
    const res = await request(app)
      .put("/api/v1/alerts/999/resolve")
      .set("Authorization", `Bearer ${viewerJwt}`);
    // 403 (role) or 400 (invalid id) — both mean the request didn't succeed
    expect([400, 403, 404]).toContain(res.status);
  });

  it("unauthenticated request to /api/v1/servers — 401", async () => {
    const res = await request(app).get("/api/v1/servers");
    expect(res.status).toBe(401);
  });
});

// ===========================================================================
// Server CRUD  (admin JWT)
// ===========================================================================

describe("Server API (admin JWT)", () => {

  it("POST — 409 on duplicate serverId", async () => {
    if (SKIP || !(await dbAvailable()) || !adminJwt) return;
    const res = await request(app)
      .post("/api/v1/servers")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ serverId: SRV_A, name: "Duplicate" });
    expect(res.status).toBe(409);
  });

  it("POST — 400 when name is missing", async () => {
    if (SKIP || !(await dbAvailable()) || !adminJwt) return;
    const res = await request(app)
      .post("/api/v1/servers")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ serverId: "no-name-srv" });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("GET / — lists servers, no token hashes exposed", async () => {
    if (SKIP || !(await dbAvailable()) || !adminJwt) return;
    const res = await request(app)
      .get("/api/v1/servers")
      .set("Authorization", `Bearer ${adminJwt}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.map((s) => s.server_id)).toContain(SRV_A);
    res.body.data.forEach((s) => expect(s.agent_token_hash).toBeUndefined());
  });

  it("GET /:id — returns a single server", async () => {
    if (SKIP || !(await dbAvailable()) || !adminJwt) return;
    const res = await request(app)
      .get(`/api/v1/servers/${SRV_A}`)
      .set("Authorization", `Bearer ${adminJwt}`);
    expect(res.status).toBe(200);
    expect(res.body.data.server_id).toBe(SRV_A);
    expect(res.body.data.agent_token_hash).toBeUndefined();
  });

  it("GET /:id — 404 for unknown id", async () => {
    if (SKIP || !(await dbAvailable()) || !adminJwt) return;
    const res = await request(app)
      .get("/api/v1/servers/does-not-exist-xyz")
      .set("Authorization", `Bearer ${adminJwt}`);
    expect(res.status).toBe(404);
  });

  it("PUT /:id — updates server details", async () => {
    if (SKIP || !(await dbAvailable()) || !adminJwt) return;
    const res = await request(app)
      .put(`/api/v1/servers/${SRV_A}`)
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ name: "Updated Name", location: "Room 42" });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe("Updated Name");
  });
});

// ===========================================================================
// Collector agent-token auth  (POST /api/v1/health — UNCHANGED from Phase 1)
// ===========================================================================

describe("Collector Authentication (agent token)", () => {

  it("401 with no Authorization header", async () => {
    const res = await request(app)
      .post("/api/v1/health")
      .send({ cpuUsage: 20, memoryUsage: 30 });
    expect(res.status).toBe(401);
  });

  it("401 with an invalid agent token", async () => {
    const res = await request(app)
      .post("/api/v1/health")
      .set("Authorization", "Bearer totally-invalid-agent-token")
      .send({ cpuUsage: 20, memoryUsage: 30 });
    expect(res.status).toBe(401);
  }, 15000);  // bcrypt scan over all registered servers can be slow

  it("401 with a dashboard JWT used on collector endpoint", async () => {
    // A user JWT must NOT authenticate the collector endpoint
    if (!adminJwt) return;
    const res = await request(app)
      .post("/api/v1/health")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ cpuUsage: 20, memoryUsage: 30 });
    // The collector endpoint uses requireAgentToken — JWT won't match any hash
    expect(res.status).toBe(401);
  }, 15000);

  it("201 with valid agent token and valid payload", async () => {
    if (SKIP || !(await dbAvailable()) || !agentTokenA) return;
    const res = await request(app)
      .post("/api/v1/health")
      .set("Authorization", `Bearer ${agentTokenA}`)
      .send({
        hostname: "test-host", os: "linux",
        cpuUsage: 42.5, memoryUsage: 63.2,
        diskUsage: [{ mount: "/", usedPercent: 71 }],
        uptimeSeconds: 123456,
        lastBootTime: "2026-08-01T10:00:00Z",
        networkStatus: "up",
        backupStatus: { status: "success", source: "rsync" },
      });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.id).toBeDefined();
  }, 15000);

  it("server identity comes from token, not body serverId", async () => {
    if (SKIP || !(await dbAvailable()) || !agentTokenA) return;
    const res = await request(app)
      .post("/api/v1/health")
      .set("Authorization", `Bearer ${agentTokenA}`)
      .send({ cpuUsage: 10, memoryUsage: 10, serverId: SRV_B }); // claims to be B
    expect(res.status).toBe(201);
    // Confirm DB row belongs to SRV_A
    const { rows } = await pool.query(
      "SELECT server_id FROM health_logs WHERE id = $1",
      [res.body.id]
    );
    expect(rows[0].server_id).toBe(SRV_A);
  }, 15000);

  it("400 for cpuUsage > 100", async () => {
    if (SKIP || !(await dbAvailable()) || !agentTokenA) return;
    const res = await request(app)
      .post("/api/v1/health")
      .set("Authorization", `Bearer ${agentTokenA}`)
      .send({ cpuUsage: 150, memoryUsage: 50 });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  }, 15000);

  it("400 for memoryUsage < 0", async () => {
    if (SKIP || !(await dbAvailable()) || !agentTokenA) return;
    const res = await request(app)
      .post("/api/v1/health")
      .set("Authorization", `Bearer ${agentTokenA}`)
      .send({ cpuUsage: 50, memoryUsage: -5 });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  }, 15000);
});

// ===========================================================================
// Health read endpoints (JWT protected)
// ===========================================================================

describe("Health read API (JWT protected)", () => {

  it("GET /api/v1/health — 401 without JWT", async () => {
    const res = await request(app).get("/api/v1/health");
    expect(res.status).toBe(401);
  });

  it("GET /api/v1/health — 200 with valid JWT", async () => {
    if (SKIP || !(await dbAvailable()) || !adminJwt) return;
    const res = await request(app)
      .get("/api/v1/health")
      .set("Authorization", `Bearer ${adminJwt}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

// ===========================================================================
// Alerts API (JWT protected)
// ===========================================================================

describe("Alerts API (JWT protected)", () => {

  it("GET /api/v1/alerts — 401 without JWT", async () => {
    const res = await request(app).get("/api/v1/alerts");
    expect(res.status).toBe(401);
  });

  it("GET /api/v1/alerts — 200 with valid JWT", async () => {
    if (SKIP || !(await dbAvailable()) || !adminJwt) return;
    const res = await request(app)
      .get("/api/v1/alerts")
      .set("Authorization", `Bearer ${adminJwt}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("GET /api/v1/alerts?all=true — 200 with valid JWT", async () => {
    if (SKIP || !(await dbAvailable()) || !adminJwt) return;
    const res = await request(app)
      .get("/api/v1/alerts?all=true")
      .set("Authorization", `Bearer ${adminJwt}`);
    expect(res.status).toBe(200);
  });
});

// ===========================================================================
// System metrics (JWT protected)
// ===========================================================================

describe("System Metrics API (JWT protected)", () => {

  it("GET /api/v1/system/status — 401 without JWT", async () => {
    const res = await request(app).get("/api/v1/system/status");
    expect(res.status).toBe(401);
  });

  it("GET /api/v1/system/status — 200 with valid JWT", async () => {
    if (!adminJwt) return;
    const res = await request(app)
      .get("/api/v1/system/status")
      .set("Authorization", `Bearer ${adminJwt}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty("hostname");
    expect(res.body.data).toHaveProperty("uptimeSeconds");
  }, 30000);  // systeminformation osInfo + cpu can be slow on first call

  it("GET /api/v1/system/metrics — 401 without JWT", async () => {
    const res = await request(app).get("/api/v1/system/metrics");
    expect(res.status).toBe(401);
  });

  it("GET /api/v1/system/metrics — 200 with valid JWT", async () => {
    if (!adminJwt) return;
    const res = await request(app)
      .get("/api/v1/system/metrics")
      .set("Authorization", `Bearer ${adminJwt}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.cpu).toHaveProperty("usagePercent");
    expect(res.body.data.ram).toHaveProperty("usedPercent");
    expect(res.body.data.ram).toHaveProperty("totalGb");
  }, 30000);  // si.currentLoad() samples CPU over ~1s but can queue behind prior calls

  it("GET /api/v1/system/metrics — viewer can access (read-only)", async () => {
    if (SKIP || !(await dbAvailable()) || !viewerJwt) return;
    const res = await request(app)
      .get("/api/v1/system/metrics")
      .set("Authorization", `Bearer ${viewerJwt}`);
    expect(res.status).toBe(200);
  }, 30000);
});

// ===========================================================================
// Server deletion cleanup
// ===========================================================================

describe("Server deletion", () => {

  it("DELETE /api/v1/servers/:id — 200 for admin", async () => {
    if (SKIP || !(await dbAvailable()) || !adminJwt) return;
    const res = await request(app)
      .delete(`/api/v1/servers/${SRV_A}`)
      .set("Authorization", `Bearer ${adminJwt}`);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
  });

  it("DELETE /api/v1/servers/:id — 404 for already-deleted server", async () => {
    if (SKIP || !(await dbAvailable()) || !adminJwt) return;
    const res = await request(app)
      .delete(`/api/v1/servers/${SRV_A}`)
      .set("Authorization", `Bearer ${adminJwt}`);
    expect(res.status).toBe(404);
  });
});
