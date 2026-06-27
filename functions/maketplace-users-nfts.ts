import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const DEFAULT_CORS =
  ""

const DEFAULT_GENESIS = ""

function corsHeaders(req: Request): Record<string, string> {
  const raw = Deno.env.get("MARKETPLACE_CORS_ORIGINS") ?? DEFAULT_CORS
  const allowed = raw.split(",").map((s) => s.trim()).filter(Boolean)
  const origin = req.headers.get("Origin")
  let value = allowed[0] ?? "https://amayatoken.online"
  if (origin && allowed.includes(origin)) value = origin
  return {
    "Access-Control-Allow-Origin": value,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
  }
}

function json(req: Request, body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json" },
  })
}

/** Align with `public.normalize_ronin_wallet_for_rls` / Flutter — must match `user_nfts.wallet_address`. */
function normalizeWalletForDb(input: string): string {
  const s = input.trim()
  if (!s) return ""
  let low = s.toLowerCase()
  if (low.startsWith("ronin:")) {
    const rest = low.slice(6).trim()
    return rest.startsWith("0x") ? rest : `0x${rest}`
  }
  return low.startsWith("0x") ? low : `0x${low}`
}

/**
 * MoveShoe / season (non-genesis) contracts: **union** of all valid `0x` addresses from secrets.
 * Include both `NFT_MINT_CONTRACT_ADDRESS` (current shoebox minter) and `NFT_CONTRACT_ADDRESS`
 * (legacy indexer / old deploy) so `user_nfts` rows match regardless of which was used when minted.
 */
function collectMoveShoeContractAddresses(): string[] {
  const set = new Set<string>()
  const addFromRaw = (raw: string | undefined) => {
    if (!raw?.trim()) return
    for (const part of raw.split(",")) {
      const seg = part.trim().toLowerCase()
      if (/^0x[a-f0-9]{40}$/.test(seg)) set.add(seg)
    }
  }
  addFromRaw(Deno.env.get("NFT_MINT_CONTRACT_ADDRESS"))
  addFromRaw(Deno.env.get("NFT_CONTRACT_ADDRESS"))
  addFromRaw(Deno.env.get("NFT_CONTRACT_ADDRESSES"))
  addFromRaw(Deno.env.get("NFTV2_CONTRACT_ADDRESS"))
  return [...set]
}

function marketplaceAllowedContracts(): string[] {
  const override = Deno.env.get("MARKETPLACE_USER_NFTS_CONTRACTS")?.trim()
  if (override) {
    return override
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => /^0x[a-f0-9]{40}$/.test(s))
  }
  const genesis = (Deno.env.get("GENESIS_NFT_CONTRACT_ADDRESS")?.trim() ||
    DEFAULT_GENESIS).toLowerCase()
  const moveShoe = collectMoveShoeContractAddresses()
  const out: string[] = []
  if (/^0x[a-f0-9]{40}$/.test(genesis)) out.push(genesis)
  for (const a of moveShoe) out.push(a)
  return [...new Set(out)]
}

function clampLevelDisplay(n: number): number {
  if (!Number.isFinite(n)) return 1
  const v = Math.floor(n)
  return Math.max(1, Math.min(10, v))
}

function clampLevelUncapped(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(10, Math.floor(n)))
}

function clampDurability(n: number): number {
  if (!Number.isFinite(n)) return 100
  return Math.max(0, Math.min(100, Math.round(n)))
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) })
  }
  if (req.method !== "POST") {
    return json(req, { success: false, error: "Method not allowed" }, 405)
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
  if (!supabaseUrl || !serviceKey) {
    return json(req, { success: false, error: "Server misconfigured" }, 500)
  }

  let body: { marketplace_access_token?: string; wallet_address?: string }
  try {
    body = await req.json()
  } catch {
    return json(req, { success: false, error: "Invalid JSON" }, 400)
  }

  const token = String(body.marketplace_access_token ?? "").trim()
  const walletRaw = String(body.wallet_address ?? "").trim()
  if (token.length < 30) {
    return json(req, { success: false, error: "Missing marketplace_access_token" }, 401)
  }
  if (!walletRaw) {
    return json(req, { success: false, error: "Missing wallet_address" }, 400)
  }

  const allowed = marketplaceAllowedContracts()
  if (allowed.length === 0) {
    console.error(
      "marketplace-user-nfts: set MARKETPLACE_USER_NFTS_CONTRACTS or GENESIS + NFT_MINT/NFT_CONTRACT_ADDRESS",
    )
    return json(req, { success: false, error: "Server misconfigured: contracts" }, 500)
  }

  const admin = createClient(supabaseUrl, serviceKey)
  const nowIso = new Date().toISOString()

  const { data: tokRow, error: tokErr } = await admin
    .from("marketplace_access_tokens")
    .select("user_id")
    .eq("token", token)
    .gt("expires_at", nowIso)
    .maybeSingle()

  if (tokErr || !tokRow?.user_id) {
    return json(req, {
      success: false,
      error: "Invalid, expired, or unknown marketplace token",
    }, 401)
  }

  const userId = String(tokRow.user_id)
  const walletNorm = normalizeWalletForDb(walletRaw)

  const { data: rows, error: qErr } = await admin
    .from("user_nfts")
    .select(
      "token_id, contract_address, wallet_address, level, durability, rarity, level_uncapped, genesis_awakened, is_deprecated, nft_type",
    )
    .eq("user_id", userId)
    .eq("wallet_address", walletNorm)
    .in("contract_address", allowed)
    .eq("is_deprecated", false)

  if (qErr) {
    console.error("marketplace-user-nfts", qErr.message)
    return json(req, { success: false, error: "query_failed" }, 500)
  }

  const list = (rows ?? []).filter((r) => {
    const nt = (r.nft_type as string | null) ?? null
    if (nt && nt !== "nft") return false
    return true
  })

  const nfts = list.map((r) => ({
    token_id: String(r.token_id),
    contract_address: String(r.contract_address || "").toLowerCase(),
    level: clampLevelDisplay(Number(r.level ?? 1)),
    durability: clampDurability(Number(r.durability ?? 100)),
    rarity: (r.rarity as string | null) ?? "common",
    level_uncapped: r.level_uncapped != null
      ? clampLevelUncapped(Number(r.level_uncapped))
      : null,
    genesis_awakened: !!(r.genesis_awakened as boolean),
  }))

  return json(req, { success: true, nfts }, 200)
})
