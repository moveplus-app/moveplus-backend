// AWAKEN GENESIS — dynamic ENR off-chain for L10 Genesis multiplier bump (token band: Rare 1–60, Epic 61–100).
// isGenesisTokenId inlined — Supabase deploy bundles only index.ts.
// ENR: increment_enr_balance deducts atomically; settlement: 50/50 burn+treasury on-chain (same as unlock-level).
// NFT: genesis_awakened set only after settlement succeeds; conditional update prevents double awaken.
// On-chain: ownerOf(tokenId) on Genesis contract must match confirmed wallet_connections.

import { serve } from 'https://'
import { createClient } from 'https://'
import { ethers } from 'https://'

/** ownerOf contract: Genesis 1–100 → Genesis minter only (never Season/NFT_MINT). Inlined — cloud bundle is index-only. */
const DEFAULT_GENESIS_CONTRACT =
  '0x5f'

function genesisContractAddress(): string {
  const fromEnv = Deno.env.get('GENESIS_NFT_CONTRACT_ADDRESS')?.trim().toLowerCase()
  if (fromEnv) return fromEnv
  return DEFAULT_GENESIS_CONTRACT.trim().toLowerCase()
}

function normalizeTo0x(addr: string): string {
  let s = (addr ?? '').trim()
  if (s.toLowerCase().startsWith('ronin:')) s = s.slice(6).trim()
  if (!s.startsWith('0x')) s = '0x' + s
  return s
}

function isValidEvmAddress(addr: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(normalizeTo0x(addr))
}

/** Genesis token IDs 1–100 always resolve to the Genesis collection for ownerOf. */
function resolveContractAddressForOwnerOf(tokenId: number): string {
  if (Number.isFinite(tokenId) && tokenId >= 1 && tokenId <= 100) {
    return normalizeTo0x(genesisContractAddress())
  }
  return normalizeTo0x(genesisContractAddress())
}

const DEFAULT_RPC = 'https://api.roninchain.com/rpc'

const OWNER_ABI = ['function ownerOf(uint256 tokenId) view returns (address)'] as const

function toChecksumAddress(addr: string): string {
  let s = (addr ?? '').trim()
  if (s.toLowerCase().startsWith('ronin:')) s = s.slice(6).trim()
  if (!s.startsWith('0x')) s = '0x' + s
  return ethers.getAddress(s)
}

function normalizeForCompare(addr: string): string {
  return toChecksumAddress(addr).toLowerCase()
}

function isGenesisTokenId(tokenId: string): boolean {
  const n = parseInt(String(tokenId), 10)
  return !Number.isNaN(n) && n >= 1 && n <= 100
}

/** Genesis band cost from token_id (on-chain band; not DB rarity). Rare 1–60, Epic 61–100. */
function getAwakenCostFromTokenId(tokenId: number): number {
  if (Number.isNaN(tokenId) || tokenId < 1 || tokenId > 100) return 1000
  if (tokenId <= 60) return 1000
  return 2500
}

