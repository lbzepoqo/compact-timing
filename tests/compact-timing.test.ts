import { expect, test } from 'claude-code/testing'

import { armedMark, busyLead, compactInstructions, contextNote, contextNoteDue, isCommit, limitOption, markResult, openUserSteps, ownCompactFailure, parseMark, pluginCompactArgs, resumePrompt, ruleText, shouldCompact, shouldNudge, shouldRemind, sizeNudge, summaryLabel, transcriptSearch, turnEnd } from '../hooks/register'

const limits = { boundaryTokens: 200_000, softTokens: 300_000 }

test('the tool input gives the state and the focus', () => {
  expect(parseMark({ state: 'boundary', focus: ' Keep the plan file path.\n' })).toEqual({ state: 'boundary', focus: 'Keep the plan file path.', resume: false })
  expect(parseMark({ state: ' Busy ' })).toEqual({ state: 'busy', focus: '', resume: false })
  expect(parseMark({ state: 'boundary', focus: 'x', resume: true })).toEqual({ state: 'boundary', focus: 'x', resume: true })
  expect(parseMark({ state: 'busy', resume: true })).toEqual({ state: 'busy', focus: '', resume: false })
  expect(parseMark({ state: 'boundary', resume: 'yes' })?.resume).toBe(false)
  expect(parseMark({ state: 'done', focus: 'anything' })).toBe(null)
})

test('a boundary compacts earlier, no mark at the soft limit, busy never', () => {
  const boundary = { state: 'boundary' as const, focus: '', resume: false }
  const busy = { state: 'busy' as const, focus: '', resume: false }
  expect(shouldCompact(boundary, 199_999, limits)).toBe(false)
  expect(shouldCompact(boundary, 200_000, limits)).toBe(true)
  expect(shouldCompact(null, 250_000, limits)).toBe(false)
  expect(shouldCompact(null, 300_000, limits)).toBe(true)
  expect(shouldCompact(busy, 450_000, limits)).toBe(false)
  expect(shouldCompact(null, undefined, limits)).toBe(false)
})

test('a boundary lasts one turn, also an interrupted one, which never compacts; busy stays', () => {
  const boundary = { state: 'boundary' as const, focus: 'x', resume: false }
  const busy = { state: 'busy' as const, focus: 'x', resume: false }
  expect(turnEnd(boundary, 250_000, false, limits)).toEqual({ next: null, compact: true, resume: false })
  expect(turnEnd(boundary, 150_000, false, limits)).toEqual({ next: null, compact: false, resume: false })
  expect(turnEnd(boundary, 250_000, true, limits)).toEqual({ next: null, compact: false, resume: false })
  expect(turnEnd(busy, 450_000, false, limits)).toEqual({ next: busy, compact: false, resume: false })
  expect(turnEnd(null, 300_000, false, limits)).toEqual({ next: null, compact: true, resume: false })
})

test('a commit gets the reminder at the boundary limit, or below it while busy', () => {
  const busy = { state: 'busy' as const, focus: '', resume: false }
  expect(shouldRemind(null, 199_999, limits)).toBe(false)
  expect(shouldRemind(null, 200_000, limits)).toBe(true)
  expect(shouldRemind(busy, 150_000, limits)).toBe(true)
  expect(shouldRemind(null, undefined, limits)).toBe(false)
})

test('a commit is recognized, also after other commands and global options', () => {
  expect(isCommit("git add a.ts && git commit -m 'Fix'")).toBe(true)
  expect(isCommit('git -C /tmp/repo commit -qm x')).toBe(true)
  expect(isCommit('git -C "/my repo" --no-pager commit -m x')).toBe(true)
  expect(isCommit('git commit-tree HEAD^{tree}')).toBe(false)
  expect(isCommit('git log --grep commit')).toBe(false)
  expect(isCommit('git status')).toBe(false)
})

