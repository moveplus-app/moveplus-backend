-- Option A: draft activity row at track start (start-activity) + mint lock aligned with that shoe.
-- tracking_live: true from start-activity until client save UPDATE clears it (metrics written).

ALTER TABLE public.activity_sessions
ADD COLUMN IF NOT EXISTS tracking_live boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.activity_sessions.tracking_live IS
  'True for server draft created at track start; set false when client saves distance/duration to the row.';

ALTER TABLE public.mint_sessions
ADD COLUMN IF NOT EXISTS locked_user_nft_id uuid REFERENCES public.user_nfts(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.mint_sessions.locked_user_nft_id IS
  'Set on first mint-energy for this mint row; economy uses this instead of current is_active.';

-- Prevent clients from rewriting locked NFT after start.
CREATE OR REPLACE FUNCTION public.activity_sessions_preserve_nft_id()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.nft_id IS NOT NULL AND NEW.nft_id IS DISTINCT FROM OLD.nft_id THEN
    NEW.nft_id := OLD.nft_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_activity_sessions_preserve_nft_id ON public.activity_sessions;
CREATE TRIGGER trg_activity_sessions_preserve_nft_id
  BEFORE UPDATE ON public.activity_sessions
  FOR EACH ROW
  EXECUTE FUNCTION public.activity_sessions_preserve_nft_id();
