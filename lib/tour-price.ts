/**
 * Tour / catalog customer sales price (John / Pagoda calculator):
 *
 *   purchase JPY × (1 + FX%) × (1 + marketplace%) = sales JPY
 *
 * Travel Advisor commission % is a share of that sales price — it is not stacked on top
 * (stacking used to inflate the client price by another ~15%). VAT remains 0.
 *
 * Keep this file free of `@/` and cross-lib imports so `scripts/verify-pricing-consistency.ts`
 * can load it under `node --experimental-strip-types`.
 */

/** Matches `DEFAULT_FX_PROTECTION_PCT` in `lib/fx-rate.ts`. */
const DEFAULT_FX_PROTECTION_PCT = 3;

function salesJpyExact(
  guidePrice: number,
  marketplacePct: number,
  fxProtectionPct: number = DEFAULT_FX_PROTECTION_PCT
): number {
  const net = Number(guidePrice) || 0;
  const fx = Number(fxProtectionPct);
  const fxClamped = Number.isFinite(fx) ? Math.min(100, Math.max(0, fx)) : DEFAULT_FX_PROTECTION_PCT;
  const mkt = Number(marketplacePct) || 0;
  return net * (1 + fxClamped / 100) * (1 + mkt / 100);
}

export interface TourPriceBreakdown {
  guidePrice: number;
  marketplaceCommissionPct: number;
  agentCommissionPct: number;
  vatRatePct: number;
  subtotalAfterMarketplace: number;
  marketplaceCommission: number;
  subtotalAfterAgent: number;
  agentCommission: number;
  vatAmount: number;
  total: number;
}

export interface CommissionSettings {
  commissionMarketplacePct: number;
  commissionAgentPct: number;
  vatRatePct: number;
}

/** Agent-facing bid proposal payload (GET /api/bids/proposal). */
export interface AgentBidPricingPayload {
  /** Guide's quoted net (before marketplace + agent commission). */
  guideTotal: number;
  /** What the advisor is charged (guide + commissions). */
  totalInclVat: number;
  pricingModel: "group_rate" | "per_person" | "flat";
  participants: { adults: number; children: number; infants: number };
  groupOverMax: boolean;
  lines: { label: string; count: number; displayAmount: number }[] | null;
  commission: CommissionSettings;
}

/**
 * Normalize job participant counts for pricing. For legacy jobs without adults/children/infants,
 * infer from group_size (treat as adults) so per-person pricing can still be calculated.
 */
export function normalizeJobParticipants(job: {
  adults?: number | null;
  children?: number | null;
  infants?: number | null;
  group_size?: number | null;
}): { adults: number; children: number; infants: number } {
  let adults = Number(job.adults) || 0;
  let children = Number(job.children) || 0;
  let infants = Number(job.infants) || 0;
  if (adults + children + infants === 0) {
    const gs = Number(job.group_size) || 0;
    adults = gs > 0 ? gs : 1;
  }
  return { adults, children, infants };
}

/**
 * Compute guide total from per-person pricing and participant counts.
 * Used when tour has price_per_adult, price_per_child, price_per_infant (per_person model).
 */
export function computeGuideTotalFromParticipants(
  pricePerAdult: number,
  pricePerChild: number,
  pricePerInfant: number,
  adults: number,
  children: number,
  infants: number
): number {
  const a = Math.max(0, Number(adults) || 0);
  const c = Math.max(0, Number(children) || 0);
  const i = Math.max(0, Number(infants) || 0);
  return (
    a * Number(pricePerAdult) +
    c * Number(pricePerChild) +
    i * Number(pricePerInfant)
  );
}
/** Line item for pricing breakdown display (e.g. "Adults (5) × ¥3,000 = ¥15,000") */
export interface PricingBreakdownLine {
  label: string;
  count: number;
  unitPrice: number;
  amount: number;
}
/** Result of computing guide total with optional breakdown for UI */
export interface GuidePricingResult {
  guideTotal: number;
  breakdownLines: PricingBreakdownLine[];
}
/** Total headcount for pricing (adults + children + infants). */
export function countParticipants(participants: {
  adults: number;
  children: number;
  infants: number;
}): number {
  const a = Math.max(0, Number(participants.adults) || 0);
  const c = Math.max(0, Number(participants.children) || 0);
  const i = Math.max(0, Number(participants.infants) || 0);
  return a + c + i;
}

/**
 * True when group_rate tour has a max_group_size and headcount exceeds it.
 * max_group_size null or ≤0 means no limit (legacy tours).
 */
export function isGroupSizeOverTourLimit(
  tour: { pricing_model?: string | null; max_group_size?: number | null },
  participants: { adults: number; children: number; infants: number }
): boolean {
  if (tour.pricing_model !== "group_rate") return false;
  const max = tour.max_group_size;
  if (max == null || !Number.isFinite(Number(max)) || Number(max) <= 0) return false;
  return countParticipants(participants) > Number(max);
}

