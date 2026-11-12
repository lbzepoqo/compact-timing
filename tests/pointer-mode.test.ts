import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  addFile,
  addRequest,
  afterLastCommit,
  commitsText,
  compactInstructions,
  emptyRecord,
  filesText,
  isCommitCall,
  isQuietCommit,
  isRemindableCommit,
  lastFailedShell,
  lastReply,
  markSchema,
  openUserSteps,
  parseMark,
  pointerAdvice,
  pointerText,
  requestsText,
  resumePrompt,
  ruleText,
  transcriptSearch,
  transcriptSearchHow,
  uncommittedText,
  unfinishedStep,
  userRequest,
  workEntries,
  workPart,
  workText,
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

test('the schema says what to write in a line each and leaves how the plugin uses it to the tool description', () => {
  for (const isPointerMode of [false, true]) {
    const properties = markSchema(isPointerMode).properties as Record<string, { description?: string }>
    for (const property of Object.values(properties)) expect((property.description ?? '').length).toBeLessThan(200)
  }
  expect(JSON.stringify(markSchema(true))).not.toContain('no summary is made')
  expect(markSchema(true).properties.focus.description).toContain('With `boundary`, the handoff that replaces the conversation')
  expect(ruleText(limits, true)).toContain('the files written, the uncommitted changes, the transcript path')
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

test('the uncommitted part lists the status lines, a clean tree, or why git gave none', () => {
  expect(uncommittedText({ exitCode: 0, stdout: ' M src/lex.ts\n?? notes.md\n', stderr: '' }, '/repo')).toBe(
    '2 in /repo when this message was made (`git status --porcelain`: two status letters, then the path from the repository root):\n M src/lex.ts\n?? notes.md',
  )
  expect(uncommittedText({ exitCode: 0, stdout: '', stderr: '' }, '/repo')).toBe('None: the working tree in /repo was clean when this message was made.')
  expect(uncommittedText({ exitCode: 128, stdout: '', stderr: 'fatal: bad index\nmore' }, '/repo')).toBe('git status failed in /repo (fatal: bad index).')
  expect(uncommittedText({ exitCode: 1, stdout: '', stderr: '' }, '/repo')).toBe('git status failed in /repo (exit code 1).')
  expect(uncommittedText({ error: 'timed out' }, '/repo')).toBe('git status failed in /repo (timed out).')
  const many = Array.from({ length: 45 }, (_, index) => ` M file${index}.ts`).join('\n')
  const text = uncommittedText({ exitCode: 0, stdout: many, stderr: '' }, '/repo')
  expect(text).toContain('45 in /repo')
  expect(text).toContain('\n M file39.ts')
  expect(text).not.toContain('file40.ts')
  expect(text.endsWith('... and 5 more')).toBe(true)
  // A cut output: its last line is partial, and the count a lower bound.
  const cut = uncommittedText({ exitCode: 0, stdout: `${many}\n M part`, stderr: '', isStdoutTruncated: true }, '/repo')
  expect(cut.startsWith('45 or more in /repo')).toBe(true)
  expect(cut).not.toContain('part')
  expect(cut.endsWith(' M file39.ts\n... and 5 more\n... and others: the output of git status was cut')).toBe(true)
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
      uncommitted: ' M src/lex.ts',
      transcriptPath: transcript,
      commits: 'None in /repo since x.',
    },
    'Done. Run `make deploy`.',
    '## Your work after the last commit\nNothing but your last message.',
  )
  expect(text.split('\n')[0]).toContain('Compacted by the compact-timing plugin at 214k tokens, at a `boundary` mark, in pointer mode')
  expect(text).toContain('not written by the user')
  expect(text).toContain('## Focus\nNext: deploy.')
  expect(text).toContain("## The user's requests\nVerbatim, oldest first; a later request can change an earlier one.\n- Fix the parser")
  expect(text).toContain('## Open steps you gave the user\nRun `make test`.')
  expect(text).toContain('Files changed through Bash are not listed.\n/repo/parser.ts')
  expect(text).toContain('(requests left out above, error text, paths, numbers)')
  expect(text).toContain('## Your last message\nDone. Run `make deploy`.')
  expect(text).toContain('## Open steps you gave the user\nRun `make test`.\n\n## Your work after the last commit\nNothing but your last message.\n\n## Your last message')
  expect(text).toContain('before acting on a command, an error or a value the focus names without giving it exactly')
  expect(text).toContain(`## Transcript\n${transcript}\n`)
  expect(text).toContain(transcriptSearchHow)
  expect(text).toContain('## Commits\nNone in /repo since x.')
  expect(text).toContain('/repo/parser.ts\n\n## Uncommitted changes\n M src/lex.ts\n\n## Transcript')
  const empty = pointerText({ tokens: 1, focus: '', userSteps: '', requests: 'None recorded.', files: 'None recorded.', uncommitted: '', transcriptPath: transcript, commits: 'c' }, '', 'work')
  expect(empty).not.toContain('## Uncommitted changes')
  expect(empty).toContain('None recorded.\n\n## Transcript')
  expect(empty).toContain('## Focus\nNone given.')
  expect(empty).toContain('## Open steps you gave the user\nNone listed.')
})

