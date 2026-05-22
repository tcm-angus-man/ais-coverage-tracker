/**
 * Bulk assignment script — appends one row per (ship × month) to the
 * Google Sheets assignments tab, skipping ship-days with no silver data.
 *
 * Usage:
 *   node scripts/bulk-assign.mjs           # live write
 *   DRY_RUN=1 node scripts/bulk-assign.mjs # print stats only, no write
 *
 * Reads credentials + blob URL from .env.local automatically.
 * The script fetches the latest snapshot from Vercel Blob to know which
 * ship-days have silver data (t > 0). Only months where the ship has at
 * least one day with data get an assignment row.
 */

import { readFileSync } from "fs";
import { createRequire } from "module";
import { randomUUID } from "crypto";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createBrotliDecompress } from "zlib";
const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// ── Load .env.local ──────────────────────────────────────────────────────────
function loadEnv(path) {
  try {
    const lines = readFileSync(path, "utf8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    // no .env.local — rely on already-set env vars
  }
}
loadEnv(resolve(__dirname, "../.env.local"));

// ── Ship list (assignee → mmsi) ──────────────────────────────────────────────
const SHIPS = [
  ["ai-ai", 308516000],
  ["kim",   310627000],
  ["nick",  309374000],
  ["nick",  308457000],
  ["kim",   310610000],
  ["kim",   311042900],
  ["nick",  311478000],
  ["ai-ai", 371083000],
  ["ai-ai", 310562000],
  ["ai-ai", 311493000],
  ["kim",   311020600],
  ["nick",  311263000],
  ["nick",  309906000],
  ["kim",   311317000],
  ["ai-ai", 311020700],
  ["ai-ai", 354298000],
  ["kim",   311316000],
  ["nick",  355263000],
  ["nick",  311018500],
  ["kim",   308017000],
  ["ai-ai", 311733000],
  ["nick",  357659000],
  ["kim",   310423000],
  ["ai-ai", 371154000],
  ["ai-ai", 309436000],
  ["kim",   357657000],
  ["nick",  308045000],
  ["nick",  355831000],
  ["kim",   310500000],
  ["ai-ai", 311378000],
  ["ai-ai", 311319000],
  ["kim",   247353700],
  ["nick",  311109000],
  ["ai-ai", 355833000],
  ["kim",   354277000],
  ["nick",  373178000],
  ["nick",  249409000],
  ["kim",   370490000],
  ["ai-ai", 310624000],
  ["ai-ai", 310327000],
  ["kim",   370491000],
  ["nick",  311805000],
  ["nick",  249666000],
  ["kim",   354842000],
  ["ai-ai", 249055000],
  ["ai-ai", 372808000],
  ["ai-ai", 311058700],
  ["nick",  310531000],
  ["kim",   248939000],
  ["kim",   308865000],
  ["nick",  310459000],
  ["nick",  249047000],
  ["kim",   308416000],
  ["ai-ai", 357698000],
  ["ai-ai", 310556000],
  ["kim",   311307000],
  ["nick",  311082000],
  ["kim",   311583000],
  ["nick",  311492000],
  ["ai-ai", 249054000],
  ["nick",  357627000],
  ["kim",   311361000],
  ["ai-ai", 311827000],
  ["ai-ai", 371861000],
  ["kim",   310473000],
  ["nick",  249046000],
  ["nick",  311746000],
  ["kim",   309653000],
  ["ai-ai", 311000274],
  ["ai-ai", 372497000],
  ["kim",   311001095],
  ["nick",  249639000],
  ["ai-ai", 249667000],
  ["nick",  357281000],
  ["kim",   310567000],
  ["nick",  310661000],
  ["kim",   352594000],
  ["ai-ai", 310674000],
  ["ai-ai", 354215000],
  ["kim",   310625000],
  ["nick",  249048000],
  ["nick",  247258100],
  ["kim",   355931000],
  ["kim",   229074000],
  ["nick",  311001094],
  ["ai-ai", 247313500],
  ["ai-ai", 311050800],
  ["ai-ai", 246648000],
  ["kim",   311315000],
  ["nick",  309951000],
  ["nick",  248513000],
  ["kim",   310384000],
  ["ai-ai", 311321000],
  ["ai-ai", 310376000],
  ["kim",   370648000],
  ["kim",   248392000],
  ["nick",  245417000],
  ["kim",   311050900],
  ["ai-ai", 310858000],
  ["nick",  215610000],
  ["kim",   352003000],
  ["ai-ai", 311000267],
  ["kim",   215325000],
  ["nick",  244128000],
  ["nick",  246028000],
  ["kim",   245206000],
  ["ai-ai", 247391900],
  ["ai-ai", 356716000],
  ["kim",   249053000],
  ["kim",   247311100],
  ["nick",  366994450],
  ["ai-ai", 311000397],
  ["nick",  248717000],
  ["nick",  310529000],
  ["kim",   311000396],
  ["ai-ai", 245304000],
  ["ai-ai", 310780000],
  ["kim",   256070000],
  ["nick",  356883000],
  ["nick",  356042000],
  ["kim",   247094800],
  ["ai-ai", 310857000],
  ["ai-ai", 215920000],
  ["kim",   247431200],
  ["ai-ai", 249973000],
  ["nick",  245968000],
  ["kim",   311000341],
  ["nick",  311000660],
  ["nick",  246442000],
  ["kim",   247282900],
  ["ai-ai", 311000710],
  ["ai-ai", 310856000],
  ["kim",   248325000],
  ["nick",  311001049],
  ["nick",  310866000],
  ["kim",   370039000],
  ["nick",  244830547],
  ["ai-ai", 311001223],
  ["kim",   244140580],
  ["ai-ai", 310867000],
  ["ai-ai", 311000807],
  ["kim",   310791000],
  ["nick",  311000599],
  ["nick",  215105000],
  ["kim",   256281000],
  ["ai-ai", 374527000],
  ["ai-ai", 259330000],
  ["kim",   311001059],
  ["nick",  311001098],
  ["nick",  248992000],
  ["ai-ai", 309163000],
  ["nick",  258465000],
  ["kim",   259371000],
  ["kim",   309416000],
  ["ai-ai", 311000464],
  ["ai-ai", 245464000],
  ["kim",   311000912],
  ["nick",  215808000],
  ["nick",  311085000],
  ["kim",   308785000],
  ["ai-ai", 310812000],
  ["kim",   311000879],
  ["nick",  311001033],
  ["ai-ai", 311083000],
  ["ai-ai", 310841000],
  ["kim",   257200000],
  ["nick",  311000983],
  ["nick",  309056000],
  ["kim",   311001253],
  ["ai-ai", 247353800],
  ["ai-ai", 258500000],
  ["kim",   311022500],
  ["nick",  310835000],
  ["nick",  311001056],
  ["kim",   310865000],
  ["ai-ai", 311027100],
  ["ai-ai", 259186000],
  ["nick",  311622000],
  ["kim",   311513000],
  ["ai-ai", 311001259],
  ["kim",   311084000],
  ["nick",  256059000],
  ["nick",  247389200],
  ["kim",   210563000],
  ["ai-ai", 308628000],
  ["ai-ai", 247282500],
  ["kim",   258595000],
  ["kim",   538003668],
  ["nick",  311038900],
  ["ai-ai", 311000585],
  ["nick",  311000515],
  ["nick",  311001201],
  ["kim",   247385300],
  ["ai-ai", 229090000],
  ["ai-ai", 311001127],
  ["kim",   538004353],
  ["nick",  311001390],
  ["nick",  308322000],
  ["kim",   247255400],
  ["ai-ai", 311001063],
  ["ai-ai", 249051000],
  ["kim",   247187700],
  ["ai-ai", 352003546],
  ["nick",  538006712],
  ["kim",   311050600],
  ["nick",  249660000],
  ["nick",  247435300],
  ["kim",   257903000],
  ["ai-ai", 311001141],
  ["nick",  229678000],
  ["ai-ai", 258215000],
  ["kim",   311001109],
  ["nick",  256235000],
  ["kim",   247229700],
  ["nick",  308814000],
  ["ai-ai", 256191000],
  ["nick",  257034130],
  ["kim",   247322800],
  ["ai-ai", 247302900],
  ["ai-ai", 247312900],
  ["kim",   311000637],
  ["nick",  311000987],
  ["nick",  247187600],
  ["kim",   311541000],
  ["ai-ai", 311536000],
  ["ai-ai", 310811000],
  ["kim",   248956000],
  ["nick",  311000986],
  ["ai-ai", 257425000],
  ["nick",  735059945],
  ["kim",   257552000],
  ["nick",  257058920],
  ["kim",   258932000],
  ["ai-ai", 309168000],
  ["ai-ai", 311001178],
  ["nick",  256389000],
  ["kim",   538001664],
  ["nick",  215813000],
  ["nick",  309242000],
  ["kim",   311000719],
  ["nick",  232021171],
  ["ai-ai", 311000969],
  ["kim",   311001044],
  ["ai-ai", 538001665],
  ["ai-ai", 232026551],
  ["kim",   538007673],
  ["nick",  257800000],
  ["nick",  538001663],
  ["kim",   311000319],
  ["ai-ai", 259070000],
  ["ai-ai", 311000930],
  ["kim",   311001221],
  ["kim",   538006842],
  ["nick",  309027000],
  ["ai-ai", 311001559],
  ["kim",   578000500],
  ["kim",   538009952],
  ["kim",   311001053],
  ["ai-ai", 256798000],
  ["ai-ai", 308908000],
  ["kim",   308311000],
  ["nick",  257088070],
  ["nick",  257850000],
  ["kim",   259144000],
  ["ai-ai", 311001189],
  ["kim",   249193000],
  ["nick",  258024000],
  ["ai-ai", 735023483],
  ["ai-ai", 311001081],
  ["kim",   249129000],
  ["kim",   256750000],
  ["nick",  310869000],
  ["kim",   311000995],
  ["ai-ai", 311001595],
  ["ai-ai", 538012044],
  ["kim",   578001600],
  ["nick",  229378000],
  ["ai-ai", 311000165],
  ["kim",   311000932],
  ["ai-ai", 538012045],
  ["ai-ai", 538010706],
  ["nick",  311001596],
  ["ai-ai", 215001000],
  ["kim",   259222000],
  ["kim",   311001551],
  ["ai-ai", 255806207],
  ["ai-ai", 255806210],
  ["nick",  311001496],
  ["nick",  311001167],
  ["kim",   735059355],
  ["ai-ai", 310805000],
  ["kim",   255806150],
  ["nick",  257182000],
  ["ai-ai", 259322000],
  ["ai-ai", 215767000],
  ["kim",   311001540],
  ["nick",  257526000],
  ["nick",  311000934],
  ["kim",   259210000],
  ["ai-ai", 538012043],
  ["ai-ai", 230184000],
  ["kim",   255806445],
  ["nick",  538009302],
  ["nick",  265004000],
  ["kim",   311000608],
  ["ai-ai", 352001180],
  ["ai-ai", 538012042],
  ["nick",  259139000],
  ["kim",   311001633],
  ["ai-ai", 276779000],
  ["kim",   215766000],
  ["nick",  256343000],
  ["nick",  309336000],
  ["kim",   311001061],
  ["ai-ai", 735059655],
  ["ai-ai", 735060058],
  ["kim",   230361000],
  ["kim",   255806401],
  ["nick",  266314000],
  ["ai-ai", 248785000],
  ["nick",  248786000],
  ["nick",  257752000],
  ["kim",   257944000],
  ["ai-ai", 258094000],
  ["ai-ai", 311562000],
  ["kim",   578000800],
  ["nick",  232649000],
  ["kim",   257753000],
  ["kim",   311001261],
  ["ai-ai", 230041000],
  ["ai-ai", 578000200],
  ["kim",   578001700],
  ["kim",   257088000],
  ["nick",  578000700],
  ["kim",   311000410],
  ["nick",  311000840],
  ["nick",  230713000],
  ["kim",   249457000],
  ["nick",  414515000],
  ["nick",  230639000],
  ["ai-ai", 538011254],
  ["ai-ai", 735060256],
  ["kim",   215768000],
  ["kim",   230629000],
  ["nick",  311000929],
  ["ai-ai", 311001086],
  ["nick",  431302000],
  ["nick",  636013956],
  ["kim",   311000893],
  ["ai-ai", 578000900],
  ["ai-ai", 276519000],
  ["kim",   311603000],
  ["nick",  255806396],
  ["nick",  259490000],
  ["kim",   311000867],
  ["ai-ai", 520184000],
  ["ai-ai", 578001100],
  ["kim",   215973000],
  ["ai-ai", 231200000],
  ["nick",  311743000],
  ["kim",   369358000],
  ["nick",  255915656],
  ["nick",  366945000],
  ["kim",   311050400],
  ["ai-ai", 578001500],
  ["ai-ai", 309908000],
  ["kim",   578001300],
  ["nick",  258478000],
  ["nick",  311001781],
  ["kim",   578001200],
  ["nick",  578001400],
  ["ai-ai", 636093228],
  ["kim",   255806393],
  ["ai-ai", 276829000],
  ["ai-ai", 255806397],
  ["kim",   244327000],
  ["nick",  255806193],
  ["nick",  276807000],
  ["kim",   276859000],
  ["ai-ai", 308445000],
  ["ai-ai", 256436000],
  ["kim",   311000160],
  ["nick",  311001666],
  ["nick",  366339000],
  ["ai-ai", 205788000],
  ["nick",  248953000],
  ["kim",   255806402],
  ["kim",   311000253],
  ["ai-ai", 367578110],
  ["ai-ai", 311050300],
  ["kim",   367480140],
  ["nick",  725017800],
  ["nick",  311001759],
  ["nick",  205481000],
  ["nick",  215855000],
  ["kim",   227194000],
  ["nick",  432545000],
  ["ai-ai", 546018800],
  ["kim",   258477000],
  ["ai-ai", 338423000],
  ["ai-ai", 370610000],
  ["kim",   725001586],
  ["nick",  255717000],
  ["nick",  357189000],
  ["kim",   244180151],
  ["ai-ai", 246573000],
  ["ai-ai", 311000728],
  ["kim",   311000951],
  ["nick",  538003543],
  ["nick",  735057940],
  ["ai-ai", 249161000],
  ["nick",  311213000],
  ["kim",   341500000],
  ["kim",   503000164],
  ["ai-ai", 636093187],
  ["ai-ai", 671188100],
  ["kim",   735058659],
  ["nick",  249069000],
  ["nick",  255806208],
  ["kim",   310871000],
  ["ai-ai", 249556000],
  ["kim",   309051000],
  ["nick",  366396000],
  ["ai-ai", 503000129],
  ["ai-ai", 503492000],
  ["kim",   725001100],
  ["nick",  235000295],
  ["nick",  239299000],
  ["kim",   367144000],
  ["ai-ai", 255806394],
  ["ai-ai", 511100759],
  ["kim",   238021000],
  ["nick",  249010000],
  ["nick",  256084000],
  ["kim",   258092000],
  ["ai-ai", 265509140],
  ["ai-ai", 273457210],
  ["nick",  325314700],
  ["kim",   735057603],
  ["ai-ai", 311001656],
  ["kim",   357521000],
  ["nick",  367583000],
  ["nick",  210189000],
  ["nick",  249596000],
  ["nick",  366892350],
  ["kim",   735059039],
  ["ai-ai", 227186000],
  ["kim",   244091000],
  ["nick",  246198000],
  ["ai-ai", 319104800],
  ["ai-ai", 367478830],
  ["kim",   367645050],
  ["nick",  735057612],
  ["nick",  239780000],
  ["kim",   636093399],
  ["ai-ai", 273458210],
  ["ai-ai", 316023823],
  ["kim",   338891000],
  ["nick",  341776000],
  ["nick",  369024000],
  ["kim",   431547000],
  ["ai-ai", 525600798],
  ["ai-ai", 576988000],
  ["nick",  235034073],
  ["kim",   256424000],
  ["ai-ai", 341799000],
  ["kim",   538008158],
  ["nick",  735058068],
  ["nick",  735059295],
  ["kim",   735059899],
  ["ai-ai", 735060209],
  ["ai-ai", 228092600],
  ["kim",   238715240],
  ["kim",   341200000],
  ["nick",  725002200],
  ["ai-ai", 735058239],
  ["nick",  735059018],
  ["nick",  735059381],
  ["kim",   240937000],
  ["ai-ai", 304977000],
  ["ai-ai", 310801000],
  ["kim",   352005711],
  ["nick",  374274000],
  ["nick",  503145080],
  ["nick",  503486000],
  ["ai-ai", 636022869],
  ["ai-ai", 228483700],
  ["kim",   231763000],
  ["ai-ai", 258150000],
  ["nick",  266155000],
  ["nick",  352005196],
  ["nick",  354993000],
  ["ai-ai", 518100276],
  ["ai-ai", 636020325],
  ["ai-ai", 735060293],
  ["nick",  235061885],
  ["kim",   256667000],
];

// ── Month ranges (oldest → newest) ──────────────────────────────────────────
const MONTH_RANGES = [
  ["2025-07-01", "2025-07-31"],
  ["2025-08-01", "2025-08-31"],
  ["2025-09-01", "2025-09-30"],
  ["2025-10-01", "2025-10-31"],
  ["2025-11-01", "2025-11-30"],
  ["2025-12-01", "2025-12-31"],
  ["2026-01-01", "2026-01-31"],
  ["2026-02-01", "2026-02-28"],
  ["2026-03-01", "2026-03-31"],
  ["2026-04-01", "2026-04-30"],
  ["2026-05-01", "2026-05-10"],
];

// ── Fetch snapshot from Vercel Blob (private, brotli-compressed) ─────────────
async function fetchSnapshot() {
  const { get } = require("@vercel/blob");
  const BLOB_KEY = "coverage-latest.json.br";
  console.log("Fetching snapshot from Vercel Blob:", BLOB_KEY);
  const result = await get(BLOB_KEY, { access: "private" });
  if (!result) throw new Error("Blob not found — run the snapshot cron first.");
  const raw = Buffer.from(await new Response(result.stream).arrayBuffer());
  // Decompress brotli
  const chunks = [];
  await new Promise((resolve, reject) => {
    const br = createBrotliDecompress();
    br.on("data", c => chunks.push(c));
    br.on("end", resolve);
    br.on("error", reject);
    br.end(raw);
  });
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

// ── Google Sheets client ─────────────────────────────────────────────────────
function getSheets() {
  const { google } = require("googleapis");
  const email      = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
  const id         = process.env.GOOGLE_SHEETS_ID;
  if (!email || !privateKey || !id) {
    throw new Error(
      "Missing env vars: GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY, GOOGLE_SHEETS_ID"
    );
  }
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: email,
      private_key: privateKey.replace(/\\n/g, "\n").replace(/^"|"$/g, ""),
    },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return { sheets: google.sheets({ version: "v4", auth }), id };
}

// ── Main ─────────────────────────────────────────────────────────────────────
const DRY_RUN = process.env.DRY_RUN === "1";

console.log("Loading snapshot to check which ship-days have silver data…");
const snapshot = await fetchSnapshot();
const silverCells = snapshot.silver_cells ?? {};

// Build mmsi → { ship_name, cruise_line } lookup from snapshot ships array
const shipMeta = new Map();
for (const s of snapshot.ships ?? []) {
  shipMeta.set(s.mmsi, { ship_name: s.display_name || s.name || "", cruise_line: s.cruise_line || "" });
}

// Build set of dates that fall within each month range
function datesInRange(dateStart, dateEnd) {
  const dates = [];
  // Use UTC arithmetic to avoid DST shifts (same fix as CoverageGrid.tsx)
  const start = new Date(dateStart + "T00:00:00Z");
  const end   = new Date(dateEnd   + "T00:00:00Z");
  for (const d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

const now = new Date().toISOString();
const rows = [];
let skippedNoData = 0;
let skippedNoDataShips = new Set();

for (const [dateStart, dateEnd] of MONTH_RANGES) {
  const datesInMonth = datesInRange(dateStart, dateEnd);

  for (const [assignee, mmsi] of SHIPS) {
    const shipSilver = silverCells[String(mmsi)] ?? {};

    // Check if the ship has any silver data (t > 0) in this month
    const hasData = datesInMonth.some(d => {
      const cell = shipSilver[d];
      return cell && cell.t > 0;
    });

    if (!hasData) {
      skippedNoData++;
      skippedNoDataShips.add(mmsi);
      continue;
    }

    const meta = shipMeta.get(mmsi) ?? { ship_name: String(mmsi), cruise_line: "" };
    rows.push([
      randomUUID(),        // assignment_id
      now,                 // created_at
      "angus",             // created_by
      String(mmsi),        // ship_mmsi
      meta.ship_name,      // ship_name
      meta.cruise_line,    // cruise_line
      dateStart,           // date_start
      dateEnd,             // date_end
      assignee,            // assignee
      "queued",            // status
      "",                  // notes
      now,                 // updated_at
      "angus",             // updated_by
    ]);
  }
}

console.log(`\nSummary:`);
console.log(`  Total possible assignments: ${SHIPS.length * MONTH_RANGES.length}`);
console.log(`  Skipped (no silver data):   ${skippedNoData} (across ${skippedNoDataShips.size} ships)`);
console.log(`  Rows to write:              ${rows.length}`);

if (DRY_RUN) {
  console.log("\nDRY RUN — no rows written.");
  console.log("First row:", rows[0]);
  console.log("Last row:",  rows[rows.length - 1]);
  process.exit(0);
}

console.log("\nAppending rows to Google Sheets…");
const { sheets, id } = getSheets();

const BATCH = 500;
let written = 0;
for (let i = 0; i < rows.length; i += BATCH) {
  const batch = rows.slice(i, i + BATCH);
  await sheets.spreadsheets.values.append({
    spreadsheetId: id,
    range: "assignments!A1",
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: batch },
  });
  written += batch.length;
  process.stdout.write(`  ${written} / ${rows.length}\r`);
}

console.log(`\nDone. ${rows.length} rows appended.`);
