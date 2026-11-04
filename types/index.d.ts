declare module 'claude-code' {
  interface PluginState {
    'compact-timing': {
      // `resume` is absent in a mark stored by a version before 0.9.0.
      mark: { state: 'busy' | 'boundary'; focus: string; resume?: boolean } | null
      noted: boolean
      nudged: boolean
      resumes: number
    }
  }
}