test('the rule names the configured limits', () => {
  const text = ruleText({ boundaryTokens: 150_000, softTokens: 250_000 })
  expect(text).toContain('contains 150k tokens or more')
  expect(text).toContain('compacts at 250k tokens')
})

test('an empty or misspelled limit falls back to the default', () => {
  expect(limitOption('150000', 200_000)).toBe(150_000)
  expect(limitOption('', 200_000)).toBe(200_000)
  expect(limitOption('300k', 300_000)).toBe(300_000)
  expect(limitOption(undefined, 300_000)).toBe(300_000)
})

test('every compaction asks for the open user steps and the transcript search, and keeps a busy focus behind its lead', () => {
  const busy = { state: 'busy' as const, focus: 'Keep the failing test name.', resume: false }
  const boundary = { state: 'boundary' as const, focus: 'Next: deploy.', resume: false }
  const standing = `${openUserSteps}\n\n${transcriptSearch}`
  const busyPart = `${busyLead}\n\nKeep the failing test name.`
  // Claude Code's own compaction, and a bare `/compact` typed or sent by a host (T3 Code's idle compaction).
  expect(compactInstructions(undefined, busy)).toBe(`${busyPart}\n\n${standing}`)
  expect(compactInstructions(' ', busy)).toBe(`${busyPart}\n\n${standing}`)
  // A `/compact` with text keeps the text and adds the busy focus after it.
  expect(compactInstructions('the user text', busy)).toBe(`the user text\n\n${busyPart}\n\n${standing}`)
  // Text that only mentions words of the focus still gets it.
  expect(compactInstructions('keep the test name', { ...busy, focus: 'test' })).toBe(`keep the test name\n\n${busyLead}\n\ntest\n\n${standing}`)
  // A boundary focus stands alone and only without instructions.
  expect(compactInstructions(undefined, boundary)).toBe(`Next: deploy.\n\n${standing}`)
  expect(compactInstructions('the user text', boundary)).toBe(`the user text\n\n${standing}`)
  expect(compactInstructions('Next: deploy.', null)).toBe(`Next: deploy.\n\n${standing}`)
  expect(compactInstructions(undefined, { state: 'busy', focus: '', resume: false })).toBe(standing)
  expect(compactInstructions(undefined, null)).toBe(standing)
})

test('the context note comes once at the boundary limit and again only after the context fell below it', () => {
  expect(contextNoteDue(199_999, false, limits)).toEqual({ due: false, noted: false })
  expect(contextNoteDue(200_000, false, limits)).toEqual({ due: true, noted: true })
  expect(contextNoteDue(260_000, true, limits)).toEqual({ due: false, noted: true })
  expect(contextNoteDue(90_000, true, limits)).toEqual({ due: false, noted: false })
  expect(contextNoteDue(undefined, true, limits)).toEqual({ due: false, noted: true })
  expect(contextNote(204_000, 'mcp__x__mark')).toContain('The context holds 204k tokens')
  expect(contextNote(204_000, 'mcp__x__mark')).toContain('call mcp__x__mark with `boundary`')
})

test('a boundary with resume resumes only after a compaction that ran', () => {
  const resuming = { state: 'boundary' as const, focus: 'Next: step 3.', resume: true }
  expect(turnEnd(resuming, 250_000, false, limits)).toEqual({ next: null, compact: true, resume: true })
  expect(turnEnd(resuming, 150_000, false, limits)).toEqual({ next: null, compact: false, resume: false })
  expect(turnEnd(resuming, 250_000, true, limits)).toEqual({ next: null, compact: false, resume: false })
  expect(resumePrompt('Next: step 3.')).toContain('from where you stopped: Next: step 3.')
  expect(resumePrompt('')).toContain('from where you stopped.')
})

