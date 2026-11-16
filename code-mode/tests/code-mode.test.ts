import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { markArgsLine, markCallOf, markSkill, matchMarkCall, parseMarkArgs, scriptCommitLogged } from '../hooks/logic'

// The skill's text as the engine expands it: its body, the arguments in place of `$ARGUMENTS`.
const skillText = (args: string) =>
  `Base directory for this skill: /plugins/compact-timing-code-mode/skills/mark\n\nIf this text reaches you, the plugin did not answer.\n\n${markArgsLine}\n${args}\n`

// A line of `git reflog --date=unix --format=%gd%x09%gs`, made now unless a time is given.
const entry = (subject: string, time = Math.floor(Date.now() / 1000)) => `HEAD@{${time}}\t${subject}`

test('the skill arguments give the state on the first line and the focus below it', () => {
  expect(parseMarkArgs(skillText('boundary\nNext: deploy.\nOpen: the port.'))).toEqual({
    state: 'boundary',
    focus: 'Next: deploy.\nOpen: the port.',
    resume: false,
  })
  expect(parseMarkArgs(skillText('Boundary resume\nNext: the tests.'))).toEqual({ state: 'boundary', focus: 'Next: the tests.', resume: true })
  expect(parseMarkArgs(skillText('\n  busy\n'))).toEqual({ state: 'busy', focus: '', resume: false })
  // `resume` counts only with `boundary`, as with the tool.
  expect(parseMarkArgs(skillText('busy resume\nx'))?.resume).toBe(false)
  expect(parseMarkArgs(skillText('done\nanything'))).toBe(null)
  expect(parseMarkArgs(skillText(''))).toBe(null)
  expect(parseMarkArgs('no arguments line at all')).toBe(null)
})

test('a focus line that started with `!` gets it back from the escape the engine adds', () => {
  expect(parseMarkArgs(skillText('boundary\n\\! `make deploy` was not run\n$HOME and "quotes" stay'))?.focus).toBe('!`make deploy` was not run\n$HOME and "quotes" stay')
})

test('a call that may run the skill is recorded with whose it is, and matched by its arguments', () => {
  expect(markCallOf({ id: 'toolu_1', name: 'Skill', input: { skill: markSkill, args: 'busy\r\nx\n' } }, undefined)).toEqual({ args: 'busy\nx' })
  expect(markCallOf({ id: 'toolu_2', name: 'REPL', input: { code: `await tools.Skill({ skill: '${markSkill}', args })` } }, 'agent-1')).toEqual({ agentId: 'agent-1' })
  // JavaScript that does not name the skill, another skill, and the record of a call JavaScript already made: none.
  expect(markCallOf({ id: 'toolu_3', name: 'REPL', input: { code: 'await tools.Read({ file_path: "a" })' } }, 'agent-1')).toBe(null)
  expect(markCallOf({ id: 'toolu_4', name: 'Skill', input: { skill: 'other:mark', args: 'busy' } }, undefined)).toBe(null)
  expect(markCallOf({ id: 'repl_5', name: 'Skill', input: { skill: markSkill, args: 'busy' } }, undefined)).toBe(null)

  // A script that starts a subagent names the skill in the subagent's prompt, without calling it.
  expect(markCallOf({ id: 'toolu_6', name: 'REPL', input: { code: `await tools.Agent({ prompt: 'call ${markSkill}' })` } }, undefined)).toBe(null)

  const pending = [{}, { agentId: 'agent-1' }, { args: 'boundary\nmain' }, { agentId: 'agent-1', args: 'busy' }]
  expect(matchMarkCall(pending, 'boundary\nmain')).toBe(2)
  // The newest script: the main one that started a subagent runs until the subagent's script is done.
  expect(matchMarkCall(pending, 'boundary\nwritten in JavaScript')).toBe(1)
  expect(matchMarkCall([{ args: 'busy' }], 'boundary')).toBe(-1)
})

