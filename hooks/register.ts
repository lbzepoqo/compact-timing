import { atom, read, update } from 'claude-code'
import type { PluginState, Register, SessionCompactResult, SessionMessage } from 'claude-code'

// The stored shapes are declared once, in types/index.d.ts.
type State = PluginState['compact-timing']

// `userSteps` is set only in pointer mode, where no summarizer lists the user's open steps.
export type Mark = { state: 'busy' | 'boundary'; focus: string; resume?: boolean; userSteps?: string }

// The last mark the model set in this session. Values are held per session, so sessions do not see
// each other's marks.
const mark = atom({ plugin: 'compact-timing', key: 'mark' } as const, null as Mark | null)
// Whether this period already had the context note; cleared once the context falls below boundaryTokens.
const noted = atom({ plugin: 'compact-timing', key: 'noted' } as const, false)
// Whether this period already had the size nudge inside a turn; cleared by a compaction.
const nudged = atom({ plugin: 'compact-timing', key: 'nudged' } as const, false)
// Automatic resumes since the user's last request, so a model that always sets `resume` cannot run unattended for long.
const resumes = atom({ plugin: 'compact-timing', key: 'resumes' } as const, 0)
const maxResumes = 10
// The plugin's own `/compact` while it runs: `pending` until the compaction hook sees it, then its outcome. Its trigger
// is `manual`, the same as a typed `/compact`, and the command's result says nothing about a skip.
// `isPointer` when pointer mode answered in place of the summarizer.
export type OwnCompact = State['ownCompact']
const ownCompact = atom({ plugin: 'compact-timing', key: 'ownCompact' } as const, null as OwnCompact)
// Pointer mode: what replaces the conversation at a `boundary` mark, stored before the plugin's `/compact` runs, since
// the mark is dropped at the end of the turn, before the compaction hook runs.
export type PointerParts = NonNullable<State['pointer']>
const pointer = atom({ plugin: 'compact-timing', key: 'pointer' } as const, null as PointerParts | null)
// Only classic hook events carry the transcript path; pointer mode records it from SessionStart and UserPromptSubmit.
const transcriptPath = atom({ plugin: 'compact-timing', key: 'transcriptPath' } as const, '')

/** The tool input as the model sends it, or null when the state is not one of the two. */
export const parseMark = (input: { state?: unknown; focus?: unknown; resume?: unknown; userSteps?: unknown }): Mark | null => {
  const state = typeof input.state === 'string' ? input.state.trim().toLowerCase() : ''
  if (state !== 'busy' && state !== 'boundary') return null
  const userSteps = state === 'boundary' && typeof input.userSteps === 'string' ? input.userSteps.trim() : ''
  return {
    state,
    focus: typeof input.focus === 'string' ? input.focus.trim() : '',
    resume: state === 'boundary' && input.resume === true,
    ...(userSteps ? { userSteps } : {}),
  }
}

export type Limits = { boundaryTokens: number; softTokens: number }

/**
 * Whether to compact at the end of a turn. A boundary allows it from `boundaryTokens`, no mark from
 * `softTokens`, and a busy mark never: autoCompactWindow stays the hard limit for a stale busy mark.
 */
export const shouldCompact = (current: Mark | null, tokens: number | undefined, limits: Limits): boolean => {
  if (tokens === undefined || current?.state === 'busy') return false
  return tokens >= (current?.state === 'boundary' ? limits.boundaryTokens : limits.softTokens)
}

const thousands = (tokens: number) => `${Math.round(tokens / 1000)}k`

const pointerFocus =
  'what the next context must keep. At a `boundary` the plugin replaces the conversation with your focus, `userSteps`, your last message, the transcript path and the commits since the session started; no summary is made. Write it as a handoff: the goal, what is done, the next step, open decisions, file paths. Without a focus the plugin makes a summary instead.'
const pointerUserSteps =
  'with `boundary`: every step, command or question you gave the user that they have not yet reported done or answered: commands exactly, the rest briefly, with what each one is for. Steps in the message that ends the turn need not be listed: the pointer keeps that message.'

