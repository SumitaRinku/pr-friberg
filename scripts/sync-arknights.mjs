import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const operators = require("../data/arknights-operators.js");
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SOURCE_URL = "https://prts.wiki/w/%E5%B9%B2%E5%91%98%E4%B8%80%E8%A7%88";
const OUTPUT_FILE = path.join(ROOT, "data", "arknights-prts-sync.json");

function decodeHtml(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .trim();
}

async function main() {
  const response = await fetch(SOURCE_URL, {
    headers:{
      "User-Agent":"Friberg-Arknights-Data-Audit/1.0 (+https://github.com/SumitaRinku/pr-friberg/arknights)"
    },
    signal:AbortSignal.timeout(30_000)
  });
  if (!response.ok) throw new Error("PRTS request failed: HTTP " + response.status);
  const html = await response.text();
  const anchorPattern = /<a\b[^>]*href="\/w\/[^"#?]+"[^>]*>([\s\S]*?)<\/a>/gi;
  const linkedNames = new Set();
  let match;
  while ((match = anchorPattern.exec(html))) {
    const label = decodeHtml(match[1]);
    if (label && label.length <= 30) linkedNames.add(label);
  }

  const coverage = operators.map(function (operator) {
    const chineseFound = html.includes(operator.name) || linkedNames.has(operator.name);
    const englishFound = html.toLowerCase().includes(operator.en.toLowerCase());
    return {id:operator.id,name:operator.name,en:operator.en,found:chineseFound || englishFound};
  });
  const missing = coverage.filter(function (entry) { return !entry.found; });
  const payload = {
    schemaVersion:1,
    source:SOURCE_URL,
    checkedAt:new Date().toISOString(),
    localOperatorCount:operators.length,
    matchedOperatorCount:coverage.length - missing.length,
    missing
  };
  await fs.writeFile(OUTPUT_FILE, JSON.stringify(payload, null, 2) + "\n", "utf8");
  console.log("[arknights] PRTS audit: " + payload.matchedOperatorCount + "/" + payload.localOperatorCount + " local operators found");
  if (missing.length) console.log("[arknights] Review missing records in " + path.relative(ROOT, OUTPUT_FILE));
}

main().catch(function (error) {
  console.error("[arknights] " + error.message);
  process.exitCode = 1;
});
