/**
 * The single pricing authority for advisor-facing prices.
 *
 * Pagoda calculator (John):
 *
 *   guide/supplier purchase JPY
 *     → × (1 + FX protection %)          default 3%, admin-editable
 *     → × (1 + commissionMarketplacePct) default 25%, per guide
 *     = customer sales price (JPY)
 *     → ÷ daily USD/JPY                  (no second FX buffer — already in JPY)
 *     = final USD sales price
 *     → × commissionAgentPct             default 15% of sales (not stacked on top)
 *     = Travel Advisor commission
 *
 * The advisor commission is a share of the final sales price. Stacking it as a second
 * markup used to inflate the client price (net × 1.25 × 1.15). Percentages are read live
 * on every computation so Tour Library, itinerary lines, emails and PDF move together.
 *
 * Rounding matches `getDisplayTotalExact` / `pagodaSalesJpyRounded` — FX + marketplace
 * compounded exactly, rounded once — so a library price and an itinerary line never
 * differ by a yen when they share the same FX %.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DEFAULT_PAGODA_MARKUP_PCT,
  parseMarkupPct,
  parseMoney,
} from "@/lib/advisor-markup";
import { DEFAULT_FX_PROTECTION_PCT, clampFxProtectionPct } from "@/lib/fx-rate";
import {
  commissionSettingsForUserId,
  fetchPrimaryGuideIdByTourId,
  loadGuideCommissionSettingsByUserIds,
  resolveCommissionUserIdForTour,
} from "@/lib/guide-commission-for-tour";
import { pagodaSalesJpyExact } from "@/lib/pagoda-sales-calculator";
import { parseCommissionSettings, type CommissionSettings } from "@/lib/tour-price";

export type PagodaLinePrice = {
  /**
   * Customer sales minus advisor commission (plus any pass-through).
   * What Pagoda retains of the line after the advisor's share.
   */
  baseDisplayPrice: number | null;
  /** What the client pays on the proposal (sales JPY + pass-through). */
  displayPrice: number | null;
  /** Advisor commission: sales × agent% (service only — not on pass-through). */
  advisorProfit: number | null;
  priceSource: "markup" | "base" | "none";
  /** Percentages actually applied — surfaced so the UI can explain the number. */
  marketplacePct: number;
  markupPct: number;
  /** Costs carried at face value inside the two figures above; no commission taken. */
  passThroughCost: number;
  fxProtectionPct: number;
};

const EMPTY_PRICE: PagodaLinePrice = {
  baseDisplayPrice: null,
  displayPrice: null,
  advisorProfit: null,
  priceSource: "none",
  marketplacePct: DEFAULT_PAGODA_MARKUP_PCT,
  markupPct: 0,
  passThroughCost: 0,
  fxProtectionPct: DEFAULT_FX_PROTECTION_PCT,
};

/**
 * The advisor commission % applied to a line (share of sales).
 *
 * Default: the guide's `commissionAgentPct` from `guide_commission_settings` — so a line with
 * no override matches the Tour Library commission split for that tour.
 *
 * Override: when `line_markup_pct` is set on the job (including 0), that percentage is used
 * instead. It changes the advisor's share only — not the customer sales price.
 */
export function advisorCommissionPctForLine(commission: CommissionSettings): number {
  return commission.commissionAgentPct;
}

/** Advisor commission % for this line: explicit line override, else the guide's agent commission. */
export function advisorMarkupPctForLine(opts: {
  lineMarkupPct?: number | null;
  itineraryMarkupPct?: number | null;
  accountDefaultMarkupPct?: number | null;
  commission: CommissionSettings;
  previewItineraryMarkupPct?: number | null;
}): number {
  const fromLine = parseMarkupPct(opts.lineMarkupPct);
  if (fromLine != null) return fromLine;
  return advisorCommissionPctForLine(opts.commission);
}

/**
 * Purchase → customer sales JPY (FX + marketplace), unrounded.
 * Name kept for call-site stability; this is no longer "Pagoda to advisor before markup".
 */