const shell = (command: string, text: string, isError = false) => ({ tool: 'Bash', input: { command }, text, ...(isError ? { isError: true as const } : {}) })
// A fix that was committed, then a second change whose test fails, the mark and the closing message.
const session = [
  { role: 'user' as const, text: 'Fix the parser', toolUses: [] },
  { role: 'assistant' as const, text: 'Reading the parser.', toolUses: [{ tool: 'Read', input: { file_path: '/repo/src/parse.ts' }, text: 'x'.repeat(5000) }] },
  { role: 'user' as const, text: '', toolUses: [] },
  { role: 'assistant' as const, text: '', toolUses: [shell('git add -A && git commit -m "Fix the parser"', '[main abc1234] Fix the parser\n 1 file changed')] },
  { role: 'user' as const, text: 'Also handle tabs' },
  { role: 'assistant' as const, text: 'Tabs reach the lexer as spaces, so the fix goes there.', toolUses: [{ tool: 'Edit', input: { file_path: '/repo/src/lex.ts' }, text: 'ok' }] },
  { role: 'assistant' as const, text: '', toolUses: [shell('bun test', `${'.'.repeat(300)}\n12 pass`), shell('bun test tabs', `error: expected 2\n${'y'.repeat(900)}\n1 fail`, true)] },
  { role: 'assistant' as const, text: '', toolUses: [{ tool: markTool, input: { state: 'boundary' }, text: 'The mark is `boundary`.' }] },
  { role: 'assistant' as const, text: 'The tab test still fails. Should I change the lexer?', toolUses: [] },
]

test('a commit is found in either shell, and only there', () => {
  expect(isCommitCall('Bash', { command: 'git commit -m x' })).toBe(true)
  expect(isCommitCall('PowerShell', { command: 'git add -A; git commit -m x' })).toBe(true)
  expect(isCommitCall('Bash', { command: 'git status' })).toBe(false)
  expect(isCommitCall('Write', { command: 'git commit -m x' })).toBe(false)
  expect(isCommitCall('Bash', {})).toBe(false)
})

