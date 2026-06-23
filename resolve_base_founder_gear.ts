/** Canonical copy: ../_shared/resolve_base_founder_gear.ts — keep in sync. Vendored for deploy bundle. */

export type ResolvedBaseFounderGear = {
  base_nft_id: string
  token_id: string
  durability: number
  multiplier: number
  daily_cap_km: number
  wallet_address_normalized: string
}

export type RoninEconomyPrecheck = {
  active: boolean
  nft_id: string | null
}

export type EarningChain = 'ronin' | 'base'

export function normalizeEarningChain(raw: unknown): EarningChain | null {
  const s = String(raw ?? '').trim().toLowerCase()
  if (s === 'ronin' || s === 'base') return s
  return null
}

export function resolveSessionEarningChain(row: {
  earning_chain?: string | null
  nft_id?: string | null
  base_nft_id?: string | null
}): EarningChain | null {
  const explicit = normalizeEarningChain(row.earning_chain)
  if (explicit) return explicit
  const hasBase =
    row.base_nft_id != null && String(row.base_nft_id).trim() !== ''
  const hasRonin = row.nft_id != null && String(row.nft_id).trim() !== ''
  if (hasBase && !hasRonin) return 'base'
  if (hasRonin && !hasBase) return 'ronin'
  return null
}

export function normalizeEvmAddressBase(input: string): string | null {
  const s = input.trim().toLowerCase()
  if (!/^0x[a-f0-9]{40}$/.test(s)) return null
  return s
}

export function baseFounderGearMultiplier(): number {
  const raw = Deno.env.get('BASE_FOUNDER_GEAR_MULTIPLIER')?.trim()
  const n = raw ? Number(raw) : DEFAULT_BASE_FOUNDER_GEAR_MULTIPLIER
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_BASE_FOUNDER_GEAR_MULTIPLIER
}

export function baseFounderGearDailyCapKm(): number {
  const raw = Deno.env.get('BASE_FOUNDER_GEAR_DAILY_CAP_KM')?.trim()
  const n = raw ? Number(raw) : DEFAULT_BASE_FOUNDER_GEAR_DAILY_CAP_KM
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_BASE_FOUNDER_GEAR_DAILY_CAP_KM
}

export async function resolveRoninEconomyPrecheck(
  supabase: SupabaseClient,
  userId: string,
): Promise<RoninEconomyPrecheck> {
  const { data: wallet } = await supabase
    .from('wallet_connections')
    .select('is_confirmed')
    .eq('user_id', userId)
    .eq('is_confirmed', true)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!wallet?.is_confirmed) {
    return { active: false, nft_id: null }
  }

  const { data: nft } = await supabase
    .from('user_nfts')
    .select('id')
    .eq('user_id', userId)
    .eq('is_active', true)
    .maybeSingle()

  const nftId = nft?.id != null ? String(nft.id) : null
  return { active: nftId != null, nft_id: nftId }
}

  if (!walletNorm) return null

  const { data: nft } = await supabase
    .from('user_base_nfts')
    .select('id, token_id, durability, wallet_address_normalized')
    .eq('user_id', userId)
    .eq('chain', BASE_CHAIN)
    .eq('is_active', true)
    .eq('wallet_address_normalized', walletNorm)
    .maybeSingle()

  if (!nft?.id) return null

  const rowWallet = normalizeEvmAddressBase(String(nft.wallet_address_normalized ?? ''))
  if (!rowWallet || rowWallet !== walletNorm) return null

  return {
    base_nft_id: String(nft.id),
    token_id: String(nft.token_id),
    durability: Math.min(100, Math.max(0, Number(nft.durability ?? 100))),
    multiplier: baseFounderGearMultiplier(),
    daily_cap_km: baseFounderGearDailyCapKm(),
    wallet_address_normalized: walletNorm,
  }
}

export async function loadBaseFounderGearById(
  supabase: SupabaseClient,
  userId: string,
  baseNftId: string,
): Promise<ResolvedBaseFounderGear | null> {
  const id = baseNftId.trim()
  if (!id) return null

  const { data: nft } = await supabase
    .from('user_base_nfts')
    .select('id, token_id, durability, wallet_address_normalized, user_id')
    .eq('id', id)
    .eq('user_id', userId)
    .eq('chain', BASE_CHAIN)
    .maybeSingle()

  if (!nft?.id) return null

  const walletNorm = normalizeEvmAddressBase(String(nft.wallet_address_normalized ?? ''))
  if (!walletNorm) return null

  return {
    base_nft_id: String(nft.id),
    token_id: String(nft.token_id),
    durability: Math.min(100, Math.max(0, Number(nft.durability ?? 100))),
    multiplier: baseFounderGearMultiplier(),
    daily_cap_km: baseFounderGearDailyCapKm(),
    wallet_address_normalized: walletNorm,
  }
}
