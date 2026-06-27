/**
 * Cached MoveShoe chain inventory: ownerOf batched forward from MIN_TOKEN_ID → highestId (no indexer).
 * Env: RONIN_RPC_URL (default https://api.roninchain.com/rpc)
 * Some script cut for security reason
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const DEFAULT_RPC = "https://api.roninchain.com/rpc"
const DEFAULT_CORS =
  ""

const CACHE = new Map<string, { data: unknown[]; ts: number }>()
const TTL_MS = 10_000
const BATCH = 5
const TARGET = 20
const MIN_TOKEN_ID = 4

const ZERO_ADDR = "0x0000000000000000000000000000000000000000"

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

function json(
  req: Request,
  body: Record<string, unknown>,
  status: number,
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json" },
  })
}

function normalizeContract(input: string): string {
  const s = input.trim().toLowerCase()
  if (!s.startsWith("0x") || s.length !== 42) return ""
  return s
}

function padUint256(n: number): string {
  if (!Number.isFinite(n) || n < 0 || n > Number.MAX_SAFE_INTEGER) {
    throw new Error("invalid tokenId")
  }
  return BigInt(Math.floor(n)).toString(16).padStart(64, "0")
}

function decodeOwnerAddress(result: string | null | undefined): string | null {
  if (result == null || result === "0x" || typeof result !== "string") return null
  const h = result.startsWith("0x") ? result.slice(2) : result
  if (h.length < 64) return null
  const addr = "0x" + h.slice(-40).toLowerCase()
  return addr
}

async function ownerOf(
  rpcUrl: string,
  contract: string,
  tokenId: number,
): Promise<string | null> {
  const data = `0x6352211e${padUint256(tokenId)}`
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: contract, data }, "latest"],
    }),
  })
  const j = await res.json() as { result?: string; error?: unknown }
  if (j.error != null) return null
  const addr = decodeOwnerAddress(j.result)
  if (!addr || addr === ZERO_ADDR) return null
  return addr
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) })
  }
  if (req.method !== "POST") {
    return json(req, { success: false, error: "Method not allowed" }, 405)
  }

  const rpcUrl = (Deno.env.get("RONIN_RPC_URL") ?? DEFAULT_RPC).trim()
  if (!rpcUrl) {
    return json(req, { success: false, error: "RONIN_RPC_URL missing" }, 500)
  }

  let body: { contract?: string; highestId?: number }
  try {
    body = await req.json()
  } catch {
    return json(req, { success: false, error: "Invalid JSON" }, 400)
  }

  const contractRaw = String(body.contract ?? "").trim()
  const contract = normalizeContract(contractRaw)
  if (!contract) {
    return json(req, { success: false, error: "Invalid contract" }, 400)
  }

  const highestId = Number(body.highestId)
  if (!Number.isFinite(highestId) || highestId < MIN_TOKEN_ID) {
    return json(req, { success: false, error: "Invalid highestId" }, 400)
  }

  const cacheKey = `${contract}-${highestId}`
  const now = Date.now()
  const hit = CACHE.get(cacheKey)
  if (hit && now - hit.ts < TTL_MS) {
    return json(req, { success: true, data: hit.data, cached: true }, 200)
  }

  const hi = Math.floor(highestId)
  const rows: { tokenId: number; owner: string }[] = []
  let current = MIN_TOKEN_ID

  while (rows.length < TARGET && current <= hi) {
    const batchIds: number[] = []
    for (let i = 0; i < BATCH; i++) {
      const id = current + i
      if (id > hi) break
      batchIds.push(id)
    }
    if (batchIds.length === 0) break

    const results = await Promise.all(
      batchIds.map(async (id) => {
        try {
          const owner = await ownerOf(rpcUrl, contract, id)
          if (!owner) return null
          return { tokenId: id, owner }
        } catch {
          return null
        }
      }),
    )

    for (const r of results) {
      if (r) rows.push(r)
      if (rows.length >= TARGET) break
    }

    current += BATCH
  }

  CACHE.set(cacheKey, { data: rows, ts: now })
  return json(req, { success: true, data: rows, cached: false }, 200)
})