/**
 * Group rate: base rate covers up to baseGroupSize people (any mix of ages), then one additional rate per extra person.
 */
export function computeGuideTotalGroupRate(
  baseRate: number,
  baseGroupSize: number,
  adults: number,
  children: number,
  infants: number,
  additionalPerPersonRate: number | null | undefined
): GuidePricingResult {
  const a = Math.max(0, Number(adults) || 0);
  const c = Math.max(0, Number(children) || 0);
  const i = Math.max(0, Number(infants) || 0);
  const totalPeople = a + c + i;
  const lines: PricingBreakdownLine[] = [];
  if (totalPeople === 0) {
    return { guideTotal: 0, breakdownLines: [] };
  }
  let guideTotal = Number(baseRate) || 0;
  lines.push({
    label: `Base (up to ${baseGroupSize} people)`,
    count: 1,
    unitPrice: guideTotal,
    amount: guideTotal,
  });
  const extra = Math.max(0, totalPeople - baseGroupSize);
  if (extra === 0) {
    return { guideTotal, breakdownLines: lines };
  }
  const rate =
    additionalPerPersonRate != null && Number.isFinite(Number(additionalPerPersonRate))
      ? Number(additionalPerPersonRate)
      : 0;
  const extraAmount = extra * rate;
  lines.push({
    label: "Additional per person",
    count: extra,
    unitPrice: rate,
    amount: extraAmount,
  });
  guideTotal += extraAmount;
  return { guideTotal, breakdownLines: lines };
}
/**
 * Per-person model: return guide total and breakdown lines (adults × rate, etc.).
 */
export function getPerPersonBreakdown(
  pricePerAdult: number,
  pricePerChild: number,
  pricePerInfant: number,
  adults: number,
  children: number,
  infants: number
): GuidePricingResult {
  const a = Math.max(0, Number(adults) || 0);
  const c = Math.max(0, Number(children) || 0);
  const i = Math.max(0, Number(infants) || 0);
  const lines: PricingBreakdownLine[] = [];
  if (a > 0) lines.push({ label: "Adults", count: a, unitPrice: pricePerAdult, amount: a * pricePerAdult });
  if (c > 0) lines.push({ label: "Children", count: c, unitPrice: pricePerChild, amount: c * pricePerChild });
  if (i > 0) lines.push({ label: "Infants", count: i, unitPrice: pricePerInfant, amount: i * pricePerInfant });
  const guideTotal = computeGuideTotalFromParticipants(
    pricePerAdult,
    pricePerChild,
    pricePerInfant,
    adults,
    children,
    infants
  );
  return { guideTotal, breakdownLines: lines };
}
/**
 * Unified: compute guide total from tour pricing (per_person or group_rate) and participant counts.
 * Returns guide total and optional breakdown lines. Use for display and for displayPrice calculation.
 */
export function computeGuideTotalFromTour(
  tour: {
    pricing_model?: string | null;
    price_per_adult?: number | null;
    price_per_child?: number | null;
    price_per_infant?: number | null;
    base_rate?: number | null;
    base_group_size?: number | null;
    max_group_size?: number | null;
    additional_per_person_rate?: number | null;
  },
  participants: { adults: number; children: number; infants: number }
): GuidePricingResult | null {
  const { adults, children, infants } = participants;
  const model = tour.pricing_model === "group_rate" ? "group_rate" : "per_person";
  if (model === "group_rate") {
    if (isGroupSizeOverTourLimit(tour, participants)) return null;
    const baseRate = Number(tour.base_rate) || 0;
    const baseGroupSize = Math.max(1, Number(tour.base_group_size) || 1);
    const hasGroupRate = baseRate > 0 && baseGroupSize > 0;
    if (!hasGroupRate) return null;
    return computeGuideTotalGroupRate(
      baseRate,
      baseGroupSize,
      adults,
      children,
      infants,
      tour.additional_per_person_rate
    );
  }
  const pa = tour.price_per_adult != null ? Number(tour.price_per_adult) : null;
  const pc = tour.price_per_child != null ? Number(tour.price_per_child) : null;
  const pi = tour.price_per_infant != null ? Number(tour.price_per_infant) : null;
  if (pa == null || pc == null || pi == null) return null;
  return getPerPersonBreakdown(pa, pc, pi, adults, children, infants);
}

/**
 * Breakdown from guide net. `total` is the customer sales price (FX + marketplace).
 * `agentCommission` is the advisor's share of that sales price — not added on top.
 */