test('the commit reminder goes by the line git prints, not by the words in the command', () => {
  const command = 'git add -A && git commit -m "Fix"'
  const busy = { state: 'busy' as const, focus: '' }
  expect(isRemindableCommit('Bash', { command }, '[main 5815a99] Fix\n 1 file changed', null)).toBe(true)
  expect(isRemindableCommit('PowerShell', { command: 'git commit -m x' }, '[main 5815a99] x', null)).toBe(true)
  // The words alone: a prompt passed to another program, an echo, a dry run, a commit a hook rejected behind a pipe.
  expect(isRemindableCommit('Bash', { command: 'claude -p "then run git commit -m x"' }, 'Done.', null)).toBe(false)
  expect(isRemindableCommit('Bash', { command: 'echo "then run git commit"' }, 'then run git commit', null)).toBe(false)
  expect(isRemindableCommit('Bash', { command: 'git commit --dry-run' }, 'On branch main', null)).toBe(false)
  expect(isRemindableCommit('Bash', { command: 'git commit -m "Fix the -q flag" 2>&1 | tail -5' }, 'lint failed', null)).toBe(false)
  expect(isRemindableCommit('Bash', { command: 'git commit -m again\nif [ $? -eq 0 ]; then echo ok; fi' }, 'nothing added to commit', null)).toBe(false)
  // A pipe that kept only the end of git's commit output.
  expect(isRemindableCommit('Bash', { command: 'git commit -m x 2>&1 | tail -2' }, ' 2 files changed, 3 insertions(+)\n create mode 100644 a.ts', null)).toBe(true)
  expect(isRemindableCommit('Bash', { command: 'git commit -m x 2>&1 | tail -1' }, ' delete mode 100644 a.ts', null)).toBe(true)
  // No output (a quiet commit, or its output sent away) and another hook's answer, which has no text, go by the command.
  expect(isRemindableCommit('Bash', { command: 'git commit -qm x' }, '', null)).toBe(true)
  expect(isRemindableCommit('Bash', { command: 'git commit -m "a; b" -q' }, '(Bash completed with no output)', null)).toBe(true)
  expect(isRemindableCommit('Bash', { command: 'git commit -m x >/dev/null' }, '(Bash completed with no output)\n', null)).toBe(true)
  expect(isRemindableCommit('Bash', { command }, undefined, null)).toBe(true)
  // A quiet commit in a command that goes on to print: the three commits of the session that wrote this rule.
  const logged = 'tsc=0\n 47 pass\n 0 fail\n5aad6be compact-timing: the last failed shell command\n88228d1 compact-timing: the pointer adds a digest'
  expect(isRemindableCommit('Bash', { command: `wsl -e bash -lc "cd ~/repo && tsc --noEmit -p . ; echo tsc=\\$? && git add -A && git commit -q -F - <<'EOF'\nSubject\n\nBody.\nEOF\ngit log --oneline | head -2"` }, logged, null)).toBe(true)
  expect(isRemindableCommit('Bash', { command: 'wsl -e bash -lc "cd ~/repo && git commit -q --amend -F /tmp/message.txt && git diff --stat"' }, ' plugin.json | 2 +-', null)).toBe(true)
  expect(isRemindableCommit('Bash', { command: `git commit -q -am 'Bump the version' && git log --format='%h %s' | head -4` }, '08a0b35 Bump the version', null)).toBe(true)
  // The price of that: quoted words with the quiet option read the same as `bash -lc "git commit -q"`.
  expect(isRemindableCommit('Bash', { command: 'echo "run git commit -q later"' }, 'run git commit -q later', null)).toBe(true)
  // So does a busy mark, whose reminder only asks whether the step is done.
  expect(isRemindableCommit('Bash', { command: 'git commit -m x 2>&1 | tail -1' }, 'lint failed', busy)).toBe(true)
  expect(isRemindableCommit('Bash', { command: 'git commit -m x 2>&1 | tail -1' }, 'lint failed', { state: 'boundary', focus: '' })).toBe(false)
  expect(isRemindableCommit('Bash', { command: 'git status' }, undefined, busy)).toBe(false)
  expect(isRemindableCommit('Write', { command }, '[main 5815a99] Fix', busy)).toBe(false)
})

test('a quiet commit has -q, --quiet or a q among its short options, outside a quoted argument', () => {
  expect(isQuietCommit('git commit -q -m x')).toBe(true)
  expect(isQuietCommit('git -C /repo commit -aqm x')).toBe(true)
  expect(isQuietCommit('git commit -m x --quiet')).toBe(true)
  expect(isQuietCommit('git commit -m "a; b" -q')).toBe(true)
  expect(isQuietCommit('git commit -qm"x"')).toBe(true)
  expect(isQuietCommit('bash -lc "git commit -m x -q"')).toBe(true)
  expect(isQuietCommit('git commit -m x')).toBe(false)
  expect(isQuietCommit('git commit --squash HEAD')).toBe(false)
  expect(isQuietCommit('git commit -m "Fix the -q flag of the parser" 2>&1 | tail -3')).toBe(false)
  expect(isQuietCommit("git commit -m 'Explain why grep -q is used'")).toBe(false)
  expect(isQuietCommit('git commit -m "Add -sequential mode" | tail -2')).toBe(false)
  expect(isQuietCommit('git commit -m x && grep -q y file')).toBe(false)
  expect(isQuietCommit('git commit -m x; git push -q')).toBe(false)
  expect(isQuietCommit('git push -q')).toBe(false)
  // The option is looked for on the commit's own line, or one continued with a backslash.
  expect(isQuietCommit('git commit -m x\ngit push -q')).toBe(false)
  expect(isQuietCommit('git commit -m x\nif [ $? -eq 0 ]; then echo ok; fi')).toBe(false)
  expect(isQuietCommit("git commit -F - <<'EOF'\nSubject\n\nThe -q flag is explained\nEOF")).toBe(false)
  expect(isQuietCommit('git commit -m x \\\n  -q')).toBe(true)
  expect(isQuietCommit('git commit -m x -q\\\n  --no-verify')).toBe(true)
  // A message attached to its option, and one with an escaped quote.
  expect(isQuietCommit('git commit -mquickfix')).toBe(false)
  expect(isQuietCommit('git commit -amquickfix')).toBe(false)
  expect(isQuietCommit('git commit -m "a \\" b" -q')).toBe(true)
})

