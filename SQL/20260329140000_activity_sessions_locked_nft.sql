-- Lock equipped user_nfts row on each activity insert (complete-activity uses activity_sessions.nft_id).
-- BEFORE INSERT: nft_id = current is_active shoe for this user (server truth; not client-supplied).

ALTER TABLE public.activity_sessions
ADD COLUMN IF NOT EXISTS nft_id uuid REFERENCES public.user_nfts(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.activity_sessions.nft_id IS
  'user_nfts row locked at insert from is_active; complete-activity resolves economy/wear from this id.';

CREATE INDEX IF NOT EXISTS idx_activity_sessions_user_pending_finalize
ON public.activity_sessions(user_id)
WHERE is_finalized = false;

CREATE OR REPLACE FUNCTION public.activity_sessions_assign_locked_nft()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.user_id IS NOT NULL THEN
    SELECT un.id INTO NEW.nft_id
    FROM public.user_nfts un
    WHERE un.user_id = NEW.user_id
      AND un.is_active = true
    LIMIT 1;
  ELSE
    NEW.nft_id := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_activity_sessions_locked_nft ON public.activity_sessions;
CREATE TRIGGER trg_activity_sessions_locked_nft
  BEFORE INSERT ON public.activity_sessions
  FOR EACH ROW
  EXECUTE FUNCTION public.activity_sessions_assign_locked_nft();
