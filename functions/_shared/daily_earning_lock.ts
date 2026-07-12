// CANONICAL SOURCE — copy to start-activity/, mint-energy/, complete-activity/ on change.
// Supabase deploy bundles each function alone; ../_shared/ is NOT included in deploy.

import type { SupabaseClient } from 'https://'
import type { EarningChain } from './resolve_base_founder_gear.ts'

const DEFAULT_EARN_LOCK_TIMEZONE = 'Asia/Manila'

function normalizeTimeZone(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return DEFAULT_EARN_LOCK_TIMEZONE

  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: raw }).format(new Date())
    return raw
  } catch (_err) {
    console.error('[daily_earning_lock] invalid_timezone_fallback', {
      raw,
      fallback: DEFAULT_EARN_LOCK_TIMEZONE,
    })
    return DEFAULT_EARN_LOCK_TIMEZONE
  }
}

/** Authoritative timezone for progressive earn day (10 PM boundary). */
export const EARN_LOCK_TIMEZONE = normalizeTimeZone(
  (Deno.env.get('EARN_LOCK_TIMEZONE') ?? DEFAULT_EARN_LOCK_TIMEZONE).trim(),
)
export const EARN_LOCK_BOUNDARY_HOUR = Number(Deno.env.get('EARN_LOCK_BOUNDARY_HOUR') ?? '22')

function formatYmdInTimezone(date: Date, timeZoneInput: string): string {
  const timeZone = normalizeTimeZone(timeZoneInput)
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

function hourInTimezone(date: Date, timeZoneInput: string): number {
  const timeZone = normalizeTimeZone(timeZoneInput)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    hour12: false,
  }).formatToParts(date)
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0')
  return hour === 24 ? 0 : hour
}

function addDaysToYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map((x) => Number(x))
  const dt = new Date(Date.UTC(y, m - 1, d + days))
  const yy = dt.getUTCFullYear()
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(dt.getUTCDate()).padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}

/**
 * Progressive earn day in `EARN_LOCK_TIMEZONE`.
 * If local hour >= boundary (default 22), returns next local calendar date.
 */
export function progressiveEarnDateStr(now = new Date()): string {
  const tz = EARN_LOCK_TIMEZONE
  const boundary = Number.isFinite(EARN_LOCK_BOUNDARY_HOUR)
    ? EARN_LOCK_BOUNDARY_HOUR
    : 22
  const ymd = formatYmdInTimezone(now, tz)
  const hour = hourInTimezone(now, tz)
  if (hour >= boundary) {
    return addDaysToYmd(ymd, 1)
  }
  return ymd
}

type ZonedParts = {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

function getZonedParts(date: Date, timeZoneInput: string): ZonedParts {
  const timeZone = normalizeTimeZone(timeZoneInput)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(date)
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0')
  let hour = get('hour')
  if (hour === 24) hour = 0
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour,
    minute: get('minute'),
  }
}

/** UTC ISO instant for wall-clock `ymd` at `hour`:00 in `timeZone`. */
function ymdHourToUtcIso(ymd: string, hour: number, timeZone: string): string {
  const [y, mo, d] = ymd.split('-').map((x) => Number(x))
  let ts = Date.UTC(y, mo - 1, d, hour, 0, 0, 0)
  for (let i = 0; i < 6; i++) {
    const z = getZonedParts(new Date(ts), timeZone)
    const targetDay = y * 10000 + mo * 100 + d
    const actualDay = z.year * 10000 + z.month * 100 + z.day
    const diffMinutes =
      (targetDay - actualDay) * 24 * 60 +
      (hour - z.hour) * 60 +
      (0 - z.minute)
    if (diffMinutes === 0) break
    ts += diffMinutes * 60 * 1000
  }
  return new Date(ts).toISOString()
}

/**
 * Current progressive earning window in `EARN_LOCK_TIMEZONE`.
 * Before boundary: previous local day boundary → current local day boundary.
 * At/after boundary: current local day boundary → next local day boundary.
 */
export function progressiveEarnWindow(now = new Date()): {
  earnDate: string
  startIso: string
  endIso: string
} {
  const earnDate = progressiveEarnDateStr(now)
  const boundary = Number.isFinite(EARN_LOCK_BOUNDARY_HOUR)
    ? EARN_LOCK_BOUNDARY_HOUR
    : 22
  const tz = EARN_LOCK_TIMEZONE
  const startYmd = addDaysToYmd(earnDate, -1)
  return {
    earnDate,
    startIso: ymdHourToUtcIso(startYmd, boundary, tz),
    endIso: ymdHourToUtcIso(earnDate, boundary, tz),
  }
}

export type DailyEarningLockRow = {
  id: string
  user_id: string
  earn_date: string
  timezone: string | null
  earning_chain: EarningChain
  activity_type: string
  ronin_nft_id: string | null
  base_nft_id: string | null
  created_at: string
}

export type DailyEarningLockSummary = {
  earning_chain: EarningChain
  activity_type: string
  locked: boolean
  ronin_nft_id?: string | null
  base_nft_id?: string | null
}

export function normalizeActivityTypeForLock(raw: string): string {
  const s = String(raw ?? '').trim().toLowerCase()
  if (s === 'walk' || s === 'run' || s === 'cycle') return s
  return s
}

export function dailyLockMatchesSession(
  lock: DailyEarningLockRow,
  chain: EarningChain,
  activityType: string,
  roninNftId: string | null,
  baseNftId: string | null,
): boolean {
  const at = normalizeActivityTypeForLock(activityType)
  if (lock.earning_chain !== chain) return false
  if (normalizeActivityTypeForLock(lock.activity_type) !== at) return false
  if (chain === 'ronin') {
    const want = roninNftId != null ? String(roninNftId).trim() : ''
    const got = lock.ronin_nft_id != null ? String(lock.ronin_nft_id).trim() : ''
    return want.length > 0 && want === got
  }
  const want = baseNftId != null ? String(baseNftId).trim() : ''
  const got = lock.base_nft_id != null ? String(lock.base_nft_id).trim() : ''
  return want.length > 0 && want === got
}