test('a summary is asked to keep an unfinished step when the last shell command after the last commit failed', () => {
  const line = unfinishedStep(session, markTool)
  expect(lastFailedShell(session, markTool)).toBe('Bash: bun test tabs')
  expect(line).toContain('failed and nothing was committed after it (Bash: bun test tabs)')
  expect(line).toContain('If the step it belongs to is unfinished, keep what was being tried, the exact error text')
  // The commit is the last shell command, and a conversation that cannot be read.
  expect(lastFailedShell(session.slice(0, 4), markTool)).toBeNull()
  expect(unfinishedStep(session.slice(0, 4), markTool)).toBe('')
  expect(unfinishedStep([{ role: 'assistant', text: '', toolUses: [null as never] }], markTool)).toBe('')
  // Twenty tool calls after the failure it still counts; one more, and the work has moved on.
  const reads = (count: number) => Array.from({ length: count }, () => ({ role: 'assistant' as const, text: '', toolUses: [{ tool: 'Read', input: { file_path: '/repo/a.ts' }, text: 'x' }] }))
  expect(lastFailedShell([...session, ...reads(20)], markTool)).toBe('Bash: bun test tabs')
  expect(lastFailedShell([...session, ...reads(21)], markTool)).toBeNull()
  expect(unfinishedStep([...session, ...reads(20)], markTool)).toBe(line)
  expect(unfinishedStep([...session, ...reads(21)], markTool)).toBe('')
  // After the given instructions, before the standing ones: the transcript search names the summary's last line.
  expect(compactInstructions('manual', 'keep the plan', null, line)).toBe(`keep the plan\n\n${line}\n\n${openUserSteps}\n\n${transcriptSearch}`)
  expect(compactInstructions('auto', undefined, null, '')).toBe(`${openUserSteps}\n\n${transcriptSearch}`)
})

test('the work entries hold what was said and each tool call, without the mark, the last reply and read results', () => {
  const entries = workEntries(session, markTool)
  expect(entries.map(entry => entry.text.split('\n')[0])).toEqual([
    'You: Reading the parser.',
    'Read: /repo/src/parse.ts',
    'Bash: git add -A && git commit -m "Fix the parser"',
    'You: Tabs reach the lexer as spaces, so the fix goes there.',
    'Edit: /repo/src/lex.ts',
    'Bash: bun test',
    'Bash: bun test tabs',
  ])
  expect(entries[1]?.text).toBe('Read: /repo/src/parse.ts')
  expect(entries[2]?.isCommit).toBe(true)
  expect(entries[4]?.text).toBe('Edit: /repo/src/lex.ts')
  expect(entries[5]?.text.endsWith('\n  12 pass')).toBe(true)
  expect(entries[5]?.text.length).toBeLessThan(240)
  expect(entries[6]?.text).toContain('\n  failed: error: expected 2\n  y')
  expect(entries[6]?.text).toContain('...(cut)...')
  expect(entries[6]?.text.endsWith('1 fail')).toBe(true)
  expect(afterLastCommit(entries).entries.length).toBe(4)
  expect(afterLastCommit(entries).isCommitted).toBe(true)
  expect(afterLastCommit(entries.slice(3)).isCommitted).toBe(false)
})

