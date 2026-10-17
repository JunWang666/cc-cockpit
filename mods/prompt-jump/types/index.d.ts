export type PromptJumpState = Record<string, never>

declare module 'claude-code' {
  interface PluginState {
    'prompt-jump': { filter: string }
  }
}
