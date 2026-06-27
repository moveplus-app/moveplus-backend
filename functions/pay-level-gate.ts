// PAY LEVEL GATE — Off-chain ENR for rarity upgrade prep (before upgrade-nft on-chain).
// Auth: JWT only (never trust client user_id). Validates equipped NFT + rarity matches action.
// ENR: increment_enr_balance (atomic). Settlement: 50/50 burn+treasury on-chain (same pattern as repair-nft).

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { ethers } from 'https://esm.sh/ethers@6'
import {
  isPayLevelGateAction,
  payLevelGateCost,
  type PayLevelGateAction,
} from './enr_costs.ts'

// ---------------------------------------------------------------------------
// On-chain settlement helpers (mirrors repair-nft burner pattern)
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
      status: 'failed'
      burnEnr: number
      treasuryEnr: number
      error: string
      burnTxHash?: string
      treasuryTxHash?: string
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
  const rpcUrl = Deno.env.get('RONIN_RPC_URL')?.trim() || 'https://api.roninchain.com/rpc'
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

  let burnTxHash: string | undefined
  let treasuryTxHash: string | undefined

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
    const totalWei = burnWei + treasuryWei

    const hotWallet = await signer.getAddress()

    const minRonEth = Deno.env.get('MINT_NFT_MIN_RON_ETH')?.trim() || '0.1'
    const minRonWei = ethers.parseEther(minRonEth)

    const ronBalance = await provider.getBalance(hotWallet)
    if (ronBalance < minRonWei) {
      throw new Error('Hot wallet RON balance too low for settlement gas')
    }

    const hotEnrBalance = await enr.balanceOf(hotWallet)
    if (hotEnrBalance < totalWei) {
      throw new Error('Hot wallet ENR balance too low for upgrade settlement')
    }

    const allowance = await enr.allowance(hotWallet, burnerAddress)
    if (allowance < burnWei) {
      throw new Error('Hot wallet ENR allowance to burner is too low')
    }

    if (burnWei > 0n) {
      const burnTx = await burner.burnFromVault(burnWei)
      burnTxHash = await waitSettlementTx(burnTx, 'upgrade ENR burn')
    }

    if (treasuryWei > 0n) {
      const treasuryTx = await enr.transfer(treasuryAddress, treasuryWei)
      treasuryTxHash = await waitSettlementTx(treasuryTx, 'upgrade ENR treasury transfer')
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

    console.error('upgrade economy settlement failed', {
      action: params.action,
      user_id: params.userId,
      payment_mode: params.paymentMode,
      burn_enr: burnEnr,
      treasury_enr: treasuryEnr,
      burn_tx_hash: burnTxHash,
      treasury_tx_hash: treasuryTxHash,
      error: message,
    })

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

function json(body: object, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  })
}

const DEFAULT_GENESIS_CONTRACT =
  ''

function normalizeEvmAddress(input: string): string {
  const s = String(input || '').trim().toLowerCase()
  if (s.startsWith('ronin:')) {
    const rest = s.slice('ronin:'.length).trim()
    return rest.startsWith('0x') ? rest : `0x${rest}`
  }
  return s.startsWith('0x') ? s : `0x${s}`
}

function genesisContractAddress(): string {
  const fromEnv = Deno.env.get('GENESIS_NFT_CONTRACT_ADDRESS')?.trim()
  return fromEnv ? normalizeEvmAddress(fromEnv) : DEFAULT_GENESIS_CONTRACT
}

function isGenesisNftRow(row: {
  token_id: string | number
  contract_address?: string | null
}): boolean {
  const tokenId = parseInt(String(row.token_id), 10)
  if (Number.isNaN(tokenId) || tokenId < 1 || tokenId > 100) return false
  return normalizeEvmAddress(String(row.contract_address ?? '')) ===
    genesisContractAddress()
}

