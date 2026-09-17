import bcrypt from "bcryptjs";
import pg     from "pg";
import dotenv from "dotenv";
dotenv.config();

const pool = new pg.Pool({
  host:     process.env.DB_HOST     || "localhost",
  port:     Number(process.env.DB_PORT) || 5433,
  user:     process.env.DB_USER     || "monitor_user",
  password: process.env.DB_PASSWORD || "monitor_pass",
  database: process.env.DB_NAME     || "server_monitor",
});

const { rows } = await pool.query(
  "SELECT email, password_hash FROM users WHERE email = 'admin@example.com'"
);

if (!rows.length) {
  console.log("NO USER FOUND in DB");
  await pool.end();
  process.exit(1);
}

const { email, password_hash: hash } = rows[0];
console.log("Email       :", email);
console.log("Hash prefix :", hash.substring(0, 7));
console.log("Hash length :", hash.length);
console.log();

// Test exact password and common mistake variants
const candidates = [
  "Admin123!",
  " Admin123!",
  "Admin123! ",
  " Admin123! ",
  "admin123!",
  "Admin123",
];

for (const pw of candidates) {
  const ok = await bcrypt.compare(pw, hash);
  console.log(`compare("${pw}") => ${ok}`);
}

await pool.end();
