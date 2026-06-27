// Public read by payment_id (UUID secret) — web uses this instead of trusting token_id in the URL.
// Some scripts cut for securtiy reason.


function json(body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
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

  if (req.method !== 'POST') {
    return json({ success: false, error: 'Method not allowed' }, 405)
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const supabase = createClient(supabaseUrl, serviceKey)

  let body: { payment_id?: string }
  try {
    body = await req.json()
  } catch {
    return json({ success: false, error: 'Invalid JSON' }, 400)
  }

  const paymentId = String(body.payment_id ?? '').trim()
  if (!paymentId) {
    return json({ success: false, error: 'Missing payment_id' }, 400)
  }

  const { data: pay, error: pErr } = await supabase
    .from('upgrade_payments')
    .select('id, status, expires_at, prep_action, expected_enr_cost, expected_min_wei, user_nft_id')
    .eq('id', paymentId)
    .maybeSingle()

  if (pErr || !pay) {
    return json({ success: false, error: 'Session not found' }, 404)
  }

  const { data: shoe, error: sErr } = await supabase
    .from('user_nfts')
    .select('token_id, contract_address, rarity')
    .eq('id', pay.user_nft_id as string)
    .maybeSingle()

  if (sErr || !shoe) {
    return json({ success: false, error: 'NFT not found' }, 404)
  }

  const exp = new Date(String(pay.expires_at)).getTime()
  const expired = Number.isFinite(exp) && Date.now() > exp

  console.log(JSON.stringify({
    event: 'get_upgrade_wallet_session',
    payment_id: paymentId,
    status: pay.status,
    expired,
  }))

  return json(
    {
      success: true,
      payment_id: pay.id,
      status: pay.status,
      expires_at: pay.expires_at,
      expired,
      prep_action: pay.prep_action,
      expected_enr_cost: pay.expected_enr_cost,
      expected_min_wei: pay.expected_min_wei,
      token_id: shoe.token_id,
      contract_address: shoe.contract_address,
      rarity: shoe.rarity,
    },
    200,
  )
})