export async function fetchDailyEarningLock(
  supabase: SupabaseClient,
  userId: string,
  earnDate: string,
): Promise<DailyEarningLockRow | null> {
  const { data, error } = await supabase
    .from('user_daily_earning_locks')
    .select(
      'id, user_id, earn_date, timezone, earning_chain, activity_type, ronin_nft_id, base_nft_id, created_at',
    )
    .eq('user_id', userId)
    .eq('earn_date', earnDate)
    .maybeSingle()

  if (error) {
    console.error('[daily-earning-lock] fetch failed', error)
    return null
  }
  if (!data) return null
  return data as DailyEarningLockRow
}

export function toDailyLockSummary(lock: DailyEarningLockRow): DailyEarningLockSummary {
  return {
    earning_chain: lock.earning_chain,
    activity_type: lock.activity_type,
    locked: true,
    ronin_nft_id: lock.ronin_nft_id,
    base_nft_id: lock.base_nft_id,
  }
}

/** Create lock for first earning activity of the day. Idempotent on (user_id, earn_date). */
export async function createDailyEarningLock(
  supabase: SupabaseClient,
  userId: string,
  input: {
    earnDate: string
    earningChain: EarningChain
    activityType: string
    roninNftId: string | null
    baseNftId: string | null
    timezone?: string | null
  },
): Promise<DailyEarningLockRow | null> {
  const at = normalizeActivityTypeForLock(input.activityType)
  if (input.earningChain === 'ronin') {
    const rid = input.roninNftId != null ? String(input.roninNftId).trim() : ''
    if (!rid.length) return null
  }
  if (input.earningChain === 'base') {
    const bid = input.baseNftId != null ? String(input.baseNftId).trim() : ''
    if (!bid.length) return null
  }
  const row = {
    user_id: userId,
    earn_date: input.earnDate,
    timezone: normalizeTimeZone(input.timezone ?? EARN_LOCK_TIMEZONE),
    ronin_nft_id: input.earningChain === 'ronin' ? input.roninNftId : null,
    base_nft_id: input.earningChain === 'base' ? input.baseNftId : null,
    earning_chain: input.earningChain,
    activity_type: at,
  }

  const { error: insErr } = await supabase
    .from('user_daily_earning_locks')
    .insert(row)

  if (insErr && insErr.code !== '23505') {
    console.error('[daily-earning-lock] insert failed', insErr)
    return null
  }

  return fetchDailyEarningLock(supabase, userId, input.earnDate)
}

export type DailyLockGateResult = {
  allowed: boolean
  warningCode: 'DAILY_EARNING_LOCK_MISMATCH' | null
  dailyLock: DailyEarningLockSummary | null
}

/**
 * Enforce daily earning lock before session gear lock.
 * Creates lock on first eligible earn; mismatches → record-only.
 */
export async function gateSessionWithDailyEarningLock(
  supabase: SupabaseClient,
  userId: string,
  input: {
    earnDate: string
    earningChain: EarningChain | null
    activityType: string
    roninNftId: string | null
    baseNftId: string | null
  },
): Promise<DailyLockGateResult> {
  const existing = await fetchDailyEarningLock(supabase, userId, input.earnDate)

  if (input.earningChain == null) {
    return {
      allowed: false,
      warningCode: null,
      dailyLock: existing ? toDailyLockSummary(existing) : null,
    }
  }

  if (!existing) {
    const created = await createDailyEarningLock(supabase, userId, {
      earnDate: input.earnDate,
      earningChain: input.earningChain,
      activityType: input.activityType,
      roninNftId: input.roninNftId,
      baseNftId: input.baseNftId,
    })
    if (!created) {
      const raced = await fetchDailyEarningLock(supabase, userId, input.earnDate)
      if (
        raced &&
        !dailyLockMatchesSession(
          raced,
          input.earningChain,
          input.activityType,
          input.roninNftId,
          input.baseNftId,
        )
      ) {
        return {
          allowed: false,
          warningCode: 'DAILY_EARNING_LOCK_MISMATCH',
          dailyLock: toDailyLockSummary(raced),
        }
      }
      return {
        allowed: true,
        warningCode: null,
        dailyLock: raced ? toDailyLockSummary(raced) : null,
      }
    }
    return {
      allowed: true,
      warningCode: null,
      dailyLock: toDailyLockSummary(created),
    }
  }

  const matches = dailyLockMatchesSession(
    existing,
    input.earningChain,
    input.activityType,
    input.roninNftId,
    input.baseNftId,
  )

  if (!matches) {
    return {
      allowed: false,
      warningCode: 'DAILY_EARNING_LOCK_MISMATCH',
      dailyLock: toDailyLockSummary(existing),
    }
  }

  return {
    allowed: true,
    warningCode: null,
    dailyLock: toDailyLockSummary(existing),
  }
}

/** Defense-in-depth for mint/complete when session still has earning_chain. */
export async function isDailyEarningLockBlocked(
  supabase: SupabaseClient,
  userId: string,
  earnDate: string,
  chain: EarningChain,
  activityType: string,
  roninNftId: string | null,
  baseNftId: string | null,
): Promise<boolean> {
  const lock = await fetchDailyEarningLock(supabase, userId, earnDate)
  if (!lock) return false
  return !dailyLockMatchesSession(lock, chain, activityType, roninNftId, baseNftId)
}
