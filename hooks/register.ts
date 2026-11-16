import { atom, read, update } from 'claude-code'
import type { PluginState, Register, SessionCompactResult } from 'claude-code'
import {
  addFile,
  addRequest,
  armedMark,
  commitReminder,
  commitsText,
  compactInstructions,
  contextNote,
  contextNoteDue,
  emptyRecord,
  filesText,
  handoffText,
  isCommitCall,
  isCommitFound,
  isCommitLogged,
  isGitAnswer,
  isRemindableCommit,
  lastReply,
  limitOption,
  markResult,
  markSchema,
  maxCommitCalls,
  maxResumes,
  ownCompactFailure,
  parseMark,
  pluginCompactArgs,
  pointerAdvice,
  pointerText,
  report,
  requestsText,
  resumePrompt,
  ruleText,
  runGit,
  shouldNudge,
  shouldRemind,
  sizeNudge,
  summaryReason,
  thousands,
  turnEnd,
  uncommittedText,
  unfinishedStep,
  unreadRecord,
  userRequest,
  workPart,
  writtenPath,
} from '../code-mode/hooks/logic'
import type { Holds, Limits, Mark, OwnCompact, PointerParts, Same, SessionRecord } from '../code-mode/hooks/logic'

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
    // Pointer mode: whether the main agent's commit command made a commit, for the work digest. A call run in the
    // background has only started by now.
    const isCommitMade = isPointerMode && isCommitCommand && input.run_in_background !== true && (await isCommitFound($, String(input.command), startedAt))
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
    // Only the reminder for a mark that is not busy names `resume`, so only it says what the nudge says.
    const isResumeReminded = isReminded && current?.state !== 'busy'
    if (tokens !== undefined && shouldNudge(current, tokens, isNudged, limits)) {
      // Decided inside the write: tool hooks of parallel calls run at the same time, and only one may send the nudge.
      let isFirst = false
      const isStored = await update($, nudged, previous => {
        isFirst = !previous
        return true
      }).then(() => true, () => false)
      if (isStored && isFirst && !isResumeReminded) context.push(sizeNudge(tokens, markTool))
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
      const reason = typeof settled === 'object' ? settled?.summaryReason : undefined
      if (reason) $.ui.log(`compact-timing: pointer mode made a summary and added the pointer's parts after it, because ${reason}`)
      else if (parts !== null && !isPointer) $.ui.log('compact-timing: pointer mode fell back to a summary for this compaction')
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
    const request = isPointerMode && isUserRequest ? userRequest(e.text) : null
    if (request !== null) await update($, sessionRecord, previous => addRequest(previous, request)).catch(() => undefined)
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
    // Another plugin's direct compaction carries its own instructions. This plugin's runs as `/compact` (`manual`).
    if (pointed === null && e.agentId === undefined && e.trigger !== 'plugin') {
      const current = await read($, mark).catch(() => null)
      e = { ...e, instructions: compactInstructions(e.trigger, e.instructions, current, unfinishedStep(e.messages, markTool)) }
    }
    const summarized = pointed ?? (await next(e))
    // A skipped summary gets nothing added. The handoff goes right after the summary, before any message the engine
    // kept, which keep their handles and stand as the engine has them.
    let summaryReasonAdded: string | undefined
    let result = summarized
    if (handoff !== null && summarized.skip === undefined) {
      const [summary, ...kept] = summarized.messages
      result = { ...summarized, messages: [...(summary ? [summary] : []), { role: 'user', text: handoff.text, toolUses: [] }, ...kept] }
      summaryReasonAdded = handoff.reason
    }
    if (e.agentId === undefined && e.trigger === 'manual') {
      const isPointer = pointed !== null
      await update($, ownCompact, previous =>
        previous === 'pending'
          ? { skip: result.skip ?? null, ...(isPointer ? { isPointer } : {}), ...(summaryReasonAdded ? { summaryReason: summaryReasonAdded } : {}) }
          : previous,
      ).catch(() => undefined)
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
