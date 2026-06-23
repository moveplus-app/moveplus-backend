// ============================================
// MOVE+ CLAIM STARTER GEAR — Season 1 Common only (rarity 0)
// ============================================


const COMMON_RARITY = 0
const MIN_TOTAL_VALID_DISTANCE_METERS = 3000
const MIN_ACCOUNT_AGE_HOURS = 24
const STARTER_GEAR_SETTINGS_ID = 'season1_common'
const STARTER_GEAR_SUPPLY_FULL_MSG = 'Starter Gear supply is fully claimed.'
const CLAIM_ALREADY_MSG = 'Starter Gear already claimed or pending.'
const MINT_SYNC_SUPPORT_MSG =
  'Starter Gear minted, but app sync needs support review.'
const CLAIM_TEMPORARILY_UNAVAILABLE_MSG =
  'Claim is temporarily unavailable.'
const NETWORK_BUSY_MSG = 'Network is busy. Please try again.'
const DEFAULT_MAX_COMMON_TOKEN_ID = 1000

const BLOCKING_CLAIM_STATUSES = new Set([
  'pending',
  'claimed',
  'minted_sync_failed',
])

type StarterGearClaimSettings = {
  is_enabled: boolean
  max_token_id: number
}

type SupabaseAdmin = ReturnType<typeof createClient>

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

function isBlockedRoninRpcUrl(url: string): boolean {
  const lower = url.trim().toLowerCase()
  return BLOCKED_RPC_HOST_MARKERS.some((marker) => lower.includes(marker))
}

function isUsableRpcUrl(url: string | undefined): url is string {
  if (!url?.trim()) return false
  const trimmed = url.trim()
  if (isBlockedRoninRpcUrl(trimmed)) return false
  try {
    const parsed = new URL(trimmed)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}

/**
 * RONIN_RPC_URL → RONIN_RPC_URL_INDEXER → https://api.roninchain.com/rpc
 * Skips rpc.roninchain.com (DNS failure on Supabase Edge).
 */
function resolveRoninRpcConfig(): { url: string; envKey: RoninRpcEnvSource } | null {
  const mainRaw = Deno.env.get('RONIN_RPC_URL')?.trim()
  if (mainRaw && isBlockedRoninRpcUrl(mainRaw)) {
    console.warn(
      `[claim-starter-gear] rpc ignored env=RONIN_RPC_URL host=${rpcHostForLog(mainRaw)} (blocked)`,
    )
  } else if (isUsableRpcUrl(mainRaw)) {
    return { url: mainRaw, envKey: 'RONIN_RPC_URL' }
  }

  const indexerRaw = Deno.env.get('RONIN_RPC_URL_INDEXER')?.trim()
  if (indexerRaw && isBlockedRoninRpcUrl(indexerRaw)) {
    console.warn(
      `[claim-starter-gear] rpc ignored env=RONIN_RPC_URL_INDEXER host=${rpcHostForLog(indexerRaw)} (blocked)`,
    )
  } else if (isUsableRpcUrl(indexerRaw)) {
    return { url: indexerRaw, envKey: 'RONIN_RPC_URL_INDEXER' }
  }

  if (isUsableRpcUrl(OFFICIAL_PUBLIC_RPC)) {
    return { url: OFFICIAL_PUBLIC_RPC, envKey: 'OFFICIAL_PUBLIC_RPC' }
  }

  return null
}

function rpcHostForLog(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return '(invalid-rpc-url)'
  }
}

function isRpcRateLimitError(err: unknown): boolean {
  const s = String(err ?? '').toLowerCase()
  return (
    s.includes('too many requests') ||
    s.includes('rate limit') ||
    s.includes('rate-limited') ||
    (s.includes('429') && s.includes('request')) ||
    (s.includes('server_error') && s.includes('many'))
  )
}

