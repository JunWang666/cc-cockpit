export type WelcomeCommit = { hash: string; time: number; subject: string }

export type WelcomeGit = {
  branch: string
  changes: number
  ahead: number | null
  behind: number | null
  commits: WelcomeCommit[]
}

export type WelcomeSession = {
  id: string
  prompt: string
  prompts: number
  time: number
  // the latest session only: its last recap and the files it edited
  recap?: string
  edited?: string[]
}

export type WelcomeDoc = { name: string; title: string; gist: string; lines: number; preview: string[] }

export type WelcomeInfo = { git: WelcomeGit | null; docs: WelcomeDoc[]; sessions: WelcomeSession[]; scannedAt: number }

declare module 'claude-code' {
  interface PluginState {
    welcome: { info: WelcomeInfo | null; isShown: boolean; openDoc: string | null }
  }
}
