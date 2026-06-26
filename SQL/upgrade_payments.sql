-- Wallet rarity-upgrade sessions: payment_id binds user ↔ NFT ↔ prep (no trust in URL token_id alone).
CREATE TABLE IF NOT EXISTS public.upgrade_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  user_nft_id uuid NOT NULL REFERENCES public.user_nfts (id) ON DELETE CASCADE,
  prep_action text NOT NULL,
  expected_enr_cost integer NOT NULL,
  expected_min_wei bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'paid', 'expired', 'failed', 'consumed')),
  tx_hash text,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_upgrade_payments_user_created
  ON public.upgrade_payments (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_upgrade_payments_nft_status
  ON public.upgrade_payments (user_nft_id, status);

COMMENT ON TABLE public.upgrade_payments IS
  'Wallet upgrade intent: pending until verify-upgrade-payment confirms on-chain tx; consumed after upgrade-nft completes.';

ALTER TABLE public.upgrade_payments ENABLE ROW LEVEL SECURITY;