/** The tool description: what the model reads about the marks. Pointer mode changes the focus and adds `userSteps`. */
export const ruleText = (limits: Limits, isPointerMode = false) =>
  [
    'Sets the compaction mark for this conversation. The compact-timing plugin compacts at task boundaries instead of at a fixed token count.',
    `- \`boundary\`: call after a task or milestone whose state is saved outside the conversation (committed, or in a plan or notes file). The plugin compacts at the end of that turn when the context contains ${thousands(limits.boundaryTokens)} tokens or more. Either way the mark is dropped when the turn ends.`,
    '- `busy`: call before a step whose details exist only in the conversation, such as a debugging sequence or reading test output. The plugin does not compact while the mark is `busy`. Call with `boundary` when the step is done.',
    isPointerMode ? `- \`focus\`: ${pointerFocus}` : '- `focus`: what the summary must keep: the next step, open decisions, file paths.',
    ...(isPointerMode ? [`- \`userSteps\`: ${pointerUserSteps}`] : []),
    '- `resume`: set it with `boundary` when steps of the current request remain. Then end the turn: the plugin compacts and sends the focus back as a prompt, so the work continues. The plugin can compact only between turns, so a long turn otherwise keeps growing.',
    `Without a mark the plugin compacts at ${thousands(limits.softTokens)} tokens. Any compaction clears the mark.`,
  ].join('\n')

/** The tool's input schema; `userSteps` only in pointer mode. */
export const markSchema = (isPointerMode = false) => ({
  type: 'object',
  properties: {
    state: { type: 'string', enum: ['boundary', 'busy'] },
    focus: {
      type: 'string',
      description: isPointerMode ? `What the next context must keep: ${pointerFocus.replace(/^what the next context must keep\. /, '')}` : 'What the summary must keep: the next step, open decisions, file paths.',
    },
    ...(isPointerMode ? { userSteps: { type: 'string', description: `Pointer mode, ${pointerUserSteps}` } } : {}),
    resume: { type: 'boolean', description: 'With `boundary`: steps of the current request remain; end the turn and the plugin compacts and sends the focus back.' },
  },
  required: ['state'],
})

/** The mark tool's answer: with `resume` it says whether to end the turn now, since that depends on the size. */
export const markResult = (current: Mark, tokens: number | undefined, limits: Limits): string => {
  if (!current.resume) return `The mark is \`${current.state}\`.`
  if (tokens !== undefined && tokens >= limits.boundaryTokens)
    return 'The mark is `boundary`. End your turn now with a one-line status and no question: the plugin compacts and then sends the focus back as a prompt, so you continue from it.'
  return `The mark is \`boundary\`, but the context (${tokens === undefined ? 'size unknown' : thousands(tokens)}) is below ${thousands(limits.boundaryTokens)}, so nothing compacts: continue the work in this turn.`
}

/**
 * The mark as stored: `resume` only when the context is large enough to compact now. Otherwise the answer says to
 * continue, and a resume left armed would send a "continue" prompt after the request is already done.
 */
export const armedMark = (current: Mark, tokens: number | undefined, limits: Limits): Mark =>
  current.resume && (tokens === undefined || tokens < limits.boundaryTokens) ? { ...current, resume: false } : current

/** Once per period inside a turn: a long turn is where the plugin falls behind, since it compacts only between turns. */
export const sizeNudge = (tokens: number, toolName: string) =>
  `compact-timing: the context holds ${thousands(tokens)} tokens, and the plugin can compact only between turns. At the next point where the work is saved (a commit, a plan or notes file), call ${toolName} with \`boundary\`, \`resume\` true and a focus listing the remaining steps, then end the turn.`

/**
 * Whether a tool result inside a turn gets the size nudge: from `softTokens`, once, and not when a resume is armed.
 * A boundary without `resume` still gets it, since the turn may keep growing after an early commit.
 */
export const shouldNudge = (current: Mark | null, tokens: number | undefined, isNudged: boolean, limits: Limits): boolean =>
  !isNudged && current?.resume !== true && tokens !== undefined && tokens >= limits.softTokens

/**
 * The prompt sent after a compaction the model asked to resume from. The model may have kept working after it set the
 * mark, so the summary, being newer, decides which steps are done.
 */