export function pagodaPriceToAdvisorExact(
  net: number,
  commission: CommissionSettings,
  fxProtectionPct: number = DEFAULT_FX_PROTECTION_PCT
): number {
  return pagodaSalesJpyExact(net, commission.commissionMarketplacePct, fxProtectionPct);
}

/**
 * Full line price from a guide/supplier net and the guide's live commission settings.
 *
 * `passThroughCost` is money the guide lays out on the client's behalf — train tickets,
 * entrance fees. It is added after sales pricing, so the client pays exactly what the
 * ticket cost and Pagoda takes nothing on it.
 */
export function priceLineForCommission(opts: {
  /** Guide/tour net, or the advisor's supplier quote — whichever this line is priced from. */
  net: number | null | undefined;
  commission: CommissionSettings;
  /** Advisor commission % of sales (not a second markup on the client price). */
  markupPct: number;
  /** Carried at face value, outside the commission. */
  passThroughCost?: number | null;
  fxProtectionPct?: number;
}): PagodaLinePrice {
  const net = parseMoney(opts.net);
  const passThrough = parseMoney(opts.passThroughCost) ?? 0;
  const fxProtectionPct = clampFxProtectionPct(
    opts.fxProtectionPct ?? DEFAULT_FX_PROTECTION_PCT
  );
  const marketplacePct = opts.commission.commissionMarketplacePct;
  const carried = Math.round(passThrough);

  if (net == null) {
    // A line with only a pass-through cost is still worth a price: it is what the client pays.
    if (passThrough > 0) {
      return {
        baseDisplayPrice: carried,
        displayPrice: carried,
        advisorProfit: 0,
        priceSource: "base",
        marketplacePct,
        markupPct: 0,
        passThroughCost: carried,
        fxProtectionPct,
      };
    }
    return { ...EMPTY_PRICE, marketplacePct, fxProtectionPct };
  }

  const salesExact = pagodaSalesJpyExact(net, marketplacePct, fxProtectionPct);
  const salesRounded = Math.round(salesExact);
  const displayPrice = salesRounded + carried;
  const markupPct = Number(opts.markupPct) || 0;

  if (markupPct <= 0) {
    return {
      baseDisplayPrice: displayPrice,
      displayPrice,
      advisorProfit: 0,
      priceSource: "base",
      marketplacePct,
      markupPct: 0,
      passThroughCost: carried,
      fxProtectionPct,
    };
  }

  // Commission from the service sales only — carried tickets cancel out of the share.
  const advisorProfit = Math.round((salesExact * markupPct) / 100);
  return {
    baseDisplayPrice: displayPrice - advisorProfit,
    displayPrice,
    advisorProfit,
    priceSource: "markup",
    marketplacePct,
    markupPct,
    passThroughCost: carried,
    fxProtectionPct,
  };
}

/** Commission defaults for a guide with no settings row (25% / 15%). */
export function defaultCommissionSettings(): CommissionSettings {
  return parseCommissionSettings({});
}

export type JobForCommission = {
  id: string;
  tour_id?: string | null;
  /** Guide being booked, when one is committed to this line. */
  guide_id?: string | null;
  tour?: { user_id?: string | null } | null;
};

type ApplicationForCommission = {
  applicant_id?: string | null;
  offer_status?: string | null;
  price_confirmation_status?: string | null;
  is_candidate?: boolean | null;
  is_finalist?: boolean | null;
};

/**
 * The guide who will actually invoice Pagoda for this line, if one is committed yet.
 *
 * Ordered by how settled the commitment is: a confirmed price beats a pending one, which
 * beats an accepted offer, which beats a shortlisted candidate. Anything less than that is
 * still an open job, so the tour owner's commission applies instead.
 */