test("a script's commit is judged by the reflog only where it can tell", () => {
  const now = Date.now()
  const reflog = { exitCode: 0, stdout: `${entry('commit: Fix the parser', Math.floor(now / 1000))}\n` }
  expect(scriptCommitLogged(reflog, now - 1000, now + 1000, 'git commit -qm "Fix the parser"')).toBe(true)
  // Another commit of the same script, with nothing staged: the reflog's commit is not its subject.
  expect(scriptCommitLogged(reflog, now - 1000, now + 1000, 'git commit -qm "Second change"')).toBe(false)
  // No subject to compare (`-F`): any commit since the script started counts.
  expect(scriptCommitLogged(reflog, now - 1000, now + 1000, 'git commit -qF msg.txt')).toBe(true)
  // Another repository, or a folder that is not one: the words decide.
  expect(scriptCommitLogged(reflog, now - 1000, now + 1000, 'cd ~/other && git commit -qm "Fix the parser"')).toBe(null)
  expect(scriptCommitLogged({ exitCode: 128, stdout: '' }, now - 1000, now + 1000, 'git commit -qm x')).toBe(null)
  expect(matchMarkCall([], 'busy')).toBe(-1)
})

// `reflog`: HEAD's reflog, newest first, as `git reflog` prints it; a test adds to it when its command commits.
type Seen = { compacts: string[]; notes: string[]; prompts: string[]; reflog: string[] }

