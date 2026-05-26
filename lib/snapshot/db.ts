import { Pool } from "pg";

// Single pool per Node process. The cron is a one-shot hourly handler, so
// keepalives don't matter much, but this avoids reconnect cost during local
// dev when the script runs repeatedly.
let pool: Pool | null = null;

export function getPool(): Pool {
  if (pool) return pool;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set");
  }
  const isLocal = url.includes("localhost") || url.includes("127.0.0.1");
  pool = new Pool({
    connectionString: url,
    max: 4,
    idleTimeoutMillis: 10_000,
    // Cron route's maxDuration is 300s. The voyage_cells query fans out
    // every voyage across every active day via LATERAL generate_series, so
    // a 10-year window across 700+ ships needs more than 60s headroom.
    statement_timeout: 280_000,
    ssl: isLocal ? false : { rejectUnauthorized: false },
  });
  return pool;
}

export async function endPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
