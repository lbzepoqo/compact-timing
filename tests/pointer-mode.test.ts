import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { commitsText, lastReply, markSchema, parseMark, pointerText, resumePrompt, ruleText, transcriptSearch, transcriptSearchHow } from '../hooks/register'

const limits = { boundaryTokens: 200_000, softTokens: 300_000 }
const transcript = '/home/user/.claude/projects/repo/0b8e.jsonl'
const markTool = 'mcp__compact-timing__mark'
// 2026-11-12T08:00:00.000Z
const startedAt = Date.UTC(2026, 10, 12, 8, 0)

test('pointer mode adds userSteps to the tool and the rule; off, both stay as they were', () => {
  expect(ruleText(limits)).not.toContain('userSteps')
  expect(ruleText(limits)).toContain('- `focus`: what the summary must keep')
  expect(ruleText(limits, true)).toContain('- `userSteps`: with `boundary`')
  expect(ruleText(limits, true)).toContain('no summary is made')
  expect(Object.keys(markSchema().properties)).toEqual(['state', 'focus', 'resume'])
  expect(Object.keys(markSchema(true).properties)).toEqual(['state', 'focus', 'userSteps', 'resume'])
})

test('userSteps is kept only with boundary and only when given', () => {
  expect(parseMark({ state: 'boundary', focus: 'f', userSteps: ' Run `make test` and report.\n' })).toEqual({
    state: 'boundary',
    focus: 'f',
    resume: false,
    userSteps: 'Run `make test` and report.',
  })
  expect(parseMark({ state: 'busy', userSteps: 'x' })).toEqual({ state: 'busy', focus: '', resume: false })
  expect(parseMark({ state: 'boundary', userSteps: '  ' })).toEqual({ state: 'boundary', focus: '', resume: false })
})

test('the summary transcript line is unchanged by the split', () => {
  expect(transcriptSearch).toBe(
    "End the summary with this line: \"For exact details the summary dropped (error text, paths, numbers), search the full transcript with command grep -oE '.{0,200}<term>.{0,200}' rather than reading it whole: each line is one long JSON record.\"",
  )
})

test('the commits part lists the log, none, or why git gave none', () => {
  const since = '2026-11-12T08:00:00.000Z'
  expect(commitsText({ exitCode: 0, stdout: 'abc123 2026-11-12 09:00 Fix\ndef456 2026-11-12 08:30 Add\n', stderr: '' }, '/repo', since)).toBe(
    `2 in /repo since ${since}, newest first:\nabc123 2026-11-12 09:00 Fix\ndef456 2026-11-12 08:30 Add`,
  )
  expect(commitsText({ exitCode: 0, stdout: '\n', stderr: '' }, '/repo', since)).toBe(`None in /repo since ${since}.`)
  expect(commitsText({ exitCode: 128, stdout: '', stderr: 'fatal: not a git repository\nmore' }, '/tmp', since)).toContain(
    'git log failed in /tmp since 2026-11-12T08:00:00.000Z (fatal: not a git repository)',
  )
  expect(commitsText({ error: 'spawn git ENOENT' }, '/tmp', since)).toContain('(spawn git ENOENT)')
  const many = Array.from({ length: 45 }, (_, index) => `c${index} subject`).join('\n')
  const text = commitsText({ exitCode: 0, stdout: many, stderr: '' }, '/repo', since)
  expect(text).toContain('45 in /repo')
  expect(text).toContain('c39 subject')
  expect(text).not.toContain('c40 subject')
  expect(text).toContain('... and 5 older')
})

test('the last reply is the newest assistant text, its end kept', () => {
  const messages = [
    { role: 'user' as const, text: 'Fix it' },
    { role: 'assistant' as const, text: 'Fixed. Please run `make deploy` and tell me the result.' },
    { role: 'assistant' as const, text: '' },
    { role: 'user' as const, text: '' },
  ]
  expect(lastReply(messages)).toBe('Fixed. Please run `make deploy` and tell me the result.')
  expect(lastReply([{ role: 'user', text: 'x' }])).toBe('')
  const long = lastReply([{ role: 'assistant', text: `${'a'.repeat(5000)}END` }])
  expect(long.startsWith('...')).toBe(true)
  expect(long.endsWith('END')).toBe(true)
  expect(long.length).toBe(3003)
})

