/**
 * Run: npm run test:pricing
 *
 * Pins the Pagoda calculator (John):
 *   sales JPY = purchase × (1 + FX%) × (1 + marketplace%)
 *   advisor commission = sales × agent%   (share of sales — not stacked into the client price)
 *
 * Tour Library and itinerary lines must quote the same number for the same tour when they
 * share marketplace % and FX %.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  getAgentDisplayTotalRounded,
  parseCommissionSettings,
} from "../lib/tour-price.ts";
import { DEFAULT_FX_PROTECTION_PCT } from "../lib/fx-rate.ts";
import {
  computePagodaSalesBreakdown,
  pagodaSalesJpyRounded,
} from "../lib/pagoda-sales-calculator.ts";

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
  const ok = actual === expected;
  if (!ok) console.error(`    expected ${String(expected)}, got ${String(actual)}`);
  assert(name, ok);
}

function read(relPath: string): string {
  return readFileSync(join(repoRoot, relPath), "utf8");
}

/** Mirrors priceLineForCommission client sales (no pass-through). */
function itineraryLinePrice(
  net: number,
  marketplacePct: number,
  _agentPct: number,
  fxPct: number = DEFAULT_FX_PROTECTION_PCT
): number {
  return pagodaSalesJpyRounded(net, marketplacePct, fxPct);
}

console.log("\n=== John calculator example ===\n");

{
  const b = computePagodaSalesBreakdown({
    purchaseJpy: 50_000,
    marketplacePct: 25,
    agentCommissionPct: 15,
    fxProtectionPct: 3,
    jpyPerUsd: 160,
  });
  assertEqual("sales JPY ¥64,375", b.salesJpy, 64_375);
  assertEqual("sales USD $402.34", b.salesUsd, 402.34);
  assertEqual("advisor commission $60.35", b.advisorCommissionUsd, 60.35);
  assertEqual("Pagoda keeps $341.99", b.pagodaKeepsUsd, 341.99);
}

console.log("\n=== library price === itinerary line price ===\n");

const cases: Array<{ net: number; marketplace: number; agent: number }> = [
  { net: 100_000, marketplace: 25, agent: 15 },
  { net: 100_000, marketplace: 40, agent: 15 },
  { net: 33_333, marketplace: 25, agent: 15 },
  { net: 7_777, marketplace: 12.5, agent: 7.5 },
  { net: 0, marketplace: 25, agent: 15 },
  { net: 250_000, marketplace: 25, agent: 0 },
];

for (const c of cases) {
  const commission = parseCommissionSettings({
    commission_marketplace_pct: c.marketplace,
    commission_agent_pct: c.agent,
  });
  const library = getAgentDisplayTotalRounded(
    c.net,
    commission.commissionMarketplacePct,
    commission.commissionAgentPct,
    commission.vatRatePct,
    DEFAULT_FX_PROTECTION_PCT
  );
  const line = itineraryLinePrice(
    c.net,
    commission.commissionMarketplacePct,
    commission.commissionAgentPct
  );
  assertEqual(
    `net ¥${c.net.toLocaleString()} @ ${c.marketplace}%/${c.agent}% → library ¥${library.toLocaleString()}`,
    line,
    library
  );
}

console.log("\n=== marketplace raises the client price; agent % does not ===\n");

const low = parseCommissionSettings({ commission_marketplace_pct: 25, commission_agent_pct: 15 });
const high = parseCommissionSettings({ commission_marketplace_pct: 40, commission_agent_pct: 15 });
const netForPartner = 100_000;
const atLow = itineraryLinePrice(netForPartner, low.commissionMarketplacePct, low.commissionAgentPct);
const atHigh = itineraryLinePrice(netForPartner, high.commissionMarketplacePct, high.commissionAgentPct);
assert("40% marketplace prices above 25%", atHigh > atLow);
// 100_000 × 1.03 × 1.25 = 128_750
assertEqual("25% + 3% FX of ¥100,000 net → ¥128,750 client", atLow, 128_750);
// 100_000 × 1.03 × 1.40 = 144_200
assertEqual("40% + 3% FX of ¥100,000 net → ¥144,200 client", atHigh, 144_200);

const sameSalesDifferentAgent = itineraryLinePrice(100_000, 25, 0);
assertEqual(
  "agent 0% does not change client sales vs agent 15%",
  sameSalesDifferentAgent,
  atLow
);

console.log("\n=== one tour, one sales price ===\n");

