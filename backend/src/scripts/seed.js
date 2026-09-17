/**
 * Database seed script — creates default user accounts.
 *
 * Run with:  npm run seed   (from the backend/ directory)
 *
 * Safe to re-run: uses INSERT ... ON CONFLICT DO NOTHING so existing
 * accounts are never overwritten.
 *
 * Default accounts created:
 *   admin@example.com  / Admin123!   role: admin
 *   viewer@example.com / Viewer123!  role: viewer
 *
 * IMPORTANT: Change these passwords immediately in any non-development
 * environment.  Never commit real credentials to source control.
 */

import bcrypt  from "bcryptjs";
import dotenv  from "dotenv";
import { pool } from "../db.js";

dotenv.config();

// ---------------------------------------------------------------------------
// Seed data — edit here if you need different defaults
// ---------------------------------------------------------------------------
const SEED_USERS = [
  {
    name:     "Default Admin",
    email:    "admin@example.com",
    password: "Admin123!",
    role:     "admin",
  },
  {
    name:     "Default Viewer",
    email:    "viewer@example.com",
    password: "Viewer123!",
    role:     "viewer",
  },
];

const BCRYPT_ROUNDS = 12;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function seed() {
  console.log("Seeding database users...\n");

  for (const u of SEED_USERS) {
    const hash = await bcrypt.hash(u.password, BCRYPT_ROUNDS);

    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO NOTHING
       RETURNING id, email, role`,
      [u.name, u.email, hash, u.role]
    );

    if (result.rows.length > 0) {
      // Print email and role — NEVER print the password
      console.log(`  [CREATED]  ${result.rows[0].email}  (role: ${result.rows[0].role})`);
    } else {
      console.log(`  [EXISTS]   ${u.email} — skipped (already in database)`);
    }
  }

  console.log("\nSeed complete.");
  console.log("REMINDER: Change default passwords before deploying to production.");
}

seed()
  .catch((err) => {
    console.error("\nSeed failed:", err.message);
    process.exit(1);
  })
  .finally(() => pool.end());
