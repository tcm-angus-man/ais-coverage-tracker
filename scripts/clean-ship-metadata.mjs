// Reads data/ship_metadata_raw.csv, applies known corrections, writes
// data/ship_metadata.csv with dates normalised to YYYY-MM-DD.
// Intended as a one-shot — re-run when the source CSV is updated.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const inPath  = resolve(repoRoot, "data/ship_metadata_raw.csv");
const outPath = resolve(repoRoot, "data/ship_metadata.csv");

// IMO numbers to drop entirely (container ships, not cruise vessels).
const DROP_IMOS = new Set(["9285005", "9776212", "9432232"]);

// Patches keyed by IMO. Values overwrite the parsed row.
// Dates here are already in YYYY-MM-DD.
const PATCHES = {
  // COSTA CONCORDIA — capsized off Giglio 13 Jan 2012.
  "9320544": { service_end: "2012-01-13" },
  // COSTA ALLEGRA — withdrawn from service after Feb 2012 engine-room fire.
  "6916885": { service_end: "2012-03-01" },
};

// Tier classification by cruise_line (the value in column 2 of the CSV).
// Tier 1 = mainstream contemporary; Tier 2 = luxury + premium expedition;
// Tier 3 = smaller regional / mid-tier; everything else falls to Tier 4.
const TIER_BY_LINE = {
  // ---------- Tier 1: mainstream contemporary ----------
  "Carnival Cruise Line": 1,
  "Royal Caribbean": 1,
  "MSC Cruises": 1,
  "Norwegian Cruise Line": 1,
  "Celebrity Cruises": 1,
  "Princess Cruises": 1,
  "Costa Cruises": 1,
  "AIDA Cruises": 1,
  "Holland America": 1,
  "TUI Cruises": 1,
  "P&O UK (P&O Cruises)": 1,
  "Disney Cruise Line": 1,
  "Cunard": 1,
  "Virgin Voyages": 1,

  // ---------- Tier 2: luxury + premium expedition ----------
  "Silversea Cruises": 2,
  "Viking Ocean (Viking Cruises)": 2,
  "Viking Expeditions (Viking Cruises)": 2,
  "Seabourn Cruises": 2,
  "Hapag-Lloyd Cruises": 2,
  "Regent Seven Seas Cruises": 2,
  "Oceania Cruises": 2,
  "Hurtigruten": 2,
  "HX Expeditions": 2,
  "Ponant Cruises": 2,
  "Lindblad Expeditions": 2,
  "Crystal Cruises": 2,
  "Azamara Cruises": 2,
  "Saga Ocean Cruises (Saga Cruises)": 2,
  "MSC Explora Journeys": 2,
  "Ritz-Carlton Yacht Collection": 2,
  "Scenic Yacht Cruises (Scenic Cruises)": 2,
  "Fred Olsen Cruise Lines": 2,
  "Marella Cruises": 2,

  // ---------- Tier 3: smaller regional / mid-tier ----------
  "Phoenix Reisen": 3,
  "Tallink Silja Line": 3,
  "Brittany Ferries": 3,
  "DFDS Seaways": 3,
  "Color Line": 3,
  "Stena Line": 3,
  "Viking Line": 3,
  "Havila Voyages": 3,
  "Fjord Line": 3,
  "Star Clippers": 3,
  "Windstar Cruises": 3,
  "Sea Cloud Cruises": 3,
  "Ambassador Cruise Line": 3,
  "Cruise & Maritime Voyages": 3,
  "Pullmantur Cruises": 3,
  "Star Cruises": 3,
  "Dream Cruises": 3,
  "Noble Caledonia": 3,
  "Swan Hellenic Cruises": 3,
  "American Queen Voyages": 3,
  "Coral Expeditions Australia": 3,
  "Aurora Expeditions Australia": 3,
  "P&O Ferries": 3,
  "NorthLink Ferries": 3,
  "P&O Australia": 3,
  "NYK Cruises Japan": 3,
  "Hebridean Island Cruises": 3,
  "Tradewind Voyages UK (Star Clippers)": 3,
  "Aroya Cruises": 3,
  "Adora Cruises Carnival China": 3,
};

