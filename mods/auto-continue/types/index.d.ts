export type AutoContinueWait = {
  // when the prompt is sent: the window's reset, plus a margin
  wakeAt: number
  // the window that ran out (`seven_day`, `five_hour`), or null when the reset time was not reported
  kind: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'auto-continue': {
      isEnabled: boolean | null
      maxWaitMs: number | null
      // when the quota first ran out in this stretch; the wait allowed counts from here
      limitedSince: number | null
      wait: AutoContinueWait | null
      attempts: number
    }
  }
}
