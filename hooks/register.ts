import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginState, Register, SessionCompactResult, StateDollar } from 'claude-code'
import {
  addFile,
  addRequest,
  armedMark,
  commitReminder,
  commitsText,
  compactAtTurnEnd,
  contextNote,
  emptyRecord,
  filesText,
  handoffText,
  hasCommittedLine,
  isCommitCall,
  isCommitFound,
  isCommitLogged,
  isGitAnswer,
  isRemindableCommit,
  lastReply,
  limitOption,
  markInstructions,
  markOwnCompact,
  markResult,
  markSchema,
  maxCommitCalls,
  parseMark,
  pointerAdvice,
  pointerText,
  promptWithNote,
  report,
  requestsText,
  ruleText,
  runGit,
  settleCompaction,
  shouldNudge,
  shouldRemind,
  sizeLine,
  sizeNudge,
  summaryReason,
  uncommittedText,
  unreadRecord,
  userRequest,
  workPart,
  writtenPath,
} from '../code-mode/hooks/logic'
import type { Holds, Limits, Mark, OwnCompact, PointerOutcome, PointerParts, PointerStep, Same, SessionRecord, TurnCells } from '../code-mode/hooks/logic'

// The tests and older imports read the logic from here.
export * from '../code-mode/hooks/logic'

// The last mark the model set in this session. Values are held per session, so sessions do not see
// each other's marks.
const mark = atom({ plugin: 'compact-timing', key: 'mark' } as const, null as Mark | null)
// Whether this period already had the context note; cleared once the context falls below boundaryTokens.
const noted = atom({ plugin: 'compact-timing', key: 'noted' } as const, false)
// Whether this period already had the size nudge inside a turn; cleared by a compaction.
const nudged = atom({ plugin: 'compact-timing', key: 'nudged' } as const, false)
// Automatic resumes since the user's last request, so a model that always sets `resume` cannot run unattended for long.
const resumes = atom({ plugin: 'compact-timing', key: 'resumes' } as const, 0)
const ownCompact = atom({ plugin: 'compact-timing', key: 'ownCompact' } as const, null as OwnCompact)
const pointer = atom({ plugin: 'compact-timing', key: 'pointer' } as const, null as PointerParts | null)
// Only classic hook events carry the transcript path; pointer mode records it from SessionStart and UserPromptSubmit.
const transcriptPath = atom({ plugin: 'compact-timing', key: 'transcriptPath' } as const, '')
const sessionRecord = atom({ plugin: 'compact-timing', key: 'sessionRecord' } as const, emptyRecord)
// Pointer mode: the ids of the main agent's shell calls that made a commit by HEAD's reflog (`isCommitLogged`), newest
// last, so the work digest finds a quiet commit. A `/clear` starts it over.
const commitCalls = atom({ plugin: 'compact-timing', key: 'commitCalls' } as const, [] as string[])

// The atoms check that the logic's shapes fit the stored ones; this checks the other way, so neither can drift.
type Stored = PluginState['compact-timing']
export type StoredShapesMatch = Holds<
  [
    Same<Stored['mark'], Mark | null>,
    Same<Stored['ownCompact'], OwnCompact>,
    Same<Stored['pointer'], PointerParts | null>,
    Same<Stored['sessionRecord'], SessionRecord>,
  ] extends [true, true, true, true]
    ? true
    : false
>

/** This plugin's values for the hooks it shares with compact-timing-code-mode. */
function turnCells($: StateDollar): TurnCells {
  return {
    mark: { read: () => read($, mark), update: change => update($, mark, change) },
    noted: { read: () => read($, noted), update: change => update($, noted, change) },
    nudged: { read: () => read($, nudged), update: change => update($, nudged, change) },
    resumes: { read: () => read($, resumes), update: change => update($, resumes, change) },
    ownCompact: { read: () => read($, ownCompact), update: change => update($, ownCompact, change) },
  }
}

