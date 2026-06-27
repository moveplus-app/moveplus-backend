// Mint a short-lived, one-time marketplace URL token (authenticated app users only).
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const TTL_MS = 5 * 60 * 1000

function json(body: object, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders })
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405)
  }

  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return json({ error: 'Unauthorized' }, 401)
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const supabase = createClient(supabaseUrl, serviceKey)

  const jwt = authHeader.replace('Bearer ', '')
  const { data: { user }, error: userErr } = await supabase.auth.getUser(jwt)
  if (userErr || !user) {
    return json({ error: 'Invalid session' }, 401)
  }

  const token = crypto.randomUUID()
  const expiresAt = new Date(Date.now() + TTL_MS).toISOString()

  const { error: insErr } = await supabase.from('marketplace_access_tokens').insert({
    token,
    user_id: user.id,
    expires_at: expiresAt,
    used: false,
  })

  if (insErr) {
    console.error('marketplace token insert', insErr)
    return json({ error: 'Could not create token' }, 500)
  }

  return json({ token, expiresAt }, 200)
})
