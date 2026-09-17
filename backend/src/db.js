import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const { Pool } = pg;

// Pool manages a set of reusable database connections.
// In production (Render), DATABASE_URL is a single connection string.
// In development, individual DB_* variables are used (matches docker-compose).
export const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      // Render Postgres requires SSL in production
      ssl: { rejectUnauthorized: false },
    })
  : new Pool({
      host:     process.env.DB_HOST     || "localhost",
      port:     Number(process.env.DB_PORT) || 5432,
      user:     process.env.DB_USER     || "monitor_user",
      password: process.env.DB_PASSWORD || "monitor_pass",
      database: process.env.DB_NAME     || "server_monitor",
    });

pool.on("error", (err) => {
  // Log connection-level errors without exposing internals
  console.error("[DB] Unexpected pool error:", err.message);
});