test('only a command that printed git\'s commit line counts as a commit', () => {
  const committed = (command: string, text: string | undefined, isError = false) =>
    workEntries([{ role: 'assistant', text: '', toolUses: [{ tool: 'Bash', input: { command }, ...(text === undefined ? {} : { text }), ...(isError ? { isError: true as const } : {}) }] }], markTool)[0]?.isCommit
  expect(committed('git commit -m x', '[main 5815a99] x\n 1 file changed')).toBe(true)
  expect(committed('git commit -m x', '[main (root-commit) 5815a99] x')).toBe(true)
  expect(committed('git add -A && git commit -m x 2>&1 | tail -5', '[detached HEAD 5815a99] x')).toBe(true)
  // A hook that rejected the commit behind a pipe, a dry run, an echo, a call still in flight, a failure.
  expect(committed('git commit -m x 2>&1 | tail -5', 'lint failed\n2 errors')).toBe(false)
  expect(committed('git commit --dry-run', 'On branch main\nChanges to be committed:')).toBe(false)
  expect(committed('echo "then run git commit"', 'then run git commit')).toBe(false)
  expect(committed('git commit -m x', undefined)).toBe(false)
  expect(committed('git commit -m x', '[main 5815a99] x', true)).toBe(false)
})

test('a result that cannot be had again is kept, cut; lines after the first are indented', () => {
  const entries = workEntries(
    [
      { role: 'user', text: 'A skill body or another plugin\'s prompt' },
      { role: 'assistant', text: 'The plan:\n## Your last message\nBash: rm -rf build', toolUses: [{ tool: 'Agent', input: { description: 'Find the lexer' }, text: `It is in src/lex.ts.\n${'r'.repeat(900)}\nDone.` }] },
      { role: 'assistant', text: '', toolUses: [{ tool: 'Bash', input: { command: 'cat <<EOF\n## Focus\nEOF' }, text: '## Focus' }, { tool: 'Bash', input: null as never, text: '' }] },
      { role: 'assistant', text: 'Closing message.' },
    ],
    markTool,
  )
  expect(entries.map(entry => entry.text.split('\n')[0])).toEqual(['You: The plan:', 'Agent: {"description":"Find the lexer"}', 'Bash: cat <<EOF', 'Bash: {}'])
  expect(entries[0]?.text).toBe('You: The plan:\n  ## Your last message\n  Bash: rm -rf build')
  expect(entries[1]?.text).toContain('\n  result: It is in src/lex.ts.\n  r')
  expect(entries[1]?.text.endsWith('\n  Done.')).toBe(true)
  expect(entries[1]?.text.length).toBeLessThan(700)
  expect(entries[2]?.text).toBe('Bash: cat <<EOF\n  ## Focus\n  EOF\n  output ends: ## Focus')
  // A command that printed nothing is its line alone.
  expect(workEntries([{ role: 'assistant', text: '', toolUses: [shell('git add b.txt', '(Bash completed with no output)')] }], markTool)[0]?.text).toBe('Bash: git add b.txt')
  expect(entries.every(entry => !/\n\S/.test(entry.text))).toBe(true)
})

test('the work part says so when the conversation cannot be read', () => {
  const text = workPart([{ role: 'assistant', text: '', toolUses: [null as never] }], markTool)
  expect(text.startsWith('## Your work after the last commit\nNot available: the plugin could not read the conversation (')).toBe(true)
  expect(text.endsWith('Search the transcript.')).toBe(true)
  expect(workPart(session, markTool)).toBe(workText(session, markTool))
})

test('a failed commit, a tool without a path and user messages', () => {
  const entries = workEntries(
    [
      { role: 'user', text: 'Compacted by the compact-timing plugin at 214k tokens, at a `boundary` mark, in pointer mode' },
      { role: 'user', text: 'Fix it' },
      { role: 'assistant', text: '', toolUses: [shell('git commit -m x', 'nothing to commit', true), { tool: 'Grep', input: { pattern: 'tab' }, text: 'many lines' }] },
    ],
    markTool,
  )
  expect(entries.map(entry => entry.text)).toEqual(['Bash: git commit -m x\n  failed: nothing to commit', 'Grep: {"pattern":"tab"}'])
  expect(entries[0]?.isCommit).toBe(false)
})