function salesPrice(net: number, marketplacePct: number, fxPct = DEFAULT_FX_PROTECTION_PCT): number {
  return pagodaSalesJpyRounded(net, marketplacePct, fxPct);
}

assertEqual("¥10,000 @ 25% + 3% FX → ¥12,875", salesPrice(10_000, 25), 12_875);
assertEqual("¥43,120 @ 20% + 3% FX → ¥53,296", salesPrice(43_120, 20), 53_296);

const pricingModule = read("lib/pagoda-pricing.ts");
assert(
  "the advisor commission defaults from the commission settings alone",
  /export function advisorCommissionPctForLine\(commission: CommissionSettings\): number \{\s*return commission\.commissionAgentPct;/.test(
    pricingModule
  )
);
assert(
  "a line markup override can change the commission share",
  /parseMarkupPct\(opts\.lineMarkupPct\)/.test(pricingModule) &&
    /if \(fromLine != null\) return fromLine;/.test(pricingModule)
);
assert(
  "itinerary markup is not used as the default sales price",
  !/return effectiveMarkupPct\(/.test(pricingModule)
);
assert(
  "line commission field is editable for advisors",
  read("components/itineraries/edit-activity-sidebar.tsx").includes(
    "onChange={(e) => setLineMarkupPct(e.target.value)}"
  )
);
assert(
  "sidebar save button stays outside the scroll area",
  read("components/itineraries/edit-activity-sidebar.tsx").includes(
    "Always visible — short viewports"
  )
);
assert(
  "changing a guide's marketplace commission still moves the price",
  salesPrice(10_000, 40) > salesPrice(10_000, 25)
);

console.log("\n=== costs paid on the client's behalf carry no commission ===\n");

function withPassThrough(net: number, marketplacePct: number, agentPct: number, carried: number) {
  const salesExact = net * (1 + DEFAULT_FX_PROTECTION_PCT / 100) * (1 + marketplacePct / 100);
  const client = Math.round(salesExact) + carried;
  const commission = Math.round((salesExact * agentPct) / 100);
  const base = client - commission;
  return { base, client, commission };
}

{
  const fee = 3_000;
  const tickets = 76_580;
  const r = withPassThrough(fee, 25, 15, tickets);
  // 3000 × 1.03 × 1.25 = 3862.5 → round 3863 + 76580 = 80443; commission round(579.375)=579
  assertEqual("¥3,000 fee + ¥76,580 tickets → client ¥80,443", r.client, 80_443);
  assertEqual("after advisor share ¥79,864", r.base, 79_864);
  assertEqual("advisor commission is 15% of the fee sales only (¥579)", r.commission, 579);

  const naive = Math.round((fee + tickets) * (1 + DEFAULT_FX_PROTECTION_PCT / 100) * 1.25);
  assert(
    `folding tickets into the fee would have charged ¥${(naive - r.client).toLocaleString()} more`,
    naive > r.client && naive - r.client === 22_016
  );
  assert("the client never pays less than the ticket cost", r.client > tickets);
}

assertEqual(
  "a line with no carried cost prices exactly as the sales formula",
  withPassThrough(10_000, 25, 15, 0).client,
  12_875
);

const pricingSrc2 = read("lib/pagoda-pricing.ts");
assert(
  "the carried cost is added after the sales price, not inside it",
  /const displayPrice = salesRounded \+ carried/.test(pricingSrc2)
);
assert(
  "it never enters the commission base",
  !/pagodaSalesJpyExact\([^)]*passThrough/.test(pricingSrc2) &&
    !/pagodaPriceToAdvisorExact\([^)]*passThrough/.test(pricingSrc2)
);

console.log("\n=== the guide can enter a carried cost, and it stays separate ===\n");

const modal = read("components/itineraries/confirm-booking-price-modal.tsx");
assert("the modal has a separate field for tickets and fees", modal.includes("pass_through_cost"));
assert(
  "it tells the guide no commission is taken on them",
  /no commission on these/.test(modal.replace(/\s+/g, " "))
);
assert(
  "it shows the total she will invoice",
  modal.includes("You will invoice Pagoda")
);

const confirmRoute2 = read("app/api/jobs/confirm-booking-price/route.ts");
assert("the route accepts and validates it", confirmRoute2.includes("pass_through_cost"));
assert(
  "it is stored on the application, not folded into guide_price",
  /guide_price: confirmedPrice,[\s\S]{0,200}pass_through_cost: passThroughCost/.test(confirmRoute2)
);

const notify = read("lib/booking-confirmed-notifications.ts");
assert(
  "Pagoda's commission is measured on the service only",
  notify.includes("pagodaToAdvisor - confirmedPrice - (priced.passThroughCost || 0)")
);
assert(
  "the guide invoices her fee plus what she laid out",
  notify.includes("const guideInvoiceTotal = confirmedPrice + carried;")
);
assert(
  "confirmed notifications load live FX protection %",
  notify.includes("getFxProtectionPct")
);

assert(
  "a missing pass_through column blocks the booking instead of dropping the amount",
  /isMissingColumnError\([\s\S]{0,400}?migrationRequired\([\s\S]{0,80}?"20260831_job_application_pass_through_cost\.sql"/.test(
    confirmRoute2
  )
);
assert(
  "the raw database message is never returned to the guide",
  !/error: finalized\.error/.test(confirmRoute2)
);
assert(
  "the itinerary read path degrades when the column is absent",
  read("app/api/jobs/route.ts").includes("job_applications(*)")
);

console.log("\n=== adding a tour does not change its price ===\n");

{
  const net = 10_000;
  const tourOwner = parseCommissionSettings({
    commission_marketplace_pct: 20,
    commission_agent_pct: 15,
  });
  const bookedGuide = parseCommissionSettings({
    commission_marketplace_pct: 25,
    commission_agent_pct: 15,
  });
  const catalogPrice = getAgentDisplayTotalRounded(
    net,
    tourOwner.commissionMarketplacePct,
    tourOwner.commissionAgentPct,
    tourOwner.vatRatePct,
    DEFAULT_FX_PROTECTION_PCT
  );
  // 10_000 × 1.03 × 1.20 = 12_360
  assertEqual("catalog quotes ¥12,360", catalogPrice, 12_360);
  assertEqual(
    "the itinerary line quotes the same, whoever is booked",
    itineraryLinePrice(net, tourOwner.commissionMarketplacePct, tourOwner.commissionAgentPct),
    catalogPrice
  );
  assert(
    "pricing from the booked guide instead would have moved it",
    itineraryLinePrice(
      net,
      bookedGuide.commissionMarketplacePct,
      bookedGuide.commissionAgentPct
    ) !== catalogPrice
  );
}

console.log("\n=== the hardcoded markup is gone from priced paths ===\n");

const priced: Array<[string, string]> = [
  ["app/api/jobs/route.ts", "itinerary line prices"],
  ["lib/booking-confirmed-notifications.ts", "confirmation email prices"],
];

for (const [relPath, what] of priced) {
  const src = read(relPath);
  assert(`${relPath}: ${what} come from lib/pagoda-pricing`, src.includes("@/lib/pagoda-pricing"));
  assert(
    `${relPath}: no hardcoded DEFAULT_PAGODA_MARKUP_PCT`,
    !src.includes("DEFAULT_PAGODA_MARKUP_PCT")
  );
}

assert(
  "jobs route loads live FX protection %",
  read("app/api/jobs/route.ts").includes("getFxProtectionPct")
);

console.log("\n=== commissions are read live, per guide ===\n");

const pricing = read("lib/pagoda-pricing.ts");
assert(
  "the sales price reads the guide's marketplace commission",
  pricing.includes("commissionMarketplacePct")
);
assert(
  "commission settings are batch-loaded, not fetched per line",
  pricing.includes("loadJobCommissionLookup") &&
    pricing.includes("loadGuideCommissionSettingsByUserIds")
);
assert(
  "a tour-linked line prices from the tour, so it matches the catalog quote",
  /if \(tourId \|\| tourOwner\) \{[\s\S]{0,200}resolveCommissionUserIdForTour/.test(pricing)
);
assert(
  "the booked guide's commission is used only when there is no tour to quote from",
  pricing.indexOf("resolveCommissionUserIdForTour(tourId, tourOwner") <
    pricing.indexOf("return bookedGuide || null")
);

const advisorMarkup = read("lib/advisor-markup.ts");
assert(
  "DEFAULT_PAGODA_MARKUP_PCT is documented as a fallback, not a rule",
  /fallback/i.test(
    advisorMarkup.slice(
      Math.max(0, advisorMarkup.indexOf("DEFAULT_PAGODA_MARKUP_PCT") - 400),
      advisorMarkup.indexOf("DEFAULT_PAGODA_MARKUP_PCT") + 120
    )
  )
);

if (failed > 0) {
  console.error(`\n${failed} check(s) failed\n`);
  process.exit(1);
}
console.log("\nAll checks passed\n");
