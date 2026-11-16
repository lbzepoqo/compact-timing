import { atom, read, update } from 'claude-code'
import type { PluginState, Register, StateDollar } from 'claude-code'
import {
  armedMark,
  commitReminder,
  compactAtTurnEnd,
  contextNote,
  isCommitCall,
  isRemindableCommit,
  isScriptCallId,
  limitOption,
  markArgsText,
  markCallOf,
  markInstructions,
  markOwnCompact,
  markResult,
  markSkill,
  markSkillName,
  matchMarkCall,
  maxMarkCalls,
  parseMarkArgs,
  promptWithNote,
  reflogArguments,
  reflogTimeout,
  report,
  runGit,
  scriptCommitLogged,
  settleCompaction,
  shouldNudge,
  shouldRemind,
  sizeNudge,
  skillAddResume,
  skillResumeCall,
} from './logic'
import type { Holds, Limits, Mark, MarkCall, OwnCompact, PendingCommand, Same, TurnCells } from './logic'

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
const commands = atom({ plugin: 'compact-timing-code-mode', key: 'commands' } as const, {} as Record<string, PendingCommand>)
const markCalls = atom({ plugin: 'compact-timing-code-mode', key: 'markCalls' } as const, [] as MarkCall[])
/**
 * The main conversation's newest step that ran scripts that may commit: when it started (0 for none), and whether its
 * scripts' commits got their reminder. The scripts of one step get one, which already asks for the mark: a later
 * commit command of them, which may have committed nothing, brings no second one.
 */
type ScriptRun = { startedAt: number; reminded: boolean }
const idleScript: ScriptRun = { startedAt: 0, reminded: false }
const script = atom({ plugin: 'compact-timing-code-mode', key: 'script' } as const, idleScript)

// The atoms check that the logic's shapes fit the stored ones; these check the other way, so neither can drift.
type Stored = PluginState['compact-timing-code-mode']
export type StoredShapesMatch = Holds<
  [
    Same<Stored['mark'], Mark | null>,
    Same<Stored['ownCompact'], OwnCompact>,
    Same<Stored['markCalls'][number], MarkCall>,
    Same<Stored['commands'][string], PendingCommand>,
    Same<Stored['script'], ScriptRun>,
  ] extends [true, true, true, true, true]
    ? true
    : false
>

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