test('the pointer holds the label, focus, open steps, last reply, transcript path and commits', () => {
  const text = pointerText(
    { tokens: 214_000, focus: 'Next: deploy.', userSteps: 'Run `make test`.', transcriptPath: transcript, commits: 'None in /repo since x.' },
    'Done. Run `make deploy`.',
  )
  expect(text.split('\n')[0]).toContain('Compacted by the compact-timing plugin at 214k tokens, at a `boundary` mark, in pointer mode')
  expect(text).toContain('not written by the user')
  expect(text).toContain('## Focus\nNext: deploy.')
  expect(text).toContain('## Open steps you gave the user\nRun `make test`.')
  expect(text).toContain('## Your last message\nDone. Run `make deploy`.')
  expect(text).toContain(`## Transcript\n${transcript}\n`)
  expect(text).toContain(transcriptSearchHow)
  expect(text).toContain('## Commits\nNone in /repo since x.')
  const empty = pointerText({ tokens: 1, focus: '', userSteps: '', transcriptPath: transcript, commits: 'c' }, '')
  expect(empty).toContain('## Focus\nNone given.')
  expect(empty).toContain('## Open steps you gave the user\nNone listed.')
})

test('the resume prompt after a pointer does not speak of a summary', () => {
  expect(resumePrompt('Next: step 3.', true)).not.toContain('summary')
  expect(resumePrompt('Next: step 3.', true)).toContain('replaced the conversation with a pointer')
  expect(resumePrompt('Next: step 3.')).toContain('The summary is newer than this focus')
})

type Seen = { summarized: string[]; installed: string[]; prompts: string[]; gitArgs: string[][]; logs: string[] }

/**
 * The world beneath the plugin: the session size, git, and `/compact`, whose command runs the compaction with the
 * trigger `manual` as Claude Code does. `summarized` holds each compaction that reached the summarizer, `installed` the
 * first message of what each plugin compaction left.
 */
