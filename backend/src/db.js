import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const { Pool } = pg;

// Pool manages a set of reusable database connections for us
export const pool = new Pool({
  host: process.env.DB_HOST || "localhost",
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER || "monitor_user",
  password: process.env.DB_PASSWORD || "monitor_pass",
  database: process.env.DB_NAME || "server_monitor",
});

pool.on("error", (err) => {
  console.error("Unexpected Postgres error", err);
});