function jsonResponse(body: object, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// ---------------------------------------------------------------------------
// On-chain settlement helpers (mirrors unlock-level / pay-level-gate)
// ---------------------------------------------------------------------------

const ERC20_ABI = [
  'function decimals() view returns (uint8)',
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
]

const ENR_BURNER_ABI = [
  'function burnFromVault(uint256 amount) external',
]

type UpgradeEconomySettlement =
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

async function settleUpgradeEconomy(params: {
  costEnr: number
  action: string
  userId: string
  paymentMode: 'offchain' | 'onchain_wallet'
  existingBurnTxHash?: string | null
  existingTreasuryTxHash?: string | null
}): Promise<UpgradeEconomySettlement> {
  const costEnr = Number(params.costEnr)

  if (!Number.isFinite(costEnr) || costEnr <= 0) {
    return {
      status: 'failed',
      burnEnr: 0,
      treasuryEnr: 0,
      error: 'Invalid settlement cost',
    }
  }

  const burnEnr = Math.floor(costEnr / 2)
  const treasuryEnr = costEnr - burnEnr

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

    const decimalsRaw = await enr.decimals()
    const decimals = Number(decimalsRaw)

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
      throw new Error('Hot wallet ENR balance too low for upgrade settlement')
    }

    if (needBurn) {
      const allowance = await enr.allowance(hotWallet, burnerAddress)
      if (allowance < burnWei) {
        throw new Error('Hot wallet ENR allowance to burner is too low')
      }
      const burnTx = await burner.burnFromVault(burnWei)
      burnTxHash = await waitSettlementTx(burnTx, 'awaken ENR burn')
    }

    if (needTreasury) {
      const treasuryTx = await enr.transfer(treasuryAddress, treasuryWei)
      treasuryTxHash = await waitSettlementTx(treasuryTx, 'awaken ENR treasury transfer')
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

    console.error('awaken-genesis: economy settlement failed', {
      action: params.action,
      user_id: params.userId,
      payment_mode: params.paymentMode,
      burn_enr: burnEnr,
      treasury_enr: treasuryEnr,
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

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      },
    })
  }

  if (req.method !== 'POST') {
    return jsonResponse({ success: false, error: 'Method not allowed' }, 405)
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return jsonResponse({ success: false, error: 'Unauthorized' }, 401)
  }

  const token = authHeader.replace('Bearer ', '')
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser(token)
  if (authError || !user) {
    return jsonResponse({ success: false, error: 'Invalid session' }, 401)
  }

  let body: { token_id?: string }
  try {
    body = await req.json()
  } catch {
    return jsonResponse({ success: false, error: 'Invalid JSON' }, 400)
  }

  const tokenId = String(body.token_id ?? '').trim()
  if (!tokenId) {
    return jsonResponse({ success: false, error: 'Missing token_id' }, 400)
  }

  if (!isGenesisTokenId(tokenId)) {
    return jsonResponse({ success: false, error: 'Not a Genesis token' }, 400)
  }

  const { data: nft, error: nftErr } = await supabase
    .from('user_nfts')
    .select('id, token_id, level, genesis_awakened, cooldown_until, user_id, contract_address')
    .eq('user_id', user.id)
    .eq('token_id', tokenId)
    .eq('is_active', true)
    .maybeSingle()

  if (nftErr || !nft) {
    return jsonResponse({
      success: false,
      error: 'NFT not found or not equipped. Equip this Genesis shoe in the app first.',
    }, 404)
  }

  const lvl = Math.max(0, Number(nft.level ?? 0))
  if (lvl < 10) {
    return jsonResponse({ success: false, error: 'Genesis must reach level 10 first' }, 400)
  }

  if (nft.genesis_awakened === true) {
    return jsonResponse({ success: true, already_awakened: true, message: 'Already awakened' }, 200)
  }

  const cooldownUntil = nft.cooldown_until ? new Date(nft.cooldown_until as string) : null
  if (cooldownUntil && cooldownUntil > new Date()) {
    return jsonResponse({ success: false, error: 'Cannot awaken during transfer cooldown' }, 400)
  }

  const { data: binding } = await supabase
    .from('wallet_connections')
    .select('wallet_address')
    .eq('user_id', user.id)
    .eq('is_confirmed', true)
    .maybeSingle()

  if (!binding?.wallet_address) {
    return jsonResponse({ success: false, error: 'Wallet not confirmed' }, 403)
  }
  const expectedOwner = normalizeForCompare(binding.wallet_address)

  const tidNum = parseInt(tokenId, 10)
  const contractRaw = resolveContractAddressForOwnerOf(tidNum)
  if (!isValidEvmAddress(contractRaw)) {
    console.error('awaken-genesis: invalid contract address', {
      tokenId,
      contractRaw,
    })
    return jsonResponse(
      { success: false, error: 'Invalid NFT contract configuration' },
      500,
    )
  }
  let contractAddress: string
  try {
    contractAddress = toChecksumAddress(contractRaw)
  } catch {
    return jsonResponse({ success: false, error: 'Invalid NFT contract configuration' }, 500)
  }

  console.log('awaken-genesis: ownerOf check (Genesis contract)', {
    tokenId,
    contractAddress,
    genesisContract: genesisContractAddress(),
    wallet: `${expectedOwner.slice(0, 6)}…${expectedOwner.slice(-4)}`,
  })

  const rpcUrl = Deno.env.get('RONIN_RPC_URL')?.trim() || DEFAULT_RPC
  const provider = new ethers.JsonRpcProvider(rpcUrl)
  const nftContract = new ethers.Contract(contractAddress, OWNER_ABI, provider)

  let onchainOwner: string
  try {
    onchainOwner = await nftContract.ownerOf(BigInt(tokenId))
  } catch (e) {
    console.error('awaken-genesis: ownerOf failed', {
      tokenId,
      contractAddress,
      error: e,
    })
    return jsonResponse(
      { success: false, error: 'Could not verify Genesis ownership on-chain.' },
      400,
    )
  }

  if (normalizeForCompare(onchainOwner) !== expectedOwner) {
    return jsonResponse({
      success: false,
      error: 'Connected wallet does not own this Genesis Gear.',
    }, 403)
  }

  const tokenIdNum = parseInt(tokenId, 10)
  const awakenCost = getAwakenCostFromTokenId(tokenIdNum)

  const { data: newBalance, error: deductErr } = await supabase.rpc('increment_enr_balance', {
    p_user_id: user.id,
    p_amount: -awakenCost,
  })

  if (deductErr) {
    console.error('awaken-genesis: ENR deduct failed', deductErr)
    return jsonResponse({ success: false, error: 'Failed to deduct ENR' }, 500)
  }

  if (newBalance === null) {
    const { data: p } = await supabase
      .from('users')
      .select('enr_balance')
      .eq('id', user.id)
      .maybeSingle()
    const current = Math.floor(Number.parseFloat(String(p?.enr_balance ?? 0)))
    return jsonResponse(
      {
        success: false,
        error: 'Not enough ENR',
        required: awakenCost,
        current,
      },
      400,
    )
  }

  // --- On-chain 50/50 settlement (burn + treasury) BEFORE genesis_awakened ---
  const settlementAction = `awaken_genesis_${tokenId}`

  const settlement = await settleUpgradeEconomy({
    costEnr: awakenCost,
    action: settlementAction,
    userId: user.id,
    paymentMode: 'offchain',
  })

  if (settlement.status === 'failed') {
    await supabase.rpc('increment_enr_balance', { p_user_id: user.id, p_amount: awakenCost })

    await supabase.from('enr_transactions').insert({
      user_id: user.id,
      type: 'awaken_genesis_settlement_failed',
      amount: 0,
      metadata: {
        token_id: tokenId,
        cost_total: awakenCost,
        burn_enr: settlement.burnEnr,
        treasury_enr: settlement.treasuryEnr,
        burn_tx_hash: settlement.burnTxHash ?? null,
        treasury_tx_hash: settlement.treasuryTxHash ?? null,
        payment_mode: 'offchain_enr_with_onchain_settlement',
        settlement_status: 'failed_refunded',
        settlement_error: settlement.error,
      },
    })

    return jsonResponse(
      {
        success: false,
        error: 'Genesis Awaken settlement failed. Your ENR was refunded.',
        settlement_error: settlement.error,
        settlement_status: 'failed_refunded',
      },
      503,
    )
  }

  if (settlement.status === 'partial') {
    await supabase.from('enr_transactions').insert({
      user_id: user.id,
      type: 'awaken_genesis_settlement_failed',
      amount: 0,
      metadata: {
        token_id: tokenId,
        cost_total: awakenCost,
        burn_enr: settlement.burnEnr,
        treasury_enr: settlement.treasuryEnr,
        burn_tx_hash: settlement.burnTxHash ?? null,
        treasury_tx_hash: settlement.treasuryTxHash ?? null,
        payment_mode: 'offchain_enr_with_onchain_settlement',
        settlement_status: 'partial',
        settlement_error: settlement.error,
        note: 'Partial on-chain settlement; ENR not refunded — retry missing leg via support',
      },
    })

    return jsonResponse(
      {
        success: false,
        error: 'Genesis Awaken settlement incomplete. Contact support to complete settlement.',
        settlement_status: 'partial',
        burn_tx_hash: settlement.burnTxHash ?? null,
        treasury_tx_hash: settlement.treasuryTxHash ?? null,
        settlement_error: settlement.error,
      },
      503,
    )
  }

  const { data: updatedNft, error: upErr } = await supabase
    .from('user_nfts')
    .update({ genesis_awakened: true })
    .eq('id', nft.id)
    .eq('user_id', user.id)
    .eq('token_id', tokenId)
    .eq('is_active', true)
    .eq('genesis_awakened', false)
    .select('id')
    .maybeSingle()

  if (upErr) {
    // ENR already burned/transferred on-chain; do not refund.
    console.error('awaken-genesis: NFT update failed after settlement', upErr)
    await supabase.from('enr_transactions').insert({
      user_id: user.id,
      type: 'awaken_genesis_flag_failed',
      amount: -awakenCost,
      metadata: {
        token_id: tokenId,
        cost_total: awakenCost,
        burn_enr: settlement.burnEnr,
        treasury_enr: settlement.treasuryEnr,
        burn_tx_hash: settlement.burnTxHash,
        treasury_tx_hash: settlement.treasuryTxHash,
        payment_mode: 'offchain_enr_with_onchain_settlement',
        settlement_status: 'settled',
        note: 'settlement succeeded but genesis_awakened update failed; needs manual fix',
      },
    })
    return jsonResponse({
      success: false,
      error: 'Payment settled on-chain but failed to update Genesis Gear. Contact support.',
    }, 500)
  }

  if (!updatedNft) {
    // Race / already awakened — settlement already on-chain; cannot refund.
    const { data: fresh } = await supabase
      .from('user_nfts')
      .select('id, genesis_awakened, is_active')
      .eq('id', nft.id)
      .eq('user_id', user.id)
      .maybeSingle()

    if (fresh?.genesis_awakened === true) {
      console.warn('awaken-genesis: duplicate awaken after settlement; already awakened')
    } else {
      console.warn('awaken-genesis: no row updated after settlement; needs reconciliation')
    }

    return jsonResponse({
      success: true,
      already_awakened: true,
      message: 'Already awakened',
      burn_enr: settlement.burnEnr,
      treasury_enr: settlement.treasuryEnr,
      burn_tx_hash: settlement.burnTxHash,
      treasury_tx_hash: settlement.treasuryTxHash,
    }, 200)
  }

  const { data: userRow, error: balErr } = await supabase
    .from('users')
    .select('enr_balance')
    .eq('id', user.id)
    .single()

  if (balErr) {
    console.warn('awaken-genesis: post-update balance fetch failed', balErr)
  }

  const enrBalance = Number.parseFloat(String(userRow?.enr_balance ?? newBalance ?? 0))

  const { error: insErr } = await supabase.from('enr_transactions').insert({
    user_id: user.id,
    type: 'awaken_genesis',
    amount: -awakenCost,
    metadata: {
      token_id: tokenId,
      cost_total: awakenCost,
      burn_enr: settlement.burnEnr,
      treasury_enr: settlement.treasuryEnr,
      burn_tx_hash: settlement.burnTxHash,
      treasury_tx_hash: settlement.treasuryTxHash,
      payment_mode: 'offchain_enr_with_onchain_settlement',
      settlement_status: 'settled',
      split: '50_50',
    },
  })
  if (insErr) {
    console.warn('awaken-genesis: enr_transactions insert failed (state committed)', insErr)
  }

  return jsonResponse({
    success: true,
    enr_spent: awakenCost,
    enr_balance: enrBalance,
    genesis_awakened: true,
    burn_enr: settlement.burnEnr,
    treasury_enr: settlement.treasuryEnr,
    burn_tx_hash: settlement.burnTxHash,
    treasury_tx_hash: settlement.treasuryTxHash,
    settlement_status: 'settled',
    payment_mode: 'offchain_enr_with_onchain_settlement',
  }, 200)
})
