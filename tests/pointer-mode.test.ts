import { expect, mock, test } from 'claude-code/testing'
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
  isCommitLogged,
  isQuietCommit,
  isRemindableCommit,
  lastFailedShell,
  lastReply,
  markSchema,
  mayNamePath,
  namedWorktrees,
  openUserSteps,
  parseMark,
  pointerAdvice,
  pointerText,
  reflogArguments,
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
  worktreeListArguments,
  worktreePaths,
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

test('without the reflog, only a command that printed git\'s commit line counts as a commit', () => {
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
  // A quiet commit prints no such line.
  expect(committed('git commit -qm x && git log --oneline -1', '5815a99 x')).toBe(false)
})

test('a call whose commit the reflog showed counts when its command holds a commit and it did not fail', () => {
  const use = (id: string, command: string, isError = false) => ({ tool_use_id: id, ...shell(command, '(Bash completed with no output)', isError) })
  const entries = workEntries(
    [
      {
        role: 'assistant',
        text: '',
        toolUses: [
          use('toolu_quiet', 'git commit -qm x'),
          use('toolu_other', 'git commit -qm y'),
          use('toolu_failed', 'git commit -qm z && bun test', true),
          use('toolu_build', 'make build'),
        ],
      },
    ],
    markTool,
    ['toolu_quiet', 'toolu_failed', 'toolu_build'],
  )
  expect(entries.map(entry => entry.isCommit)).toEqual([true, false, false, false])
  // Without the list, or with a use that has no id, the output decides as before.
  expect(workEntries([{ role: 'assistant', text: '', toolUses: [use('toolu_quiet', 'git commit -qm x')] }], markTool)[0]?.isCommit).toBe(false)
  expect(workEntries([{ role: 'assistant', text: '', toolUses: [shell('git commit -qm x', '')] }], markTool, ['toolu_quiet'])[0]?.isCommit).toBe(false)
})

// A line of `git reflog --date=unix --format=%gd%x09%gs`, made now unless a time is given.
const entry = (subject: string, time = Math.floor(Date.now() / 1000)) => `HEAD@{${time}}\t${subject}`