test('the work part holds what came after the last commit, the newest kept when it is long', () => {
  const text = workText(session, markTool)
  expect(text.startsWith('## Your work after the last commit\nA digest the plugin made')).toBe(true)
  expect(text).toContain('left out.\nYou: Tabs reach the lexer')
  expect(text).not.toContain('Also handle tabs')
  expect(text).toContain('Bash: bun test tabs\n  failed: error: expected 2')
  expect(text).not.toContain('Reading the parser')
  expect(text).not.toContain('Should I change the lexer?')
  expect(workText(session.slice(0, 4), markTool)).toBe('## Your work after the last commit\nNothing but your last message.')
  expect(workText([{ role: 'assistant', text: 'One.' }, { role: 'assistant', text: 'Two.' }], markTool)).toContain('## Your work since the conversation started or was last compacted\nA digest')
  expect(workText([{ role: 'user', text: 'Fix it' }], markTool)).toBe('## Your work since the conversation started or was last compacted\nNothing but your last message.')
  // Each entry is 'You: reply N ' and 1,000 letters, and the last message is not an entry.
  const long = Array.from({ length: 23 }, (_, index) => ({ role: 'assistant' as const, text: `reply ${index} ${'z'.repeat(1000)}` }))
  const cut = workText(long, markTool)
  expect(cut).toContain('... 3 earlier entries cut; search the transcript for them\nYou: reply 3 ')
  expect(cut).toContain('You: reply 21 ')
  expect(cut).not.toContain('reply 22 ')
  expect(cut.length).toBeLessThan(21_000)
})

