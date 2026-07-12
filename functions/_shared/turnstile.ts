/**
 * Cloudflare Turnstile server-side verification (Supabase Edge Functions).
 * Secret: CLOUDFLARE_TURNSTILE_SECRET_KEY (Supabase secrets only — never log).
 */

export const TURNSTILE_VERIFY_URL =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify'

export type TurnstileErrorCode =
  | 'TURNSTILE_MISSING_TOKEN'
  | 'TURNSTILE_SECRET_NOT_CONFIGURED'
  | 'TURNSTILE_VERIFY_FAILED'
  | 'TURNSTILE_HTTP_ERROR'

export type TurnstileVerifyResult =
  | { ok: true }
  | { ok: false; errorCode: TurnstileErrorCode; httpStatus?: number }

export function readTurnstileTokenFromBody(body: Record<string, unknown>): string {
  const raw = body.turnstileToken ?? body.turnstile_token ?? body.token
  return typeof raw === 'string' ? raw.trim() : ''
}

export async function verifyTurnstileToken(params: {
  token: string | null | undefined
  remoteIp?: string | null
}): Promise<TurnstileVerifyResult> {
  const secret = Deno.env.get('CLOUDFLARE_TURNSTILE_SECRET_KEY')?.trim()
  if (!secret) {
    return { ok: false, errorCode: 'TURNSTILE_SECRET_NOT_CONFIGURED' }
  }

  const token = params.token?.trim() ?? ''
  if (!token) {
    return { ok: false, errorCode: 'TURNSTILE_MISSING_TOKEN' }
  }

  const form = new URLSearchParams()
  form.set('secret', secret)
  form.set('response', token)
  const remoteIp = params.remoteIp?.trim()
  if (remoteIp) {
    form.set('remoteip', remoteIp)
  }

  let response: Response
  try {
    response = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    })
  } catch {
    return { ok: false, errorCode: 'TURNSTILE_HTTP_ERROR' }
  }

  if (!response.ok) {
    return {
      ok: false,
      errorCode: 'TURNSTILE_HTTP_ERROR',
      httpStatus: response.status,
    }
  }

  let payload: { success?: boolean }
  try {
    payload = await response.json()
  } catch {
    return { ok: false, errorCode: 'TURNSTILE_VERIFY_FAILED' }
  }

  if (payload.success !== true) {
    return { ok: false, errorCode: 'TURNSTILE_VERIFY_FAILED' }
  }

  return { ok: true }
}
