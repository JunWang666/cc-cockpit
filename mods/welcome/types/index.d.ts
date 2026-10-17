export type WelcomeCommit = { hash: string; time: number; subject: string }

export type WelcomeGit = {
  branch: string
  changes: number
  ahead: number | null
  behind: number | null
  commits: WelcomeCommit[]
}

export type WelcomeSession = { id: string; prompt: string; prompts: number; time: number }

export type WelcomeInfo = { git: WelcomeGit | null; sessions: WelcomeSession[]; scannedAt: number }

declare module 'claude-code' {
  interface PluginState {
    welcome: { info: WelcomeInfo | null; isShown: boolean }
  }
}
