export type QuotaWindow = { kind: string; percentUsed: number; resetsAt?: string }

export type QuotaStats = {
  turn: number
  speed: number | null
  turnCost: number | null
  total: number
  costAtStart: number
  context: number
}

declare module 'claude-code' {
  interface PluginState {
    // what the band reads of the auto-continue mod, when it is installed
    'auto-continue': {
      isEnabled: boolean | null
      wait: { wakeAt: number; kind: string | null } | null
      scheduled: { at: number; text: string } | null
    }
    'quota-band': {
      stats: QuotaStats
      windows: QuotaWindow[]
      cacheExpiresAt: number | null
      now: number
    }
  }
}