/** This plugin's values for the hooks it shares with compact-timing. */
function turnCells($: StateDollar): TurnCells {
  return {
    mark: { read: () => read($, mark), update: change => update($, mark, change) },
    noted: { read: () => read($, noted), update: change => update($, noted, change) },
    nudged: { read: () => read($, nudged), update: change => update($, nudged, change) },
    resumes: { read: () => read($, resumes), update: change => update($, resumes, change) },
    ownCompact: { read: () => read($, ownCompact), update: change => update($, ownCompact, change) },
  }
}

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
      const calls = uses.flatMap(use => markCallOf(use, e.agentId) ?? [])
      if (calls.length > 0) await update($, markCalls, previous => [...previous, ...calls].slice(-maxMarkCalls)).catch(() => undefined)
      // Only a script that may commit needs its start time; most Code Mode steps are scripts.
      const isCommitScript = (use: Block) => use.name === 'REPL' && !isScriptCallId(use.id) && String((use.input as { code?: unknown })?.code ?? '').includes('commit')
      if (!isSubagent && uses.some(isCommitScript))
        await update($, script, () => ({ startedAt: Date.now(), reminded: false })).catch(() => undefined)
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
    if (e.door !== 'tool-result') return next(e)
    const results = blocks.filter(block => block.type === 'tool_result' && typeof block.tool_use_id === 'string')
    if (results.length === 0) return next(e)
    // A direct mark call whose result came while it is still pending never ran the skill: drop it, in any agent, so it
    // can't be matched to a later call. Only a direct call is kept by id, and in Code Mode most calls are a script's.
    const resultIds = new Set(results.map(block => String(block.tool_use_id)))
    const isDirectRow = results.some(block => !isScriptCallId(block.tool_use_id))
    const pendingCalls = isDirectRow ? await read($, markCalls).catch(() => [] as MarkCall[]) : []
    if (pendingCalls.some(call => call.id !== undefined && resultIds.has(call.id)))
      await update($, markCalls, previous => previous.filter(call => call.id === undefined || !resultIds.has(call.id))).catch(() => undefined)
    if (e.agentId !== undefined) return next(e)
    const [pending, isNudged] = await Promise.all([read($, commands).catch(() => ({}) as Stored['commands']), read($, nudged).catch(() => true)])
    const calls = new Map(results.flatMap(block => {
      const call = pending[String(block.tool_use_id)]
      return call === undefined ? [] : [[block, call] as const]
    }))
    // Most results are not a commit, and the nudge comes once: those rows need nothing more.
    if (calls.size === 0 && isNudged) return next(e)
    if (calls.size > 0)
      await update($, commands, previous => Object.fromEntries(Object.entries(previous).filter(([id]) => !resultIds.has(id)))).catch(() => undefined)
    const notes = new Map<Block, string[]>()
    const add = (block: Block, text: string) => notes.set(block, [...(notes.get(block) ?? []), text])
    try {
      const [current, tokens] = await Promise.all([
        read($, mark).catch(() => null),
        $.session.usage().then(usage => usage.context.tokens).catch(() => undefined),
      ])
      let isResumeReminded = false
      // The scripts' reminder is given once (`ScriptRun`); also within this row, as the store may fail.
      const isScriptRow = [...calls.keys()].some(block => isScriptCallId(block.tool_use_id))
      const run = isScriptRow && shouldRemind(current, tokens, limits) ? await read($, script).catch(() => idleScript) : idleScript
      let isScriptReminded = run.reminded
      // A call a script made is recorded with no output, so whether it committed is read from HEAD's reflog since the
      // step started, once for the row. Under a `busy` mark the words are enough, as with a direct call. Without a
      // start time, or where the reflog can't tell (`scriptCommitLogged`), the words decide, as for a silent direct call.
      const startedAt = isScriptRow && !isScriptReminded && current?.state !== 'busy' ? run.startedAt : 0
      const reflog = startedAt > 0 ? await runGit($, reflogArguments, { timeoutMs: reflogTimeout }) : null
      const endedAt = Date.now()
      for (const [block, call] of calls) {
        if (block.is_error === true || !shouldRemind(current, tokens, limits)) continue
        const isScript = isScriptCallId(block.tool_use_id)
        if (isScript && isScriptReminded) continue
        const logged = reflog !== null && isScript ? scriptCommitLogged(reflog, startedAt, endedAt, call.command) : null
        const isCommitted = logged ?? isRemindableCommit(call.tool, { command: call.command }, resultText(block.content), current)
        if (!isCommitted) continue
        if (isScript) {
          isScriptReminded = true
          // Decided inside the write: another row of the step's scripts may be judged at the same time.
          let isFirst = true
          const isStored = await update($, script, previous => {
            isFirst = !previous.reminded
            return { ...previous, reminded: true }
          }).then(() => true, () => false)
          if (isStored && !isFirst) continue
        }
        add(block, commitReminder(markSkillName, current, skillAddResume))
        // Only the reminder for a mark that is not busy names `resume`, so only it says what the nudge says.
        isResumeReminded ||= current?.state !== 'busy'
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
      if (isScriptCallId(block.tool_use_id)) {
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
    // Which pending call ran the skill (`matchMarkCall`); none when the user typed it.
    const args = markArgsText(e.text) ?? ''
    let call: MarkCall | undefined
    await update($, markCalls, previous => {
      const index = matchMarkCall(previous, args)
      call = previous[index]
      return index === -1 ? previous : previous.filter((_, other) => other !== index)
    }).catch(() => undefined)
    if ((call as MarkCall | undefined)?.agentId !== undefined) return { text: 'Only the main conversation sets the compaction mark.' }
    const parsed = parseMarkArgs(e.text)
    if (!parsed) return { text: 'The mark was not set: the first line of the arguments must be `boundary` or `busy`.' }
    const tokens = parsed.resume ? await $.session.usage().then(usage => usage.context.tokens).catch(() => undefined) : undefined
    const isStored = await update($, mark, () => armedMark(parsed, tokens, limits)).then(() => true, () => false)
    if (!isStored) return { text: 'The mark was not set: the plugin could not store it.' }
    return { text: markResult(parsed, tokens, limits) }
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    // A call of this agent that never ran the skill must not be matched to a later one. Read first: most turns leave
    // nothing to clear, and a write each turn is wasted.
    const pendingCalls = await read($, markCalls).catch(() => [] as MarkCall[])
    if (pendingCalls.some(call => call.agentId === e.agentId))
      await update($, markCalls, previous => previous.filter(call => call.agentId !== e.agentId)).catch(() => undefined)
    if (e.agentId !== undefined) return result
    // A failed read falls through to the write: a start time must not reach the next turn.
    const run = await read($, script).catch(() => null)
    if (run === null || run.startedAt !== 0 || run.reminded) await update($, script, () => idleScript).catch(() => undefined)
    await compactAtTurnEnd($, turnCells($), plugin, limits, e.isAborted === true)
    return result
  })

  on('prompt.submit', ($, e, next) => promptWithNote($, e, next, turnCells($), limits, isContextNoteOn, markSkillName))

  on('command.run', async ($, e, next) => {
    await markOwnCompact(e, turnCells($).ownCompact, plugin)
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const cells = turnCells($)
    const result = await next(await markInstructions(e, cells.mark, 'Skill'))
    await settleCompaction(e, result, cells)
    return result
  })
}
