// CANONICAL SOURCE — copy to mint-energy/, complete-activity/ on change.
// Supabase deploy bundles each function alone; ../_shared/ is NOT included in deploy.

import type { SupabaseClient } from 'https://'
import { progressiveEarnWindow } from './daily_earning_lock.ts'

/**
 * Saved eligible earning activities in the current progressive day window.
 * Excludes unsaved drafts, record-only sessions, and zero-energy saves.
 */
export async function countEligibleCompletedEarningActivities(
  supabase: SupabaseClient,
  userId: string,
  activityType: string,
  now = new Date(),
): Promise<number> {
  const { startIso, endIso } = progressiveEarnWindow(now)
  const at = String(activityType ?? '').trim().toLowerCase()

  const { count, error } = await supabase
    .from('activity_sessions')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('is_finalized', true)
    .eq('activity_type', at)
    .not('earning_chain', 'is', null)
    .eq('has_nft_at_start', true)
    .gt('energy_earned', 0)
    .gte('created_at', startIso)
    .lt('created_at', endIso)

  if (error) {
    console.error('[eligible-earning-count]', error)
    return 0
  }
  return count ?? 0
}