// Pointer mode at a boundary: the compaction hook answers with these parts in place of the summarizer. Without them
// (no mode, no mark, no focus, no transcript path, a failure here) the same `/compact` makes a summary.
function pointerStep($: EngineInterface, isAdaptive: boolean): PointerStep {
  return {
    prepare: async (marked, tokens, usage) => {
      let parts: PointerParts | null = null
      if (marked?.state === 'boundary') {
        try {
          const path = await read($, transcriptPath)
          if (!path) {
            $.ui.log('compact-timing: pointer mode has no transcript path for this session, so this compaction makes a summary')
          } else if (!marked.focus && !isAdaptive) {
            // Without a focus the pointer would hold no goal and no next step: the summary keeps more. Adaptive pointer
            // mode makes that summary itself and adds the other parts after it.
            $.ui.log('compact-timing: the boundary mark has no focus, so this compaction makes a summary instead of a pointer')
          } else {
            const directory = await $.session.cwd()
            const since = new Date(usage.startedAt).toISOString()
            // The author tells the model's own commits from ones a pull brought in.
            const git = (...gitArguments: string[]) => runGit($, gitArguments, { cwd: directory, timeoutMs: 10_000 })
            // `--no-optional-locks`: a status in the background must not hold the index lock against a `git add` or
            // `git commit` the user or another session runs at that moment. The other two options override settings
            // that would hide untracked files or write a path with other than plain letters as escapes.
            const [run, status] = await Promise.all([
              git('log', `--since=${since}`, '--format=%h %ad %an: %s', '--date=format:%Y-%m-%d %H:%M'),
              git('--no-optional-locks', '-c', 'core.quotePath=false', 'status', '--porcelain', '--untracked-files=normal'),
            ])
            const record = await read($, sessionRecord).catch(() => null)
            parts = {
              tokens,
              focus: marked.focus,
              userSteps: marked.userSteps ?? '',
              requests: record ? requestsText(record) : unreadRecord,
              files: record ? filesText(record) : unreadRecord,
              // Both fail outside a repository, and the commits part then says why, once. A repository without a
              // commit fails only the log, and there everything is uncommitted.
              uncommitted: isGitAnswer(status) || isGitAnswer(run) ? uncommittedText(status, directory) : '',
              transcriptPath: path,
              commits: commitsText(run, directory, since),
            }
          }
        } catch (error) {
          report($, `compact-timing: the pointer parts failed, making a plain summary (${error instanceof Error ? error.message : String(error)})`)
        }
      }
      await update($, pointer, () => parts)
      return parts !== null
    },
    clear: async () => {
      await update($, pointer, () => null)
    },
  }
}

