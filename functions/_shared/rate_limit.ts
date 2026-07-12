/**
 * Hashed backend rate limits for Base onboarding edge functions.
 * Canonical copy — vendored into each deploy folder (Supabase does not bundle ../_shared).
 *
 * Requires migration 20260728120000_security_rate_limits.sql and env RATE_LIMIT_SALT.
 */

import { createClient } from 'https://';

export const RATE_LIMIT_ERROR = {
  error: 'RATE_LIMITED',
  error_code: 'RATE_LIMITED',
  message: 'Too many attempts. Please try again later.',
} as const;

export type RateLimitRule = {
  scope: string;
  identifierParts: (string | null | undefined)[];
  maxRequests: number;
  windowSeconds: number;
};

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function hashRateLimitIdentifier(
  ...parts: (string | null | undefined)[]
): Promise<string> {
  const salt = Deno.env.get('RATE_LIMIT_SALT')?.trim() ?? '';
  const joined = parts
    .filter((p) => p != null && String(p).trim() !== '')
    .map((p) => String(p).trim())
    .join('|');
  if (!joined) {
    return sha256Hex(`${salt}:anonymous`);
  }
  return sha256Hex(`${salt}:${joined}`);
}

export function readClientIpForRateLimit(req: Request): string | null {
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  const realIp = req.headers.get('x-real-ip')?.trim();
  return realIp || null;
}

function windowStartIso(nowMs: number, windowSeconds: number): string {
  const bucketSec = Math.floor(nowMs / 1000 / windowSeconds) * windowSeconds;
  return new Date(bucketSec * 1000).toISOString();
}

export async function enforceRateLimits(
  admin: ReturnType<typeof createClient>,
  rules: RateLimitRule[],
): Promise<{ ok: true } | { ok: false; scope: string }> {
  const nowMs = Date.now();

  for (const rule of rules) {
    const identifierHash = await hashRateLimitIdentifier(...rule.identifierParts);
    const windowStart = windowStartIso(nowMs, rule.windowSeconds);

    const { data, error } = await admin.rpc('increment_security_rate_limit', {
      p_scope: rule.scope,
      p_identifier_hash: identifierHash,
      p_window_start: windowStart,
      p_max_requests: rule.maxRequests,
    });

    if (error || !data || data.allowed !== true) {
      return { ok: false, scope: rule.scope };
    }
  }

  return { ok: true };
}
