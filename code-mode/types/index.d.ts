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
      // Calls that may run the mark skill, oldest first: the skill's hook has no agent id of its own.
      markCalls: { isSubagent: boolean; args?: string }[]
    }
  }
}