export const resumePrompt = (focus: string, isPointer = false) =>
  isPointer
    ? [
        'compact-timing: an automatic prompt from a plugin, not written by the user. The plugin replaced the conversation with a pointer at the `boundary` mark you set with `resume`.',
        "Continue the user's request from the focus in the pointer.",
        'You may have worked on after you set the mark: before repeating a step, commit, push or deploy, check your last message in the pointer, the commits and `git status`.',
      ].join('\n')
    : [
        'compact-timing: an automatic prompt from a plugin, not written by the user. The plugin compacted the conversation at the `boundary` mark you set with `resume`.',
        `Continue the user's request from where you stopped${focus ? `: ${focus}` : '.'}`,
        'The summary is newer than this focus: skip any step it shows done, and check before repeating a commit, push or deploy.',
      ].join('\n')

/** The first summary line, so the user and the model can tell a plugin compaction from a typed /compact: both are recorded as `manual`. */
export const summaryLabel = (current: Mark | null, tokens: number) =>
  `Start the summary with this line: "Compacted by the compact-timing plugin at ${thousands(tokens)} tokens, ${current?.state === 'boundary' ? 'at a `boundary` mark' : 'at the soft limit with no mark'}."`

/**
 * The arguments of the plugin's `/compact`: the label and the focus. The compaction hook adds the standing
 * instructions to every compaction, this one too.
 */
export const pluginCompactArgs = (current: Mark | null, tokens: number) =>
  [summaryLabel(current, tokens), current?.focus ?? ''].filter(Boolean).join('\n\n')

/** Why the plugin's own `/compact` did not stand, or null when it did. */
export const ownCompactFailure = (outcome: OwnCompact): string | null => {
  if (outcome === null || outcome === 'pending') return 'the compaction did not run'
  return outcome.skip === null ? null : `compaction skipped (${outcome.skip})`
}

