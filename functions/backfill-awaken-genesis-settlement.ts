// ADMIN — Backfill missing on-chain burn/treasury for historical awaken_genesis rows.
// Does NOT deduct user ENR again. Does NOT change user_nfts or genesis_awakened.
//
// Auth: header x-admin-key must equal ADMIN_SECRET.
// Query: ?dry_run=true — list affected rows only, no chain/DB writes.
//        ?limit=N — batch size (default 1, max 5).
//        ?id=<uuid> — optional single enr_transactions.id.

import { serve } from 'https://'
import { createClient } from 'https://'
import { ethers } from 'https://'

const DEFAULT_RPC = 'https://'

const ERC20_ABI = [
  'function decimals() view returns (uint8)',
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
]

const ENR_BURNER_ABI = [
  'function burnFromVault(uint256 amount) external',
]

function jsonResponse(body: object, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function isNonEmptyTxHash(v: unknown): v is string {
  return typeof v === 'string' && /^0x[a-fA-F0-9]{64}$/.test(v.trim())
}

function getTreasuryAddress(): string {
  const raw =
    Deno.env.get('ENR_TREASURY_WALLET')?.trim() ||
    Deno.env.get('ENR_TREASURY_ADDRESS')?.trim() ||
    Deno.env.get('TREASURY_WALLET_ADDRESS')?.trim() ||
    Deno.env.get('REWARD_TREASURY_ADDRESS')?.trim() ||
    Deno.env.get('MOVEPLUS_TREASURY_ADDRESS')?.trim()

  if (!raw) {
    throw new Error('Missing treasury address env for upgrade economy settlement')
  }

  return ethers.getAddress(raw.startsWith('0x') ? raw : `0x${raw}`)
}

function getUpgradeSettlementSigner() {
  const rpcUrl = Deno.env.get('RONIN_RPC_URL')?.trim() || DEFAULT_RPC
  const hotKey = Deno.env.get('REWARD_HOT_PRIVATE_KEY')
  const enrToken = Deno.env.get('ENR_TOKEN_ADDRESS')?.trim()
  const burnerAddress = Deno.env.get('ENR_BURNER_ADDRESS')?.trim()

  if (!hotKey) throw new Error('Missing REWARD_HOT_PRIVATE_KEY')
  if (!enrToken) throw new Error('Missing ENR_TOKEN_ADDRESS')
  if (!burnerAddress) throw new Error('Missing ENR_BURNER_ADDRESS')

  const provider = new ethers.JsonRpcProvider(rpcUrl)
  const signer = new ethers.Wallet(hotKey, provider)

  return {
    provider,
    signer,
    enrTokenAddress: ethers.getAddress(enrToken.startsWith('0x') ? enrToken : `0x${enrToken}`),
    burnerAddress: ethers.getAddress(burnerAddress.startsWith('0x') ? burnerAddress : `0x${burnerAddress}`),
    treasuryAddress: getTreasuryAddress(),
  }
}

async function waitSettlementTx(
  tx: ethers.ContractTransactionResponse,
  label: string,
): Promise<string> {
  const receipt = await Promise.race([
    tx.wait(1),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} confirmation timeout`)), 90_000),
    ),
  ])

  if (!receipt || Number(receipt.status) !== 1) {
    throw new Error(`${label} transaction failed`)
  }

  return tx.hash
}

type SettlementLegResult =
  | {
      status: 'settled'
      burnEnr: number
      treasuryEnr: number
      burnTxHash: string
      treasuryTxHash: string
    }
  | {
      status: 'partial'
      burnEnr: number
      treasuryEnr: number
      burnTxHash?: string
      treasuryTxHash?: string
      error: string
    }
  | {
      status: 'failed'
      burnEnr: number
      treasuryEnr: number
      error: string
      burnTxHash?: string
      treasuryTxHash?: string
    }

async function settleMissingLegs(params: {
  costTotal: number
  burnEnr: number
  treasuryEnr: number
  existingBurnTxHash?: string | null
  existingTreasuryTxHash?: string | null
  action: string
}): Promise<SettlementLegResult> {
  const burnEnr = Math.floor(params.burnEnr)
  const treasuryEnr = Math.floor(params.treasuryEnr)
  const costTotal = Math.floor(params.costTotal)

  if (burnEnr + treasuryEnr !== costTotal) {
    return {
      status: 'failed',
      burnEnr,
      treasuryEnr,
      error: 'burn_enr + treasury_enr must equal cost_total',
    }
  }

  let burnTxHash = isNonEmptyTxHash(params.existingBurnTxHash)
    ? params.existingBurnTxHash.trim()
    : undefined
  let treasuryTxHash = isNonEmptyTxHash(params.existingTreasuryTxHash)
    ? params.existingTreasuryTxHash.trim()
    : undefined

  const needBurn = burnEnr > 0 && !burnTxHash
  const needTreasury = treasuryEnr > 0 && !treasuryTxHash

  if (!needBurn && !needTreasury) {
    return {
      status: 'settled',
      burnEnr,
      treasuryEnr,
      burnTxHash: burnTxHash ?? '',
      treasuryTxHash: treasuryTxHash ?? '',
    }
  }

  try {
    const {
      provider,
      signer,
      enrTokenAddress,
      burnerAddress,
      treasuryAddress,
    } = getUpgradeSettlementSigner()

    const enr = new ethers.Contract(enrTokenAddress, ERC20_ABI, signer)
    const burner = new ethers.Contract(burnerAddress, ENR_BURNER_ABI, signer)

    const decimals = Number(await enr.decimals())
    const burnWei = ethers.parseUnits(String(burnEnr), decimals)
    const treasuryWei = ethers.parseUnits(String(treasuryEnr), decimals)
    const requiredWei = (needBurn ? burnWei : 0n) + (needTreasury ? treasuryWei : 0n)

    const hotWallet = await signer.getAddress()
    const minRonEth = Deno.env.get('MINT_NFT_MIN_RON_ETH')?.trim() || '0.1'
    const minRonWei = ethers.parseEther(minRonEth)

    const ronBalance = await provider.getBalance(hotWallet)
    if (ronBalance < minRonWei) {
      throw new Error('Hot wallet RON balance too low for settlement gas')
    }

    const hotEnrBalance = await enr.balanceOf(hotWallet)
    if (hotEnrBalance < requiredWei) {
      throw new Error('Hot wallet ENR balance too low for backfill settlement')
    }

    if (needBurn) {
      const allowance = await enr.allowance(hotWallet, burnerAddress)
      if (allowance < burnWei) {
        throw new Error('Hot wallet ENR allowance to burner is too low')
      }
      const burnTx = await burner.burnFromVault(burnWei)
      burnTxHash = await waitSettlementTx(burnTx, 'backfill awaken ENR burn')
    }

    if (needTreasury) {
      const treasuryTx = await enr.transfer(treasuryAddress, treasuryWei)
      treasuryTxHash = await waitSettlementTx(treasuryTx, 'backfill awaken ENR treasury')
    }

    return {
      status: 'settled',
      burnEnr,
      treasuryEnr,
      burnTxHash: burnTxHash ?? '',
      treasuryTxHash: treasuryTxHash ?? '',
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error('backfill-awaken-genesis-settlement: chain error', {
      action: params.action,
      burn_tx_hash: burnTxHash,
      treasury_tx_hash: treasuryTxHash,
      error: message,
    })

    if (burnTxHash || treasuryTxHash) {
      return {
        status: 'partial',
        burnEnr,
        treasuryEnr,
        burnTxHash,
        treasuryTxHash,
        error: message,
      }
    }

    return {
      status: 'failed',
      burnEnr,
      treasuryEnr,
      burnTxHash,
      treasuryTxHash,
      error: message,
    }
  }
}

type ParsedRow = {
  id: string
  user_id: string
  amount: number
  created_at: string
  token_id: string
  cost_total: number
  burn_enr: number
  treasury_enr: number
  burn_tx_hash: string | null
  treasury_tx_hash: string | null
}

function parseAwakenRow(row: {
  id: string
  user_id: string
  amount: unknown
  metadata: unknown
  created_at: string
}): { ok: true; parsed: ParsedRow } | { ok: false; reason: string } {
  const meta = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
    ? row.metadata as Record<string, unknown>
    : null

  if (!meta) return { ok: false, reason: 'missing_metadata' }

  const tokenId = String(meta.token_id ?? '').trim()
  if (!tokenId) return { ok: false, reason: 'missing_token_id' }

  const costTotal = Math.floor(Number(meta.cost_total ?? Math.abs(Number(row.amount))))
  const burnEnr = Math.floor(Number(meta.burn_enr ?? costTotal / 2))
  const treasuryEnr = Math.floor(Number(meta.treasury_enr ?? costTotal - burnEnr))

  if (!Number.isFinite(costTotal) || costTotal <= 0) {
    return { ok: false, reason: 'invalid_cost_total' }
  }
  if (burnEnr + treasuryEnr !== costTotal) {
    return { ok: false, reason: 'split_mismatch' }
  }

  const burnTx = isNonEmptyTxHash(meta.burn_tx_hash) ? meta.burn_tx_hash.trim() : null
  const treasuryTx = isNonEmptyTxHash(meta.treasury_tx_hash)
    ? meta.treasury_tx_hash.trim()
    : null

  if (burnTx && treasuryTx) {
    return { ok: false, reason: 'already_settled' }
  }

  return {
    ok: true,
    parsed: {
      id: row.id,
      user_id: row.user_id,
      amount: Number(row.amount),
      created_at: row.created_at,
      token_id: tokenId,
      cost_total: costTotal,
      burn_enr: burnEnr,
      treasury_enr: treasuryEnr,
      burn_tx_hash: burnTx,
      treasury_tx_hash: treasuryTx,
    },
  }
}

serve(async (req) => {
  const adminSecret = Deno.env.get('ADMIN_SECRET')
  if (!adminSecret || adminSecret.length < 8) {
    console.error('backfill-awaken-genesis-settlement: ADMIN_SECRET missing')
    return jsonResponse({ error: 'Service misconfigured' }, 500)
  }

  const adminKey = req.headers.get('x-admin-key') ?? ''
  if (adminKey !== adminSecret) {
    return new Response('Unauthorized', { status: 401 })
  }

  if (req.method !== 'POST' && req.method !== 'GET') {
    return jsonResponse({ error: 'Method not allowed' }, 405)
  }

  const url = new URL(req.url)
  const dryRun = url.searchParams.get('dry_run') === 'true'
  const singleId = url.searchParams.get('id')?.trim() ?? ''
  const limitRaw = parseInt(url.searchParams.get('limit') ?? '1', 10)
  const limit = Math.max(1, Math.min(5, Number.isFinite(limitRaw) ? limitRaw : 1))

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const supabase = createClient(supabaseUrl, serviceKey)

  let query = supabase
    .from('enr_transactions')
    .select('id, user_id, type, amount, metadata, created_at')
    .eq('type', 'awaken_genesis')
    .or('metadata->>burn_tx_hash.is.null,metadata->>treasury_tx_hash.is.null')
    .order('created_at', { ascending: true })
    .limit(limit)

  if (singleId) {
    query = supabase
      .from('enr_transactions')
      .select('id, user_id, type, amount, metadata, created_at')
      .eq('type', 'awaken_genesis')
      .eq('id', singleId)
      .limit(1)
  }

  const { data: rows, error: fetchErr } = await query

  if (fetchErr) {
    console.error('backfill-awaken-genesis-settlement: fetch error', fetchErr)
    return jsonResponse({ error: 'Failed to load rows' }, 500)
  }

  const candidates = (rows ?? []).filter((row) => {
    const meta = row.metadata as Record<string, unknown> | null
    const burnMissing = !isNonEmptyTxHash(meta?.burn_tx_hash)
    const treasuryMissing = !isNonEmptyTxHash(meta?.treasury_tx_hash)
    return burnMissing || treasuryMissing
  })

  const dryRunItems: Array<Record<string, unknown>> = []
  const skipped: Array<Record<string, unknown>> = []
  const settled: Array<Record<string, unknown>> = []
  const failed: Array<Record<string, unknown>> = []

  for (const row of candidates) {
    const parsedResult = parseAwakenRow(row as ParsedRow & { metadata: unknown })
    if (!parsedResult.ok) {
      skipped.push({
        id: row.id,
        reason: parsedResult.reason,
        created_at: row.created_at,
      })
      continue
    }

    const p = parsedResult.parsed

    if (dryRun) {
      dryRunItems.push({
        id: p.id,
        user_id: p.user_id,
        token_id: p.token_id,
        cost_total: p.cost_total,
        burn_enr: p.burn_enr,
        treasury_enr: p.treasury_enr,
        missing_burn: !p.burn_tx_hash,
        missing_treasury: !p.treasury_tx_hash,
        created_at: p.created_at,
      })
      continue
    }

    const action = `backfill_awaken_genesis_${p.token_id}_${p.id}`
    const settlement = await settleMissingLegs({
      costTotal: p.cost_total,
      burnEnr: p.burn_enr,
      treasuryEnr: p.treasury_enr,
      existingBurnTxHash: p.burn_tx_hash,
      existingTreasuryTxHash: p.treasury_tx_hash,
      action,
    })

    const priorMeta = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
      ? { ...(row.metadata as Record<string, unknown>) }
      : {}

    const nextMeta: Record<string, unknown> = {
      ...priorMeta,
      burn_enr: settlement.burnEnr,
      treasury_enr: settlement.treasuryEnr,
      cost_total: p.cost_total,
      token_id: p.token_id,
      burn_tx_hash: settlement.burnTxHash ?? priorMeta.burn_tx_hash ?? null,
      treasury_tx_hash: settlement.treasuryTxHash ?? priorMeta.treasury_tx_hash ?? null,
      payment_mode: 'offchain_enr_with_onchain_settlement',
      backfilled: settlement.status === 'settled',
      backfill_reason: 'missing_awaken_genesis_onchain_settlement',
    }

    if (settlement.status === 'settled') {
      nextMeta.settlement_status = 'settled'
      nextMeta.settled_at = new Date().toISOString()
    } else if (settlement.status === 'partial') {
      nextMeta.settlement_status = 'partial'
      nextMeta.settlement_error = settlement.error
    } else {
      nextMeta.settlement_status = 'failed'
      nextMeta.settlement_error = settlement.error
    }

    const { error: updErr } = await supabase
      .from('enr_transactions')
      .update({ metadata: nextMeta })
      .eq('id', p.id)
      .eq('type', 'awaken_genesis')

    if (updErr) {
      failed.push({
        id: p.id,
        error: 'metadata_update_failed',
        settlement_status: settlement.status,
        burn_tx_hash: settlement.burnTxHash ?? null,
        treasury_tx_hash: settlement.treasuryTxHash ?? null,
      })
      continue
    }

    if (settlement.status === 'settled') {
      settled.push({
        id: p.id,
        token_id: p.token_id,
        burn_tx_hash: settlement.burnTxHash,
        treasury_tx_hash: settlement.treasuryTxHash,
        settlement_status: 'settled',
      })
    } else {
      failed.push({
        id: p.id,
        token_id: p.token_id,
        settlement_status: settlement.status,
        burn_tx_hash: settlement.burnTxHash ?? null,
        treasury_tx_hash: settlement.treasuryTxHash ?? null,
        error: settlement.error,
      })
    }
  }

  return jsonResponse({
    dry_run: dryRun,
    affected_candidates: candidates.length,
    dry_run_items: dryRunItems,
    settled,
    failed,
    skipped,
  }, 200)
})
