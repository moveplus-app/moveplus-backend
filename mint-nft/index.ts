// ============================================
// MOVE+ MINT NFT — Hot-wallet operator mints to user (Ronin)
// ============================================
// Prerequisites (ops):
// - Contract `mintWithRarity(address to, uint8 rarity, string tokenURI_)` callable by operator
// - Token ids are assigned by the contract. Backend predicts the next id via
//   `nextTokenId()`, then `nextCommonId()`, then `totalSupply()+1` to build tokenURI passed into mint().
//   Concurrent mints can cause prediction ≠ minted id; we accept the chain id (warn only).
//   Note: on-chain tokenURI may still be the pre-tx prediction; align ops / contract if needed.
// - setOperator(REWARD_HOT_WALLET) on contract — without it mintWithRarity reverts
// - If mint-to-hot then transfer-to-user: setTransferEnabled(true) when contract gates transfers
// - REWARD_HOT_PRIVATE_KEY has RON for gas (see MINT_NFT_MIN_RON_ETH)
//
// Secrets / env:
// - REWARD_HOT_PRIVATE_KEY (required)
// - RONIN_RPC_URL (optional; default https://api.roninchain.com/rpc)
// - NFT_MINT_CONTRACT_ADDRESS (optional; default = deployed minter) or NFTV2_CONTRACT_ADDRESS if unset
// - NFT_METADATA_IPFS_CID (optional; metadata folder CID; files at …/<tokenId>.json)
// - NFT_IMAGES_IPFS_CID (optional; user_nfts.image_url ipfs://…/<id>.png)
// - MINT_NFT_ENABLED — if "false", rejects all calls
// - MINT_NFT_RATE_LIMIT_PER_MINUTE — default 5 (per user, via check_mint_rate_limit)
// - MINT_NFT_MIN_RON_ETH — default "0.1" (minimum hot-wallet RON balance)
// - MINT_NFT_METADATA_GATEWAY_BASE — default https://gateway.lighthouse.storage/ipfs (HEAD/GET …/<cid>/<id>.json)
// - MINT_NFT_METADATA_FALLBACK_GATEWAY_BASE — optional second gateway if primary fails (default https://ipfs.io/ipfs)
// - MINT_NFT_SKIP_METADATA_CHECK — set "true" to skip pre-mint metadata fetch (emergency only)
// - MINT_NFT_SKIP_TOKENURI_IMAGE — set "true" to skip on-chain tokenURI + JSON image (use IPFS fallback only)
//
// MVP: at most one user_nfts row per user per contract (409). Remove for multi-NFT / upgrades.
// ============================================


const MINT_ABI = [
  'function mintWithRarity(address to, uint8 rarity, string tokenURI_) external',
  'function tokenURI(uint256 tokenId) view returns (string)',
  'event Minted(address indexed to, uint256 indexed tokenId, uint8 rarity)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
  'function nextTokenId() view returns (uint256)',
  'function nextCommonId() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
]