function rarityMatchesAction(
  dbRarity: string,
  action: PayLevelGateAction,
): boolean {
  const r = dbRarity.toLowerCase()
  if (action === 'common_to_uncommon') return r === 'common'
  if (action === 'uncommon_to_rare') return r === 'uncommon'
  if (action === 'rare_to_epic') return r === 'rare'
  return false
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      },
    })
  }

  if (req.method !== 'POST') {
    return json({ success: false, error: 'Method not allowed' }, 405)
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const supabase = createClient(supabaseUrl, serviceKey)

  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return json({ success: false, error: 'Unauthorized' }, 401)
  }

  const jwt = authHeader.replace('Bearer ', '')
  const { data: { user }, error: authErr } = await supabase.auth.getUser(jwt)
  if (authErr || !user) {
    return json({ success: false, error: 'Invalid session' }, 401)
  }

  let body: { user_nft_id?: string; action?: string }
  try {
    body = await req.json()
  } catch {
    return json({ success: false, error: 'Invalid JSON' }, 400)
  }

  const nftId = String(body.user_nft_id ?? '').trim()
  const actionRaw = String(body.action ?? '').trim()
  if (!nftId || !isPayLevelGateAction(actionRaw)) {
    return json({ success: false, error: 'Missing user_nft_id or invalid action' }, 400)
  }
  const action = actionRaw as PayLevelGateAction
  const cost = payLevelGateCost(action)
  if (cost <= 0) {
    return json({ success: false, error: 'Invalid cost' }, 400)
  }

  const { data: row, error: rowErr } = await supabase
    .from('user_nfts')
    .select('id, user_id, rarity, is_active, upgrade_pending, token_id, contract_address')
    .eq('id', nftId)
    .eq('user_id', user.id)
    .maybeSingle()

  if (rowErr || !row) {
    return json({ success: false, error: 'NFT not found' }, 404)
  }

  if (isGenesisNftRow(row)) {
    return json({ success: false, error: 'Genesis NFTs use the in-app Genesis paths only' }, 400)
  }

  if (!row.is_active) {
    return json({ success: false, error: 'Equip this shoe first' }, 400)
  }

  if (row.upgrade_pending) {
    return json({ success: false, error: 'Upgrade already paid; complete on-chain upgrade or contact support' }, 400)
  }

  const rarity = String(row.rarity ?? 'common').toLowerCase()
  if (!rarityMatchesAction(rarity, action)) {
    return json(
      {
        success: false,
        error: 'Action does not match this NFT rarity',
        current_rarity: rarity,
        action,
      },
      400,
    )
  }

  const insufficientPayload = (currentFloored: number) => ({
    success: false,
    code: 'INSUFFICIENT_OFFCHAIN_ENR',
    error: 'Insufficient Move+ ENR balance',
    required: cost,
    current: currentFloored,
    onchain_fallback_enabled: true,
  })

  const { data: userBefore } = await supabase.from('users').select('enr_balance').eq('id', user.id).maybeSingle()
  const offchainBalance = Math.floor(Number.parseFloat(String(userBefore?.enr_balance ?? 0)))
  if (offchainBalance < cost) {
    return json(insufficientPayload(offchainBalance), 402)
  }

  const { data: newBalance, error: deductErr } = await supabase.rpc('increment_enr_balance', {
    p_user_id: user.id,
    p_amount: -cost,
  })

  if (deductErr) {
    console.error('pay-level-gate: deduct failed', deductErr)
    return json({ success: false, error: 'Failed to deduct ENR' }, 500)
  }

  if (newBalance === null) {
    const { data: p } = await supabase.from('users').select('enr_balance').eq('id', user.id).maybeSingle()
    const current = Math.floor(Number.parseFloat(String(p?.enr_balance ?? 0)))
    return json(insufficientPayload(current), 402)
  }

  // --- On-chain 50/50 settlement (burn + treasury) BEFORE marking upgrade_pending ---
  const settlement = await settleUpgradeEconomy({
    costEnr: cost,
    action,
    userId: user.id,
    paymentMode: 'offchain',
  })

  if (settlement.status !== 'settled') {
    await supabase.rpc('increment_enr_balance', { p_user_id: user.id, p_amount: cost })

    await supabase.from('enr_transactions').insert({
      user_id: user.id,
      type: 'upgrade_payment_offchain_failed',
      amount: 0,
      metadata: {
        action,
        user_nft_id: nftId,
        token_id: row.token_id,
        cost_enr: cost,
        burn_enr: settlement.burnEnr,
        treasury_enr: settlement.treasuryEnr,
        burn_tx_hash: settlement.burnTxHash ?? null,
        treasury_tx_hash: settlement.treasuryTxHash ?? null,
        payment_mode: 'offchain',
        economy_settlement_status: 'failed_refunded',
        settlement_error: settlement.error,
      },
    })

    return json(
      {
        success: false,
        error: 'Payment settlement failed. ENR refunded.',
        settlement_error: settlement.error,
      },
      503,
    )
  }

  // Settlement succeeded — now flag the NFT as upgrade_pending
  const { data: flagged, error: upErr } = await supabase
    .from('user_nfts')
    .update({
      upgrade_pending: true,
      upgrade_prep_action: action,
    })
    .eq('id', nftId)
    .eq('user_id', user.id)
    .eq('upgrade_pending', false)
    .select('id')
    .maybeSingle()

  if (upErr || !flagged) {
    if (upErr) console.error('pay-level-gate: NFT flag update failed after settlement', upErr)
    else console.warn('pay-level-gate: no row updated (race) after settlement')
    // ENR already burned/transferred on-chain; do not refund (would be double-spend).
    // Log for manual reconciliation.
    await supabase.from('enr_transactions').insert({
      user_id: user.id,
      type: 'pay_level_gate_flag_failed',
      amount: -cost,
      metadata: {
        action,
        user_nft_id: nftId,
        token_id: row.token_id,
        cost_enr: cost,
        burn_enr: settlement.burnEnr,
        treasury_enr: settlement.treasuryEnr,
        burn_tx_hash: settlement.burnTxHash,
        treasury_tx_hash: settlement.treasuryTxHash,
        payment_mode: 'offchain',
        economy_settlement_status: 'settled',
        note: 'settlement succeeded but NFT flag update failed; needs manual fix',
      },
    })
    return json({ success: false, error: 'Payment settled on-chain but failed to update NFT. Contact support.' }, 500)
  }

  const { data: enrTx, error: logErr } = await supabase
    .from('enr_transactions')
    .insert({
      user_id: user.id,
      type: 'pay_level_gate',
      amount: -cost,
      metadata: {
        action,
        user_nft_id: nftId,
        token_id: row.token_id,
        cost_enr: cost,
        burn_enr: settlement.burnEnr,
        treasury_enr: settlement.treasuryEnr,
        burn_tx_hash: settlement.burnTxHash,
        treasury_tx_hash: settlement.treasuryTxHash,
        payment_mode: 'offchain',
        economy_settlement_status: 'settled',
        split: '50_50',
      },
    })
    .select('id')
    .single()

  if (logErr) {
    console.warn('pay-level-gate: enr_transactions insert failed (state committed)', logErr)
  }

  const { data: userRow } = await supabase.from('users').select('enr_balance').eq('id', user.id).maybeSingle()
  const enrOut = Number.parseFloat(String(userRow?.enr_balance ?? newBalance ?? 0))

  return json({
    success: true,
    upgrade_pending: true,
    source: 'offchain_enr',
    action,
    cost,
    enr_spent: cost,
    enr_balance: enrOut,
    burn_enr: settlement.burnEnr,
    treasury_enr: settlement.treasuryEnr,
    burn_tx_hash: settlement.burnTxHash,
    treasury_tx_hash: settlement.treasuryTxHash,
    economy_settlement_status: 'settled',
  }, 200)
})