const world = (on: On, $: Engine, tokens: number): Seen => {
  const seen: Seen = { compacts: [], notes: [], prompts: [], reflog: [entry('commit (initial): Start', 1762934400)] }
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens, window: 1_000_000 }, rateLimits: [], changed: [] } }) as never)
  on('skill.prompt', (_, e) => ({ text: e.text }))
  on('session.append', (_, e, next) => {
    const input = e as unknown as { door?: string; message: { content: { text?: string }[] } }
    if (input.door === 'note' || input.door === undefined) seen.notes.push(input.message.content.map(block => block.text ?? '').join(''))
    return next(e)
  })
  on('session.compact', () => ({ messages: [{ role: 'user', text: 'the summary', toolUses: [] }] }) as never)
  on('command.run', async (_, e) => {
    if (e.command === 'compact') {
      seen.compacts.push(String(e.args))
      await $.session.compact({ trigger: 'manual', instructions: e.args, messages: [{ role: 'user', text: 'Fix the parser', toolUses: [] }] } as never)
    }
    return {} as never
  })
  on('prompt.submit', (_, e) => {
    seen.prompts.push(e.text)
    return { text: e.text } as never
  })
  on('session.cwd', () => ({ value: '/repo' }) as never)
  on('process.run', (_, e) => {
    const stdout = e.argv[1] === 'reflog' ? `${seen.reflog.join('\n')}\n` : e.argv[1] === 'worktree' ? 'worktree /repo\nHEAD 91c4c32\nbranch refs/heads/main\n\n' : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.log', () => ({ value: undefined }) as never)
  return seen
}

/**
 * `claude plugin test` at the repo root also runs this file, against the root plugin. These tests need the Code Mode
 * plugin's hooks, so they return at once there: the skill text comes back unanswered when this plugin isn't loaded.
 * `cd code-mode && claude plugin test .` runs them for real.
 */
const isCodeModeLoaded = async ($: Engine) =>
  (await $.skill.prompt({ skill: markSkill, text: skillText('not a state') } as never)).text !== skillText('not a state')

const endTurn = ($: Engine) => $.turn.complete({ reason: 'answer', answer: 'Done.', durationMs: 1, isAborted: false, turnId: 't1' })

/** A model row with tool calls, as the engine appends it; `agentId` for a subagent's. */
const callRow = ($: Engine, uses: { id: string; name: string; input: Record<string, unknown> }[], agentId?: string) =>
  $.session.append({
    door: 'response',
    origin: { kind: 'model', model: 'claude' },
    uuid: `row-${uses[0]?.id}`,
    ...(agentId ? { agentId } : {}),
    message: { type: 'assistant', content: uses.map(use => ({ type: 'tool_use', ...use })) },
  } as never)

/** A tool result row, and the content the model reads from it. */
const resultRow = async ($: Engine, id: string, text: string, tool = 'Bash') => {
  const stored = (await $.session.append({
    door: 'tool-result',
    origin: { kind: 'tool', tool },
    uuid: `result-${id}`,
    message: { type: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
  } as never)) as { message?: { content: { content?: unknown }[] } }
  return JSON.stringify(stored.message?.content[0]?.content)
}

const callSkill = async ($: Engine, args: string, agentId?: string) => {
  await callRow($, [{ id: `skill-${args.length}`, name: 'Skill', input: { skill: markSkill, args } }], agentId)
  return (await $.skill.prompt({ skill: markSkill, text: skillText(args) } as never)).text
}

test('the skill sets a boundary that compacts at the end of the turn', async ($, on) => {
  const seen = world(on, $, 250_000)
  if (!(await isCodeModeLoaded($))) return
  expect(await callSkill($, 'boundary\nNext: deploy.')).toBe('The mark is `boundary`.')
  await endTurn($)
  expect(seen.compacts).toHaveLength(1)
  expect(seen.compacts[0]).toContain('at a `boundary` mark')
  expect(seen.compacts[0]).toContain('Next: deploy.')
})

test('with resume, the plugin compacts and sends the focus back as a prompt', async ($, on) => {
  const seen = world(on, $, 250_000)
  if (!(await isCodeModeLoaded($))) return
  expect(await callSkill($, 'boundary resume\nNext: step 3.')).toContain('End your turn now')
  await endTurn($)
  expect(seen.prompts.some(prompt => prompt.includes('Next: step 3.'))).toBe(true)
})

test('a busy mark holds the compaction off at any size', async ($, on) => {
  const seen = world(on, $, 400_000)
  if (!(await isCodeModeLoaded($))) return
  await callSkill($, 'busy\nReading the failing test output.')
  await endTurn($)
  expect(seen.compacts).toEqual([])
})

test("a subagent's call sets no mark", async ($, on) => {
  const seen = world(on, $, 250_000)
  if (!(await isCodeModeLoaded($))) return
  expect(await callSkill($, 'boundary\nfrom a subagent', 'agent-1')).toBe('Only the main conversation sets the compaction mark.')
  await endTurn($)
  // No mark below softTokens: nothing compacts.
  expect(seen.compacts).toEqual([])
})

test("a subagent's JavaScript in between does not make the main call a subagent's, nor the other way round", async ($, on) => {
  const seen = world(on, $, 250_000)
  if (!(await isCodeModeLoaded($))) return
  // The main model calls the skill while a background subagent runs Code Mode steps.
  await callRow($, [{ id: 'toolu_10', name: 'Skill', input: { skill: markSkill, args: 'boundary\nNext: deploy.' } }])
  await callRow($, [{ id: 'toolu_11', name: 'REPL', input: { code: 'await tools.Read({ file_path: "a" })' } }], 'agent-1')
  expect((await $.skill.prompt({ skill: markSkill, text: skillText('boundary\nNext: deploy.') } as never)).text).toBe('The mark is `boundary`.')
  // The subagent's JavaScript calls the skill while the main model runs a step of its own.
  await callRow($, [{ id: 'toolu_12', name: 'REPL', input: { code: `await tools.Skill({ skill: '${markSkill}', args: 'busy' })` } }], 'agent-1')
  await callRow($, [{ id: 'toolu_13', name: 'REPL', input: { code: 'await tools.Bash({ command: "ls" })' } }])
  expect((await $.skill.prompt({ skill: markSkill, text: skillText('busy') } as never)).text).toBe('Only the main conversation sets the compaction mark.')
  // As seen live: the main script starts a subagent whose prompt names the skill, and the subagent's script calls it.
  await callRow($, [{ id: 'toolu_14', name: 'REPL', input: { code: `await tools.Agent({ prompt: 'Call ${markSkill} with busy.' })` } }])
  await callRow($, [{ id: 'toolu_15', name: 'REPL', input: { code: `await tools.Skill({ skill: '${markSkill}', args: 'busy' })` } }], 'agent-2')
  expect((await $.skill.prompt({ skill: markSkill, text: skillText('busy') } as never)).text).toBe('Only the main conversation sets the compaction mark.')
  await endTurn($)
  expect(seen.compacts).toHaveLength(1)
})

test('arguments without a state set no mark', async ($, on) => {
  world(on, $, 250_000)
  if (!(await isCodeModeLoaded($))) return
  expect(await callSkill($, 'done\nanything')).toContain('The mark was not set')
})

test("a direct commit call gets the reminder in its own result, naming the skill", async ($, on) => {
  const seen = world(on, $, 250_000)
  if (!(await isCodeModeLoaded($))) return
  await callRow($, [{ id: 'toolu_1', name: 'Bash', input: { command: 'git commit -qm "Fix the parser"' } }])
  const content = await resultRow($, 'toolu_1', '')
  expect(content).toContain('this commit saved work outside the conversation')
  // The empty output is left out: the API refuses an empty text block.
  expect(content).not.toContain('"text":""')
  expect(content).toContain(markSkill)
  // The skill takes lines, not the tool's fields.
  expect(content).toContain('put `resume` after `boundary` on the first line')
  expect(content).not.toContain('`resume` true')
  expect(seen.notes).toEqual([])
})

test("a commit the model's JavaScript made gets the reminder in a row of its own, when HEAD's reflog shows it", async ($, on) => {
  const seen = world(on, $, 250_000)
  if (!(await isCodeModeLoaded($))) return
  // The script runs, commits, and only then are its calls recorded, with no output.
  await callRow($, [{ id: 'toolu_20', name: 'REPL', input: { code: 'await tools.Bash({ command: "git commit -qm fix" })' } }])
  seen.reflog.unshift(entry('commit: Fix the parser'))
  await callRow($, [{ id: 'repl_1', name: 'Bash', input: { command: 'git add -A && git commit -qm "Fix the parser"' } }])
  const content = await resultRow($, 'repl_1', '')
  expect(content).not.toContain('this commit saved work')
  expect(seen.notes).toHaveLength(1)
  expect(seen.notes[0]).toContain('this commit saved work outside the conversation')
})

test("a script's commit command that committed nothing gets no reminder", async ($, on) => {
  const seen = world(on, $, 250_000)
  if (!(await isCodeModeLoaded($))) return
  // "nothing to commit": the reflog has no entry since the script started.
  await callRow($, [{ id: 'toolu_21', name: 'REPL', input: { code: 'await tools.Bash({ command: "git commit -qm fix" })' } }])
  await callRow($, [{ id: 'repl_2', name: 'Bash', input: { command: 'git commit -qm "Fix the parser"' } }])
  await resultRow($, 'repl_2', '')
  expect(seen.notes).toEqual([])
})

test('below boundaryTokens a commit gets no reminder', async ($, on) => {
  const seen = world(on, $, 100_000)
  if (!(await isCodeModeLoaded($))) return
  await callRow($, [{ id: 'toolu_2', name: 'Bash', input: { command: 'git commit -qm x' } }])
  expect(await resultRow($, 'toolu_2', '')).not.toContain('this commit saved work')
  expect(seen.notes).toEqual([])
})

test('a command that only names a commit gets no reminder', async ($, on) => {
  const seen = world(on, $, 250_000)
  if (!(await isCodeModeLoaded($))) return
  await callRow($, [{ id: 'toolu_5', name: 'Bash', input: { command: 'echo "next: git commit -m fix"' } }])
  expect(await resultRow($, 'toolu_5', 'next: git commit -m fix')).not.toContain('this commit saved work')
  expect(seen.notes).toEqual([])
})

test('the size nudge comes once, on the first result at softTokens', async ($, on) => {
  world(on, $, 320_000)
  if (!(await isCodeModeLoaded($))) return
  await callRow($, [{ id: 'toolu_3', name: 'Read', input: { file_path: '/repo/a.ts' } }])
  expect(await resultRow($, 'toolu_3', 'text', 'Read')).toContain('the plugin can compact only between turns')
  await callRow($, [{ id: 'toolu_4', name: 'Read', input: { file_path: '/repo/b.ts' } }])
  expect(await resultRow($, 'toolu_4', 'text', 'Read')).not.toContain('the plugin can compact only between turns')
})
