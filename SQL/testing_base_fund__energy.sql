-- ============================================
-- Fund Base chain Energy (test / admin only)
-- ============================================
-- Run in Supabase Dashboard → SQL Editor (uses service_role context).
--
-- Credits user_chain_balances(chain='base') ONLY.
-- Does NOT modify:
--   - users.energy_points  (Ronin / global Energy)
--   - users.enr_balance    (Ronin / global ENR)
--   - user_chain_balances(chain='ronin')
-- ============================================

DO $$
DECLARE
  v_user_id uuid := 'YOUR UUID';
  v_base_wallet text := 'YOUR WALLET';
  v_energy_amount numeric := 1000;
  v_bal jsonb;
BEGIN
  -- Sanity check: linked Base wallet (warn only — credit still applies to user_id)
  IF NOT EXISTS (
    SELECT 1
    FROM public.user_wallets uw
    WHERE uw.user_id = v_user_id
      AND uw.chain = 'base'
      AND lower(trim(uw.wallet_address)) = lower(trim(v_base_wallet))
      AND uw.is_active = true
  ) THEN
    RAISE WARNING
      'Active Base wallet % not found for user %. Crediting user_id anyway.',
      v_base_wallet, v_user_id;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = v_user_id) THEN
    RAISE EXCEPTION 'User % not found in auth.users', v_user_id;
  END IF;

  v_bal := public.increment_chain_balance(
    v_user_id,
    'base',
    v_energy_amount,
    0
  );

  IF v_bal IS NULL THEN
    RAISE EXCEPTION 'increment_chain_balance failed for user % chain base', v_user_id;
  END IF;

  INSERT INTO public.chain_balance_history (
    user_id,
    chain,
    energy_delta,
    enr_delta,
    transaction_type,
    description
  ) VALUES (
    v_user_id,
    'base',
    v_energy_amount,
    0,
    'admin_test',
    format(
      'manual test grant: +%s Base Energy (wallet %s)',
      v_energy_amount::text,
      v_base_wallet
    )
  );

  RAISE NOTICE 'Base Energy credited. New balances: energy=%, enr=%',
    v_bal->>'energy_balance',
    v_bal->>'enr_balance';
END $$;

-- --- Verify Base balance ---
SELECT
  user_id,
  chain,
  floor(energy_balance)::bigint AS base_energy,
  floor(enr_balance)::bigint AS base_enr,
  updated_at
FROM public.user_chain_balances
WHERE user_id = 'USER UUID'
  AND chain = 'base';

-- --- Confirm Ronin/global balances unchanged (read-only check) ---
SELECT
  id,
  floor(energy_points)::bigint AS global_energy,
  floor(enr_balance)::bigint AS global_enr
FROM public.users
WHERE id = 'USER UUID';

-- --- Confirm no Ronin chain row was created/modified ---
SELECT
  user_id,
  chain,
  floor(energy_balance)::bigint AS energy,
  floor(enr_balance)::bigint AS enr
FROM public.user_chain_balances
WHERE user_id = 'USER UUID'
  AND chain = 'ronin';