const VALID_TIERS = new Set([1, 2, 3, 4]);

// Parse DD/MM/YYYY or blank → YYYY-MM-DD or "".
function normaliseDate(raw) {
  const s = (raw || "").trim();
  if (!s) return "";
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) throw new Error(`unparseable date: ${JSON.stringify(s)}`);
  const [, d, mo, y] = m;
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

// Minimal CSV split that handles the trailing-empty-column case but does
// NOT handle quoted commas. Input has none — fine.
function splitRow(line) {
  return line.split(",");
}

const raw = readFileSync(inPath, "utf8").replace(/\r\n/g, "\n");
const lines = raw.split("\n").filter(l => l.length > 0);
const header = splitRow(lines[0]);
const expectHeader = ["ship_name","cruise_line","imo_number","ship_count","cruise_type","service_start","service_end"];
for (let i = 0; i < expectHeader.length; i++) {
  if (header[i] !== expectHeader[i]) {
    throw new Error(`header mismatch at col ${i}: got ${header[i]}, want ${expectHeader[i]}`);
  }
}

const outHeader = [...expectHeader, "tier"];
const out = [];
let dropped = 0;
let patched = 0;
const typeCounts = new Map();
const tierCounts = new Map();
const tier4Lines = new Map();
const dupCheck = new Set();
let dupes = 0;

for (let li = 1; li < lines.length; li++) {
  const cols = splitRow(lines[li]);
  if (cols.length !== 7) {
    throw new Error(`row ${li + 1} has ${cols.length} cols, want 7: ${lines[li]}`);
  }
  const [ship_name, cruise_line, imo_number, ship_count, cruise_type, service_start_raw, service_end_raw] = cols;
  const imo = imo_number.trim();

  if (DROP_IMOS.has(imo)) { dropped++; continue; }
  if (dupCheck.has(imo)) { dupes++; continue; }
  dupCheck.add(imo);

  let service_start = normaliseDate(service_start_raw);
  let service_end   = normaliseDate(service_end_raw);

  const patch = PATCHES[imo];
  if (patch) {
    if (patch.service_start !== undefined) service_start = patch.service_start;
    if (patch.service_end   !== undefined) service_end   = patch.service_end;
    patched++;
  }

  const tier = TIER_BY_LINE[cruise_line] ?? 4;
  if (!VALID_TIERS.has(tier)) throw new Error(`bad tier for ${cruise_line}: ${tier}`);

  typeCounts.set(cruise_type, (typeCounts.get(cruise_type) || 0) + 1);
  tierCounts.set(tier, (tierCounts.get(tier) || 0) + 1);
  if (tier === 4) tier4Lines.set(cruise_line, (tier4Lines.get(cruise_line) || 0) + 1);

  out.push([ship_name, cruise_line, imo, ship_count, cruise_type, service_start, service_end, String(tier)].join(","));
}

const outCsv = [outHeader.join(","), ...out].join("\n") + "\n";
writeFileSync(outPath, outCsv);

console.log(`input rows:   ${lines.length - 1}`);
console.log(`output rows:  ${out.length}`);
console.log(`dropped:      ${dropped} (container ships)`);
console.log(`patched:      ${patched}`);
console.log(`duplicates:   ${dupes}`);
console.log(``);
console.log(`tier breakdown:`);
for (const t of [1, 2, 3, 4]) console.log(`  Tier ${t}: ${tierCounts.get(t) || 0}`);
console.log(``);
console.log(`cruise_type breakdown:`);
const types = [...typeCounts.entries()].sort((a, b) => b[1] - a[1]);
for (const [t, n] of types) console.log(`  ${t.padEnd(20)} ${n}`);
console.log(``);
console.log(`Tier-4 default lines (${tier4Lines.size} distinct, ordered by ship count):`);
const t4 = [...tier4Lines.entries()].sort((a, b) => b[1] - a[1]);
for (const [line, n] of t4) console.log(`  ${String(n).padStart(3)}  ${line}`);
console.log(``);
console.log(`wrote ${outPath}`);
