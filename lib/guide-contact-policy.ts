import type { SupabaseClient } from "@supabase/supabase-js";
import { detectSensitiveContact } from "@/lib/chat-message-sanitize";
import { authLog, chatLog } from "@/lib/ops-log";
import { suspendMarketplaceUser } from "@/lib/user-suspend";

/** After this many guide→advisor contact-share attempts, the account is suspended. */
export const GUIDE_CONTACT_STRIKE_LIMIT = 2;

export const GUIDE_CONTACT_SHARE_EVENT = "guide_contact_share_attempt";
export const GUIDE_CONTACT_SUSPEND_EVENT = "guide_suspended_contact_policy";
export const CLIENT_CONTACT_SHARED_EVENT = "client_contact_shared";

export type GuideContactPolicyResult = {
  attempted: boolean;
  strikeCount: number;
  suspended: boolean;
  warning: string | null;
};

async function insertSecurityAudit(
  supabase: SupabaseClient,
  row: {
    event_type: string;
    actor_id: string | null;
    target_user_id?: string | null;
    target_role?: string | null;
    meta?: Record<string, unknown>;
  }
): Promise<void> {
  const { error } = await supabase.from("security_audit_log").insert({
    event_type: row.event_type,
    actor_id: row.actor_id,
    target_user_id: row.target_user_id ?? null,
    target_role: row.target_role ?? null,
    meta: row.meta ?? {},
  });
  if (error) {
    chatLog.error("security_audit.insert_failed", error, {
      eventType: row.event_type,
      actorId: row.actor_id,
    });
  }
}

export async function countGuideContactStrikes(
  supabase: SupabaseClient,
  guideId: string
): Promise<number> {
  const { count, error } = await supabase
    .from("security_audit_log")
    .select("id", { count: "exact", head: true })
    .eq("event_type", GUIDE_CONTACT_SHARE_EVENT)
    .eq("actor_id", guideId);

  if (error) {
    chatLog.error("guide_contact.strike_count_failed", error, { guideId });
    return 0;
  }
  return count ?? 0;
}

/**
 * When a guide tries to send their own contact to an advisor in chat:
 * record a strike, keep the masked message, suspend after 2 strikes.
 * Advisors sharing client logistics are not struck (platform auto-shares client contact).
 */
export async function enforceGuideContactSharePolicy(opts: {
  supabase: SupabaseClient;
  /** Session account on the guide side of the thread (not admin acting). */
  guideSessionUserId: string;
  chatId: string;
  messageId?: string | null;
  rawText: string;
  /** True when the session user is this chat's guide_id. */
  senderIsGuideOnThread: boolean;
  adminActing?: boolean;
}): Promise<GuideContactPolicyResult> {
  const empty: GuideContactPolicyResult = {
    attempted: false,
    strikeCount: 0,
    suspended: false,
    warning: null,
  };

  if (opts.adminActing) return empty;
  if (!opts.senderIsGuideOnThread) return empty;
  if (!detectSensitiveContact(opts.rawText)) return empty;

  await insertSecurityAudit(opts.supabase, {
    event_type: GUIDE_CONTACT_SHARE_EVENT,
    actor_id: opts.guideSessionUserId,
    target_role: "guide",
    meta: {
      chatId: opts.chatId,
      messageId: opts.messageId ?? null,
    },
  });

  const strikeCount = await countGuideContactStrikes(
    opts.supabase,
    opts.guideSessionUserId
  );

  chatLog.info("guide_contact.strike_recorded", {
    guideId: opts.guideSessionUserId,
    chatId: opts.chatId,
    strikeCount,
    limit: GUIDE_CONTACT_STRIKE_LIMIT,
  });

  if (strikeCount < GUIDE_CONTACT_STRIKE_LIMIT) {
    return {
      attempted: true,
      strikeCount,
      suspended: false,
      warning:
        `Contact details were hidden. Sharing your personal contact with advisors is not allowed (${strikeCount}/${GUIDE_CONTACT_STRIKE_LIMIT}). A second attempt will suspend your account.`,
    };
  }

  const suspended = await suspendMarketplaceUser(
    opts.supabase,
    opts.guideSessionUserId
  );

  if (suspended.ok && !suspended.alreadySuspended) {
    await insertSecurityAudit(opts.supabase, {
      event_type: GUIDE_CONTACT_SUSPEND_EVENT,
      actor_id: opts.guideSessionUserId,
      target_user_id: opts.guideSessionUserId,
      target_role: "guide",
      meta: {
        chatId: opts.chatId,
        strikeCount,
        reason: "guide_shared_contact_with_advisor",
      },
    });
    authLog.info("guide.suspended_contact_policy", {
      guideId: opts.guideSessionUserId,
      strikeCount,
      toursBanned: suspended.toursBanned ?? null,
    });
  }

  return {
    attempted: true,
    strikeCount,
    suspended: suspended.ok,
    warning: suspended.ok
      ? "Your account has been suspended for repeatedly sharing personal contact details with advisors. Contact Pagoda support if you believe this is an error."
      : `Contact details were hidden. Sharing your personal contact with advisors is not allowed (${strikeCount}/${GUIDE_CONTACT_STRIKE_LIMIT}).`,
  };
}

/** Idempotent audit when client intake contact is revealed to an assigned guide. */
export async function recordClientContactShared(opts: {
  supabase: SupabaseClient;
  jobId: string;
  guideId: string;
  itineraryId?: string | null;
  sharedByUserId?: string | null;
  fieldsPresent: string[];
}): Promise<void> {
  const { count, error: countErr } = await opts.supabase
    .from("security_audit_log")
    .select("id", { count: "exact", head: true })
    .eq("event_type", CLIENT_CONTACT_SHARED_EVENT)
    .eq("target_user_id", opts.guideId)
    .filter("meta->>jobId", "eq", opts.jobId);

  if (countErr) {
    chatLog.error("client_contact.share_lookup_failed", countErr, {
      jobId: opts.jobId,
      guideId: opts.guideId,
    });
  } else if ((count ?? 0) > 0) {
    return;
  }

  await insertSecurityAudit(opts.supabase, {
    event_type: CLIENT_CONTACT_SHARED_EVENT,
    actor_id: opts.sharedByUserId ?? null,
    target_user_id: opts.guideId,
    target_role: "guide",
    meta: {
      jobId: opts.jobId,
      itineraryId: opts.itineraryId ?? null,
      fieldsPresent: opts.fieldsPresent,
    },
  });

  chatLog.info("client_contact.shared", {
    jobId: opts.jobId,
    guideId: opts.guideId,
    fieldsPresent: opts.fieldsPresent,
  });
}