test('HEAD\'s reflog shows a commit made during the call, and only a commit', () => {
  const callStart = 1762934400_500
  const callEnd = 1762934402_500
  const logged = (entries: string[], exitCode = 0) => isCommitLogged({ exitCode, stdout: `${entries.join('\n')}\n` }, callStart, callEnd)
  expect(reflogArguments).toEqual(['reflog', '-n', '20', '--no-show-signature', '--date=unix', '--format=%gd%x09%gs'])
  expect(logged([entry('commit: Fix the parser', 1762934401)])).toBe(true)
  for (const kind of ['amend', 'initial', 'merge', 'cherry-pick', 'rebase']) expect(logged([entry(`commit (${kind}): Fix the parser`, 1762934401)])).toBe(true)
  // Git keeps whole seconds, so a commit in the second the call started or ended counts.
  expect(logged([entry('commit: Fix the parser', 1762934400)])).toBe(true)
  expect(logged([entry('commit: Fix the parser', 1762934402)])).toBe(true)
  // A commit followed by a checkout in the same command.
  expect(logged([entry('checkout: moving from fix to main', 1762934401), entry('commit: Fix the parser', 1762934401)])).toBe(true)
  // A commit before the call, one dated after it (a date set ahead, a clock running fast), and what other commands write.
  expect(logged([entry('commit: Fix the parser', 1762934399)])).toBe(false)
  expect(logged([entry('commit: Fix the parser', 1762934403)])).toBe(false)
  expect(logged([entry('commit: Fix the parser', 1893456000)])).toBe(false)
  const others = ['rebase (pick): Fix', 'cherry-pick: Fix', 'pull: Fast-forward', 'reset: moving to HEAD~1', 'checkout: moving from commit: to main', "merge fix: Merge made by the 'ort' strategy."]
  expect(logged(others.map(subject => entry(subject, 1762934401)))).toBe(false)
  // A failed read, no answer, no reflog.
  expect(logged([entry('commit: Fix the parser', 1762934401)], 128)).toBe(false)
  expect(isCommitLogged({ error: 'timed out' }, callStart, callEnd)).toBe(false)
  expect(logged([])).toBe(false)
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

const isReflogRead = (args: readonly string[]) => args[1] === 'reflog'

// `gitFolders` holds the folder of each git run in `gitArgs`, undefined for the session folder.
type Seen = { summarized: string[]; instructions: string[]; installed: string[]; prompts: string[]; gitArgs: string[][]; gitFolders: (string | undefined)[]; logs: string[] }
type Overrides = {
  toolCall?: (input: Record<string, unknown>) => unknown
  isRepository?: boolean
  hasCommits?: boolean
  // HEAD's reflog, newest first, as `git reflog` prints it; the function throws for a git that does not answer. `cwd` is
  // the folder of the read, undefined for the session folder.
  reflog?: (cwd?: string) => readonly string[]
  // The paths `git worktree list` prints, the session folder's own first.
  worktrees?: readonly string[]
  // The conversation the plugin's compaction replaces.
  messages?: unknown[]
}

/**
 * The world beneath the plugin: the session size, git, and `/compact`, whose command runs the compaction with the
 * trigger `manual` as Claude Code does. `summarized` holds each compaction that reached the summarizer and `instructions`
 * what it was told, `installed` the first message of what each plugin compaction left.
 */
const world = (on: On, $: Engine, tokens = 250_000, overrides: Overrides = {}): Seen => {
  const seen: Seen = { summarized: [], instructions: [], installed: [], prompts: [], gitArgs: [], gitFolders: [], logs: [] }
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
    seen.gitFolders.push(e.init?.cwd)
    if (overrides.isRepository === false)
      return { value: { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository\n', isStdoutTruncated: false, isStderrTruncated: false } } as never
    const isStatus = e.argv.includes('status')
    // A repository without a commit: the log fails, the status answers.
    if (overrides.hasCommits === false && !isStatus)
      return { value: { exitCode: 128, stdout: '', stderr: "fatal: your current branch 'main' does not have any commits yet\n", isStdoutTruncated: false, isStderrTruncated: false } } as never
    const reflog = () => `${(overrides.reflog?.(e.init?.cwd) ?? [entry('commit (initial): Start', 1762934400)]).join('\n')}\n`
    const worktrees = () => (overrides.worktrees ?? ['/repo']).map(path => `worktree ${path}\nHEAD 91c4c32\nbranch refs/heads/main\n\n`).join('')
    const stdout = isStatus
      ? ' M src/lex.ts\n?? notes.md\n'
      : isReflogRead(e.argv)
        ? reflog()
        : e.argv[1] === 'worktree'
          ? worktrees()
          : 'abc123 2026-11-12 09:00 Fix the parser\n'
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
        messages: overrides.messages ?? [
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
  const seen = world(on, $, 250_000, { toolCall: input => (input.command === 'git commit -m y' ? { result: 'ok' } : { result: 'ok', text: outputs[String(input.command)] }) })
  await start($)
  const context = async (command: string) => ((await $.tool.call({ tool: 'Bash', command } as never)) as { context?: string[] }).context ?? []
  expect((await context('git commit -m x'))[0]).toContain('this commit saved work outside the conversation')
  expect(await context('echo "then run git commit"')).toEqual([])
  expect((await context('git commit -qm z')).length).toBe(1)
  expect((await context('git commit -m y')).length).toBe(1)
  // Under a busy mark the words are enough, and the reminder asks whether the step is done.
  await setMark($, { state: 'busy' })
  expect((await context('echo "then run git commit"'))[0]).toContain('the mark is `busy`')
  // Without pointer mode the reflog is not read.
  expect(seen.gitArgs).toEqual([])
})

test('at the soft limit, only a commit reminder that names resume takes the place of the size nudge', async ($, on) => {
  world(on, $, 310_000)
  await start($)
  const context = async (command: string) => ((await $.tool.call({ tool: 'Bash', command } as never)) as { context?: string[] }).context ?? []
  // The busy reminder asks only whether the step is done, so the nudge comes with it, once.
  await setMark($, { state: 'busy' })
  const first = await context('git commit -qm one')
  expect(first.length).toBe(2)
  expect(first[0]).toContain('the mark is `busy`')
  expect(first[1]).toContain('holds 310k tokens')
  expect((await context('git commit -qm two')).length).toBe(1)
  expect(await context('ls')).toEqual([])
})

test('at the soft limit, a commit reminder without a busy mark uses up the size nudge', async ($, on) => {
  world(on, $, 310_000)
  await start($)
  const context = async (command: string) => ((await $.tool.call({ tool: 'Bash', command } as never)) as { context?: string[] }).context ?? []
  const first = await context('git commit -qm one')
  expect(first.length).toBe(1)
  expect(first[0]).toContain('add `resume` true')
  expect(await context('ls')).toEqual([])
})

/**
 * A session in pointer mode whose commands write to HEAD's reflog what `commits` gives them, oldest first. What a call
 * wrote is dated now while it runs and in the past once the next call starts, as for calls some seconds apart.
 * `compact` replaces the conversation with the given messages, which `use` builds with the ids the calls were given.
 */
const reflogWorld = (
  on: On,
  $: Engine,
  overrides: {
    commits: Record<string, string[]>
    answer?: () => boolean
    result?: (command: string) => unknown
    worktrees?: readonly string[]
    // The worktree a command commits in, when not the session folder's.
    commitFolder?: (command: string) => string | undefined
  },
) => {
  const older = [entry('commit (initial): Start', 1762934400)]
  let latest: string[] = []
  const ids: Record<string, string> = {}
  const messages: unknown[] = []
  // The folder whose reflog the last call wrote to: undefined for the session folder's.
  let latestFolder: string | undefined
  const seen = world(on, $, 250_000, {
    reflog: cwd => {
      if (overrides.answer?.() === false) throw new Error('timed out')
      return [...(cwd === latestFolder ? latest.map(subject => entry(subject)) : []), ...older]
    },
    worktrees: overrides.worktrees,
    messages,
    toolCall: input => {
      const command = String(input.command)
      ids[command] = String(input.tool_use_id)
      older.unshift(...latest.map(subject => entry(subject, 1762934400)))
      latest = [...(overrides.commits[command] ?? [])].reverse()
      latestFolder = overrides.commitFolder?.(command)
      return overrides.result?.(command) ?? { result: 'ok', text: '' }
    },
  })
  const run = (command: string, extra: Record<string, unknown> = {}) => $.tool.call({ tool: 'Bash', command, ...extra } as never)
  const use = (command: string, text = '', isError = false) => ({ tool_use_id: ids[command], ...shell(command, text, isError) })
  const compact = async (...conversation: unknown[]) => {
    messages.push(...conversation)
    await setMark($, { state: 'boundary', focus: 'Next: the lexer.' })
    await endTurn($)
    return seen.installed[0] ?? ''
  }
  return { seen, run, use, compact }
}

test('pointer mode: a quiet commit in HEAD\'s reflog starts the digest after it, one a hook rejected does not', { options: { pointerMode: true } }, async ($, on) => {
  const quiet = 'git commit -qm "Fix the parser" && git checkout -q main'
  const rejected = 'git commit -q -m "Fix the lexer"; git log --oneline -1'
  const session = reflogWorld(on, $, { commits: { [quiet]: ['commit: Fix the parser', 'checkout: moving from fix to main'] } })
  await start($)
  await session.run(quiet)
  await session.run('bun test')
  await session.run(rejected)
  // One read after each commit command, none for the test run.
  expect(session.seen.gitArgs.filter(isReflogRead)).toEqual([
    ['git', ...reflogArguments],
    ['git', ...reflogArguments],
  ])
  const pointer = await session.compact(
    { role: 'user', text: 'Fix the parser', toolUses: [] },
    { role: 'assistant', text: 'Fixing the parser.', toolUses: [session.use(quiet, '(Bash completed with no output)')] },
    { role: 'assistant', text: 'Now the lexer.', toolUses: [session.use('bun test', '1 fail')] },
    { role: 'assistant', text: 'Committing the lexer.', toolUses: [session.use(rejected, 'lint failed\nbbbbbbb Fix the parser')] },
    { role: 'assistant', text: 'The lexer commit was rejected.', toolUses: [] },
  )
  expect(pointer).toContain('## Your work after the last commit\nA digest the plugin made')
  expect(pointer).not.toContain('Fixing the parser.')
  expect(pointer).toContain('You: Now the lexer.')
  expect(pointer).toContain('lint failed')
})

test('pointer mode: the reflog finds no commit for a rebase, no answer, a failed, denied or background call, or a subagent', { options: { pointerMode: true } }, async ($, on) => {
  let isAnswering = true
  const commands = {
    rebase: 'git commit -qm x; git pull --rebase',
    slow: 'git commit -qm slow',
    failed: 'git commit -qm x && bun test',
    denied: 'git commit -qm denied',
    background: 'git commit -qm background',
  }
  const session = reflogWorld(on, $, {
    commits: {
      [commands.rebase]: ['pull --rebase (start): checkout origin/main', 'rebase (pick): Fix', 'rebase (finish): returning to refs/heads/main'],
      [commands.slow]: ['commit: slow'],
      [commands.failed]: ['commit: x'],
      [commands.denied]: ['commit: denied'],
      [commands.background]: ['commit: background'],
      'git commit -qm subagent': ['commit: subagent'],
    },
    answer: () => isAnswering,
    result: command => (command === commands.failed ? { result: 'x', text: '1 fail', isError: true } : command === commands.denied ? { deny: 'not allowed' } : undefined),
  })
  await start($)
  await session.run(commands.rebase)
  isAnswering = false
  await session.run(commands.slow)
  isAnswering = true
  expect(session.seen.gitArgs.filter(isReflogRead).length).toBe(2)
  // Not read after a failed call, a denied one, one run in the background, or a subagent's.
  await session.run(commands.failed)
  await session.run(commands.denied)
  await session.run(commands.background, { run_in_background: true })
  await session.run('git commit -qm subagent', { agentId: 'a1' })
  expect(session.seen.gitArgs.filter(isReflogRead).length).toBe(2)
  const pointer = await session.compact(
    { role: 'assistant', text: 'Committing.', toolUses: Object.values(commands).map(command => session.use(command, '', command === commands.failed)) },
    { role: 'assistant', text: 'Done.', toolUses: [] },
  )
  expect(pointer).toContain('## Your work since the conversation started or was last compacted\n')
  expect(pointer).toContain('You: Committing.')
})

test('the worktrees a command names are the ones read for its commit', () => {
  expect(worktreeListArguments).toEqual(['worktree', 'list', '--porcelain'])
  const porcelain = [
    'worktree /repo\nHEAD 91c4c32\nbranch refs/heads/main\n',
    'worktree /repo/.claude/worktrees/fix\nHEAD 91c4c32\nbranch refs/heads/fix\n',
    'worktree "/odd\\npath"\nHEAD 91c4c32\ndetached\n',
    'worktree /home/ada/repo-worktrees/lexer\nHEAD 91c4c32\nbranch refs/heads/lexer\n',
  ].join('\n')
  const paths = worktreePaths(porcelain)
  expect(paths).toEqual(['/repo', '/repo/.claude/worktrees/fix', '/home/ada/repo-worktrees/lexer'])
  const named = (command: string, cwd = '/repo') => namedWorktrees(command, paths, cwd, '/home/ada')
  // By full path, after `cd` or with `git -C`, quoted, or with a folder in it.
  expect(named('cd /repo/.claude/worktrees/fix && git commit -qm x')).toEqual(['/repo/.claude/worktrees/fix'])
  expect(named('git -C "/repo/.claude/worktrees/fix" commit -qm x')).toEqual(['/repo/.claude/worktrees/fix'])
  expect(named("cd '/repo/.claude/worktrees/fix/src'; git commit -qm x")).toEqual(['/repo/.claude/worktrees/fix'])
  // Under the home folder with `~` or `$HOME`.
  expect(named('cd ~/repo-worktrees/lexer && git commit -qm x')).toEqual(['/home/ada/repo-worktrees/lexer'])
  expect(named('cd $HOME/repo-worktrees/lexer && git commit -qm x')).toEqual(['/home/ada/repo-worktrees/lexer'])
  // The session folder's own worktree is not read again, also from a folder in it, and the main worktree is not named
  // by the path of one inside it.
  expect(named('cd /repo && git commit -qm x')).toEqual([])
  expect(named('cd /repo/.claude/worktrees/fix && git commit -qm x', '/repo/.claude/worktrees/fix/src')).toEqual([])
  expect(named('cd /repo && git commit -qm x', '/repo/.claude/worktrees/fix')).toEqual(['/repo'])
  // A path that only starts the same, a relative path, a bare name or no path names none.
  expect(named('cd /repo/.claude/worktrees/fix-2 && git commit -qm x')).toEqual([])
  expect(named('cd /home/ada/repo-worktrees/lexer2 && git commit -qm x')).toEqual([])
  expect(named('cd ../repo-worktrees/lexer && git commit -qm x')).toEqual([])
  expect(named('cd lexer && git commit -qm "Fix the lexer"')).toEqual([])
  expect(named('git commit -qm x')).toEqual([])
  // Two worktrees named, each once, in the order the command names them.
  expect(named('git -C ~/repo-worktrees/lexer commit -qm x && git -C /repo/.claude/worktrees/fix commit -qm y && cd /repo/.claude/worktrees/fix')).toEqual([
    '/home/ada/repo-worktrees/lexer',
    '/repo/.claude/worktrees/fix',
  ])
  expect(named('cd /repo/.claude/worktrees/fix && git commit -qm y; cd ~/repo-worktrees/lexer && git commit -qm x')).toEqual([
    '/repo/.claude/worktrees/fix',
    '/home/ada/repo-worktrees/lexer',
  ])
  // Whatever the command does there: which of them holds this command's commit is for the commit's subject to say.
  expect(named('git commit -qm x; cat /home/ada/repo-worktrees/lexer/notes.md')).toEqual(['/home/ada/repo-worktrees/lexer'])
  // The worktrees are listed only for a command that could name a path.
  expect(mayNamePath('git commit -qm "Fix the parser" || true')).toBe(false)
  expect(['cd /repo && git commit -qm x', 'cd ~ && git commit -qm x', 'cd $HOME/fix && git commit -qm x', 'cd C:\\repo && git commit -qm x'].every(mayNamePath)).toBe(true)
  // On Windows: backslashes, either case of the drive, and the Git Bash and WSL spellings.
  const windows = ['C:/Users/ada/repo', 'C:/Users/ada/repo-wt/fix']
  const windowsNamed = (command: string) => namedWorktrees(command, windows, 'C:\\Users\\ada\\repo', 'C:\\Users\\ada')
  expect(windowsNamed('cd C:\\Users\\ada\\repo-wt\\fix; git commit -qm x')).toEqual(['C:/Users/ada/repo-wt/fix'])
  expect(windowsNamed('cd c:/users/ada/repo-wt/fix && git commit -qm x')).toEqual(['C:/Users/ada/repo-wt/fix'])
  expect(windowsNamed('cd /c/Users/ada/repo-wt/fix && git commit -qm x')).toEqual(['C:/Users/ada/repo-wt/fix'])
  expect(windowsNamed('wsl -e bash -c "cd /mnt/c/Users/ada/repo-wt/fix && git commit -qm x"')).toEqual(['C:/Users/ada/repo-wt/fix'])
  expect(windowsNamed('cd ~/repo-wt/fix && git commit -qm x')).toEqual(['C:/Users/ada/repo-wt/fix'])
  expect(windowsNamed('cd C:\\Users\\ada\\repo && git commit -qm x')).toEqual([])
  // Doubled backslashes, as an escaped path has them.
  expect(windowsNamed('git -C "C:\\\\Users\\\\ada\\\\repo-wt\\\\fix" commit -qm x')).toEqual(['C:/Users/ada/repo-wt/fix'])
  // At most four are read, the first the command names.
  const many = Array.from({ length: 6 }, (_, index) => `/wt/w${index}`)
  const command = [...many].reverse().map(path => `git -C ${path} commit -qm x`).join('; ')
  expect(namedWorktrees(command, ['/repo', ...many], '/repo', undefined)).toEqual(['/wt/w5', '/wt/w4', '/wt/w3', '/wt/w2'])
})

test('a commit in another worktree is this command\'s only when its subject is in the command', () => {
  const now = Math.floor(Date.now() / 1000)
  const reflog = (subject: string) => ({ exitCode: 0, stdout: `HEAD@{${now}}\t${subject}\n` })
  const logged = (subject: string, command: string) => isCommitLogged(reflog(subject), now * 1000, now * 1000 + 500, command)
  expect(logged('commit: Fix the parser', 'cd /wt && git commit -qm "Fix the parser"')).toBe(true)
  // Word for word, whatever the quoting, the case or an amend.
  expect(logged('commit: Fix the "parser"', `bash -c "cd /wt && git commit -qm 'Fix the \\"parser\\"'"`)).toBe(true)
  expect(logged('commit (amend): fix the parser', 'git -C /wt commit -q --amend -m "Fix the parser"')).toBe(true)
  expect(logged('commit: Fix the parser', 'cd /wt && git commit -qF - <<EOF\nFix the parser\n\nWhy.\nEOF')).toBe(true)
  // Another subject, a part of a word, a message from a file, or an empty subject is not.
  expect(logged('commit: Other session work', 'git commit -qm "Fix the parser"; cat /wt/notes.md')).toBe(false)
  expect(logged('commit: Fix', 'cd /wt && git commit -qm "Fixes"')).toBe(false)
  expect(logged('commit: Fix the parser', 'cd /wt && git commit -qF msg.txt')).toBe(false)
  expect(logged('commit: ...', 'cd /wt && git commit -qm ...')).toBe(false)
  // Without a command, as for the session folder, the subject does not matter.
  expect(isCommitLogged(reflog('commit: Other session work'), now * 1000, now * 1000 + 500)).toBe(true)
})

test('pointer mode: a quiet commit in another worktree the command names counts, one in a worktree it only reads in does not', { options: { pointerMode: true } }, async ($, on) => {
  mock.env(on, { HOME: '/home/ada' })
  const named = 'cd ~/repo-worktrees/fix && git commit -qm "Fix the parser"'
  // A commit a hook rejected, while another session commits in a worktree the command reads a file of.
  const readOnly = 'git commit -qm "Fix the lexer"; cat ~/repo-worktrees/other/notes.md'
  const noPath = 'git commit -qm "Fix the docs"'
  const session = reflogWorld(on, $, {
    commits: { [named]: ['commit: Fix the parser'], [readOnly]: ['commit: Other session work'], [noPath]: ['commit: Fix the docs'] },
    worktrees: ['/repo', '/home/ada/repo-worktrees/fix', '/home/ada/repo-worktrees/other'],
    commitFolder: command => (command === named ? '/home/ada/repo-worktrees/fix' : '/home/ada/repo-worktrees/other'),
  })
  await start($)
  await session.run(named)
  await session.run(readOnly)
  await session.run(noPath)
  const reads = session.seen.gitArgs.filter(args => isReflogRead(args) || args[1] === 'worktree')
  // For each of the first two: the session folder, the list, then only the worktree the command names. The third names
  // no path, so the worktrees are not listed.
  expect(reads).toEqual([
    ['git', ...reflogArguments],
    ['git', ...worktreeListArguments],
    ['git', ...reflogArguments],
    ['git', ...reflogArguments],
    ['git', ...worktreeListArguments],
    ['git', ...reflogArguments],
    ['git', ...reflogArguments],
  ])
  const readFolders = session.seen.gitFolders.filter((_, index) => isReflogRead(session.seen.gitArgs[index] ?? []))
  expect(readFolders).toEqual([undefined, '/home/ada/repo-worktrees/fix', undefined, '/home/ada/repo-worktrees/other', undefined])
  const pointer = await session.compact(
    { role: 'assistant', text: 'Fixing the parser.', toolUses: [session.use(named)] },
    { role: 'assistant', text: 'Fixing the lexer.', toolUses: [session.use(readOnly)] },
    { role: 'assistant', text: 'Lexer done.', toolUses: [] },
  )
  expect(pointer).toContain('## Your work after the last commit\n')
  expect(pointer).not.toContain('Fixing the parser.')
  expect(pointer).toContain('You: Fixing the lexer.')
})

test('pointer mode: a /clear empties the record of commits', { options: { pointerMode: true } }, async ($, on) => {
  const before = 'git commit -qm before'
  const after = 'git commit -qm after'
  const session = reflogWorld(on, $, { commits: { [before]: ['commit: before'], [after]: ['commit: after'] } })
  await start($)
  await session.run(before)
  await $.session.end({ reason: 'clear', sessionId: 's1' } as never)
  await session.run(after)
  // The commit after the /clear counts; the one before it no longer does, so the digest starts after the first.
  const pointer = await session.compact(
    { role: 'assistant', text: 'Committing.', toolUses: [session.use(after), session.use(before)] },
    { role: 'assistant', text: 'Done.', toolUses: [] },
  )
  expect(pointer).toContain(`## Your work after the last commit\nA digest the plugin made, oldest first: what you said, each tool call, the end of a shell output, the text of a failure and the start and end of other results. Results of file reads, searches and edits are left out.\nBash: ${before}`)
})

test('pointer mode: the record of commits keeps the newest 200', { options: { pointerMode: true } }, async ($, on) => {
  const commands = Array.from({ length: 201 }, (_, index) => `git commit -qm c${index}`)
  const session = reflogWorld(on, $, { commits: Object.fromEntries(commands.map(command => [command, [`commit: ${command}`]])) })
  await start($)
  for (const command of commands) await session.run(command)
  // The 200th newest still counts and the first fell out, so the digest starts after the 200th newest and holds the
  // first. With a smaller record neither would count; with no limit the digest would start after the first.
  const pointer = await session.compact(
    { role: 'assistant', text: 'Committing.', toolUses: [session.use(commands[1] ?? ''), session.use(commands[0] ?? '')] },
    { role: 'assistant', text: 'Done.', toolUses: [] },
  )
  expect(pointer).toContain('## Your work after the last commit\n')
  expect(pointer).toContain(`Bash: ${commands[0]}`)
})

test('pointer mode: the reminder follows a commit whose own output was sent away when the reflog shows it', { options: { pointerMode: true } }, async ($, on) => {
  const session = reflogWorld(on, $, {
    commits: { 'git commit -m x >/dev/null && git log -1': ['commit: x'] },
    result: () => ({ result: 'ok', text: 'commit 5815a99\nAuthor: Ada\n\n    x' }),
  })
  await start($)
  const context = async (command: string) => ((await session.run(command)) as { context?: string[] }).context ?? []
  expect((await context('git commit -m x >/dev/null && git log -1'))[0]).toContain('this commit saved work outside the conversation')
  expect(await context('git commit -m y >/dev/null && git log -1')).toEqual([])
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
