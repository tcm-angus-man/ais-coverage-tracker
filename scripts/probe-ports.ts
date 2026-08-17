/* eslint-disable no-console */
import { Pool } from "pg";
function getEnv(k: string): string { const v = process.env[k]; if (!v) throw new Error(`${k} env var not set`); return v; }
async function main() {
  const url = getEnv("DATABASE_URL");
  const isLocal = url.includes("localhost") || url.includes("127.0.0.1");
  const pool = new Pool({ connectionString: url, max: 1, ssl: isLocal ? false : { rejectUnauthorized: false } });
  try {
    const q = await pool.query<{ table_name: string; column_name: string; data_type: string }>(`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (column_name ILIKE '%port%' OR table_name ILIKE '%port%')
      ORDER BY table_name, ordinal_position
    `);
    for (const r of q.rows) console.log(`${r.table_name}.${r.column_name}  (${r.data_type})`);
    console.log("---- voyages columns ----");
    const v = await pool.query<{ column_name: string; data_type: string }>(`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema='public' AND table_name='voyages' ORDER BY ordinal_position
    `);
    for (const r of v.rows) console.log(`  ${r.column_name}  (${r.data_type})`);
  } finally { await pool.end().catch(() => undefined); }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