function jsonResponse(body: object, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function maskAddress(addr: string | undefined | null): string {
  const a = (addr ?? '').trim()
  if (a.length < 12) return '(omitted)'
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

function logError(context: string, err: unknown) {
  const e = err as { message?: string; code?: string }
  const msg = (e?.message ?? (err instanceof Error ? err.message : String(err))).slice(0, 240)
  const code = e?.code ? String(e.code) : undefined
  console.error(`mint-nft: ${context}`, code ? { code, message: msg } : msg)
}

/** Ronin / EVM: normalize ronin:0x… → checksummed 0x… */
function toChecksumAddress(addr: string): string {
  let s = (addr ?? '').trim()
  if (s.toLowerCase().startsWith('ronin:')) s = s.slice(6).trim()
  if (!s.startsWith('0x')) s = '0x' + s
  return ethers.getAddress(s)
}

function normalizeForCompare(addr: string): string {
  return toChecksumAddress(addr).toLowerCase()
}

/** HEAD then GET; non-2xx (incl. 404) → false. */
async function metadataJsonReachableAtUrl(url: string): Promise<boolean> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 12_000)
  try {
    let res = await fetch(url, { method: 'HEAD', signal: ctl.signal, redirect: 'follow' })
    if (res.ok) return true
    res = await fetch(url, {
      method: 'GET',
      signal: ctl.signal,
      redirect: 'follow',
      headers: { Range: 'bytes=0-512' },
    })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/** Verify JSON metadata is reachable (primary gateway, then optional fallback e.g. ipfs.io). */
async function metadataJsonReachable(metadataCid: string, tokenIdStr: string): Promise<boolean> {
  const primary = (Deno.env.get('MINT_NFT_METADATA_GATEWAY_BASE')?.trim() ||
    'https://gateway.lighthouse.storage/ipfs').replace(/\/$/, '')
  const primaryUrl = `${primary}/${metadataCid}/${tokenIdStr}.json`
  if (await metadataJsonReachableAtUrl(primaryUrl)) return true
  const fallback = (Deno.env.get('MINT_NFT_METADATA_FALLBACK_GATEWAY_BASE')?.trim() ||
    'https://ipfs.io/ipfs').replace(/\/$/, '')
  const fallbackUrl = `${fallback}/${metadataCid}/${tokenIdStr}.json`
  return await metadataJsonReachableAtUrl(fallbackUrl)
}

let _iface: ethers.Interface | null = null
let _contract: ethers.Contract | null = null
let _signer: ethers.Wallet | null = null

function getMintContext() {
  if (!_contract || !_signer) {
    const enabled = Deno.env.get('MINT_NFT_ENABLED')
    if (enabled === 'false') {
      throw new Error('MINT_NFT_ENABLED is false')
    }
    const rpcUrl = Deno.env.get('RONIN_RPC_URL')?.trim() || DEFAULT_RPC
    const hotKey = Deno.env.get('REWARD_HOT_PRIVATE_KEY')
    const contractRaw = resolveMintContractAddressFromEnv()
    if (!hotKey) {
      throw new Error('Missing REWARD_HOT_PRIVATE_KEY')
    }
    const provider = new ethers.JsonRpcProvider(rpcUrl)
    _signer = new ethers.Wallet(hotKey, provider)
    const contractAddr = ethers.getAddress(contractRaw)
    _contract = new ethers.Contract(contractAddr, MINT_ABI, _signer)
  }
  if (!_iface) {
    _iface = new ethers.Interface(MINT_ABI)
  }
  return { contract: _contract!, signer: _signer!, iface: _iface! }
}

/** Best-effort next id for metadata paths; actual id comes from receipt (Minted / Transfer). */
async function predictNextTokenId(contract: ethers.Contract): Promise<bigint> {
  try {
    const n = await contract.nextTokenId()
    return BigInt(n.toString())
  } catch {
    try {
      const n = await contract.nextCommonId()
      return BigInt(n.toString())
    } catch {
      try {
        const ts = await contract.totalSupply()
        return BigInt(ts.toString()) + 1n
      } catch (e) {
        logError('predictNextTokenId', e)
        throw new Error(
          'Cannot read next token id from contract (need nextTokenId(), nextCommonId(), or totalSupply())',
        )
      }
    }
  }
}

/** ipfs:///ipfs/... → HTTP gateway URL for fetch() */
function ipfsUriToHttpGateway(uri: string): string {
  const u = uri.trim()
  const base = (Deno.env.get('MINT_NFT_METADATA_GATEWAY_BASE')?.trim() ||
    'https://gateway.lighthouse.storage/ipfs').replace(/\/$/, '')
  if (u.toLowerCase().startsWith('ipfs://')) {
    const path = u.slice('ipfs://'.length).replace(/^ipfs\//i, '')
    return `${base}/${path}`
  }
  return u
}

/**
 * Read on-chain tokenURI → fetch JSON → metadata.image; fallback to [fallbackImageUrl] on any failure.
 */
async function resolveImageUrlFromChainMetadata(
  contract: ethers.Contract,
  chainTokenId: string,
  fallbackImageUrl: string,
): Promise<{ imageUrl: string; source: 'chain_metadata' | 'fallback' }> {
  if (Deno.env.get('MINT_NFT_SKIP_TOKENURI_IMAGE')?.trim() === 'true') {
    return { imageUrl: fallbackImageUrl, source: 'fallback' }
  }
  try {
    const tid = BigInt(chainTokenId)
    const rawUri: string = await (contract as ethers.Contract & {
      tokenURI: (id: bigint) => Promise<string>
    }).tokenURI(tid)
    if (typeof rawUri !== 'string' || !rawUri.trim()) {
      return { imageUrl: fallbackImageUrl, source: 'fallback' }
    }
    const metaUrl = ipfsUriToHttpGateway(rawUri.trim())
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 18_000)
    let res: Response
    try {
      res = await fetch(metaUrl, {
        method: 'GET',
        redirect: 'follow',
        signal: ctl.signal,
        headers: { Accept: 'application/json' },
      })
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) {
      console.warn('mint-nft: metadata fetch non-OK', { metaUrl, status: res.status })
      return { imageUrl: fallbackImageUrl, source: 'fallback' }
    }
    const json = (await res.json()) as { image?: string }
    const img = json?.image
    if (typeof img !== 'string' || !img.trim()) {
      return { imageUrl: fallbackImageUrl, source: 'fallback' }
    }
    const imageUrl = ipfsUriToHttpGateway(img.trim())
    return { imageUrl, source: 'chain_metadata' }
  } catch (e) {
    console.warn('mint-nft: tokenURI/metadata image resolution failed', String(e))
    return { imageUrl: fallbackImageUrl, source: 'fallback' }
  }
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
  console.log('mint-nft: request received')
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405)
  }

  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return jsonResponse({ error: 'Unauthorized' }, 401)
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const supabase = createClient(supabaseUrl, supabaseServiceKey)
  const jwt = authHeader.replace('Bearer ', '')

  const { data: { user }, error: authError } = await supabase.auth.getUser(jwt)
  if (authError || !user) {
    return jsonResponse({ error: 'Invalid session' }, 401)
  }

  const mintNftLimit = Math.max(
    1,
    Math.min(60, Number(Deno.env.get('MINT_NFT_RATE_LIMIT_PER_MINUTE') ?? '5') || 5),
  )
  const { data: rateOk } = await supabase.rpc('check_mint_rate_limit', {
    p_identifier: user.id,
    p_identifier_type: 'mint_nft',
    p_limit_per_minute: mintNftLimit,
  })
  if (rateOk === false) {
    return jsonResponse({ error: 'Too many mint attempts. Try again shortly.' }, 429)
  }

  let body: { wallet?: string; design?: number; token_id?: unknown }
  try {
    body = await req.json()
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400)
  }

  if (
    body.token_id !== undefined &&
    body.token_id !== null &&
    String(body.token_id).trim() !== ''
  ) {
    return jsonResponse({
      error:
        'token_id must not be sent; the contract assigns token ids. Use wallet (and design) only.',
    }, 400)
  }

  const walletRaw = body.wallet
  if (!walletRaw?.trim()) {
    return jsonResponse({ error: 'Missing wallet' }, 400)
  }

  let recipient: string
  try {
    recipient = toChecksumAddress(walletRaw)
  } catch {
    return jsonResponse({ error: 'Invalid wallet address' }, 400)
  }

  const designNum = Number(body.design ?? 1)
  if (!Number.isFinite(designNum) || designNum < 1 || designNum > 7 || !Number.isInteger(designNum)) {
    return jsonResponse({ error: 'design must be an integer 1–7' }, 400)
  }
  const design = designNum

  const metadataCid = Deno.env.get('NFT_METADATA_IPFS_CID')?.trim() || DEFAULT_METADATA_CID
  const imagesCid = Deno.env.get('NFT_IMAGES_IPFS_CID')?.trim() || DEFAULT_IMAGES_CID
  const contractAddr = resolveMintContractAddressFromEnv()
  let contractNorm: string
  try {
    contractNorm = normalizeForCompare(contractAddr)
  } catch {
    return jsonResponse({
      error: 'Invalid NFT_MINT_CONTRACT_ADDRESS or NFTV2_CONTRACT_ADDRESS',
    }, 500)
  }

  const { data: binding } = await supabase
    .from('wallet_connections')
    .select('wallet_address, is_confirmed')
    .eq('user_id', user.id)
    .eq('is_confirmed', true)
    .maybeSingle()

  if (!binding?.wallet_address) {
    return jsonResponse({ error: 'Wallet not confirmed' }, 403)
  }
  if (normalizeForCompare(binding.wallet_address) !== recipient.toLowerCase()) {
    return jsonResponse({ error: 'Wallet mismatch' }, 403)
  }

  // MVP: one NFT per user for this collection. Remove this block when supporting multiple NFTs / upgrades.
  const { count: existingNfts, error: countErr } = await supabase
    .from('user_nfts')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .eq('contract_address', contractNorm)

  if (countErr) {
    logError('count user_nfts', countErr)
    return jsonResponse({ error: 'Failed to verify NFT state' }, 500)
  }
  if ((existingNfts ?? 0) > 0) {
    return jsonResponse({ error: 'User already has an NFT for this collection' }, 409)
  }

  let contract: ethers.Contract
  let iface: ethers.Interface
  let signer: ethers.Wallet
  try {
    ;({ contract, iface, signer } = getMintContext())
  } catch (e) {
    logError('init mint context', e)
    const msg = e instanceof Error ? e.message : 'Mint misconfigured'
    if (msg.includes('MINT_NFT_ENABLED')) {
      return jsonResponse({ error: 'Minting is temporarily disabled' }, 403)
    }
    return jsonResponse({ error: 'Mint service misconfigured' }, 500)
  }

  let predictedId: bigint
  try {
    predictedId = await predictNextTokenId(contract)
  } catch (e) {
    logError('predict next token id', e)
    return jsonResponse(
      {
        error:
          'Could not determine next token id from contract. Ensure nextTokenId(), nextCommonId(), or totalSupply() exists.',
      },
      500,
    )
  }

  const predictedIdStr = predictedId.toString()
  const skipMetaCheck = Deno.env.get('MINT_NFT_SKIP_METADATA_CHECK') === 'true'
  if (!skipMetaCheck) {
    const metaOk = await metadataJsonReachable(metadataCid, predictedIdStr)
    if (!metaOk) {
      return jsonResponse(
        {
          error:
            'Metadata JSON not reachable for predicted token id. Upload ipfs metadata or fix gateway CID before mint.',
          predicted_token_id: predictedIdStr,
        },
        400,
      )
    }
  }

  const tokenURI = `ipfs://${metadataCid}/${predictedIdStr}.json`

  const minRonEth = Deno.env.get('MINT_NFT_MIN_RON_ETH')?.trim() || '0.1'
  let minRonWei: bigint
  try {
    minRonWei = ethers.parseEther(minRonEth)
  } catch {
    minRonWei = ethers.parseEther('0.1')
  }

  const ronBalance = await signer.provider!.getBalance(signer.address)
  if (ronBalance < minRonWei) {
    console.error('mint-nft: hot wallet RON below minimum', {
      op: maskAddress(signer.address),
      minEth: minRonEth,
    })
    return jsonResponse({ error: 'Mint temporarily unavailable' }, 503)
  }

  /** Initial mint is always common (0) on-chain; `design` stays in API/DB for art only. */
  const rarityCommon = 0

  let tx: ethers.ContractTransactionResponse
  try {
    tx = await contract.mintWithRarity(recipient, rarityCommon, tokenURI)
  } catch (e) {
    logError('mint tx send', e)
    return jsonResponse({ error: 'Mint transaction failed' }, 500)
  }

  let receipt: ethers.TransactionReceipt | null = null
  try {
    receipt = await Promise.race([
      tx.wait(1).catch(async () => tx.wait(2)),
      new Promise<null>((_, reject) =>
        setTimeout(() => reject(new Error('Transaction confirmation timeout')), 120_000)
      ),
    ]) as ethers.TransactionReceipt
  } catch (e) {
    logError('mint tx wait', e)
    return jsonResponse({
      error: 'Mint confirmation timed out or failed',
      tx_hash: tx.hash,
    }, 500)
  }

  const chainTokenId = parseMintedTokenId(receipt, iface)
  if (chainTokenId === null) {
    console.error('mint-nft: could not parse Transfer log', { hash: tx.hash })
    return jsonResponse({
      error: 'Mint succeeded but token id could not be read from receipt',
      tx_hash: tx.hash,
    }, 500)
  }

  let tokenIdMismatch = false
  if (chainTokenId !== predictedIdStr) {
    tokenIdMismatch = true
    console.warn('mint-nft: tokenId mismatch (likely concurrent mint race)', {
      predicted: predictedIdStr,
      actual: chainTokenId,
      tx_hash: tx.hash,
    })
  }

  const canonicalTokenUri = `ipfs://${metadataCid}/${chainTokenId}.json`
  if (!skipMetaCheck) {
    const actualMetaOk = await metadataJsonReachable(metadataCid, chainTokenId)
    if (!actualMetaOk) {
      console.error('CRITICAL: minted token id has no reachable metadata JSON', {
        token_id: chainTokenId,
        tx_hash: tx.hash,
        predicted_token_id: predictedIdStr,
      })
    }
  }

  const rarity = 'common'
  const fallbackImage = `ipfs://${imagesCid}/${chainTokenId}.png`
  const { imageUrl, source: imageUrlSource } = await resolveImageUrlFromChainMetadata(
    contract,
    chainTokenId,
    fallbackImage,
  )
  console.log('mint-nft: image_url resolved', {
    token_id: chainTokenId,
    image_url_source: imageUrlSource,
    tx_hash: tx.hash,
  })

  const row = {
    user_id: user.id,
    wallet_address: recipient,
    token_id: chainTokenId,
    contract_address: contractNorm,
    durability: 100,
    level: 0,
    rarity,
    image_url: imageUrl,
    last_verified_at: new Date().toISOString(),
    is_active: false,
  }

  console.log('mint-nft: user_nfts insert BEFORE', {
    user_id: user.id,
    token_id: chainTokenId,
    contract_address: contractNorm,
    tx_hash: tx.hash,
  })

  const { data: insertedRow, error: insErr } = await supabase
    .from('user_nfts')
    .insert(row)
    .select('id')
    .single()
  if (insErr || !insertedRow?.id) {
    logError('user_nfts insert after mint', insErr)
    console.error('mint-nft: user_nfts insert ERROR', {
      error: insErr,
      tx_hash: tx.hash,
      token_id: chainTokenId,
      user_id: user.id,
    })
    console.error('CRITICAL: NFT minted but DB failed', {
      tx_hash: tx.hash,
      token_id: chainTokenId,
      user_id: user.id,
    })
    return jsonResponse({
      error: 'On-chain mint succeeded but failed to save NFT. Contact support with tx hash.',
      tx_hash: tx.hash,
      token_id: chainTokenId,
    }, 500)
  }

  console.log('mint-nft: user_nfts insert AFTER ok', {
    token_id: chainTokenId,
    user_id: user.id,
    tx_hash: tx.hash,
    user_nft_id: insertedRow.id,
  })

  const { data: equipRpc, error: equipErr } = await supabase.rpc('set_user_active_nft', {
    p_user_id: user.id,
    p_user_nft_id: insertedRow.id,
  })

  const equipResult = equipRpc as Record<string, unknown> | null
  const lastNftSwitchAt = equipResult?.last_nft_switch_at?.toString() ?? null

  if (equipErr || !equipResult || equipResult.success !== true) {
    const equipReason = equipResult?.reason?.toString() ?? ''
    console.warn('mint-nft: auto-equip failed (mint saved, not equipped)', {
      user_id: user.id.length > 10 ? `${user.id.slice(0, 4)}…${user.id.slice(-4)}` : user.id,
      user_nft_id: insertedRow.id,
      cooldown: equipReason || 'rpc_failed',
      last_nft_switch_at: lastNftSwitchAt,
      equip_err: equipErr?.message,
    })
    return jsonResponse({
      success: true,
      tx_hash: tx.hash,
      token_id: chainTokenId,
      contract_address: contractNorm,
      token_uri: canonicalTokenUri,
      token_uri_sent_in_tx: tokenURI,
      image_url: imageUrl,
      image_url_source: imageUrlSource,
      design,
      equipped: false,
      equip_error:
        equipResult?.error?.toString() ??
        'Mint saved but could not equip. Confirm wallet in Web3, then tap Activate.',
      ...(tokenIdMismatch
        ? { prediction_mismatch: true, predicted_token_id: predictedIdStr }
        : {}),
    }, 200)
  }

  console.log('mint-nft: auto-equip ok', {
    user_id: user.id.length > 10 ? `${user.id.slice(0, 4)}…${user.id.slice(-4)}` : user.id,
    user_nft_id: insertedRow.id,
    cooldown: lastNftSwitchAt ? 'written' : 'missing',
    last_nft_switch_at: lastNftSwitchAt,
  })

  return jsonResponse({
    success: true,
    tx_hash: tx.hash,
    token_id: chainTokenId,
    contract_address: contractNorm,
    token_uri: canonicalTokenUri,
    token_uri_sent_in_tx: tokenURI,
    image_url: imageUrl,
    image_url_source: imageUrlSource,
    design,
    equipped: true,
    last_nft_switch_at: lastNftSwitchAt,
    ...(tokenIdMismatch
      ? { prediction_mismatch: true, predicted_token_id: predictedIdStr }
      : {}),
  }, 200)
})
