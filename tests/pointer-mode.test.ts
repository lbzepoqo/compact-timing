import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  addFile,
  addRequest,
  commitsText,
  emptyRecord,
  filesText,
  lastReply,
  markSchema,
  parseMark,
  pointerText,
  requestsText,
  resumePrompt,
  ruleText,
  transcriptSearch,
  transcriptSearchHow,
  userRequest,
  writtenPath,
} from '../hooks/register'

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
    {
      tokens: 214_000,
      focus: 'Next: deploy.',
      userSteps: 'Run `make test`.',
      requests: '- Fix the parser',
      files: '/repo/parser.ts',
      transcriptPath: transcript,
      commits: 'None in /repo since x.',
    },
    'Done. Run `make deploy`.',
  )
  expect(text.split('\n')[0]).toContain('Compacted by the compact-timing plugin at 214k tokens, at a `boundary` mark, in pointer mode')
  expect(text).toContain('not written by the user')
  expect(text).toContain('## Focus\nNext: deploy.')
  expect(text).toContain("## The user's requests\nVerbatim, oldest first; a later request can change an earlier one.\n- Fix the parser")
  expect(text).toContain('## Open steps you gave the user\nRun `make test`.')
  expect(text).toContain('Files changed through Bash are not listed.\n/repo/parser.ts')
  expect(text).toContain('(requests left out above, error text, paths, numbers)')
  expect(text).toContain('## Your last message\nDone. Run `make deploy`.')
  expect(text).toContain(`## Transcript\n${transcript}\n`)
  expect(text).toContain(transcriptSearchHow)
  expect(text).toContain('## Commits\nNone in /repo since x.')
  const empty = pointerText({ tokens: 1, focus: '', userSteps: '', requests: 'None recorded.', files: 'None recorded.', transcriptPath: transcript, commits: 'c' }, '')
  expect(empty).toContain('## Focus\nNone given.')
  expect(empty).toContain('## Open steps you gave the user\nNone listed.')
})

test('a request keeps one kind of line break and is cut at 2,000 characters', () => {
  expect(userRequest('  Fix the parser\r\nin src/parse.ts\n')).toBe('Fix the parser\nin src/parse.ts')
  expect(userRequest('/home/user/repo/parse.ts throws, fix it')).toBe('/home/user/repo/parse.ts throws, fix it')
  expect(userRequest('   ')).toBeNull()
  const long = userRequest(`${'a'.repeat(2500)}END`) ?? ''
  expect(long.startsWith('a'.repeat(2000))).toBe(true)
  expect(long).toContain('...(cut here; the rest is in the transcript)')
  expect(long).not.toContain('END')
})

test('the record keeps the first three and the newest five requests and counts the rest', () => {
  let record = emptyRecord
  for (let index = 1; index <= 11; index++) record = addRequest(record, `request ${index}`)
  expect(record.requests).toEqual(['request 1', 'request 2', 'request 3', 'request 7', 'request 8', 'request 9', 'request 10', 'request 11'])
  expect(record.omittedRequests).toBe(3)
  const text = requestsText(record)
  expect(text.split('\n').slice(0, 5)).toEqual([
    '- request 1',
    '- request 2',
    '- request 3',
    '- ... 3 more between these; search the transcript for them',
    '- request 7',
  ])
  expect(requestsText(addRequest(emptyRecord, 'line one\nline two'))).toBe('- line one\n  line two')
  expect(requestsText(emptyRecord)).toBe('None recorded.')
})

test('the record lists each written file once, at most 40, and counts later writes', () => {
  expect(writtenPath('Write', { file_path: '/repo/a.ts' })).toBe('/repo/a.ts')
  expect(writtenPath('Edit', { file_path: '/repo/a.ts' })).toBe('/repo/a.ts')
  expect(writtenPath('NotebookEdit', { notebook_path: '/repo/n.ipynb' })).toBe('/repo/n.ipynb')
  expect(writtenPath('Read', { file_path: '/repo/a.ts' })).toBeNull()
  expect(writtenPath('Write', {})).toBeNull()
  let record = addFile(addFile(emptyRecord, '/repo/a.ts'), '/repo/a.ts')
  expect(record.files).toEqual(['/repo/a.ts'])
  for (let index = 0; index < 45; index++) record = addFile(record, `/repo/file${index}.ts`)
  expect(record.files.length).toBe(40)
  expect(record.omittedFiles).toBe(6)
  expect(filesText(record)).toContain('... and 6 more writes to files not listed')
  expect(filesText(emptyRecord)).toBe('None recorded.')
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
  on('classic.UserPromptSubmit', () => ({}) as never)
  on('session.end', (_, e) => ({ sessionId: e.sessionId }) as never)
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
  // Tools other than the mark: the call succeeds.
  on('tool.call', () => ({ result: 'ok' }) as never)
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


const prompt = ($: Engine, text: string, origin = 'sdk', extra: Record<string, unknown> = {}) =>
  $.prompt.submit({ text, wait: false, origin: { kind: origin }, ...extra } as never)

test('pointer mode: the pointer quotes the user\'s requests and lists the files written', { options: { pointerMode: true } }, async ($, on) => {
  const seen = world(on, $)
  await start($)
  await prompt($, 'Fix the parser in src/parse.ts', 'composer')
  await prompt($, '/compact', 'composer', { command: { name: 'compact', args: '' } })
  await prompt($, 'a meta prompt', 'sdk', { isMeta: true })
  await prompt($, 'compact-timing: an automatic prompt from a plugin', 'plugin')
  await prompt($, 'Also add a test')
  await $.tool.call({ tool: 'Write', file_path: '/repo/tests/parse.test.ts' } as never)
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/parse.ts' } as never)
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/parse.ts' } as never)
  await $.tool.call({ tool: 'Write', file_path: '/repo/x.ts', agentId: 'a1' } as never)
  await setMark($, { state: 'boundary', focus: 'Next: deploy.' })
  await endTurn($)
  const pointer = seen.installed[0] ?? ''
  expect(pointer).toContain("## The user's requests\nVerbatim, oldest first; a later request can change an earlier one.\n- Fix the parser in src/parse.ts\n- Also add a test\n")
  expect(pointer).toContain('## Files written this session with Write, Edit or NotebookEdit\nFiles changed through Bash are not listed.\n/repo/tests/parse.test.ts\n/repo/src/parse.ts\n')
  expect(pointer).not.toContain('meta prompt')
  expect(pointer).not.toContain('- compact-timing:')
  expect(pointer).not.toContain('- /compact')
  expect(pointer).not.toContain('/repo/x.ts')
})

test('pointer mode: a /clear starts the record over', { options: { pointerMode: true } }, async ($, on) => {
  const seen = world(on, $)
  await start($)
  await prompt($, 'Old task')
  await $.tool.call({ tool: 'Write', file_path: '/repo/old.ts' } as never)
  await $.session.end({ reason: 'clear', sessionId: 's1' } as never)
  await $.classic.UserPromptSubmit({ prompt: 'New task', transcript_path: '/home/user/.claude/projects/repo/new.jsonl' } as never)
  await prompt($, 'New task')
  await setMark($, { state: 'boundary', focus: 'Next: deploy.' })
  await endTurn($)
  const pointer = seen.installed[0] ?? ''
  expect(pointer).toContain('- New task')
  expect(pointer).not.toContain('Old task')
  expect(pointer).toContain('Files changed through Bash are not listed.\nNone recorded.')
  expect(pointer).toContain('## Transcript\n/home/user/.claude/projects/repo/new.jsonl')
})

