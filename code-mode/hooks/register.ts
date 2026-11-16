import { atom, read, update } from 'claude-code'
import type { PluginState, Register } from 'claude-code'
import {
  armedMark,
  commitReminder,
  compactInstructions,
  contextNote,
  contextNoteDue,
  isCommitCall,
  isRemindableCommit,
  limitOption,
  markArgsText,
  markCallOf,
  matchMarkCall,
  maxMarkCalls,
  markResult,
  markSkill,
  markSkillName,
  maxResumes,
  ownCompactFailure,
  parseMarkArgs,
  pluginCompactArgs,
  report,
  resumePrompt,
  shouldNudge,
  shouldRemind,
  skillAddResume,
  skillResumeCall,
  sizeNudge,
  thousands,
  turnEnd,
  unfinishedStep,
} from './logic'
import type { Holds, Limits, Mark, MarkCall, OwnCompact, Same } from './logic'

// compact-timing for Code Mode. Claude Code turns Code Mode off when a mod listens to `tool.call` (or another tool
// event), and only a `tool.call` hook can answer a tool a plugin registers. So the model sets the mark with a skill,
// answered in `skill.prompt`, and the reminders ride on `session.append`, which sees each tool call's rows: in Code
// Mode the calls the model's JavaScript made are added after the script ran, with ids that start with `repl_`.
// No pointer mode: in Code Mode those rows hold no output, which its work digest needs.

const plugin = 'compact-timing-code-mode'
const mark = atom({ plugin: 'compact-timing-code-mode', key: 'mark' } as const, null as Mark | null)
const noted = atom({ plugin: 'compact-timing-code-mode', key: 'noted' } as const, false)
const nudged = atom({ plugin: 'compact-timing-code-mode', key: 'nudged' } as const, false)
const resumes = atom({ plugin: 'compact-timing-code-mode', key: 'resumes' } as const, 0)
const ownCompact = atom({ plugin: 'compact-timing-code-mode', key: 'ownCompact' } as const, null as OwnCompact)
const commands = atom({ plugin: 'compact-timing-code-mode', key: 'commands' } as const, {} as Record<string, { tool: string; command: string }>)
const markCalls = atom({ plugin: 'compact-timing-code-mode', key: 'markCalls' } as const, [] as MarkCall[])

// The atoms check that the logic's shapes fit the stored ones; these check the other way, so neither can drift.
type Stored = PluginState['compact-timing-code-mode']
export type StoredShapesMatch = Holds<[Same<Stored['mark'], Mark | null>, Same<Stored['ownCompact'], OwnCompact>, Same<Stored['markCalls'][number], MarkCall>] extends [true, true, true] ? true : false>

// Kept per session, so a call whose result never came (an interrupted turn) can't grow the stored state without end.
const maxCommands = 50

type Block = { type: string; [key: string]: unknown }

/** A tool result's content as the model reads it. */
const resultText = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map(block => (typeof block?.text === 'string' ? block.text : '')).join('\n')
      : ''

/** The content with a text block added: how a note reaches the model with the result of a call it made itself. */
const withText = (content: unknown, text: string): Block[] => [
  // An empty text block is refused by the API: a commit with `-q` prints nothing.
  ...(typeof content === 'string' ? (content === '' ? [] : [{ type: 'text', text: content }]) : Array.isArray(content) ? (content as Block[]) : []),
  { type: 'text', text },
]

