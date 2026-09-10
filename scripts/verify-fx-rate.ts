/**
 * Run: npm run test:fx-rate
 *
 * Frankfurter (ECB) USD/JPY. FX protection is applied in the JPY sales price
 * (purchase × 1.03 × marketplace); advisor USD labels convert at the raw rate only.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  convertJpyToUsdWithBuffer,
  DEFAULT_FX_PROTECTION_PCT,
  formatUsdAmount,
  parseFrankfurterUsdJpy,
  roundUsd,
} from "../lib/fx-rate.ts";
import { computePagodaSalesBreakdown } from "../lib/pagoda-sales-calculator.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;

function assert(name: string, cond: boolean) {
  if (!cond) {
    console.error(`  ✗ ${name}`);
    failed += 1;
  } else {
    console.log(`  ✓ ${name}`);
  }
}

function assertEqual(name: string, actual: unknown, expected: unknown) {
  if (actual !== expected) {
    console.error(`    expected ${String(expected)}, got ${String(actual)}`);
  }
  assert(name, actual === expected);
}

function read(relPath: string): string {
  return readFileSync(join(repoRoot, relPath), "utf8");
}

console.log("\n=== Frankfurter parse ===\n");

const sample = parseFrankfurterUsdJpy({
  amount: 1,
  base: "USD",
  date: "2026-09-01",
  rates: { JPY: 150 },
});
assert("parses Frankfurter USD/JPY body", sample != null);
assertEqual("jpy per usd", sample?.jpyPerUsd, 150);
assertEqual("rate date", sample?.rateDate, "2026-09-01");

console.log("\n=== John sales → USD (no double FX) ===\n");

const john = computePagodaSalesBreakdown({
  purchaseJpy: 50_000,
  marketplacePct: 25,
  agentCommissionPct: 15,
  fxProtectionPct: 3,
  jpyPerUsd: 160,
});
assertEqual("sales JPY", john.salesJpy, 64_375);
assertEqual("USD sales", john.salesUsd, 402.34);
assertEqual("advisor USD", john.advisorCommissionUsd, 60.35);
assertEqual("Pagoda keeps USD", john.pagodaKeepsUsd, 341.99);

// Sales JPY already includes FX — convert with buffer 0.
const fromSales = convertJpyToUsdWithBuffer(64_375, 160, 0);
assertEqual("raw convert of sales JPY", fromSales.usdFinal, 402.34);

// Buffer still available for raw purchase amounts that have not been sales-priced.
const rawWithBuffer = convertJpyToUsdWithBuffer(100_000, 150, 3);
assertEqual("optional buffer on raw JPY", rawWithBuffer.usdFinal, 686.67);
assertEqual("usd base before buffer", roundUsd(rawWithBuffer.usdBase), 666.67);

console.log("\n=== display formatting ===\n");

assertEqual("usd format", formatUsdAmount(402.34), "402.34");
assertEqual("default FX protection", DEFAULT_FX_PROTECTION_PCT, 3);

const fxHook = read("hooks/use-fx-usd-jpy.ts");
assert(
  "USD labels omit approximate ~ prefix (looks like minus)",
  fxHook.includes('label: `US$${formatUsdAmount(usd.usdFinal)}`') &&
    !fxHook.includes("~US$")
);
assert(
  "advisor USD conversion uses buffer 0 (FX already in JPY sales)",
  /convertJpyToUsdWithBufferFromQuote\(Number\(jpy\), fx\.quote, 0\)/.test(fxHook)
);

console.log("\n=== wiring ===\n");

const fxRoute = read("app/api/fx/usd-jpy/route.ts");
assert("advisor fx route uses Frankfurter helper", fxRoute.includes("fetchFrankfurterUsdJpyQuote"));
assert("advisor fx route uses generic hint", fxRoute.includes("fxRateAdvisorHint"));

const adminRoute = read("app/api/admin/fx-settings/route.ts");
assert("admin can read fx settings", adminRoute.includes("getFxProtectionPct"));
assert("admin can save fx settings", adminRoute.includes("setFxProtectionPct"));

assert(
  "itinerary row shows jpy + usd label",
  read("components/itineraries/activity-list-item.tsx").includes("JpyUsdPriceLabel")
);
assert(
  "tour library cards show usd for agents",
  read("components/tour_library/tour-card.tsx").includes("JpyUsdPriceLabel")
);
assert(
  "pdf shows usd prices",
  read("components/pdf/PdfContent.tsx").includes("formatJpyUsdPriceLine")
);
assert(
  "select-from-library modal shows usd prices",
  read("components/itineraries/tour-modal.tsx").includes("JpyUsdPriceLabel")
);
assert(
  "markup calculator shows usd prices",
  read("components/itineraries/advisor-markup-panel.tsx").includes("JpyUsdPriceLabel")
);

const migration = read("migrations/20260902_fx_protection_pct.sql");
assert("migration seeds fx_protection_pct", migration.includes("'fx_protection_pct'"));

console.log(failed === 0 ? "\nAll checks passed\n" : `\n${failed} check(s) failed\n`);
process.exit(failed === 0 ? 0 : 1);