export function bookedGuideIdFromApplications(
  applications: unknown
): string | null {
  const apps = Array.isArray(applications)
    ? (applications as ApplicationForCommission[])
    : [];
  if (apps.length === 0) return null;

  const applicantId = (a: ApplicationForCommission | undefined): string | null => {
    const id = typeof a?.applicant_id === "string" ? a.applicant_id.trim() : "";
    return id || null;
  };
  const offer = (a: ApplicationForCommission) => String(a.offer_status || "").toLowerCase();

  return (
    applicantId(apps.find((a) => a.price_confirmation_status === "confirmed")) ??
    applicantId(apps.find((a) => a.price_confirmation_status === "requested")) ??
    applicantId(apps.find((a) => ["completed", "hired", "accepted"].includes(offer(a)))) ??
    applicantId(apps.find((a) => a.is_finalist === true)) ??
    applicantId(apps.find((a) => a.is_candidate === true || offer(a) === "candidate")) ??
    null
  );
}

/**
 * Whose commission applies to a job line.
 *
 * A line that came from the Tour Library prices exactly as that tour does in the catalog —
 * assigned guide, else tour owner — because that is the figure the advisor was quoted when
 * they added it. Preferring the booked guide instead makes the price move the moment a guide
 * is committed: an advisor who added a tour at ¥13,800 saw a few hundred more on the
 * itinerary, with nothing in the UI to explain it. Whoever ends up invoicing, the quote holds.
 *
 * The booked guide's commission is used only for a line with no tour behind it — a direct or
 * custom job, where there is no catalog price to honour.
 */
export function resolveCommissionUserIdForJob(
  job: JobForCommission,
  primaryGuideByTourId: Map<string, string>
): string | null {
  const tourId = job.tour_id != null ? String(job.tour_id).trim() : "";
  const tourOwner =
    typeof job.tour?.user_id === "string" ? job.tour.user_id.trim() : "";

  if (tourId || tourOwner) {
    return resolveCommissionUserIdForTour(tourId, tourOwner, primaryGuideByTourId);
  }

  const bookedGuide = typeof job.guide_id === "string" ? job.guide_id.trim() : "";
  return bookedGuide || null;
}

export type JobCommissionLookup = {
  /** Commission for one job, falling back to platform defaults when nothing resolves. */
  forJob: (job: JobForCommission) => CommissionSettings;
};

/**
 * Batch-load commission settings for every guide referenced by a set of jobs.
 *
 * Two queries for a whole itinerary regardless of line count — the per-line alternative
 * would put a round trip inside the price loop.
 */
export async function loadJobCommissionLookup(
  supabase: SupabaseClient,
  jobs: JobForCommission[]
): Promise<JobCommissionLookup> {
  const tourIds = [
    ...new Set(
      jobs
        .map((j) => (j.tour_id != null ? String(j.tour_id).trim() : ""))
        .filter(Boolean)
    ),
  ];

  const primaryGuideByTourId = tourIds.length
    ? await fetchPrimaryGuideIdByTourId(supabase, tourIds)
    : new Map<string, string>();

  const commissionUserIds = [
    ...new Set(
      jobs
        .map((j) => resolveCommissionUserIdForJob(j, primaryGuideByTourId))
        .filter((id): id is string => !!id)
    ),
  ];

  const settingsByUserId = commissionUserIds.length
    ? await loadGuideCommissionSettingsByUserIds(supabase, commissionUserIds)
    : new Map<string, CommissionSettings>();

  return {
    forJob(job) {
      const userId = resolveCommissionUserIdForJob(job, primaryGuideByTourId);
      if (!userId) return defaultCommissionSettings();
      return commissionSettingsForUserId(userId, settingsByUserId);
    },
  };
}

/** Commission for a single guide — for paths that price one booking, not an itinerary. */
export async function loadCommissionForGuide(
  supabase: SupabaseClient,
  guideId: string | null | undefined
): Promise<CommissionSettings> {
  const id = typeof guideId === "string" ? guideId.trim() : "";
  if (!id) return defaultCommissionSettings();
  const byUserId = await loadGuideCommissionSettingsByUserIds(supabase, [id]);
  return commissionSettingsForUserId(id, byUserId);
}
