/* eslint-disable no-console */
// Local dry-run of the Postgres → Blob pipeline. Reads DATABASE_URL and
// BLOB_READ_WRITE_TOKEN from the environment, runs the full build, and
// prints a one-line summary. Useful for verifying schema changes haven't
// broken the queries before the next hourly cron fires.
//
// Usage:  npm run snapshot:local
//
// Per .claude/rules/data-privacy.md the developer running this is reading
// the production DB themselves — Claude does not. Do not paste the output
// of this script back into chat.

import { buildSnapshot, endPool } from "@/lib/snapshot/build";

async function main() {
  const started = Date.now();
  const result = await buildSnapshot();
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `[snapshot:local] ok in ${elapsed}s — ` +
      `ships=${result.ships} ` +
      `voyage_rows=${result.voyage_cell_rows} ` +
      `silver_rows=${result.silver_cell_rows} ` +
      `bytes=${result.bytes_compressed} ` +
      `generated_at=${result.generated_at}`,
  );
}

main()
  .catch((err) => {
    console.error("[snapshot:local] failed", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await endPool().catch(() => undefined);
  });
