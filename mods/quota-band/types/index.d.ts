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
    'quota-band': {
      stats: QuotaStats
      windows: QuotaWindow[]
      cacheExpiresAt: number | null
      now: number
    }
  }
}
