// Base Founder Gear KM curve — Founder collection only. Level 10 = 500 km.
// Copy to complete-activity/base_founder_level.ts for Supabase deploy bundle.
// 200 km is an in-segment milestone (L8→L9); it does not change level.
// TODO: awaken at L10 + 500 km — reset level, repair rate (not implemented).

/** Cumulative km thresholds for Founder levels 2–10 (index 0 = L2). */
export const BASE_FOUNDER_KM_CURVE = [5, 8, 12, 20, 50, 70, 100, 350, 500] as const

/** Display-only milestone inside L8→L9 (100–350 km). Does not affect level. */
export const BASE_FOUNDER_MIDPOINT_KM = 200

export type BaseGearRowForFounderCheck = {
  contract_address: string
  rarity?: string | null
  metadata?: Record<string, unknown> | null
}

function asRecord(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return v as Record<string, unknown>
  }
  return {}
}

/** True only for Base Founder Gear — seasonal / other collections excluded. */
export function isFounderBaseGearRow(row: BaseGearRowForFounderCheck): boolean {
  const metadata = asRecord(row.metadata)
  const metaType = String(metadata.gear_type ?? '').trim().toLowerCase()
  if (metaType === 'founder') return true
  if (metaType) return false

  const rarity = String(row.rarity ?? '').trim().toLowerCase()
  if (rarity === 'founder') return true

  // Do not infer Founder from contract address alone — future Base collections may differ.
  return false
}

/** Founder level from cumulative km. Level 10 requires 500 km (not 350). */
export function calculateBaseFounderLevel(totalKm: number): number {
  const km = Number.isFinite(totalKm) ? Math.max(0, totalKm) : 0
  if (km >= 500) return 10
  if (km >= 350) return 9
  if (km >= 100) return 8
  if (km >= 70) return 7
  if (km >= 50) return 6
  if (km >= 20) return 5
  if (km >= 12) return 4
  if (km >= 8) return 3
  if (km >= 5) return 2
  return 1
}

export function baseFounderKmForLevel(targetLevel: number): number {
  const lv = Math.max(1, Math.min(10, Math.floor(targetLevel)))
  if (lv <= 1) return 0
  return BASE_FOUNDER_KM_CURVE[lv - 2] ?? 500
}
