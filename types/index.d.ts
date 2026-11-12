declare module 'claude-code' {
  interface PluginState {
    'compact-timing': {
      // `resume` is absent in a mark stored by a version before 0.9.0; `userSteps` is set only in pointer mode.
      mark: { state: 'busy' | 'boundary'; focus: string; resume?: boolean; userSteps?: string } | null
      noted: boolean
      nudged: boolean
      resumes: number
      ownCompact: 'pending' | { skip: string | null; isPointer?: boolean } | null
      pointer: { tokens: number; focus: string; userSteps: string; requests: string; files: string; uncommitted: string; transcriptPath: string; commits: string } | null
      transcriptPath: string
      sessionRecord: { requests: string[]; omittedRequests: number; files: string[]; omittedFiles: number }
      // Pointer mode: the ids of the shell calls whose commit HEAD's reflog shows.
      commitCalls: string[]
    }
  }
}
