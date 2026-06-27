// MOVE+ Waypoint wallet bind — same rules as bind-wallet (strict 1 account = 1 wallet).
// INTENTIONAL CUT THE OTHER SCRIPT


const MIGRATION_REQUEST_TTL_MINUTES = 30
const WAYPOINT_JWKS_URL = "https://waypoint.roninchain.com/.well-known/jwks.json"
const WAYPOINT_JWT_ISSUER = "https://id.skymavis.com"
const WAYPOINT_JWKS = jose.createRemoteJWKSet(new URL(WAYPOINT_JWKS_URL))

function json(body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  })
}

function normalizeRoninAddress(input: string): string {
  const s = input.trim()
  if (s.startsWith("ronin:")) {
    const rest = s.slice("ronin:".length)
    return rest.startsWith("0x") ? rest.toLowerCase() : `0x${rest}`.toLowerCase()
  }
  return s.toLowerCase()
}

function walletFromWaypointJwtPayload(payload: jose.JWTPayload): string {
  const raw = payload.roninAddress ?? payload.ronin_address ?? payload.wallet_address ??
    payload.address
  if (typeof raw !== "string" || !raw.trim()) return ""
  return normalizeRoninAddress(raw)
}

async function verifyWaypointIdTokenForWallet(
  idToken: string,
  expectedWallet: string,
): Promise<{ ok: boolean; error?: string }> {
  const clientId = Deno.env.get("WAYPOINT_CLIENT_ID")?.trim()
  if (!clientId) {
    return { ok: false, error: "WAYPOINT_CLIENT_ID not configured" }
  }

  try {
    const { payload } = await jose.jwtVerify(idToken, WAYPOINT_JWKS, {
      issuer: WAYPOINT_JWT_ISSUER,
      audience: clientId,
    })
    const tokenWallet = walletFromWaypointJwtPayload(payload)
    if (!tokenWallet || !/^0x[a-f0-9]{40}$/.test(tokenWallet)) {
      return { ok: false, error: "ID token missing roninAddress" }
    }
    if (tokenWallet !== normalizeRoninAddress(expectedWallet)) {
      return { ok: false, error: "ID token wallet does not match requested address" }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

async function upsertPendingMigrationRequest(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  oldWallet: string,
  newWallet: string,
  provider: string,
  metadata: Record<string, unknown> = {},
): Promise<{ ok: boolean; error?: string }> {
  const nowIso = new Date().toISOString()
  const expiresAt = new Date(Date.now() + MIGRATION_REQUEST_TTL_MINUTES * 60 * 1000)
    .toISOString()

  await supabase
    .from("ronin_wallet_migration_requests")
    .update({ status: "cancelled", consumed_at: nowIso })
    .eq("user_id", userId)
    .eq("status", "pending")
    .is("consumed_at", null)

  const { error } = await supabase.from("ronin_wallet_migration_requests").insert({
    user_id: userId,
    old_wallet_address: oldWallet,
    new_wallet_address: newWallet,
    provider,
    status: "pending",
    expires_at: expiresAt,
    verified_at: nowIso,
    metadata,
  })

  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, apikey, content-type",
      },
    })
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    )

    const authHeader = req.headers.get("Authorization")
    if (!authHeader) {
      return json({ success: false, error: "Unauthorized" }, 401)
    }

    const token = authHeader.replace("Bearer ", "")
    const { data: { user }, error: userError } = await supabase.auth.getUser(token)
    if (userError || !user) {
      return json({ success: false, error: "Invalid user" }, 401)
    }

    const userId = user.id
    const body = await req.json()
    let rawAddress = (body.wallet_address || body.address || "").trim()
    if (rawAddress.startsWith("ronin:")) rawAddress = "0x" + rawAddress.slice(6)
    const walletAddress = normalizeRoninAddress(rawAddress)

    if (!walletAddress || !/^0x[a-f0-9]{40}$/.test(walletAddress)) {
      return json({ success: false, error: "Missing or invalid wallet address" }, 400)
    }

    const idToken = typeof body.data === "string"
      ? body.data.trim()
      : typeof body.id_token === "string"
      ? body.id_token.trim()
      : ""

    const { data: addressOwner } = await supabase
      .from("wallet_connections")
      .select("user_id")
      .eq("wallet_address", walletAddress)
      .maybeSingle()

    if (addressOwner && addressOwner.user_id !== userId) {
      return json({
        success: false,
        error_code: "WALLET_ALREADY_IN_USE",
        message: "This Ronin wallet is already linked to another Move+ account.",
      }, 400)
    }

    const { data: existingRow } = await supabase
      .from("wallet_connections")
      .select("id, wallet_address, is_confirmed, is_active, connection_type")
      .eq("user_id", userId)
      .maybeSingle()

    if (existingRow) {
      const existingAddr = normalizeRoninAddress(existingRow.wallet_address)
      if (existingAddr !== walletAddress) {
        if (!idToken) {
          return json({
            success: false,
            error_code: "MIGRATION_AUTH_REQUIRED",
            message: "Please reconnect your Ronin wallet before syncing migrated Gear.",
          }, 403)
        }

        const jwtCheck = await verifyWaypointIdTokenForWallet(idToken, walletAddress)
        if (!jwtCheck.ok) {
          return json({
            success: false,
            error_code: "MIGRATION_AUTH_REQUIRED",
            message: "Please reconnect your Ronin wallet before syncing migrated Gear.",
          }, 403)
        }

        const pending = await upsertPendingMigrationRequest(
          supabase,
          userId,
          existingAddr,
          walletAddress,
          "ronin_stash",
          { auth_method: "waypoint_sdk", migration_reason: "waypoint_to_stash" },
        )
        if (!pending.ok) {
          return json({ success: false, error: pending.error ?? "Failed to store migration request" }, 500)
        }

        return json({
          success: true,
          migration_pending: true,
          wallet_migrated: false,
          previous_wallet: existingAddr,
          pending_wallet_address: walletAddress,
          wallet: walletAddress,
          message:
            "We detected a new Ronin wallet. If you migrated from Ronin Waypoint to Ronin Stash, tap Sync Gear to relink your NFTs.",
        }, 200)
      }

      const nowIso = new Date().toISOString()
      const { error: updErr } = await supabase
        .from("wallet_connections")
        .update({
          is_active: true,
          is_confirmed: true,
          disconnected_at: null,
          connected_at: nowIso,
          confirmed_at: nowIso,
          updated_at: nowIso,
        })
        .eq("id", existingRow.id)

      if (updErr) {
        return json({ success: false, error: updErr.message }, 500)
      }

      const { error: linkNftsErr } = await supabase
        .from("user_nfts")
        .update({
          user_id: userId,
          last_verified_at: nowIso,
        })
        .eq("wallet_address", walletAddress)
        .is("user_id", null)
      if (linkNftsErr) {
        console.warn("waypoint-sdk-bind: link indexed user_nfts failed", linkNftsErr)
      }

      return json({
        success: true,
        wallet: existingRow.wallet_address,
        message: "Wallet bound",
      }, 200)
    }

    const nowIso = new Date().toISOString()
    const { error: insertError } = await supabase.from("wallet_connections").insert({
      user_id: userId,
      wallet_address: walletAddress,
      chain: "ronin",
      connection_type: "ronin",
      is_confirmed: true,
      is_active: true,
      connected_at: nowIso,
      confirmed_at: nowIso,
      updated_at: nowIso,
    })

    if (insertError) {
      return json({ success: false, error: insertError.message }, 500)
    }

    const { error: linkNftsErr } = await supabase
      .from("user_nfts")
      .update({
        user_id: userId,
        last_verified_at: nowIso,
      })
      .eq("wallet_address", walletAddress)
      .is("user_id", null)
    if (linkNftsErr) {
      console.warn("waypoint-sdk-bind: link indexed user_nfts failed", linkNftsErr)
    }

    return json({ success: true, wallet: walletAddress }, 200)
  } catch (err) {
    return json({ success: false, error: "Internal error", details: String(err) }, 500)
  }
})
