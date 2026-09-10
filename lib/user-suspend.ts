import type { SupabaseClient } from "@supabase/supabase-js";

export type SuspendUserResult = {
  ok: true;
  role: string | null;
  alreadySuspended?: boolean;
  jobsNoLongerAvailable?: number;
  toursBanned?: number;
} | {
  ok: false;
  error: string;
  status: number;
};

/**
 * Deactivate a marketplace account (same side effects as Admin → Suspend).
 * Safe to call from policy automation — idempotent if already inactive.
 */
export async function suspendMarketplaceUser(
  supabase: SupabaseClient,
  userId: string
): Promise<SuspendUserResult> {
  const { data: user, error: userErr } = await supabase
    .from("users")
    .select("id, role, is_active")
    .eq("id", userId)
    .maybeSingle();

  if (userErr || !user) {
    return { ok: false, error: "User not found.", status: 404 };
  }

  if (user.is_active === false) {
    return { ok: true, role: user.role ?? null, alreadySuspended: true };
  }

  const { error: updateErr } = await supabase
    .from("users")
    .update({ is_active: false })
    .eq("id", userId);

  if (updateErr) {
    return { ok: false, error: "Failed to suspend user.", status: 500 };
  }

  let jobsNoLongerAvailable: number | undefined;
  let toursBanned: number | undefined;

  if (user.role === "agent" || user.role === "agency") {
    const { count, error: jobsErr } = await supabase
      .from("jobs")
      .select("id", { count: "exact", head: true })
      .eq("created_by", userId);
    if (!jobsErr) jobsNoLongerAvailable = count ?? 0;
  }

  if (user.role === "guide") {
    const { data: tourUpdates, error: tourErr } = await supabase
      .from("tour")
      .update({ status: "banned", updated_at: new Date().toISOString() })
      .eq("user_id", userId)
      .select("id");
    if (!tourErr) toursBanned = Array.isArray(tourUpdates) ? tourUpdates.length : 0;
  }

  return {
    ok: true,
    role: user.role ?? null,
    jobsNoLongerAvailable,
    toursBanned,
  };
}