function userFacingMintRevertError(
  err: unknown,
): { message: string; status: number } | null {
  if (isRpcRateLimitError(err)) {
    return { message: NETWORK_BUSY_MSG, status: 503 }
  }
  const s = String(err ?? '').toLowerCase()
  if (
    s.includes('paused') ||
    s.includes('pausable') ||
    s.includes('operator') ||
    s.includes('not operator') ||
    s.includes('caller is not') ||
    s.includes('enforced pause')
  ) {
    return { message: CLAIM_TEMPORARILY_UNAVAILABLE_MSG, status: 503 }
  }
  if (
    s.includes('sold out') ||
    s.includes('exceed') ||
    s.includes('max common') ||
    s.includes('common cap') ||
    (s.includes('supply') && s.includes('common')) ||
    s.includes('nextcommonid')
  ) {
    return {
      message: STARTER_GEAR_SUPPLY_FULL_MSG,
      status: 400,
    }
  }
  return null
}

function isCommonSoldOutRevert(err: unknown): boolean {
  const mapped = userFacingMintRevertError(err)
  return mapped?.message === STARTER_GEAR_SUPPLY_FULL_MSG
}

function isCommonSupplyExhausted(
  tokenId: string,
  maxTokenId: number,
): boolean {
  try {
    return BigInt(tokenId) >= BigInt(maxTokenId)
  } catch {
    const n = Number(tokenId)
    return Number.isFinite(n) && n >= maxTokenId
  }
}

async function loadStarterGearSettings(
  admin: SupabaseAdmin,
): Promise<StarterGearClaimSettings> {
  const { data, error } = await admin
    .from('starter_gear_claim_settings')
    .select('is_enabled,max_token_id')
    .eq('id', STARTER_GEAR_SETTINGS_ID)
    .maybeSingle()

  if (error) {
    console.error('[claim-starter-gear] settings read failed', error.message)
    return { is_enabled: true, max_token_id: DEFAULT_MAX_COMMON_TOKEN_ID }
  }

  if (!data) {
    return { is_enabled: true, max_token_id: DEFAULT_MAX_COMMON_TOKEN_ID }
  }

  const maxTokenId = Number(data.max_token_id ?? DEFAULT_MAX_COMMON_TOKEN_ID)
  return {
    is_enabled: data.is_enabled !== false,
    max_token_id: Number.isFinite(maxTokenId) && maxTokenId > 0
      ? maxTokenId
      : DEFAULT_MAX_COMMON_TOKEN_ID,
  }
}

function isUniqueViolation(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false
  if (err.code === '23505') return true
  const msg = String(err.message ?? '').toLowerCase()
  return msg.includes('duplicate key') || msg.includes('unique constraint')
}

type StarterGearClaimRow = {
  id: string
  status: string
  token_id: string | null
  tx_hash: string | null
}

function claimBlockedResponse(
  row: Pick<StarterGearClaimRow, 'token_id' | 'tx_hash'> | null,
  status = 409,
): Response {
  return jsonResponse({
    success: false,
    error: CLAIM_ALREADY_MSG,
    claim_blocked: true,
    token_id: row?.token_id ?? undefined,
    tx_hash: row?.tx_hash ?? undefined,
  }, status)
}

function buildPendingClaimMetadata(
  totalValidDistance: number,
  contractNorm: string,
  tokenUri: string,
): Record<string, unknown> {
  return {
    requirement_meters: MIN_TOTAL_VALID_DISTANCE_METERS,
    total_valid_distance_meters: Math.floor(totalValidDistance),
    contract_address: contractNorm,
    rarity: 'common',
    on_chain_rarity: COMMON_RARITY,
    token_uri: tokenUri,
    pending_started_at: new Date().toISOString(),
  }
}

