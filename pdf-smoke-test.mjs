import fs from "node:fs/promises";
import path from "node:path";
import pdf from "pdf-parse";

const isHttp = s => /^https?:\/\//i.test(s);

async function readPdfBuffer(input) {
  if (isHttp(input)) {
    const r = await fetch(input);
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${input}`);
    return Buffer.from(await r.arrayBuffer());
  }
  return fs.readFile(path.resolve(input));
}

function normText(t) {
  return String(t)
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\u2013|\u2014/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

// simple K:V pluck (handles "Key: Value" and "Key - Value")
function kvPairs(text) {
  const out = {};
  normText(text)
    .split(/(?<=\.)\s+|[\r\n]+/g)
    .map(s => s.trim())
    .filter(Boolean)
    .forEach(line => {
      const m = line.match(/^([^:–—-]{2,60})[:–—-]\s*(.{2,300})$/);
      if (m) {
        const key = m[1].toLowerCase().replace(/\s+/g, "_");
        out[key] = m[2].trim();
      }
    });
  return out;
}

// minimal synonym map for common specs
const KEYMAP = {
  weight_capacity: [/weight\s*capacity/i, /\bcapacity\b/i],
  product_weight: [/product\s*weight|unit\s*weight/i],
  shipping_weight: [/shipping\s*weight/i],
  dimensions: [/overall\s*dimensions\b|\bdimensions\b/i],
  seat_dimensions: [/seat\s*dimensions?|seat\s*(width|depth)/i],
  seat_opening: [/seat\s*opening/i],
  adjustable_seat_height: [/adjustable\s*seat\s*height|seat\s*height/i],
  top_speed: [/top\s*speed/i],
  turning_radius: [/turning\s*radius/i],
  batteries: /\bbatter(y|ies)\b/i,
  motor: /\bmotor\b/i,
  warranty: /\bwarranty\b/i,
  color: /\bcolor\b/i,
  controller: /\bcontroller\b/i,
  ground_clearance: /\bground\s*clearance\b/i,
};

function pickBySynonyms(pairs, rawText) {
  const hits = {};
  for (const [canon, syns] of Object.entries(KEYMAP)) {
    const candidates = Object.entries(pairs).filter(([k]) =>
      syns instanceof RegExp ? syns.test(k.replace(/_/g, " ")) :
      syns.some(rx => rx.test(k.replace(/_/g, " ")))
    );
    if (candidates.length) {
      // choose the longest value (often most complete)
      const best = candidates.sort((a,b)=> b[1].length - a[1].length)[0][1];
      hits[canon] = best;
      continue;
    }
    // fallback: raw text search to catch "Top Speed 4.25 mph" styles
    const rx = syns instanceof RegExp ? syns : syns[0];
    const m = normText(rawText).match(new RegExp(`(${rx.source})[:\\s-]+([^\\n]{2,80})`, 'i'));
    if (m) hits[canon] = m[2].trim();
  }
  return hits;
}

// Optional: expectations you can tweak per product
const EXPECT = {
  // Scooter example expectations (tune as needed)
  scooter: [
    [/weight\s*capacity.*300\s*lb/i, "Weight Capacity ~300 lb"],
    [/top\s*speed.*4\.25\s*mph/i, "Top Speed ~4.25 mph"],
    [/turning\s*radius.*45\.5/i, "Turning Radius ~45.5"],
  ],
  // Bariatric commode example
  commode: [
    [/weight\s*capacity.*650\s*lb/i, "Weight Capacity ~650 lb"],
    [/seat\s*dimensions?.*23["”]?\s*w?\s*x\s*18["”]?\s*d/i, "Seat Dimensions ~23\" x 18\""],
    [/seat\s*opening.*8\.25["”]?\s*w?\s*x\s*10["”]?\s*d/i, "Seat Opening ~8.25\" x 10\""],
  ],
};

async function main() {
  const input = process.argv[2];
  if (!input) {
    console.error("Usage: node pdf-smoke-test.mjs <PDF_URL_OR_PATH> [profile]");
    process.exit(1);
  }
  const profile = (process.argv[3] || "").toLowerCase(); // "scooter" or "commode" for quick asserts

  const buf = await readPdfBuffer(input);
  const data = await pdf(buf);
  const text = data.text || "";
  const pairs = kvPairs(text);
  const hits = pickBySynonyms(pairs, text);

  console.log("=== Extracted pairs ===");
  console.log(pairs);
  console.log("\n=== Normalized hits ===");
  console.log(hits);

  if (profile && EXPECT[profile]) {
    let pass = 0;
    let fail = 0;
    console.log(`\n=== Checks: ${profile} ===`);
    for (const [rx, label] of EXPECT[profile]) {
      if (rx.test(normText(text))) { console.log(`✓ ${label}`); pass++; }
      else { console.log(`✗ ${label}`); fail++; }
    }
    console.log(`Summary: ${pass} passed, ${fail} failed`);
    if (fail) process.exitCode = 2;
  }
}

main().catch(e => { console.error(e); process.exit(1); });