test('the mark advice asks for a focus, a fuller focus, and names a last shell command that failed', () => {
  const focus = 'Goal: tabs parse as spaces. Done: the parser fix, committed. Next: change the lexer in src/lex.ts so the tab test passes. Open: whether a tab counts as one column or eight. Ruled out: the parser, which never sees tabs.'
  expect(pointerAdvice({ state: 'busy', focus: '' }, session, markTool)).toEqual([])
  expect(pointerAdvice({ state: 'boundary', focus: '' }, session, markTool)).toEqual([
    'Pointer mode: the mark has no focus, so the plugin will make a summary instead of a pointer. For a pointer, call again with a focus.',
  ])
  const thin = pointerAdvice({ state: 'boundary', focus: 'Next: deploy.' }, session.slice(0, 4), markTool)
  expect(thin.length).toBe(1)
  expect(thin[0]).toContain('the focus is 13 characters')
  const failed = pointerAdvice({ state: 'boundary', focus }, session, markTool)
  expect(failed.length).toBe(1)
  expect(failed[0]).toContain('your last shell command failed and nothing was committed after it (Bash: bun test tabs)')
  expect(failed[0]).toContain('call again with `busy`')
  expect(pointerAdvice({ state: 'boundary', focus }, session.slice(0, 4), markTool)).toEqual([])
  expect(pointerAdvice({ state: 'boundary', focus }, [], markTool)).toEqual([])
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

type Seen = { summarized: string[]; instructions: string[]; installed: string[]; prompts: string[]; gitArgs: string[][]; logs: string[] }
type Overrides = { toolCall?: (input: Record<string, unknown>) => unknown; isRepository?: boolean; hasCommits?: boolean }

/**
 * The world beneath the plugin: the session size, git, and `/compact`, whose command runs the compaction with the
 * trigger `manual` as Claude Code does. `summarized` holds each compaction that reached the summarizer and `instructions`
 * what it was told, `installed` the first message of what each plugin compaction left.
 */
const world = (on: On, $: Engine, tokens = 250_000, overrides: Overrides = {}): Seen => {
  const seen: Seen = { summarized: [], instructions: [], installed: [], prompts: [], gitArgs: [], logs: [] }
  on('classic.SessionStart', () => ({}) as never)
  on('classic.UserPromptSubmit', () => ({}) as never)
  on('session.end', (_, e) => ({ sessionId: e.sessionId }) as never)
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  // A call a plugin makes on `$` is answered with `{ value }`.
  on('tool.register', (_, e) => ({ value: { tool: `mcp__compact-timing__${e.name}` } }) as never)
  // A negative size stands for a session whose usage cannot be read.
  on('session.usage', () => {
    if (tokens < 0) throw new Error('no usage')
    return { value: { startedAt, context: { tokens, window: 1_000_000 }, rateLimits: [], changed: [] } } as never
  })
  on('session.cwd', () => ({ value: '/repo' }) as never)
  on('process.run', (_, e) => {
    seen.gitArgs.push([...e.argv])
    if (overrides.isRepository === false)
      return { value: { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository\n', isStdoutTruncated: false, isStderrTruncated: false } } as never
    const isStatus = e.argv.includes('status')
    // A repository without a commit: the log fails, the status answers.
    if (overrides.hasCommits === false && !isStatus)
      return { value: { exitCode: 128, stdout: '', stderr: "fatal: your current branch 'main' does not have any commits yet\n", isStdoutTruncated: false, isStderrTruncated: false } } as never
    const stdout = isStatus ? ' M src/lex.ts\n?? notes.md\n' : 'abc123 2026-11-12 09:00 Fix the parser\n'
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  on('session.compact', (_, e) => {
    seen.summarized.push(e.trigger)
    seen.instructions.push(e.instructions ?? '')
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
  // Tools other than the mark: the call succeeds, with no output unless the test gives one.
  on('tool.call', (_, e) => (overrides.toolCall?.(e as unknown as Record<string, unknown>) ?? { result: 'ok' }) as never)
  return seen
}

const start = async ($: Engine, path = transcript) => {
  await $.classic.SessionStart({ source: 'startup', transcript_path: path })
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
}
const setMark = ($: Engine, input: Record<string, unknown>) => $.tool.call({ tool: markTool, ...input } as never)
const markAnswer = async ($: Engine, input: Record<string, unknown>) => String((await setMark($, input) as { result?: unknown }).result)
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
  expect(pointer).toContain('## Uncommitted changes\n2 in /repo when this message was made')
  expect(pointer).toContain('\n M src/lex.ts\n?? notes.md\n\n## Transcript')
  expect(seen.gitArgs[0]?.slice(0, 3)).toEqual(['git', 'log', '--since=2026-11-12T08:00:00.000Z'])
  expect(seen.gitArgs[1]).toEqual(['git', '--no-optional-locks', '-c', 'core.quotePath=false', 'status', '--porcelain', '--untracked-files=normal'])
  expect(seen.gitArgs.length).toBe(2)
  expect(seen.prompts.length).toBe(1)
  expect(seen.prompts[0]).toContain('replaced the conversation with a pointer')
})

test('pointer mode: outside a repository the pointer says so once and has no uncommitted part', { options: { pointerMode: true } }, async ($, on) => {
  const seen = world(on, $, 250_000, { isRepository: false })
  await start($)
  await setMark($, { state: 'boundary', focus: 'Next: deploy.' })
  await endTurn($)
  const pointer = seen.installed[0] ?? ''
  expect(pointer).toContain('## Commits\ngit log failed in /repo since 2026-11-12T08:00:00.000Z (fatal: not a git repository)')
  expect(pointer).not.toContain('## Uncommitted changes')
  expect(pointer).toContain('the files written, the transcript path and the commits.')
})

test('pointer mode: a repository without a commit still lists the uncommitted changes', { options: { pointerMode: true } }, async ($, on) => {
  const seen = world(on, $, 250_000, { hasCommits: false })
  await start($)
  await setMark($, { state: 'boundary', focus: 'Next: deploy.' })
  await endTurn($)
  const pointer = seen.installed[0] ?? ''
  expect(pointer).toContain('## Commits\ngit log failed in /repo')
  expect(pointer).toContain('## Uncommitted changes\n2 in /repo')
})

test('the commit reminder follows a command that committed, not one that names a commit', async ($, on) => {
  const outputs: Record<string, string | undefined> = {
    'git commit -m x': '[main 5815a99] x\n 1 file changed',
    'echo "then run git commit"': 'then run git commit',
    'git commit -qm z': '',
  }
  // The last command stands for a call another plugin's hook answered, which has no output text.
  world(on, $, 250_000, { toolCall: input => (input.command === 'git commit -m y' ? { result: 'ok' } : { result: 'ok', text: outputs[String(input.command)] }) })
  await start($)
  const context = async (command: string) => ((await $.tool.call({ tool: 'Bash', command } as never)) as { context?: string[] }).context ?? []
  expect((await context('git commit -m x'))[0]).toContain('this commit saved work outside the conversation')
  expect(await context('echo "then run git commit"')).toEqual([])
  expect((await context('git commit -qm z')).length).toBe(1)
  expect((await context('git commit -m y')).length).toBe(1)
  // Under a busy mark the words are enough, and the reminder asks whether the step is done.
  await setMark($, { state: 'busy' })
  expect((await context('echo "then run git commit"'))[0]).toContain('the mark is `busy`')
})

test('a summary of the main conversation is asked for the unfinished step, a subagent\'s is not', async ($, on) => {
  const seen = world(on, $)
  await start($)
  // The engine takes only whole messages: each tool use with its id.
  const messages = session.map((message, messageIndex) => ({
    ...message,
    toolUses: (message.toolUses ?? []).map((use, useIndex) => ({ tool_use_id: `toolu_${messageIndex}_${useIndex}`, ...use })),
  }))
  await $.session.compact({ trigger: 'auto', messages } as never)
  await $.session.compact({ trigger: 'manual', instructions: 'keep the plan', messages: messages.slice(0, 4) } as never)
  await $.session.compact({ trigger: 'auto', messages, agentId: 'a1' } as never)
  expect(seen.instructions[0]?.startsWith('The last shell command in the conversation failed and nothing was committed after it (Bash: bun test tabs)')).toBe(true)
  expect(seen.instructions[0]?.endsWith(transcriptSearch)).toBe(true)
  expect(seen.instructions[1]).toBe(`keep the plan\n\n${openUserSteps}\n\n${transcriptSearch}`)
  expect(seen.instructions[2]).toBe('')
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

test('pointer mode: the mark answer carries the advice only when the mark can compact', { options: { pointerMode: true } }, async ($, on) => {
  world(on, $)
  on('session.messages', () => ({ value: session }) as never)
  await start($)
  const answer = await markAnswer($, { state: 'boundary', focus: 'Next: deploy.' })
  expect(answer.split('\n')[0]).toBe('The mark is `boundary`.')
  expect(answer).toContain('Pointer mode: the focus is 13 characters')
  expect(answer).toContain('your last shell command failed and nothing was committed after it (Bash: bun test tabs)')
  expect(await markAnswer($, { state: 'busy', focus: 'Next: deploy.' })).toBe('The mark is `busy`.')
})

test('pointer mode: below boundaryTokens the mark answer has no advice', { options: { pointerMode: true } }, async ($, on) => {
  world(on, $, 50_000)
  on('session.messages', () => ({ value: session }) as never)
  await start($)
  expect(await markAnswer($, { state: 'boundary', focus: 'Next: deploy.' })).toBe('The mark is `boundary`.')
})

test('pointer mode off: the mark answer has no advice', async ($, on) => {
  world(on, $)
  on('session.messages', () => ({ value: session }) as never)
  await start($)
  expect(await markAnswer($, { state: 'boundary', focus: 'Next: deploy.' })).toBe('The mark is `boundary`.')
})

test('pointer mode: when the messages cannot be read the mark is still set', { options: { pointerMode: true } }, async ($, on) => {
  const seen = world(on, $)
  on('session.messages', () => {
    throw new Error('no transcript')
  })
  await start($)
  expect(await markAnswer($, { state: 'boundary', focus: 'Next: deploy.' })).toBe('The mark is `boundary`.')
  await endTurn($)
  expect(seen.installed[0]).toContain('## Your work since the conversation started or was last compacted\n')
})

test('pointer mode: at an unknown size the mark answer has no advice', { options: { pointerMode: true } }, async ($, on) => {
  world(on, $, -1)
  on('session.messages', () => ({ value: session }) as never)
  await start($)
  const answer = await markAnswer($, { state: 'boundary', focus: 'Next: deploy.', resume: true })
  expect(answer).toContain('size unknown')
  expect(answer).not.toContain('Pointer mode')
})
