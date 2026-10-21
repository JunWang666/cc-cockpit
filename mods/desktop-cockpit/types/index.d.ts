export type CockpitWindow = { kind: string; percentUsed: number; resetsAt?: string }

export type CockpitStats = {
  turn: number
  speed: number | null
  turnCost: number | null
  total: number
  costAtStart: number
  context: number
}

export type CockpitCommit = { hash: string; time: number; subject: string }

export type CockpitGit = {
  branch: string
  changes: number
  ahead: number | null
  behind: number | null
  commits: CockpitCommit[]
}

export type CockpitSession = {
  id: string
  prompt: string
  prompts: number
  time: number
  // the latest session only: its last recap and the files it edited
  recap?: string
  edited?: string[]
}

export type CockpitDoc = { name: string; title: string; gist: string; lines: number; preview: string[] }

export type CockpitProject = {
  git: CockpitGit | null
  docs: CockpitDoc[]
  sessions: CockpitSession[]
  scannedAt: number
}

export type CockpitTab = 'usage' | 'project' | 'prompts'

declare module 'claude-code' {
  interface PluginState {
    'desktop-cockpit': {
      stats: CockpitStats
      windows: CockpitWindow[]
      cacheExpiresAt: number | null
      now: number
      project: CockpitProject | null
      isWelcomeShown: boolean
      openDoc: string | null
      tab: CockpitTab
      filter: string
    }
  }
}