/** A `git commit`, also after global options such as `-C <dir>`, `-c <key=value>` or `--no-pager`. */
export const isCommit = (command: string) =>
  /\bgit(?:\s+(?:-[Cc]\s+(?:"[^"]*"|'[^']*'|\S+)|--?[\w-]+(?:=\S+)?))*\s+commit(?![\w-])/.test(command)

/**
 * Read right after a commit's result. The tool description alone is often missed, so the reminder
 * comes at the moment a boundary is most likely.
 */
export const commitReminder = (toolName: string, current: Mark | null) =>
  current?.state === 'busy'
    ? `compact-timing: the mark is \`busy\`. If the step whose details exist only in the conversation is done, call ${toolName} with \`boundary\` and a focus: the next step and open decisions.`
    : [
        `compact-timing: this commit saved work outside the conversation. If a task or milestone is done, call ${toolName} with \`boundary\` and a focus: the next step and open decisions. If steps of the current request remain, add \`resume\` true and end the turn.`,
        'If the work continues and its details exist only in the conversation, call it with `busy` instead.',
      ].join(' ')

/**
 * Whether a commit gets the reminder: when a boundary mark can compact at this size, or when a busy
 * mark is set, since the reminder is what makes the model replace it.
 */
export const shouldRemind = (current: Mark | null, tokens: number | undefined, limits: Limits): boolean =>
  current?.state === 'busy' || (tokens !== undefined && tokens >= limits.boundaryTokens)

/**
 * At the end of a main turn: the mark the next turn starts with, and whether to compact now. A boundary
 * counts only at the end of the turn that set it, also when the turn was interrupted, since an interrupt
 * often means the boundary no longer holds. An interrupted turn never compacts.
 */
export const turnEnd = (
  current: Mark | null,
  tokens: number | undefined,
  isAborted: boolean,
  limits: Limits,
): { next: Mark | null; compact: boolean; resume: boolean } => {
  const compact = !isAborted && shouldCompact(current, tokens, limits)
  return { next: current?.state === 'boundary' ? null : current, compact, resume: compact && current?.resume === true }
}

/**
 * Steps handed to the user are not the model's own pending tasks, and a summary once dropped a test the model had
 * asked the user to run. Commands stay exact and the rest stays short, so the list does not grow with each compaction.
 */
export const openUserSteps =
  'Keep every step, command or question the assistant gave the user that the user has not yet reported done or answered: commands exactly, the rest briefly, with what each one is for.'

/**
 * Claude Code appends the transcript path to the summary and says to read it, but a transcript holds one long JSON
 * record per line, so reading it whole refills the context the compaction freed. `command` skips a shell function
 * named grep (such as one calling ugrep, which rejects this window as too complex).
 */
export const transcriptSearchHow =
  "search the full transcript with command grep -oE '.{0,200}<term>.{0,200}' rather than reading it whole: each line is one long JSON record."
export const transcriptSearch = `End the summary with this line: "For exact details the summary dropped (error text, paths, numbers), ${transcriptSearchHow}"`

const maxCommitLines = 40
const maxLastReply = 3000

/** The `git log` part of the pointer: the commits, none, or why git gave none. Never throws, so a failed git keeps the pointer. */
export const commitsText = (
  run: { exitCode: number; stdout: string; stderr: string } | { error: string },
  directory: string,
  since: string,
): string => {
  const where = `in ${directory} since ${since}`
  if ('error' in run) return `git log failed ${where} (${run.error}). If the work is in a repository elsewhere, run git log there.`
  if (run.exitCode !== 0) {
    const reason = run.stderr.trim().split('\n')[0] || `exit code ${run.exitCode}`
    return `git log failed ${where} (${reason}). If the work is in a repository elsewhere, run git log there.`
  }
  const lines = run.stdout.split('\n').filter(line => line.trim() !== '')
  if (lines.length === 0) return `None ${where}.`
  const shown = lines.slice(0, maxCommitLines)
  const more = lines.length > shown.length ? [`... and ${lines.length - shown.length} older`] : []
  return [`${lines.length} ${where}, newest first:`, ...shown, ...more].join('\n')
}

/**
 * The model's last message with text: the mark is set inside a turn, so steps given to the user in the turn's closing
 * message come after it. The end is kept, since a closing message ends with what it asks.
 */
export const lastReply = (messages: readonly Pick<SessionMessage, 'role' | 'text'>[]): string => {
  const last = [...messages].reverse().find(message => message.role === 'assistant' && message.text.trim() !== '')
  if (!last) return ''
  const text = last.text.trim()
  return text.length > maxLastReply ? `...${text.slice(-maxLastReply)}` : text
}

/** The one user message that replaces the conversation in pointer mode. Its first line labels it, as summaryLabel does a summary. */
export const pointerText = (parts: PointerParts, reply: string) =>
  [
    `Compacted by the compact-timing plugin at ${thousands(parts.tokens)} tokens, at a \`boundary\` mark, in pointer mode: this message replaced the conversation, and no summary was made.`,
    'compact-timing: an automatic message from a plugin, not written by the user. You wrote the focus, the open steps and the last message; the plugin added the transcript path and the commits.',
    `## Focus\n${parts.focus || 'None given.'}`,
    `## Open steps you gave the user\n${parts.userSteps || 'None listed.'}`,
    `## Your last message\n${reply || 'None found.'}`,
    `## Transcript\n${parts.transcriptPath}\nFor anything else from the conversation (what the user asked, error text, paths, numbers), ${transcriptSearchHow} Search it before asking the user for something they may already have given.`,
    `## Commits\n${parts.commits}`,
  ].join('\n\n')

/**
 * Instructions for every compaction of the main conversation: the ones given, or the mark's focus for a compaction
 * Claude Code starts itself (trigger `auto` or `precompute`), followed by the open user steps and the transcript search.
 * Only a `busy` mark outlives its turn, so the focus keeps the details of an unfinished step in the summary.
 */
export const compactInstructions = (trigger: string, instructions: string | undefined, current: Mark | null) => {
  const isEngine = trigger === 'auto' || trigger === 'precompute'
  const given = instructions?.trim() || (isEngine ? current?.focus : '')
  return [given, openUserSteps, transcriptSearch].filter(Boolean).join('\n\n')
}

/**
 * Whether a prompt gets the context note: once when the context reaches `boundaryTokens`, and again only
 * after it fell below that (a compaction or a fresh session). Returns the new `noted` flag with the decision.
 */
export const contextNoteDue = (tokens: number | undefined, noted: boolean, limits: Limits): { due: boolean; noted: boolean } => {
  if (tokens === undefined) return { due: false, noted }
  if (tokens < limits.boundaryTokens) return { due: false, noted: false }
  return { due: !noted, noted: true }
}

/**
 * Sent with the prompt that finds the context large. A topic switch without a commit gets no boundary mark,
 * and a plugin cannot compact before the prompt runs, so the model is asked to suggest a fresh session.
 */
export const contextNote = (tokens: number, toolName: string) =>
  [
    'compact-timing: an automatic note from a plugin, not written by the user, who does not see it.',
    `- The context holds ${thousands(tokens)} tokens. From now on, when a request starts new work: if it continues the current work, call ${toolName} with \`boundary\` at the next natural break; if it is unrelated and needs nothing from this conversation, suggest a fresh session (/clear or a new terminal); if it is new but needs a few facts from here, suggest a short handoff and then a fresh session. If the current request already starts new work, apply this now. Suggest it at most once; the user decides.`,
  ].join('\n')

/** A positive number from the settings, else the default: an empty or misspelled value must not compact every turn. */
export const limitOption = (value: unknown, fallback: number): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/** A failure the user should see: a toast in the terminal, and a transcript line, which an SDK host such as T3 Code shows too. */
const report = ($: { ui: { toast: (text: string) => void; log: (text: string) => void } }, text: string) => {
  $.ui.toast(text)
  $.ui.log(text)
}

export const register: Register = (on, options) => {
  const limits: Limits = {
    boundaryTokens: limitOption(options.boundaryTokens, 200_000),
    softTokens: limitOption(options.softTokens, 300_000),
  }
  let markTool = 'mcp__compact-timing__mark'
  const isContextNoteOn = options.contextNote !== false
  // Also the string, as `--values-stdin` takes values (see the README's example).
  const isPointerMode = options.pointerMode === true || options.pointerMode === 'true'

  on('session.start', async ($, e, next) => {
    const registered = await $.tool.register({
      name: 'mark',
      description: ruleText(limits, isPointerMode),
      inputSchema: markSchema(isPointerMode),
      isDeferred: false,
    })
    markTool = registered.tool
    return next(e)
  })

  if (isPointerMode) {
    // Recorded on both: `/clear` starts a new transcript, and a plugin enabled mid-session first sees a prompt. Written
    // only when it changed, so a prompt costs a read.
    on('classic.SessionStart', async ($, e, next) => {
      if (e.agent_id === undefined && e.transcript_path && (await read($, transcriptPath).catch(() => '')) !== e.transcript_path)
        await update($, transcriptPath, () => e.transcript_path).catch(() => undefined)
      return next(e)
    })
    on('classic.UserPromptSubmit', async ($, e, next) => {
      if (e.agent_id === undefined && e.transcript_path && (await read($, transcriptPath).catch(() => '')) !== e.transcript_path)
        await update($, transcriptPath, () => e.transcript_path).catch(() => undefined)
      return next(e)
    })
  }

  on('tool.call', async ($, e, next) => {
    if (e.tool === markTool) {
      if (e.agentId !== undefined) return { result: 'Only the main conversation sets the compaction mark.' }
      const input = e as unknown as { state?: unknown; focus?: unknown; resume?: unknown; userSteps?: unknown }
      const parsed = parseMark(isPointerMode ? input : { ...input, userSteps: undefined })
      if (!parsed) return { result: 'The mark was not set: state must be `boundary` or `busy`.' }
      const tokens = parsed.resume ? await $.session.usage().then(usage => usage.context.tokens).catch(() => undefined) : undefined
      const stored = armedMark(parsed, tokens, limits)
      await update($, mark, () => stored)
      return { result: markResult(parsed, tokens, limits) }
    }
    const result = await next(e)
    if (e.agentId !== undefined || result.deny !== undefined || result.isError) return result
    const isCommitCall = e.tool === 'Bash' && isCommit((e as unknown as { command: string }).command)
    const isNudged = await read($, nudged).catch(() => true)
    if (!isCommitCall && isNudged) return result
    const [current, tokens] = await Promise.all([
      read($, mark).catch(() => null),
      $.session.usage().then(usage => usage.context.tokens).catch(() => undefined),
    ])
    const context: string[] = []
    const isReminded = isCommitCall && shouldRemind(current, tokens, limits)
    if (isReminded) context.push(commitReminder(markTool, current))
    if (tokens !== undefined && shouldNudge(current, tokens, isNudged, limits)) {
      // Decided inside the write: tool hooks of parallel calls run at the same time, and only one may send the nudge.
      let isFirst = false
      const isStored = await update($, nudged, previous => {
        isFirst = !previous
        return true
      }).then(() => true, () => false)
      // A commit reminder already says the same, so it uses up the nudge.
      if (isStored && isFirst && !isReminded) context.push(sizeNudge(tokens, markTool))
    }
    return context.length ? { ...result, context: [...(result.context ?? []), ...context] } : result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    try {
      const usage = await $.session.usage()
      const tokens = usage.context.tokens
      let current = null as Mark | null
      let decision = { next: null as Mark | null, compact: false, resume: false }
      // One read-modify-write, so a mark set meanwhile is neither lost nor judged by the old value.
      await update($, mark, previous => {
        current = previous
        decision = turnEnd(previous, tokens, e.isAborted === true, limits)
        return decision.next
      })
      if (!decision.compact || tokens === undefined) return result
      const focus = current?.focus ?? ''
      $.ui.toast(`compact-timing: compacting at ${thousands(tokens)} tokens${decision.resume ? ', then resuming' : ''}`)
      // `/compact` rather than `$.session.compact()`, which rejects in a headless or SDK session (T3 Code, `-p`).
      // The command runs once the session is idle and resolves after the compaction, in the terminal and the SDK alike.
      // The command.run hook below marks this run `pending`, and the compaction hook stores its outcome.
      await update($, ownCompact, (): OwnCompact => null)
      // Pointer mode at a boundary: the compaction hook answers with these parts in place of the summarizer. Without
      // them (no mode, no mark, no focus, no transcript path, a failure here) the same `/compact` makes a summary.
      // `current` is assigned inside the callback above, which TypeScript does not follow.
      const marked = current as Mark | null
      let parts: PointerParts | null = null
      if (isPointerMode && marked?.state === 'boundary') {
        try {
          const path = await read($, transcriptPath)
          if (!path) {
            $.ui.log('compact-timing: pointer mode has no transcript path for this session, so this compaction makes a summary')
          } else if (!marked.focus) {
            // Without a focus the pointer would hold no goal and no next step: the summary keeps more.
            $.ui.log('compact-timing: the boundary mark has no focus, so this compaction makes a summary instead of a pointer')
          } else {
            const directory = await $.session.cwd()
            const since = new Date(usage.startedAt).toISOString()
            // The author tells the model's own commits from ones a pull brought in.
            const run = await $.process
              .run(['git', 'log', `--since=${since}`, '--format=%h %ad %an: %s', '--date=format:%Y-%m-%d %H:%M'], { cwd: directory, timeoutMs: 10_000 })
              .catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }))
            parts = { tokens, focus: marked.focus, userSteps: marked.userSteps ?? '', transcriptPath: path, commits: commitsText(run, directory, since) }
          }
        } catch (error) {
          report($, `compact-timing: pointer failed, making a summary (${error instanceof Error ? error.message : String(error)})`)
        }
      }
      if (isPointerMode) await update($, pointer, () => parts)
      let outcome: OwnCompact = null
      try {
        await $.command.run({ command: 'compact', args: pluginCompactArgs(current, tokens) })
      } finally {
        // Its own failure must not hide the command's.
        await update($, ownCompact, previous => {
          outcome = previous
          return null
        }).catch(() => undefined)
        if (isPointerMode) await update($, pointer, () => null).catch(() => undefined)
      }
      const failure = ownCompactFailure(outcome)
      if (failure !== null) {
        report($, `compact-timing: ${failure}`)
        return result
      }
      const settled = outcome as OwnCompact
      const isPointer = typeof settled === 'object' && settled?.isPointer === true
      if (parts !== null && !isPointer) $.ui.log('compact-timing: pointer mode fell back to a summary for this compaction')
      if (!decision.resume) return result
      let count = 0
      await update($, resumes, previous => (count = previous + 1))
      if (count > maxResumes) {
        report($, `compact-timing: stopped after ${maxResumes} automatic resumes in a row; type "continue" to go on`)
        return result
      }
      // Not awaited: a plugin's prompt runs once the session is idle, which is after this hook returns.
      void $.prompt.submit({ text: resumePrompt(focus, isPointer) }).catch(error =>
        report($, `compact-timing: resume prompt failed (${error instanceof Error ? error.message : String(error)})`),
      )
    } catch (error) {
      report($, `compact-timing: end of turn failed (${error instanceof Error ? error.message : String(error)})`)
    }
    return result
  })

  // Only a request the user typed (or sent from a remote or SDK host) gets the note: a task notification,
  // a scheduled prompt or a slash command would use it up without the user's next topic seeing it.
  on('prompt.submit', async ($, e, next) => {
    const isUserRequest = ['composer', 'bridge', 'sdk'].includes(e.origin.kind) && e.command === undefined && e.isMeta === undefined
    if (isUserRequest) await update($, resumes, () => 0).catch(() => undefined)
    if (!isContextNoteOn || !isUserRequest) return next(e)
    const [previous, tokens] = await Promise.all([
      read($, noted).catch(() => undefined),
      $.session.usage().then(usage => usage.context.tokens).catch(() => undefined),
    ])
    if (previous === undefined) return next(e)
    const decision = contextNoteDue(tokens, previous, limits)
    if (decision.noted !== previous) {
      const isStored = await update($, noted, () => decision.noted).then(() => true, () => false)
      // A note whose flag was not stored would come again with every prompt.
      if (!isStored) return next(e)
    }
    if (!decision.due || tokens === undefined) return next(e)
    return next({ ...e, context: [...(e.context ?? []), contextNote(tokens, markTool)] })
  })

  // Only the plugin's own `/compact` is marked, while it runs, so a `/compact` the user queued is not taken for it.
  on('command.run', async ($, e, next) => {
    if (e.command === 'compact' && e.origin.kind === 'plugin' && e.origin.name === 'compact-timing')
      await update($, ownCompact, (): OwnCompact => 'pending')
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    // Pointer mode answers only the plugin's own `/compact` at a boundary: `pending` and the parts stored for it. Every
    // other compaction (a typed `/compact`, Claude Code's own, a subagent's) goes on to the summarizer.
    let pointed: SessionCompactResult | null = null
    if (isPointerMode && e.agentId === undefined && e.trigger === 'manual') {
      const [own, parts] = await Promise.all([read($, ownCompact).catch(() => null), read($, pointer).catch(() => null)])
      if (own === 'pending' && parts) pointed = { messages: [{ role: 'user', text: pointerText(parts, lastReply(e.messages)), toolUses: [] }] }
    }
    // Another plugin's direct compaction carries its own instructions. This plugin's runs as `/compact` (`manual`).
    if (pointed === null && e.agentId === undefined && e.trigger !== 'plugin') {
      const current = await read($, mark).catch(() => null)
      e = { ...e, instructions: compactInstructions(e.trigger, e.instructions, current) }
    }
    const result = pointed ?? (await next(e))
    if (e.agentId === undefined && e.trigger === 'manual') {
      const isPointer = pointed !== null
      await update($, ownCompact, previous => (previous === 'pending' ? { skip: result.skip ?? null, ...(isPointer ? { isPointer } : {}) } : previous)).catch(
        () => undefined,
      )
    }
    // A compaction that replaces the conversation, also the automatic one at the hard limit, clears the mark.
    // A precompute installs nothing, so the mark stays.
    if (e.agentId === undefined && e.trigger !== 'precompute' && result.skip === undefined) {
      await update($, mark, () => null).catch(() => undefined)
      // The usage figure stays at the pre-compaction size until the next response, so the note is held
      // until a prompt reads a size below boundaryTokens.
      await update($, noted, () => true).catch(() => undefined)
      await update($, nudged, () => false).catch(() => undefined)
    }
    return result
  })
}
