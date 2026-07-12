/**
 * Finalize an abandoned activity draft without rewards, wear, or gear updates.
 * Does NOT delete the row (preserves audit trail for distance if saved client-side).
 */

import { serve } from 'https://'
import { createClient } from 'https://'

function json(body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  })
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
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const anon = Deno.env.get('SUPABASE_ANON_KEY')
    const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!supabaseUrl || !anon || !service) {
      return json({ error: 'Server misconfigured' }, 500)
    }

    const userClient = createClient(supabaseUrl, anon, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    })
    const { data: auth, error: authErr } = await userClient.auth.getUser()
    if (authErr || !auth?.user) return json({ error: 'Unauthorized' }, 401)
    const user = auth.user

    let body: { session_id?: string; activity_session_id?: string }
    try {
      body = await req.json()
    } catch {
      return json({ error: 'Invalid JSON' }, 400)
    }

    const sessionId = (body.session_id ?? body.activity_session_id ?? '').trim()
    if (!sessionId) return json({ error: 'session_id required' }, 400)

    const admin = createClient(supabaseUrl, service)
    const nowIso = new Date().toISOString()

    const { data: row, error: selErr } = await admin
      .from('activity_sessions')
      .select('id, is_finalized, energy_earned')
      .eq('id', sessionId)
      .eq('user_id', user.id)
      .maybeSingle()

    if (selErr || !row) return json({ error: 'Activity not found' }, 404)
    if (row.is_finalized === true) {
      return json({ success: true, already_finalized: true }, 200)
    }

    const energyPatch =
      row.energy_earned == null ? { energy_earned: 0 } : {}

    const { error: updErr } = await admin
      .from('activity_sessions')
      .update({
        is_finalized: true,
        tracking_live: false,
        ...energyPatch,
        updated_at: nowIso,
      })
      .eq('id', sessionId)
      .eq('user_id', user.id)
      .eq('is_finalized', false)

    if (updErr) {
      console.error('abandon-activity-session update', updErr)
      return json({ error: 'Failed to abandon session' }, 500)
    }

    console.log('[activity-session-abandon]', {
      user_id: user.id,
      session_id: sessionId,
    })

    return json({ success: true }, 200)
  } catch (e) {
    return json({ error: String(e) }, 500)
  }
})
