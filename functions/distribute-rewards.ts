/**
 * Calls finish_and_distribute_challenge_rooms() with the service role:
 * 1) finish_expired_challenge_rooms — mark rooms past end_at as finished
 * 2) distribute_ready_player_one_rewards_batch — Energy, snapshot, notifications
 *
 * Schedule via Supabase cron, GitHub Actions, or similar.
 *
 * Optional: CRON_SECRET — Authorization: Bearer <CRON_SECRET>
 * Optional: CORS_ORIGIN — e.g. https://yourapp.com (default * for cron-only use)
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': Deno.env.get('CORS_ORIGIN') ?? '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
}

const RPC_TIMEOUT_MS = 15_000

function parsedProcessedRooms(data: unknown): number {
  if (data == null || typeof data !== 'object') return 0
  const d = data as Record<string, unknown>
  const dist = d.distribution
  if (dist != null && typeof dist === 'object') {
    const rooms = (dist as Record<string, unknown>).rooms_processed
    if (typeof rooms === 'number') return rooms
  }
  return 0
}

function parsedFinishedExpired(data: unknown): number {
  if (data == null || typeof data !== 'object') return 0
  const n = (data as Record<string, unknown>).finished_expired_rooms
  return typeof n === 'number' ? n : 0
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const cronSecret = Deno.env.get('CRON_SECRET')
  const auth = req.headers.get('Authorization') ?? ''
  if (cronSecret && auth !== `Bearer ${cronSecret}`) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const url = Deno.env.get('SUPABASE_URL') ?? ''
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  if (!url || !key) {
    return new Response(
      JSON.stringify({ error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY' }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      },
    )
  }

  const supabase = createClient(url, key)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS)

  let data: unknown
  let error: { message: string } | null

  try {
    const res = await supabase.rpc(
      'finish_and_distribute_challenge_rooms',
      {},
      { signal: controller.signal },
    )
    data = res.data
    error = res.error
  } catch (err) {
    clearTimeout(timeout)
    console.error('[CRON][RPO][TIMEOUT]', {
      message: err instanceof Error ? err.message : String(err),
      time: new Date().toISOString(),
    })
    return new Response(
      JSON.stringify({ success: false, error: 'Timeout or aborted' }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      },
    )
  }

  clearTimeout(timeout)

  if (error) {
    console.error('[CRON][RPO][ERROR]', {
      message: error.message,
      time: new Date().toISOString(),
    })
    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      },
    )
  }

  const processedRooms = parsedProcessedRooms(data)
  const finishedExpired = parsedFinishedExpired(data)

  console.log('[CRON][RPO] success', {
    time: new Date().toISOString(),
    finished_expired_rooms: finishedExpired,
    processed_rooms: processedRooms,
    raw: data,
  })

  return new Response(
    JSON.stringify({
      success: true,
      finished_expired_rooms: finishedExpired,
      processed_rooms: processedRooms,
    }),
    {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    },
  )
})