test('the mark answer says to end the turn only when a resume can compact', () => {
  const resuming = { state: 'boundary' as const, focus: '', resume: true }
  expect(markResult(resuming, 200_000, limits)).toContain('End your turn now')
  expect(markResult(resuming, 150_000, limits)).toContain('below 200k, so nothing compacts')
  expect(markResult(resuming, undefined, limits)).toContain('size unknown')
  expect(markResult({ state: 'busy', focus: '', resume: false }, 400_000, limits)).toBe('The mark is `busy`.')
})

test('a boundary without resume that compacts says nothing runs until a new prompt', () => {
  const boundary = { state: 'boundary' as const, focus: '', resume: false }
  const answer = markResult(boundary, 200_000, limits)
  expect(answer).toContain('Nothing runs after that until a new prompt arrives')
  expect(answer).toContain('wait for it in this turn, or set `resume`')
  expect(markResult(boundary, 150_000, limits)).toBe('The mark is `boundary`.')
  expect(markResult(boundary, undefined, limits)).toBe('The mark is `boundary`.')
})

test('the size nudge comes once from the soft limit, not while a resume is armed', () => {
  const boundary = { state: 'boundary' as const, focus: '', resume: false }
  const busy = { state: 'busy' as const, focus: '', resume: false }
  expect(shouldNudge(busy, 299_999, false, limits)).toBe(false)
  expect(shouldNudge(busy, 300_000, false, limits)).toBe(true)
  expect(shouldNudge(null, 300_000, false, limits)).toBe(true)
  expect(shouldNudge(busy, 300_000, true, limits)).toBe(false)
  expect(shouldNudge(boundary, 300_000, false, limits)).toBe(true)
  expect(shouldNudge({ ...boundary, resume: true }, 300_000, false, limits)).toBe(false)
  expect(shouldNudge(null, undefined, false, limits)).toBe(false)
  expect(sizeNudge(310_000, 'mcp__x__mark')).toContain('holds 310k tokens')
  // A parallel call can get the nudge before a commit of the same response gets its reminder, so the nudge must not
  // send the model to a later commit.
  expect(sizeNudge(310_000, 'mcp__x__mark')).toContain("a commit that succeeded among the calls you just made counts")
})

test('a plugin compaction labels its summary', () => {
  expect(summaryLabel({ state: 'boundary', focus: '', resume: false }, 214_000)).toContain('compact-timing plugin at 214k tokens, at a `boundary` mark')
  expect(summaryLabel(null, 301_000)).toContain('at the soft limit with no mark')
})

test('the plugin compacts with /compact, its label and focus as the arguments, the standing instructions once', () => {
  const boundary = { state: 'boundary' as const, focus: 'Next: deploy.', resume: false }
  const args = pluginCompactArgs(boundary, 214_000)
  expect(args).toBe(`${summaryLabel(boundary, 214_000)}\n\nNext: deploy.`)
  expect(pluginCompactArgs(null, 301_000)).toBe(summaryLabel(null, 301_000))
  // The compaction hook sees it as a typed /compact and adds the standing instructions after it.
  expect(compactInstructions(args, boundary)).toBe(`${args}\n\n${openUserSteps}\n\n${transcriptSearch}`)
})

test('the plugin compaction counts only when its compaction hook saw it stand', () => {
  expect(ownCompactFailure({ skip: null })).toBe(null)
  expect(ownCompactFailure({ skip: 'blocked by a hook' })).toBe('compaction skipped (blocked by a hook)')
  expect(ownCompactFailure('pending')).toBe('the compaction did not run')
  expect(ownCompactFailure(null)).toBe('the compaction did not run')
})

test('a resume is stored only when the context can compact now', () => {
  const resuming = { state: 'boundary' as const, focus: 'x', resume: true }
  expect(armedMark(resuming, 200_000, limits)).toEqual(resuming)
  expect(armedMark(resuming, 150_000, limits)).toEqual({ ...resuming, resume: false })
  expect(armedMark(resuming, undefined, limits)).toEqual({ ...resuming, resume: false })
})