export const register: Register = (on, options) => {
  const limits: Limits = {
    boundaryTokens: limitOption(options.boundaryTokens, 200_000),
    softTokens: limitOption(options.softTokens, 300_000),
  }
  let markTool = 'mcp__compact-timing__mark'
  const isContextNoteOn = options.contextNote !== false
  // `plugin configure` stores the boolean even when `--values-stdin` gets the string "true".
  const isPointerMode = options.pointerMode === true
  // On unless set to false: a thin focus or an unfinished step gets a summary with the pointer's parts after it. The
  // engine refuses a value that is not a boolean, by the userConfig type.
  const isAdaptive = isPointerMode && options.adaptivePointer !== false

  on('session.start', async ($, e, next) => {
    const registered = await $.tool.register({
      name: 'mark',
      description: ruleText(limits, isPointerMode, isAdaptive),
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
    // A `/clear` ends the conversation and no `session.start` follows, so the record of the old one is dropped here.
    on('session.end', async ($, e, next) => {
      if (e.reason === 'clear') {
        await update($, sessionRecord, () => emptyRecord).catch(() => undefined)
        await update($, commitCalls, () => []).catch(() => undefined)
      }
      return next(e)
    })
  }

  on('tool.call', async ($, e, next) => {
    if (e.tool === markTool) {
      if (e.agentId !== undefined) return { result: 'Only the main conversation sets the compaction mark.' }
      const input = e as unknown as { state?: unknown; focus?: unknown; resume?: unknown; userSteps?: unknown }
      const parsed = parseMark(isPointerMode ? input : { ...input, userSteps: undefined })
      if (!parsed) return { result: 'The mark was not set: state must be `boundary` or `busy`.' }
      const isPointerMark = isPointerMode && parsed.state === 'boundary'
      const tokens = parsed.resume || isPointerMark ? await $.session.usage().then(usage => usage.context.tokens).catch(() => undefined) : undefined
      const stored = armedMark(parsed, tokens, limits)
      await update($, mark, () => stored)
      // Only when this mark can compact: below boundaryTokens, or at an unknown size, no pointer is made and the
      // advice would be noise. The mark is stored by now, so a failure here must not fail the call.
      let advice: string[] = []
      if (isPointerMark && tokens !== undefined && tokens >= limits.boundaryTokens) {
        try {
          // Without a focus the advice needs no messages.
          advice = pointerAdvice(parsed, parsed.focus ? await $.session.messages() : [], markTool, isAdaptive)
        } catch {
          advice = []
        }
      }
      return { result: [markResult(parsed, tokens, limits), ...advice].join('\n') }
    }
    const input = e as unknown as Record<string, unknown>
    const isCommitCommand = isCommitCall(e.tool, input)
    // Taken before the hooks beneath and the permission prompt, so the window includes the wait for approval.
    const startedAt = Date.now()
    const result = await next(e)
    if (e.agentId !== undefined || result.deny !== undefined || result.isError) return result
    // Pointer mode: whether a commit command made a commit, for the work digest. When git already printed its commit
    // line, record the call without spawning git (`isCommitFound`) so the digest still finds it even if the host clips
    // the output later.
    const isCommitMade =
      isPointerMode &&
      isCommitCommand &&
      input.run_in_background !== true &&
      (hasCommittedLine(result.text) || (await isCommitFound($, String(input.command), startedAt)))
    if (isCommitMade)
      await update($, commitCalls, previous => [...(Array.isArray(previous) ? previous : []), e.tool_use_id].slice(-maxCommitCalls)).catch(() => undefined)
    if (isPointerMode) {
      const written = writtenPath(e.tool, input)
      if (written !== null) await update($, sessionRecord, previous => addFile(previous, written)).catch(() => undefined)
    }
    const isNudged = await read($, nudged).catch(() => true)
    if (!isCommitCommand && isNudged) return result
    const [current, tokens] = await Promise.all([
      read($, mark).catch(() => null),
      $.session.usage().then(usage => usage.context.tokens).catch(() => undefined),
    ])
    // The reflog is read only in pointer mode, where it also catches a commit whose own output was sent away.
    const isCommitting = isCommitMade || isRemindableCommit(e.tool, input, result.text, current)
    const context: string[] = []
    const isReminded = isCommitting && shouldRemind(current, tokens, limits)
    if (isReminded) context.push(commitReminder(markTool, current))
    // The nudge comes with a commit reminder too, since only it says how many tokens the context holds. The reminder
    // that names `resume` already says to set the mark now, so then only the size is added.
    const isResumeReminded = isReminded && current?.state !== 'busy'
    if (tokens !== undefined && shouldNudge(current, tokens, isNudged, limits)) {
      // Decided inside the write: tool hooks of parallel calls run at the same time, and only one may send the nudge.
      let isFirst = false
      const isStored = await update($, nudged, previous => {
        isFirst = !previous
        return true
      }).then(() => true, () => false)
      if (isStored && isFirst) context.push(isResumeReminded ? sizeLine(tokens) : sizeNudge(tokens, markTool))
    }
    return context.length ? { ...result, context: [...(result.context ?? []), ...context] } : result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    await compactAtTurnEnd($, turnCells($), 'compact-timing', limits, e.isAborted === true, isPointerMode ? pointerStep($, isAdaptive) : undefined)
    return result
  })

  // Pointer mode records each request the user typed, for the pointer to quote.
  on('prompt.submit', ($, e, next) =>
    promptWithNote($, e, next, turnCells($), limits, isContextNoteOn, markTool, async () => {
      const request = isPointerMode ? userRequest(e.text) : null
      if (request !== null) await update($, sessionRecord, previous => addRequest(previous, request))
    }),
  )

  on('command.run', async ($, e, next) => {
    await markOwnCompact(e, turnCells($).ownCompact, 'compact-timing')
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    // Pointer mode answers only the plugin's own `/compact` at a boundary: `pending` and the parts stored for it. Every
    // other compaction (a typed `/compact`, Claude Code's own, a subagent's) goes on to the summarizer.
    let pointed: SessionCompactResult | null = null
    // Adaptive pointer mode: why a summary is made, and the message added after it.
    let handoff: { reason: string; text: string } | null = null
    if (isPointerMode && e.agentId === undefined && e.trigger === 'manual') {
      const [own, parts, commits] = await Promise.all([
        read($, ownCompact).catch(() => null),
        read($, pointer).catch(() => null),
        read($, commitCalls).catch(() => []),
      ])
      // A stored value of another shape finds no commit by the reflog rather than costing the digest.
      const committed = Array.isArray(commits) ? commits.filter(id => typeof id === 'string') : []
      if (own === 'pending' && parts) {
        const reason = isAdaptive ? summaryReason(parts.focus, e.messages, markTool) : null
        if (reason === null)
          pointed = { messages: [{ role: 'user', text: pointerText(parts, lastReply(e.messages), workPart(e.messages, markTool, committed)), toolUses: [] }] }
        else handoff = { reason, text: handoffText(parts, reason) }
      }
    }
    const cells = turnCells($)
    const summarized = pointed ?? (await next(await markInstructions(e, cells.mark, markTool)))
    // A skipped summary gets nothing added. The handoff goes right after the summary, before any message the engine
    // kept, which keep their handles and stand as the engine has them.
    let result = summarized
    let pointerOutcome: PointerOutcome = pointed !== null ? { isPointer: true } : {}
    if (handoff !== null && summarized.skip === undefined) {
      const [summary, ...kept] = summarized.messages
      result = { ...summarized, messages: [...(summary ? [summary] : []), { role: 'user', text: handoff.text, toolUses: [] }, ...kept] }
      pointerOutcome = { summaryReason: handoff.reason }
    }
    await settleCompaction(e, result, cells, pointerOutcome)
    return result
  })
}
