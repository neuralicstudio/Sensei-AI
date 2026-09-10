/**
 * Pagoda customer sales price + Travel Advisor commission (John / Pagoda calculator).
 *
 *   Purchase JPY
 *     → × (1 + FX protection %)     default 3%
 *     → × (1 + Pagoda marketplace %)  default 25%
 *     = Pagoda sales price (JPY) — what the customer pays (in JPY terms)
 *     → ÷ daily USD/JPY rate
 *     = Final USD sales price
 *     → × Travel Advisor commission %   default 15% of USD sales (not of purchase)
 *     = Advisor commission USD
 *
 * Advisor commission is a share of the final sales price, not a second markup stacked
 * on top of Pagoda's cut (that used to inflate the client price by another 15%).
 *
 * Self-contained (no cross-lib imports) so `scripts/verify-*.ts` can load it under
 * `node --experimental-strip-types`.
 */

/** Matches `DEFAULT_FX_PROTECTION_PCT` in `lib/fx-rate.ts`. */
const DEFAULT_FX_PROTECTION_PCT = 3;

function clampFxProtectionPct(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_FX_PROTECTION_PCT;
  return Math.min(100, Math.max(0, Math.round(n * 100) / 100));
}

function roundUsd(amount: number): number {
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount * 100) / 100;
}

export type PagodaSalesBreakdown = {
  purchaseJpy: number;
  fxProtectionPct: number;
  marketplacePct: number;
  agentCommissionPct: number;
  /** purchase × (1 + fx%) */
  fxProtectedJpy: number;
  /** FX-protected × (1 + marketplace%) — customer sales in JPY */
  salesJpy: number;
  jpyPerUsd: number | null;
  /** salesJpy ÷ rate (2 dp). Null when no rate. */
  salesUsd: number | null;
  /** salesUsd × agent% (2 dp). */
  advisorCommissionUsd: number | null;
  /** salesUsd − advisor commission. */
  pagodaKeepsUsd: number | null;
  /** salesJpy × agent% (yen, rounded). */
  advisorCommissionJpy: number;
  /** salesJpy − advisor commission (yen). */
  pagodaKeepsJpy: number;
};

/** Exact sales JPY before rounding (for compounding with pass-through elsewhere). */
export function pagodaSalesJpyExact(
  purchaseJpy: number,
  marketplacePct: number,
  fxProtectionPct: number = DEFAULT_FX_PROTECTION_PCT
): number {
  const net = Number(purchaseJpy) || 0;
  const fx = clampFxProtectionPct(fxProtectionPct);
  const mkt = Number(marketplacePct) || 0;
  return net * (1 + fx / 100) * (1 + mkt / 100);
}

export function pagodaSalesJpyRounded(
  purchaseJpy: number,
  marketplacePct: number,
  fxProtectionPct: number = DEFAULT_FX_PROTECTION_PCT
): number {
  return Math.round(pagodaSalesJpyExact(purchaseJpy, marketplacePct, fxProtectionPct));
}

/**
 * Full breakdown. Pass `jpyPerUsd` to fill USD fields (Frankfurter ECB rate).
 * Advisor commission is always taken from the sales price, never from raw purchase.
 */
export function computePagodaSalesBreakdown(opts: {
  purchaseJpy: number;
  marketplacePct: number;
  agentCommissionPct: number;
  fxProtectionPct?: number;
  jpyPerUsd?: number | null;
}): PagodaSalesBreakdown {
  const purchaseJpy = Math.round(Number(opts.purchaseJpy) || 0);
  const fxProtectionPct = clampFxProtectionPct(
    opts.fxProtectionPct ?? DEFAULT_FX_PROTECTION_PCT
  );
  const marketplacePct = Number(opts.marketplacePct) || 0;
  const agentCommissionPct = Number(opts.agentCommissionPct) || 0;

  const fxProtectedJpy = purchaseJpy * (1 + fxProtectionPct / 100);
  const salesJpy = Math.round(fxProtectedJpy * (1 + marketplacePct / 100));
  const advisorCommissionJpy = Math.round((salesJpy * agentCommissionPct) / 100);
  const pagodaKeepsJpy = salesJpy - advisorCommissionJpy;

  const rate =
    opts.jpyPerUsd != null && Number.isFinite(Number(opts.jpyPerUsd)) && Number(opts.jpyPerUsd) > 0
      ? Number(opts.jpyPerUsd)
      : null;

  let salesUsd: number | null = null;
  let advisorCommissionUsd: number | null = null;
  let pagodaKeepsUsd: number | null = null;

  if (rate != null) {
    // FX protection already applied in JPY — convert with the raw rate only.
    salesUsd = roundUsd(salesJpy / rate);
    advisorCommissionUsd = roundUsd((salesUsd * agentCommissionPct) / 100);
    pagodaKeepsUsd = roundUsd(salesUsd - advisorCommissionUsd);
  }

  return {
    purchaseJpy,
    fxProtectionPct,
    marketplacePct,
    agentCommissionPct,
    fxProtectedJpy: Math.round(fxProtectedJpy * 100) / 100,
    salesJpy,
    jpyPerUsd: rate,
    salesUsd,
    advisorCommissionUsd,
    pagodaKeepsUsd,
    advisorCommissionJpy,
    pagodaKeepsJpy,
  };
}
