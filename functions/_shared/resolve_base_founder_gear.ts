// Canonical Base Founder Gear economy resolver — edit here, then copy to each function folder:
//   start-activity/resolve_base_founder_gear.ts
//   mint-energy/resolve_base_founder_gear.ts
//   complete-activity/resolve_base_founder_gear.ts
// Supabase deploy bundles each function alone — ../_shared/ is NOT included on deploy.
import type { SupabaseClient } from 'https://'



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

/** Session earning context: explicit lock wins; else infer from locked columns (legacy rows). */
export function resolveSessionEarningChain(row: {
  earning_chain?: string | null
  nft_id?: string | null
  base_nft_id?: string | null
}): EarningChain | null {
  return normalizeEarningChain(row.earning_chain)
}

/**
 * True only when the session is genuinely on the Base gear earning path.
 * Does NOT treat "Ronin inactive" / free Web2 users as Base — avoids pausing global Energy.
 */
export function isBaseGearEarningSession(input: {
  sessionEarningChain?: EarningChain | null
  activityBaseNftId?: string | null
  lockedUserBaseNftId?: string | null
}): boolean {
  if (input.sessionEarningChain === 'base') return true
  if (input.sessionEarningChain === 'ronin') return false
  const activityBase = String(input.activityBaseNftId ?? '').trim()
  if (activityBase) return true
  const lockedBase = String(input.lockedUserBaseNftId ?? '').trim()
  if (lockedBase) return true
  return false
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

/** Ronin earning path: confirmed wallet_connections + active user_nfts row. */
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

/**
 * Active Base Founder Gear for earning — server-side only.
 * Requires active user_wallets (chain=base) and matching is_active user_base_nfts row.
 */
export async function resolveActiveBaseFounderGear(
  supabase: SupabaseClient,
  userId: string,
): Promise<ResolvedBaseFounderGear | null> {
  const { data: baseWallet } = await supabase
    .from('user_wallets')
    .select('wallet_address_normalized')
    .eq('user_id', userId)
    .eq('chain', BASE_CHAIN)
    .eq('is_active', true)
    .order('verified_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const walletNorm = normalizeEvmAddressBase(
    String(baseWallet?.wallet_address_normalized ?? ''),
  )
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

/** Load Base gear by session lock id; validates user ownership. */
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
