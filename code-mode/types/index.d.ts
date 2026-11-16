declare module 'claude-code' {
  interface PluginState {
    'compact-timing-code-mode': {
      mark: { state: 'busy' | 'boundary'; focus: string; resume?: boolean; userSteps?: string } | null
      noted: boolean
      nudged: boolean
      resumes: number
      ownCompact: 'pending' | { skip: string | null; isPointer?: boolean; summaryReason?: string } | null
      // The shell commands of the main conversation's commit calls whose result has not come yet, by call id.
      commands: Record<string, { tool: string; command: string }>
      // When the main conversation's newest Code Mode script started: a commit it made is checked in HEAD's reflog from then.
      scriptStartedAt: number
      // Calls that may run the mark skill, oldest first, with the subagent's id: the skill's hook has none of its own.
      markCalls: { agentId?: string; args?: string; id?: string }[]
    }
  }
}
