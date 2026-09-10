-- Why: production may not have run 20260820_security_phase1.sql yet, so
-- CREATE INDEX alone fails with 42P01 (relation security_audit_log does not exist).
-- This migration creates the audit table if missing, then adds indexes used for
-- client_contact_shared + guide contact-strike lookups (suspend after 2).

CREATE TABLE IF NOT EXISTS public.security_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  actor_id text,
  target_user_id text,
  target_role text,
  ip text,
  user_agent text,
  meta jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS security_audit_log_created_idx
  ON public.security_audit_log (created_at DESC);

CREATE INDEX IF NOT EXISTS security_audit_log_event_idx
  ON public.security_audit_log (event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS security_audit_log_actor_event_idx
  ON public.security_audit_log (actor_id, event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS security_audit_log_target_event_idx
  ON public.security_audit_log (target_user_id, event_type, created_at DESC);

COMMENT ON TABLE public.security_audit_log IS
  'Privileged / policy actions: impersonation, client_contact_shared, guide_contact_share_attempt, guide_suspended_contact_policy';