async function acquirePendingClaim(
  admin: SupabaseAdmin,
  params: {
    userId: string
    walletAddress: string
    deviceIdHash: string | null
    metadata: Record<string, unknown>
  },
): Promise<{ claimId: string } | { response: Response }> {
  const { userId, walletAddress, deviceIdHash, metadata } = params

  const { data: byUser, error: byUserErr } = await admin
    .from('starter_gear_claims')
    .select('id,status,token_id,tx_hash')
    .eq('user_id', userId)
    .maybeSingle()

  if (byUserErr) {
    console.error('[claim-starter-gear] claim lookup failed', byUserErr.message)
    return {
      response: jsonResponse({
        success: false,
        error: 'Could not start Starter Gear claim.',
        details: byUserErr.message,
      }, 500),
    }
  }

  if (byUser) {
    if (byUser.status === 'failed') {
      const { data: reclaimed, error: reclaimErr } = await admin
        .from('starter_gear_claims')
        .update({
          status: 'pending',
          wallet_address: walletAddress,
          device_id_hash: deviceIdHash,
          token_id: null,
          tx_hash: null,
          claimed_at: null,
          metadata: {
            ...metadata,
            retry_from_failed: true,
            pending_started_at: new Date().toISOString(),
          },
        })
        .eq('id', byUser.id)
        .eq('status', 'failed')
        .select('id')
        .maybeSingle()

      if (reclaimErr || !reclaimed?.id) {
        return { response: claimBlockedResponse(byUser) }
      }
      return { claimId: reclaimed.id }
    }

    if (BLOCKING_CLAIM_STATUSES.has(byUser.status)) {
      return { response: claimBlockedResponse(byUser) }
    }

    return { response: claimBlockedResponse(byUser) }
  }

  const { data: inserted, error: insertErr } = await admin
    .from('starter_gear_claims')
    .insert({
      user_id: userId,
      wallet_address: walletAddress,
      device_id_hash: deviceIdHash,
      status: 'pending',
      claim_reason: 'starter_gear_3km',
      metadata,
    })
    .select('id')
    .single()

  if (insertErr) {
    if (isUniqueViolation(insertErr)) {
      let conflict: StarterGearClaimRow | null = null
      const { data: byUserConflict } = await admin
        .from('starter_gear_claims')
        .select('id,status,token_id,tx_hash')
        .eq('user_id', userId)
        .maybeSingle()
      conflict = byUserConflict

      if (!conflict) {
        const { data: byWalletConflict } = await admin
          .from('starter_gear_claims')
          .select('id,status,token_id,tx_hash')
          .eq('wallet_address', walletAddress)
          .maybeSingle()
        conflict = byWalletConflict
      }

      if (!conflict && deviceIdHash) {
        const { data: byDeviceConflict } = await admin
          .from('starter_gear_claims')
          .select('id,status,token_id,tx_hash')
          .eq('device_id_hash', deviceIdHash)
          .maybeSingle()
        conflict = byDeviceConflict
      }

      if (conflict?.status === 'failed' && conflict.id) {
        const { data: reclaimed, error: reclaimErr } = await admin
          .from('starter_gear_claims')
          .update({
            status: 'pending',
            wallet_address: walletAddress,
            device_id_hash: deviceIdHash,
            token_id: null,
            tx_hash: null,
            claimed_at: null,
            metadata: {
              ...metadata,
              retry_from_failed: true,
              pending_started_at: new Date().toISOString(),
            },
          })
          .eq('id', conflict.id)
          .eq('status', 'failed')
          .select('id')
          .maybeSingle()

        if (!reclaimErr && reclaimed?.id) {
          return { claimId: reclaimed.id }
        }
      }

     

  return { claimId: inserted.id }
}

async function updateClaimRow(
  admin: SupabaseAdmin,
  claimId: string,
  patch: Record<string, unknown>,
): Promise<{ error: string | null }> {
  const { error } = await admin
    .from('starter_gear_claims')
    .update(patch)
    .eq('id', claimId)

  if (error) {
    console.error('[claim-starter-gear] claim update failed', {
      claimId,
      patch,
      message: error.message,
    })
    return { error: error.message }
  }
  return { error: null }
}

async function disableStarterGearClaims(
  admin: SupabaseAdmin,
  reason: string,
): Promise<void> {
  const { error } = await admin
    .from('starter_gear_claim_settings')
    .update({
      is_enabled: false,
      disabled_at: new Date().toISOString(),
      disabled_reason: reason,
      updated_at: new Date().toISOString(),
    })
    .eq('id', STARTER_GEAR_SETTINGS_ID)

  if (error) {
    console.error('[claim-starter-gear] disable settings failed', error.message)
  } else {
    console.log('[claim-starter-gear] starter gear claims disabled', { reason })
  }
}

function userFacingErrorFromUnknown(err: unknown): { message: string; status: number } {
  const mapped = userFacingMintRevertError(err)
  if (mapped) return mapped
  return {
    message: 'Starter Gear claim failed. Please try again.',
    status: 500,
  }
}

/** Non-empty tokenURI for mint; actual token id comes from receipt logs. */
function buildStarterGearTokenUri(metadataCid: string): string {
  const cid = metadataCid?.trim()
  if (cid) {
    return `ipfs://${cid}/starter-common.json`
  }
  return STARTER_GEAR_GENERIC_TOKEN_URI
}

function logRpcPreflight(envKey: RoninRpcEnvSource, rpcUrl: string): void {
  console.log(
    `[claim-starter-gear] rpc source = ${envKey}, host = ${rpcHostForLog(rpcUrl)}`,
  )
  

function resolveSeasonContractAddress(): string {
  return (
    Deno.env.get('NFT_MINT_CONTRACT_ADDRESS')?.trim() ||
    Deno.env.get('NFTV2_CONTRACT_ADDRESS')?.trim() ||
    Deno.env.get('NFT_CONTRACT_ADDRESS')?.trim() ||
    DEFAULT_NFT_CONTRACT
  )
}

function resolveGenesisContractAddress(): string {
  return (
    Deno.env.get('GENESIS_NFT_CONTRACT_ADDRESS')?.trim() ||
    DEFAULT_GENESIS_CONTRACT
  )
}

function normalizeRoninAddress(input: string): string {
  const s = String(input ?? '').trim()
  if (!s) return ''
  if (s.startsWith('ronin:')) {
    const rest = s.slice('ronin:'.length)
    if (rest.startsWith('0x')) return rest.toLowerCase()
    return `0x${rest}`.toLowerCase()
  }
  return s.toLowerCase()
}

function checksumAddress(value: string): string {
  try {
    return ethers.getAddress(value)
  } catch {
    return value
  }
}

function hoursSince(dateRaw: string | null | undefined): number {
  if (!dateRaw) return 0
  const t = new Date(dateRaw).getTime()
  if (!Number.isFinite(t)) return 0
  return (Date.now() - t) / 1000 / 60 / 60
}



function parseMintedTokenId(
  receipt: ethers.TransactionReceipt | null,
  iface: ethers.Interface,
): string | null {
  if (!receipt?.logs?.length) return null
  for (const log of receipt.logs) {
    try {
      const ev = iface.parseLog({
        topics: log.topics as string[],
        data: log.data,
      })
      if (ev?.name === 'Minted') {
        const args = ev.args as unknown as { tokenId?: bigint }
        const tid = args.tokenId
        if (tid != null) return BigInt(tid.toString()).toString()
      }
    } catch {
      continue
    }
  }
  for (const log of receipt.logs) {
    try {
      const ev = iface.parseLog({
        topics: log.topics as string[],
        data: log.data,
      })
      if (ev?.name === 'Transfer') {
        const from = ev.args[0] as string
        const tokenId = ev.args[2] as bigint
        if (from === ethers.ZeroAddress) {
          return tokenId.toString()
        }
      }
    } catch {
      continue
    }
  }
  return null
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS })
  }

  if (req.method !== 'POST') {
    return jsonResponse({ success: false, error: 'Method not allowed' }, 405)
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const serviceRole = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    const rpcConfig = resolveRoninRpcConfig()
    if (!rpcConfig) {
      return jsonResponse(
        { success: false, error: 'RONIN_RPC_URL missing or invalid' },
        500,
      )
    }
   

    if (!hotPrivateKey || !seasonContract) {
      return jsonResponse(
        { success: false, error: 'Server config missing: mint config' },
        500,
      )
    }

    const authHeader = req.headers.get('Authorization') ?? ''
    const jwt = authHeader.replace(/^Bearer\s+/i, '').trim()
    if (!jwt) {
      return jsonResponse({ success: false, error: 'Unauthorized' }, 401)
    }

    const body = await req.json().catch(() => ({} as Record<string, unknown>))

    if (
      body.rarity !== undefined ||
      body.rarity_id !== undefined ||
      body.token_id !== undefined
    ) {
      return jsonResponse({
        success: false,
        error: 'Starter Gear is Common only; rarity and token_id cannot be specified.',
      }, 400)
    }

    const deviceIdHash =
      String(body.device_id_hash ?? '').trim() || null

    const admin = createClient(supabaseUrl, serviceRole, {
      auth: { persistSession: false },
    })

    const claimSettings = await loadStarterGearSettings(admin)
    if (!claimSettings.is_enabled) {
      return jsonResponse({
        success: false,
        error: STARTER_GEAR_SUPPLY_FULL_MSG,
      }, 400)
    }

    const { data: userData, error: userErr } = await admin.auth.getUser(jwt)
    if (userErr || !userData?.user) {
      return jsonResponse({ success: false, error: 'Unauthorized' }, 401)
    }

    const user = userData.user
    const userId = user.id

    if (!user.email_confirmed_at) {
      return jsonResponse({
        success: false,
        error: 'Please verify your email before claiming Starter Gear.',
      }, 400)
    }

    if (hoursSince(user.created_at) < MIN_ACCOUNT_AGE_HOURS) {
      return jsonResponse({
        success: false,
        error:
          'Starter Gear can be claimed after your account is at least 24 hours old.',
      }, 400)
    }


    if (walletErr) {
      return jsonResponse({
        success: false,
        error: 'Could not check connected account.',
        details: walletErr.message,
      }, 500)
    }

    const walletRow = walletRows?.[0]
    const walletAddress = normalizeRoninAddress(
      String(walletRow?.wallet_address ?? ''),
    )

    if (!walletAddress || !walletRow?.is_confirmed) {
      return jsonResponse({
        success: false,
        error:
          'Please connect and verify your account before claiming Starter Gear.',
      }, 400)
    }

    const registeredContracts = uniqueContractAddresses([
      seasonContract,
      genesisContract,
    ]).map((c) => normalizeRoninAddress(c))

   

    if (ownedGearErr) {
      return jsonResponse({
        success: false,
        error: 'Could not check existing Gear.',
        details: ownedGearErr.message,
      }, 500)
    }

    if ((ownedGearRows?.length ?? 0) > 0) {
      return jsonResponse({
        success: false,
        error:
          'Starter Gear is only available for accounts without existing Gear.',
      }, 409)
    }

    

    if (activityErr) {
      return jsonResponse({
        success: false,
        error: 'Could not check activity progress.',
        details: activityErr.message,
      }, 500)
    }

    const totalValidDistance = (activityRows ?? []).reduce((sum, row) => {
      const meters = Number(row.distance_meters ?? 0)
      if (!Number.isFinite(meters) || meters <= 0) return sum
      return sum + meters
    }, 0)

    if (totalValidDistance < MIN_TOTAL_VALID_DISTANCE_METERS) {
      return jsonResponse({
        success: false,
        error:
          'Complete 3km of valid walking or running to claim Starter Gear.',
        progress_meters: Math.floor(totalValidDistance),
        required_meters: MIN_TOTAL_VALID_DISTANCE_METERS,
      }, 400)
    }

    const seasonAddress = checksumAddress(
      normalizeRoninAddress(seasonContract),
    )
    

    const pendingAcquire = await acquirePendingClaim(admin, {
      userId,
      walletAddress,
      deviceIdHash,
      metadata: pendingMetadata,
    })
    if ('response' in pendingAcquire) {
      return pendingAcquire.response
    }
    const claimId = pendingAcquire.claimId

    const provider = new ethers.JsonRpcProvider(
      rpcConfig.url,
      RONIN_MAINNET_CHAIN_ID,
    )
    const hotWallet = new ethers.Wallet(hotPrivateKey, provider)
    const shoe = new ethers.Contract(seasonAddress, MOVE_SHOE_ABI, hotWallet)
    const iface = shoe.interface

  

    let tx: ethers.ContractTransactionResponse | null = null
    try {
      tx = await shoe.mintWithRarity(
        checksumAddress(walletAddress),
        COMMON_RARITY,
        tokenUri,
      )
    } catch (e) {
      console.error('[claim-starter-gear] mint tx send', e)
      if (isCommonSoldOutRevert(e)) {
        await updateClaimRow(admin, claimId, {
          status: 'failed',
          metadata: {
            ...pendingMetadata,
            failure_reason: 'supply_full',
          },
        })
        await disableStarterGearClaims(admin, 'max_common_supply_claimed')
        return jsonResponse({
          success: false,
          error: STARTER_GEAR_SUPPLY_FULL_MSG,
        }, 400)
      }
      await updateClaimRow(admin, claimId, {
        status: 'failed',
        metadata: {
          ...pendingMetadata,
          failure_reason: 'mint_send_failed',
          failure_at: new Date().toISOString(),
        },
      })
      const { message, status } = userFacingErrorFromUnknown(e)
      return jsonResponse({ success: false, error: message }, status)
    }

  
    const txHash = receipt?.hash ?? tx.hash

    if (!receipt || receipt.status !== 1) {
      await updateClaimRow(admin, claimId, {
        status: 'minted_sync_failed',
        tx_hash: txHash,
        metadata: {
          ...pendingMetadata,
          failure_reason: 'receipt_not_success',
        },
      })
      return jsonResponse({
        success: false,
        error: 'Starter Gear mint failed.',
        tx_hash: txHash,
        claim_blocked: true,
      }, 500)
    }

    const chainTokenId = parseMintedTokenId(receipt, iface)
    if (!chainTokenId) {
      console.error('[claim-starter-gear] mint ok but token id missing in receipt', {
        tx_hash: txHash,
      })
      await updateClaimRow(admin, claimId, {
        status: 'minted_sync_failed',
        tx_hash: txHash,
        metadata: {
          ...pendingMetadata,
          failure_reason: 'token_id_parse_failed',
        },
      })
      return jsonResponse({
        success: false,
        error: MINT_SYNC_SUPPORT_MSG,
        tx_hash: txHash,
        claim_blocked: true,
      }, 500)
    }

    const imageUrl = `ipfs://${imagesCid}/${chainTokenId}.png`

    // Columns aligned with verify-nfts / index-nft-transfers inserts (no updated_at on user_nfts).
    const nowIso = new Date().toISOString()
    const { error: nftUpsertErr } = await admin.from('user_nfts').upsert(
      {
        user_id: userId,
        wallet_address: walletAddress,
        token_id: chainTokenId,
        contract_address: contractNorm,
        rarity: 'common',
        level: 1,
        level_uncapped: 1,
        total_distance: 0,
        level_progress_meters: 0,
        durability: 100,
        is_active: false,
        is_deprecated: false,
        image_url: imageUrl,
        last_verified_at: nowIso,
      },
      { onConflict: 'contract_address,token_id' },
    )

    if (nftUpsertErr) {
      console.error('[claim-starter-gear] user_nfts upsert after mint', nftUpsertErr)
      await updateClaimRow(admin, claimId, {
        status: 'minted_sync_failed',
        token_id: chainTokenId,
        tx_hash: txHash,
        metadata: {
          ...pendingMetadata,
          failure_reason: 'user_nfts_upsert_failed',
          minted_by: hotWallet.address,
        },
      })
      return jsonResponse({
        success: false,
        error: MINT_SYNC_SUPPORT_MSG,
        token_id: chainTokenId,
        tx_hash: txHash,
        claim_blocked: true,
        details: nftUpsertErr.message,
      }, 500)
    }

    const claimedAt = nowIso
    const { error: claimFinalizeErr } = await updateClaimRow(admin, claimId, {
      status: 'claimed',
      token_id: chainTokenId,
      tx_hash: txHash,
      claimed_at: claimedAt,
      metadata: {
        ...pendingMetadata,
        minted_by: hotWallet.address,
        claimed_at: claimedAt,
      },
    })

    if (claimFinalizeErr) {
      console.error('[claim-starter-gear] claim finalize after mint', claimFinalizeErr)
      await updateClaimRow(admin, claimId, {
        status: 'minted_sync_failed',
        token_id: chainTokenId,
        tx_hash: txHash,
        metadata: {
          ...pendingMetadata,
          failure_reason: 'claim_finalize_failed',
          minted_by: hotWallet.address,
        },
      })
      return jsonResponse({
        success: false,
        error: MINT_SYNC_SUPPORT_MSG,
        token_id: chainTokenId,
        tx_hash: txHash,
        claim_blocked: true,
        details: claimFinalizeErr,
      }, 500)
    }

    if (isCommonSupplyExhausted(chainTokenId, claimSettings.max_token_id)) {
      await disableStarterGearClaims(admin, 'max_common_supply_claimed')
    }

    return jsonResponse({
      success: true,
      token_id: chainTokenId,
      tx_hash: txHash,
      rarity: 'common',
      message: 'Starter Gear claimed successfully.',
    })
  } catch (err) {
    console.error('[claim-starter-gear] error', err)
    const { message, status } = userFacingErrorFromUnknown(err)
    return jsonResponse({ success: false, error: message }, status)
  }
})