const world = (on: On, $: Engine, tokens = 250_000): Seen => {
  const seen: Seen = { summarized: [], installed: [], prompts: [], gitArgs: [], logs: [] }
  on('classic.SessionStart', () => ({}) as never)
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  // A call a plugin makes on `$` is answered with `{ value }`.
  on('tool.register', (_, e) => ({ value: { tool: `mcp__compact-timing__${e.name}` } }) as never)
  on('session.usage', () => ({ value: { startedAt, context: { tokens, window: 1_000_000 }, rateLimits: [], changed: [] } }) as never)
  on('session.cwd', () => ({ value: '/repo' }) as never)
  on('process.run', (_, e) => {
    seen.gitArgs.push([...e.argv])
    return { value: { exitCode: 0, stdout: 'abc123 2026-11-12 09:00 Fix the parser\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  on('session.compact', (_, e) => {
    seen.summarized.push(e.trigger)
    return { messages: [{ role: 'user', text: 'the summary', toolUses: [] }] }
  })
  on('command.run', async (_, e) => {
    if (e.command === 'compact') {
      const result = await $.session.compact({
        trigger: 'manual',
        instructions: e.args,
        messages: [
          { role: 'user', text: 'Fix the parser', toolUses: [] },
          { role: 'assistant', text: 'Fixed and committed. Please run `make deploy`.', toolUses: [] },
        ],
      } as never)
      seen.installed.push(result.messages?.[0]?.text ?? `skip: ${result.skip}`)
    }
    return {} as never
  })
  on('prompt.submit', (_, e) => {
    seen.prompts.push(e.text)
    return { text: e.text } as never
  })
  on('ui.log', (_, e) => {
    seen.logs.push(String((e as { text?: unknown }).text))
    return { value: undefined } as never
  })
  on('ui.toast', () => ({ value: undefined }) as never)
  return seen
}

const start = async ($: Engine, path = transcript) => {
  await $.classic.SessionStart({ source: 'startup', transcript_path: path })
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
}
const setMark = ($: Engine, input: Record<string, unknown>) => $.tool.call({ tool: markTool, ...input } as never)
const endTurn = ($: Engine) => $.turn.complete({ reason: 'answer', answer: 'Done.', durationMs: 1, isAborted: false, turnId: 't1' })

test('pointer mode: the plugin compaction at a boundary replaces the conversation without the summarizer', { options: { pointerMode: true } }, async ($, on) => {
  const seen = world(on, $)
  await start($)
  await setMark($, { state: 'boundary', focus: 'Next: deploy.', userSteps: 'Run `make test`.', resume: true })
  await endTurn($)
  expect(seen.summarized).toEqual([])
  expect(seen.installed.length).toBe(1)
  const pointer = seen.installed[0]
  expect(pointer).toContain('in pointer mode')
  expect(pointer).toContain('## Focus\nNext: deploy.')
  expect(pointer).toContain('## Open steps you gave the user\nRun `make test`.')
  expect(pointer).toContain('## Your last message\nFixed and committed. Please run `make deploy`.')
  expect(pointer).toContain(`## Transcript\n${transcript}`)
  expect(pointer).toContain('abc123 2026-11-12 09:00 Fix the parser')
  expect(seen.gitArgs[0]?.slice(0, 3)).toEqual(['git', 'log', '--since=2026-11-12T08:00:00.000Z'])
  expect(seen.prompts.length).toBe(1)
  expect(seen.prompts[0]).toContain('replaced the conversation with a pointer')
})

test('pointer mode off: the same boundary compaction makes a summary', async ($, on) => {
  const seen = world(on, $)
  await start($)
  await setMark($, { state: 'boundary', focus: 'Next: deploy.', userSteps: 'Run `make test`.' })
  await endTurn($)
  expect(seen.summarized).toEqual(['manual'])
  expect(seen.installed).toEqual(['the summary'])
  expect(seen.gitArgs).toEqual([])
})

test('pointer mode: no mark at the soft limit makes a summary', { options: { pointerMode: true } }, async ($, on) => {
  const seen = world(on, $, 310_000)
  await start($)
  await endTurn($)
  expect(seen.summarized).toEqual(['manual'])
  expect(seen.installed).toEqual(['the summary'])
})

test('pointer mode: without a transcript path the boundary compaction makes a summary', { options: { pointerMode: true } }, async ($, on) => {
  const seen = world(on, $)
  await start($, '')
  await setMark($, { state: 'boundary', focus: 'Next: deploy.' })
  await endTurn($)
  expect(seen.summarized).toEqual(['manual'])
  expect(seen.logs.some(line => line.includes('no transcript path'))).toBe(true)
})

test('pointer mode: a boundary without a focus makes a summary', { options: { pointerMode: true } }, async ($, on) => {
  const seen = world(on, $)
  await start($)
  await setMark($, { state: 'boundary', userSteps: 'Run `make test`.' })
  await endTurn($)
  expect(seen.summarized).toEqual(['manual'])
  expect(seen.gitArgs).toEqual([])
  expect(seen.logs.some(line => line.includes('has no focus'))).toBe(true)
})

test('pointer mode: Claude Code compactions, a typed /compact and a subagent keep the summary', { options: { pointerMode: true } }, async ($, on) => {
  const seen = world(on, $)
  await start($)
  await setMark($, { state: 'busy', focus: 'Keep the failing test name.' })
  const messages = [{ role: 'user', text: 'x', toolUses: [] }]
  await $.session.compact({ trigger: 'auto', messages } as never)
  await $.session.compact({ trigger: 'precompute', messages } as never)
  await $.session.compact({ trigger: 'manual', messages } as never)
  await $.session.compact({ trigger: 'auto', messages, agentId: 'a1' } as never)
  expect(seen.summarized).toEqual(['auto', 'precompute', 'manual', 'auto'])
})

