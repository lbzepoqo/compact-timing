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
      // The main conversation's newest step with Code Mode scripts that may commit: when it started (0 for none), as a
      // commit they made is checked in HEAD's reflog from then, and whether they got their one reminder.
      script: { startedAt: number; reminded: boolean }
      // Calls that may run the mark skill, oldest first, with the subagent's id: the skill's hook has none of its own.
      markCalls: { agentId?: string; args?: string; id?: string; isScript?: true }[]
    }
  }
}