export function calculateTotalFromGuidePrice(
  guidePrice: number,
  marketplacePct: number,
  agentPct: number,
  vatPct: number,
  fxProtectionPct: number = DEFAULT_FX_PROTECTION_PCT
): TourPriceBreakdown {
  const salesExact = salesJpyExact(guidePrice, marketplacePct, fxProtectionPct);
  const sales = Math.round(salesExact);
  const marketplaceCommission = sales - Math.round(Number(guidePrice) || 0);
  const agentCommission = Math.round((sales * agentPct) / 100);
  const vatAmount = Math.round((sales * vatPct) / 100);
  const total = sales + vatAmount;

  return {
    guidePrice,
    marketplaceCommissionPct: marketplacePct,
    agentCommissionPct: agentPct,
    vatRatePct: vatPct,
    // After FX + marketplace — the customer sales amount before VAT.
    subtotalAfterMarketplace: sales,
    marketplaceCommission,
    // Agent % is a share of sales, so the subtotal does not grow again.
    subtotalAfterAgent: sales,
    agentCommission,
    vatAmount,
    total,
  };
}

/**
 * Exact customer sales JPY (FX + marketplace). `agentPct` is ignored for the total —
 * kept in the signature so call sites stay stable; commission is computed separately.
 */
export function getDisplayTotalExact(
  guidePrice: number,
  marketplacePct: number,
  _agentPct: number,
  vatPct: number,
  fxProtectionPct: number = DEFAULT_FX_PROTECTION_PCT
): number {
  const sales = salesJpyExact(guidePrice, marketplacePct, fxProtectionPct);
  return sales + (sales * vatPct) / 100;
}

/**
 * Agent-facing customer sales total (rounded). Matches itinerary lines priced via
 * `priceLineForCommission` when the same FX % and marketplace % are used.
 */
export function getAgentDisplayTotalRounded(
  guidePrice: number,
  marketplacePct: number,
  agentPct: number,
  vatPct: number,
  fxProtectionPct: number = DEFAULT_FX_PROTECTION_PCT
): number {
  return Math.round(
    getDisplayTotalExact(guidePrice, marketplacePct, agentPct, vatPct, fxProtectionPct)
  );
}

/** VAT removed from sales pricing — always 0. Kept for type/API compatibility. */
export const FIXED_VAT_RATE_PCT = 0;

export const DEFAULT_COMMISSION_SETTINGS: CommissionSettings = {
  commissionMarketplacePct: 25,
  commissionAgentPct: 15,
  vatRatePct: FIXED_VAT_RATE_PCT,
};

/**
 * Map guide-currency breakdown lines to agent-facing amounts (incl. commissions & VAT).
 * Line amounts sum to `guideTotal`; display amounts are rounded to sum to
 * `getAgentDisplayTotalRounded(guideTotal, ...)`.
 */
export function mapGuideBreakdownLinesToAgentRounded(
  lines: PricingBreakdownLine[],
  guideTotal: number,
  comm: CommissionSettings,
  fxProtectionPct: number = DEFAULT_FX_PROTECTION_PCT
): { label: string; count: number; displayAmount: number }[] {
  if (lines.length === 0) return [];
  const totalRounded = getAgentDisplayTotalRounded(
    guideTotal,
    comm.commissionMarketplacePct,
    comm.commissionAgentPct,
    comm.vatRatePct,
    fxProtectionPct
  );
  const out = lines.map((line) => ({
    label: line.label,
    count: line.count,
    displayAmount: Math.round(
      getDisplayTotalExact(
        line.amount,
        comm.commissionMarketplacePct,
        comm.commissionAgentPct,
        comm.vatRatePct,
        fxProtectionPct
      )
    ),
  }));
  const sum = out.reduce((s, l) => s + l.displayAmount, 0);
  const drift = totalRounded - sum;
  if (drift !== 0 && out.length > 0) {
    const last = out.length - 1;
    out[last] = { ...out[last], displayAmount: out[last].displayAmount + drift };
  }
  return out;
}

export function parseCommissionSettings(raw: {
  commission_marketplace_pct?: string | number | null;
  commission_agent_pct?: string | number | null;
  vat_rate_pct?: string | number | null;
}): CommissionSettings {
  const n = (v: string | number | null | undefined, def: number) => {
    if (v == null || v === "") return def;
    const x = typeof v === "number" ? v : parseFloat(String(v));
    return Number.isFinite(x) ? x : def;
  };
  return {
    commissionMarketplacePct: n(raw.commission_marketplace_pct, DEFAULT_COMMISSION_SETTINGS.commissionMarketplacePct),
    commissionAgentPct: n(raw.commission_agent_pct, DEFAULT_COMMISSION_SETTINGS.commissionAgentPct),
    // VAT removed from sales pricing — always 0 regardless of DB value.
    vatRatePct: FIXED_VAT_RATE_PCT,
  };
}
