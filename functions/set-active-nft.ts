// Set the single equipped user_nfts row for the authenticated user.
// - Atomic DB update: RPC `set_user_active_nft` (transaction: deactivate all → activate target → wallet timestamp).
// - Cooldown when *switching*: 72h from `wallet_connections.last_nft_switch_at` only (global anchor).
// - First equip when nothing is equipped: allowed even if `last_nft_switch_at` is set (no row with is_active).
// - Requires confirmed wallet_connections; RPC fails if cooldown timestamp cannot be written.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const SWITCH_COOLDOWN_MS = 72 * 60 * 60 * 1000

function json(body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  })
}

function normalizeAddr(input: string): string {
  const s = input.trim().toLowerCase()
  if (s.startsWith("ronin:")) {
    const rest = s.slice("ronin:".length)
    return rest.startsWith("0x") ? rest : `0x${rest}`
  }
  return s.startsWith("0x") ? s : `0x${s}`
}

function shortUserId(id: string): string {
  const s = String(id)
  if (s.length <= 10) return s
  return `${s.slice(0, 4)}…${s.slice(-4)}`
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      },
    })
  }

  if (req.method !== "POST") {
    return json({ success: false, error: "Method not allowed" }, 405)
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
    if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
      return json({ success: false, error: "Server misconfigured" }, 500)
    }

    const authHeader = req.headers.get("Authorization") ?? ""
    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: userData, error: userErr } = await userClient.auth.getUser()
    if (userErr || !userData?.user) {
      return json({ success: false, error: "Unauthorized" }, 401)
    }
    const user = userData.user

    let body: {
      user_nft_id?: string
      token_id?: string
      contract_address?: string
    }
    try {
      body = await req.json()
    } catch {
      return json({ success: false, error: "Invalid JSON" }, 400)
    }

    const admin = createClient(supabaseUrl, serviceRoleKey)

    const { data: walletRow, error: walletErr } = await admin
      .from("wallet_connections")
      .select("last_nft_switch_at, is_confirmed")
      .eq("user_id", user.id)
      .maybeSingle()

    if (walletErr) {
      console.error("set-active-nft: wallet lookup", walletErr)
      return json({ success: false, error: "Wallet lookup failed" }, 500)
    }

    if (!walletRow || walletRow.is_confirmed !== true) {
      console.log("set-active-nft: wallet not confirmed", {
        user_id: shortUserId(user.id),
        wallet_present: Boolean(walletRow),
        cooldown: "n/a",
        last_nft_switch_at: walletRow?.last_nft_switch_at ?? null,
      })
      return json({
        success: false,
        reason: "wallet_not_confirmed",
        error:
          "Connect and confirm your wallet before equipping GEAR. Open Web3 → Wallet, verify your connection, then try again.",
      }, 403)
    }

    let nftId = String(body.user_nft_id ?? "").trim()
    const rawTid = body.token_id != null ? String(body.token_id).trim() : ""
    const rawCa = body.contract_address != null ? String(body.contract_address).trim() : ""

    if (!nftId && rawTid.length > 0 && rawCa.length > 0) {
      const ca = normalizeAddr(rawCa)
      const { data: byTok, error: tokErr } = await admin
        .from("user_nfts")
        .select("id")
        .eq("user_id", user.id)
        .eq("contract_address", ca)
        .eq("token_id", rawTid)
        .maybeSingle()
      if (tokErr) {
        console.error("set-active-nft: lookup by token", tokErr)
        return json({ success: false, error: "NFT lookup failed" }, 500)
      }
      nftId = byTok?.id ? String(byTok.id) : ""
    }

    if (!nftId) {
      return json({
        success: false,
        error: "Provide user_nft_id or token_id + contract_address",
      }, 400)
    }

    const { data: owned, error: ownErr } = await admin
      .from("user_nfts")
      .select("id")
      .eq("id", nftId)
      .eq("user_id", user.id)
      .maybeSingle()

    if (ownErr || !owned) {
      return json({ success: false, error: "NFT not found" }, 404)
    }

    const now = Date.now()
    const pendingCutoff = new Date(now - 72 * 60 * 60 * 1000).toISOString()
    const staleLiveCutoff = new Date(now - 30 * 60 * 1000).toISOString()

    // Remove zero-movement draft rows so they do not block equip (real sessions keep distance > 0).
    await admin
      .from("activity_sessions")
      .delete()
      .eq("user_id", user.id)
      .eq("is_finalized", false)
      .eq("distance_meters", 0)
      .is("energy_earned", null)
      .eq("tracking_live", false)
      .gte("created_at", pendingCutoff)

    await admin
      .from("activity_sessions")
      .delete()
      .eq("user_id", user.id)
      .eq("is_finalized", false)
      .eq("distance_meters", 0)
      .is("energy_earned", null)
      .eq("tracking_live", true)
      .lt("created_at", staleLiveCutoff)

    const { data: pendingSession } = await admin
      .from("activity_sessions")
      .select("id")
      .eq("user_id", user.id)
      .eq("is_finalized", false)
      .gte("created_at", pendingCutoff)
      .limit(1)
      .maybeSingle()

    if (pendingSession?.id) {
      return json({
        success: false,
        error:
          "Cannot switch NFT while an activity from the last 72h is still pending finalization. Finish saving the activity or wait for the lock to expire.",
        reason: "activity_pending_finalize",
      }, 200)
    }

    const { data: currentActive } = await admin
      .from("user_nfts")
      .select("id")
      .eq("user_id", user.id)
      .eq("is_active", true)
      .maybeSingle()

    if (currentActive?.id === nftId) {
      const { data: row } = await admin
        .from("user_nfts")
        .select("id, token_id, contract_address")
        .eq("id", nftId)
        .eq("user_id", user.id)
        .maybeSingle()
      const lastSwitchAt = walletRow.last_nft_switch_at?.toString() ?? null
      return json({
        success: true,
        user_nft_id: nftId,
        unchanged: true,
        last_nft_switch_at: lastSwitchAt,
        active_nft: row
          ? {
            id: row.id,
            token_id: row.token_id,
            contract_address: row.contract_address,
          }
          : undefined,
      }, 200)
    }

    // Global cooldown: only when switching from one equipped shoe to another.
    if (currentActive?.id && currentActive.id !== nftId) {
      const last = walletRow.last_nft_switch_at
        ? new Date(walletRow.last_nft_switch_at as string).getTime()
        : NaN
      if (Number.isFinite(last) && Date.now() - last < SWITCH_COOLDOWN_MS) {
        const retryAfterMs = last + SWITCH_COOLDOWN_MS
        const remainingMs = Math.max(0, retryAfterMs - Date.now())
        const remainingHours = Math.ceil(remainingMs / (1000 * 60 * 60))
        console.log("set-active-nft: cooldown_active", {
          user_id: shortUserId(user.id),
          user_nft_id: nftId,
          cooldown: "blocked",
          last_nft_switch_at: walletRow.last_nft_switch_at,
        })
        return json({
          success: false,
          reason: "cooldown_active",
          error: "You can only switch your earning shoe once every 72 hours.",
          retry_after: new Date(retryAfterMs).toISOString(),
          remaining_hours: remainingHours,
          remaining_ms: remainingMs,
          last_nft_switch_at: walletRow.last_nft_switch_at,
        }, 200)
      }
    }

    const { data: rpcRaw, error: rpcErr } = await admin.rpc("set_user_active_nft", {
      p_user_id: user.id,
      p_user_nft_id: nftId,
    })

    if (rpcErr) {
      console.error("set-active-nft: rpc failed", rpcErr)
      return json({ success: false, error: "Failed to update equipped NFT" }, 500)
    }

    const rpcResult = rpcRaw as Record<string, unknown> | null
    if (!rpcResult || rpcResult.success !== true) {
      const reason = rpcResult?.reason?.toString() ?? ""
      const err = rpcResult?.error?.toString() ?? "Failed to set equipped NFT"
      console.log("set-active-nft: rpc rejected", {
        user_id: shortUserId(user.id),
        user_nft_id: nftId,
        cooldown: reason === "wallet_connection_missing" ? "missing_wallet_row" : "failed",
        last_nft_switch_at: null,
        reason: reason || undefined,
      })
      if (reason === "wallet_connection_missing") {
        return json({
          success: false,
          reason,
          error:
            "Wallet connection missing. Reconnect and confirm your wallet in Web3, then try equipping again.",
        }, 403)
      }
      const st = err.includes("not found") ? 404 : 500
      return json({ success: false, error: err, reason: reason || undefined }, st)
    }

    const tid = rpcResult.token_id?.toString() ?? ""
    const ca = rpcResult.contract_address?.toString() ?? ""
    const lastSwitchAt = rpcResult.last_nft_switch_at?.toString() ?? null

    console.log("set-active-nft: equip ok", {
      user_id: shortUserId(user.id),
      user_nft_id: nftId,
      cooldown: lastSwitchAt ? "written" : "missing",
      last_nft_switch_at: lastSwitchAt,
    })

    return json({
      success: true,
      user_nft_id: rpcResult.user_nft_id,
      token_id: tid,
      contract_address: ca,
      last_nft_switch_at: lastSwitchAt,
      active_nft: {
        id: rpcResult.user_nft_id,
        token_id: tid,
        contract_address: ca,
      },
    }, 200)
  } catch (e) {
    return json({ success: false, error: String(e) }, 500)
  }
})