export const register: Register = (on, options) => {
  const limits: Limits = {
    boundaryTokens: limitOption(options.boundaryTokens, 200_000),
    softTokens: limitOption(options.softTokens, 300_000),
  }
  const isContextNoteOn = options.contextNote !== false

  on('session.append', async ($, e, next) => {
    const blocks = (Array.isArray(e.message.content) ? e.message.content : []) as Block[]
    if (e.door === 'response') {
      const uses = blocks.filter(block => block.type === 'tool_use')
      const isSubagent = e.agentId !== undefined
      const calls = uses.flatMap(use => markCallOf(use, isSubagent) ?? [])
      if (calls.length > 0) await update($, markCalls, previous => [...previous, ...calls].slice(-maxMarkCalls)).catch(() => undefined)
      const commits = isSubagent
        ? []
        : uses.flatMap(use => {
            const input = (use.input ?? {}) as Record<string, unknown>
            return typeof use.id === 'string' && typeof use.name === 'string' && isCommitCall(use.name, input)
              ? [[use.id, { tool: use.name, command: String(input.command) }] as const]
              : []
          })
      if (commits.length > 0)
        await update($, commands, previous => Object.fromEntries([...Object.entries(previous), ...commits].slice(-maxCommands))).catch(() => undefined)
      return next(e)
    }
    if (e.door !== 'tool-result' || e.agentId !== undefined) return next(e)
    const results = blocks.filter(block => block.type === 'tool_result' && typeof block.tool_use_id === 'string')
    if (results.length === 0) return next(e)
    const [pending, isNudged] = await Promise.all([read($, commands).catch(() => ({}) as Stored['commands']), read($, nudged).catch(() => true)])
    const calls = new Map(results.flatMap(block => {
      const call = pending[String(block.tool_use_id)]
      return call === undefined ? [] : [[block, call] as const]
    }))
    // Most results are not a commit, and the nudge comes once: those rows need nothing more.
    if (calls.size === 0 && isNudged) return next(e)
    if (calls.size > 0) {
      const ids = new Set(results.map(block => String(block.tool_use_id)))
      await update($, commands, previous => Object.fromEntries(Object.entries(previous).filter(([id]) => !ids.has(id)))).catch(() => undefined)
    }
    const notes = new Map<Block, string[]>()
    const add = (block: Block, text: string) => notes.set(block, [...(notes.get(block) ?? []), text])
    try {
      const [current, tokens] = await Promise.all([
        read($, mark).catch(() => null),
        $.session.usage().then(usage => usage.context.tokens).catch(() => undefined),
      ])
      let isResumeReminded = false
      for (const [block, call] of calls) {
        if (block.is_error === true) continue
        const input = { command: call.command }
        if (isRemindableCommit(call.tool, input, resultText(block.content), current) && shouldRemind(current, tokens, limits)) {
          add(block, commitReminder(markSkillName, current, skillAddResume))
          // Only the reminder for a mark that is not busy names `resume`, so only it says what the nudge says.
          isResumeReminded ||= current?.state !== 'busy'
        }
      }
      if (tokens !== undefined && shouldNudge(current, tokens, isNudged, limits)) {
        // Decided inside the write: rows of parallel calls arrive at the same time, and only one may send the nudge.
        let isFirst = false
        const isStored = await update($, nudged, previous => {
          isFirst = !previous
          return true
        }).then(() => true, () => false)
        const last = results[results.length - 1]
        if (isStored && isFirst && !isResumeReminded && last) add(last, sizeNudge(tokens, markSkillName, skillResumeCall))
      }
    } catch {
      return next(e)
    }
    if (notes.size === 0) return next(e)
    // A call the model's JavaScript made is recorded after the script's result went back, so its row is not read: the
    // note goes in a row of its own. A direct call's result is read, and the note goes in it, where it cannot come
    // between the results of parallel calls.
    const later: string[] = []
    const content = blocks.map(block => {
      const texts = notes.get(block)
      if (texts === undefined) return block
      if (String(block.tool_use_id).startsWith('repl_')) {
        later.push(...texts)
        return block
      }
      return { ...block, content: withText(block.content, texts.join('\n')) }
    })
    const result = await next({ ...e, message: { ...e.message, content } } as typeof e)
    if (later.length > 0)
      await $.session
        .append({ message: { type: 'user', content: [{ type: 'text', text: later.join('\n') }] } })
        .catch(error => report($, `${plugin}: the reminder failed (${error instanceof Error ? error.message : String(error)})`))
    return result
  })

  on('skill.prompt', async ($, e, next) => {
    const result = await next(e)
    if (e.skill !== markSkill) return result
    // The oldest pending call with these arguments ran the skill; none when the user typed it.
    const args = markArgsText(e.text) ?? ''
    let call: MarkCall | undefined
    await update($, markCalls, previous => {
      const index = matchMarkCall(previous, args)
      call = previous[index]
      return index === -1 ? previous : previous.filter((_, other) => other !== index)
    }).catch(() => undefined)
    if ((call as MarkCall | undefined)?.isSubagent === true) return { text: 'Only the main conversation sets the compaction mark.' }
    const parsed = parseMarkArgs(e.text)
    if (!parsed) return { text: 'The mark was not set: the first line of the arguments must be `boundary` or `busy`.' }
    const tokens = parsed.resume ? await $.session.usage().then(usage => usage.context.tokens).catch(() => undefined) : undefined
    const isStored = await update($, mark, () => armedMark(parsed, tokens, limits)).then(() => true, () => false)
    if (!isStored) return { text: 'The mark was not set: the plugin could not store it.' }
    return { text: markResult(parsed, tokens, limits) }
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    // A main-conversation call that names the skill but never ran it must not be matched to a later one.
    await update($, markCalls, previous => previous.filter(call => call.isSubagent)).catch(() => undefined)
    try {
      const tokens = (await $.session.usage()).context.tokens
      let current = null as Mark | null
      let decision = { next: null as Mark | null, compact: false, resume: false }
      // One read-modify-write, so a mark set meanwhile is neither lost nor judged by the old value.
      await update($, mark, previous => {
        current = previous
        decision = turnEnd(previous, tokens, e.isAborted === true, limits)
        return decision.next
      })
      if (!decision.compact || tokens === undefined) return result
      // `current` is assigned inside the callback above, which TypeScript does not follow.
      const marked = current as Mark | null
      $.ui.toast(`${plugin}: compacting at ${thousands(tokens)} tokens${decision.resume ? ', then resuming' : ''}`)
      await update($, ownCompact, (): OwnCompact => null)
      let outcome: OwnCompact = null
      try {
        // `/compact` rather than `$.session.compact()`, which rejects in a headless or SDK session.
        await $.command.run({ command: 'compact', args: pluginCompactArgs(marked, tokens) })
      } finally {
        await update($, ownCompact, previous => {
          outcome = previous
          return null
        }).catch(() => undefined)
      }
      const failure = ownCompactFailure(outcome)
      if (failure !== null) {
        report($, `${plugin}: ${failure}`)
        return result
      }
      if (!decision.resume) return result
      let count = 0
      await update($, resumes, previous => (count = previous + 1))
      if (count > maxResumes) {
        report($, `${plugin}: stopped after ${maxResumes} automatic resumes in a row; type "continue" to go on`)
        return result
      }
      // Not awaited: a plugin's prompt runs once the session is idle, which is after this hook returns.
      void $.prompt.submit({ text: resumePrompt(marked?.focus ?? '') }).catch(error =>
        report($, `${plugin}: resume prompt failed (${error instanceof Error ? error.message : String(error)})`),
      )
    } catch (error) {
      report($, `${plugin}: end of turn failed (${error instanceof Error ? error.message : String(error)})`)
    }
    return result
  })

  // Only a request the user typed (or sent from a remote or SDK host) gets the note.
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
      if (!isStored) return next(e)
    }
    if (!decision.due || tokens === undefined) return next(e)
    return next({ ...e, context: [...(e.context ?? []), contextNote(tokens, markSkillName)] })
  })

  // Only the plugin's own `/compact` is marked, while it runs, so a `/compact` the user queued is not taken for it.
  on('command.run', async ($, e, next) => {
    if (e.command === 'compact' && e.origin.kind === 'plugin' && e.origin.name === plugin) await update($, ownCompact, (): OwnCompact => 'pending')
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    if (e.agentId === undefined && e.trigger !== 'plugin') {
      const current = await read($, mark).catch(() => null)
      e = { ...e, instructions: compactInstructions(e.trigger, e.instructions, current, unfinishedStep(e.messages, 'Skill')) }
    }
    const result = await next(e)
    if (e.agentId === undefined && e.trigger === 'manual')
      await update($, ownCompact, previous => (previous === 'pending' ? { skip: result.skip ?? null } : previous)).catch(() => undefined)
    // A compaction that replaces the conversation clears the mark; a precompute installs nothing, so the mark stays.
    if (e.agentId === undefined && e.trigger !== 'precompute' && result.skip === undefined) {
      await update($, mark, () => null).catch(() => undefined)
      // The usage figure stays at the pre-compaction size until the next response.
      await update($, noted, () => true).catch(() => undefined)
      await update($, nudged, () => false).catch(() => undefined)
    }
    return result
  })
}
