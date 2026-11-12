import { atom, read, update } from 'claude-code'
import type { PluginState, ProcessRunInit, ProcessRunResult, Register, SessionCompactResult, SessionMessage, ToolUseSummary } from 'claude-code'

// The stored shapes are declared once, in types/index.d.ts.
type State = PluginState['compact-timing']

// `userSteps` is set only in pointer mode, where no summarizer lists the user's open steps.
export type Mark = { state: 'busy' | 'boundary'; focus: string; resume?: boolean; userSteps?: string }

// The last mark the model set in this session. Values are held per session, so sessions do not see
// each other's marks.
const mark = atom({ plugin: 'compact-timing', key: 'mark' } as const, null as Mark | null)
// Whether this period already had the context note; cleared once the context falls below boundaryTokens.
const noted = atom({ plugin: 'compact-timing', key: 'noted' } as const, false)
// Whether this period already had the size nudge inside a turn; cleared by a compaction.
const nudged = atom({ plugin: 'compact-timing', key: 'nudged' } as const, false)
// Automatic resumes since the user's last request, so a model that always sets `resume` cannot run unattended for long.
const resumes = atom({ plugin: 'compact-timing', key: 'resumes' } as const, 0)
const maxResumes = 10
// The plugin's own `/compact` while it runs: `pending` until the compaction hook sees it, then its outcome. Its trigger
// is `manual`, the same as a typed `/compact`, and the command's result says nothing about a skip.
// `isPointer` when pointer mode answered in place of the summarizer.
export type OwnCompact = State['ownCompact']
const ownCompact = atom({ plugin: 'compact-timing', key: 'ownCompact' } as const, null as OwnCompact)
// Pointer mode: what replaces the conversation at a `boundary` mark, stored before the plugin's `/compact` runs, since
// the mark is dropped at the end of the turn, before the compaction hook runs.
export type PointerParts = NonNullable<State['pointer']>
const pointer = atom({ plugin: 'compact-timing', key: 'pointer' } as const, null as PointerParts | null)
// Only classic hook events carry the transcript path; pointer mode records it from SessionStart and UserPromptSubmit.
const transcriptPath = atom({ plugin: 'compact-timing', key: 'transcriptPath' } as const, '')
// Pointer mode: the user's requests and the files written, which the focus may paraphrase or leave out. Recorded as the
// session runs, because the plugin cannot read a long transcript (`$.fs.read` stops at 4 MiB). A `/clear` starts it over.
export type SessionRecord = State['sessionRecord']
export const emptyRecord: SessionRecord = { requests: [], omittedRequests: 0, files: [], omittedFiles: 0 }
const sessionRecord = atom({ plugin: 'compact-timing', key: 'sessionRecord' } as const, emptyRecord)
// Pointer mode: the ids of the main agent's shell calls that made a commit by HEAD's reflog (`isCommitLogged`), newest
// last, so the work digest finds a quiet commit. A `/clear` starts it over.
const commitCalls = atom({ plugin: 'compact-timing', key: 'commitCalls' } as const, [] as string[])
const maxCommitCalls = 200
// The reflog read runs after the call, before its result goes back to the model.
const reflogTimeout = 3000

/** The tool input as the model sends it, or null when the state is not one of the two. */
export const parseMark = (input: { state?: unknown; focus?: unknown; resume?: unknown; userSteps?: unknown }): Mark | null => {
  const state = typeof input.state === 'string' ? input.state.trim().toLowerCase() : ''
  if (state !== 'busy' && state !== 'boundary') return null
  const userSteps = state === 'boundary' && typeof input.userSteps === 'string' ? input.userSteps.trim() : ''
  return {
    state,
    focus: typeof input.focus === 'string' ? input.focus.trim() : '',
    resume: state === 'boundary' && input.resume === true,
    ...(userSteps ? { userSteps } : {}),
  }
}

export type Limits = { boundaryTokens: number; softTokens: number }

/**
 * Whether to compact at the end of a turn. A boundary allows it from `boundaryTokens`, no mark from
 * `softTokens`, and a busy mark never: autoCompactWindow stays the hard limit for a stale busy mark.
 */
export const shouldCompact = (current: Mark | null, tokens: number | undefined, limits: Limits): boolean => {
  if (tokens === undefined || current?.state === 'busy') return false
  return tokens >= (current?.state === 'boundary' ? limits.boundaryTokens : limits.softTokens)
}

const thousands = (tokens: number) => `${Math.round(tokens / 1000)}k`

const pointerFocus =
  'what the next context must keep. At a `boundary` the plugin replaces the conversation with your focus, the requests the user typed, verbatim, `userSteps`, a digest of your work after the last commit (your messages, the tool calls, what failed), your last message, the files written, the uncommitted changes, the transcript path and the commits since the session started; no summary is made. Write it as a handoff: the goal, what is done, the next step, open decisions, what you ruled out and why, file paths. Without a focus the plugin makes a summary instead.'
const pointerUserSteps =
  'with `boundary`: every step, command or question you gave the user that they have not yet reported done or answered: commands exactly, the rest briefly, with what each one is for. Steps in the message that ends the turn need not be listed: the pointer keeps that message.'

/** The tool description: what the model reads about the marks. Pointer mode changes the focus and adds `userSteps`. */
export const ruleText = (limits: Limits, isPointerMode = false) =>
  [
    'Sets the compaction mark for this conversation. The compact-timing plugin compacts at task boundaries instead of at a fixed token count.',
    `- \`boundary\`: call after a task or milestone whose state is saved outside the conversation (committed, or in a plan or notes file). The plugin compacts at the end of that turn when the context contains ${thousands(limits.boundaryTokens)} tokens or more. Either way the mark is dropped when the turn ends.`,
    '- `busy`: call before a step whose details exist only in the conversation, such as a debugging sequence or reading test output. The plugin does not compact while the mark is `busy`. Call with `boundary` when the step is done.',
    isPointerMode ? `- \`focus\`: ${pointerFocus}` : '- `focus`: what the summary must keep: the next step, open decisions, file paths.',
    ...(isPointerMode ? [`- \`userSteps\`: ${pointerUserSteps}`] : []),
    '- `resume`: set it with `boundary` when steps of the current request remain. Then end the turn: the plugin compacts and sends the focus back as a prompt, so the work continues. The plugin can compact only between turns, so a long turn otherwise keeps growing.',
    `Without a mark the plugin compacts at ${thousands(limits.softTokens)} tokens. Any compaction clears the mark.`,
  ].join('\n')

/**
 * The tool's input schema; `userSteps` only in pointer mode. Each description says in one line what to write. How the
 * plugin uses it is in the tool description, which the model reads in the same request, so it is not repeated here.
 */
export const markSchema = (isPointerMode = false) => ({
  type: 'object',
  properties: {
    state: { type: 'string', enum: ['boundary', 'busy'] },
    focus: {
      type: 'string',
      description: isPointerMode
        ? 'With `boundary`, the handoff that replaces the conversation: the goal, what is done, the next step, open decisions, what you ruled out and why, file paths. With `busy`, what a summary must keep.'
        : 'What the summary must keep: the next step, open decisions, file paths.',
    },
    ...(isPointerMode
      ? { userSteps: { type: 'string', description: 'With `boundary`: each step, command or question you gave the user that is still open, commands exactly.' } }
      : {}),
    resume: { type: 'boolean', description: 'With `boundary`: steps of the current request remain, so compact and continue.' },
  },
  required: ['state'],
})

/** The mark tool's answer: with `resume` it says whether to end the turn now, since that depends on the size. */
export const markResult = (current: Mark, tokens: number | undefined, limits: Limits): string => {
  if (!current.resume) return `The mark is \`${current.state}\`.`
  if (tokens !== undefined && tokens >= limits.boundaryTokens)
    return 'The mark is `boundary`. End your turn now with a one-line status and no question: the plugin compacts and then sends the focus back as a prompt, so you continue from it.'
  return `The mark is \`boundary\`, but the context (${tokens === undefined ? 'size unknown' : thousands(tokens)}) is below ${thousands(limits.boundaryTokens)}, so nothing compacts: continue the work in this turn.`
}

/**
 * The mark as stored: `resume` only when the context is large enough to compact now. Otherwise the answer says to
 * continue, and a resume left armed would send a "continue" prompt after the request is already done.
 */
export const armedMark = (current: Mark, tokens: number | undefined, limits: Limits): Mark =>
  current.resume && (tokens === undefined || tokens < limits.boundaryTokens) ? { ...current, resume: false } : current

/** Once per period inside a turn: a long turn is where the plugin falls behind, since it compacts only between turns. */
export const sizeNudge = (tokens: number, toolName: string) =>
  `compact-timing: the context holds ${thousands(tokens)} tokens, and the plugin can compact only between turns. At the next point where the work is saved (a commit, a plan or notes file), call ${toolName} with \`boundary\`, \`resume\` true and a focus listing the remaining steps, then end the turn.`

/**
 * Whether a tool result inside a turn gets the size nudge: from `softTokens`, once, and not when a resume is armed.
 * A boundary without `resume` still gets it, since the turn may keep growing after an early commit.
 */
export const shouldNudge = (current: Mark | null, tokens: number | undefined, isNudged: boolean, limits: Limits): boolean =>
  !isNudged && current?.resume !== true && tokens !== undefined && tokens >= limits.softTokens

/**
 * The prompt sent after a compaction the model asked to resume from. The model may have kept working after it set the
 * mark, so the summary, being newer, decides which steps are done.
 */
export const resumePrompt = (focus: string, isPointer = false) =>
  isPointer
    ? [
        'compact-timing: an automatic prompt from a plugin, not written by the user. The plugin replaced the conversation with a pointer at the `boundary` mark you set with `resume`.',
        "Continue the user's request from the focus in the pointer.",
        'You may have worked on after you set the mark: before repeating a step, commit, push or deploy, check your last message in the pointer, the commits and `git status`.',
      ].join('\n')
    : [
        'compact-timing: an automatic prompt from a plugin, not written by the user. The plugin compacted the conversation at the `boundary` mark you set with `resume`.',
        `Continue the user's request from where you stopped${focus ? `: ${focus}` : '.'}`,
        'The summary is newer than this focus: skip any step it shows done, and check before repeating a commit, push or deploy.',
      ].join('\n')

/** The first summary line, so the user and the model can tell a plugin compaction from a typed /compact: both are recorded as `manual`. */
export const summaryLabel = (current: Mark | null, tokens: number) =>
  `Start the summary with this line: "Compacted by the compact-timing plugin at ${thousands(tokens)} tokens, ${current?.state === 'boundary' ? 'at a `boundary` mark' : 'at the soft limit with no mark'}."`

/**
 * The arguments of the plugin's `/compact`: the label and the focus. The compaction hook adds the standing
 * instructions to every compaction, this one too.
 */
export const pluginCompactArgs = (current: Mark | null, tokens: number) =>
  [summaryLabel(current, tokens), current?.focus ?? ''].filter(Boolean).join('\n\n')

/** Why the plugin's own `/compact` did not stand, or null when it did. */
export const ownCompactFailure = (outcome: OwnCompact): string | null => {
  if (outcome === null || outcome === 'pending') return 'the compaction did not run'
  return outcome.skip === null ? null : `compaction skipped (${outcome.skip})`
}

const commitCommand = String.raw`\bgit(?:\s+(?:-[Cc]\s+(?:"[^"]*"|'[^']*'|\S+)|--?[\w-]+(?:=\S+)?))*\s+commit(?![\w-])`
const commitPattern = new RegExp(commitCommand)
// After `commit`, on its line or one continued with a backslash: any arguments (a quoted one is skipped whole, so a
// `-q` inside a message does not count), then `--quiet` or a group of short options with a `q` (`-q`, `-aq`, `-qm`),
// before the next `;`, `&` or `|`. The letters before the `q` leave out the options that take the rest of the word as
// their value (`-m`, `-F`, `-C`, `-c`, `-t`), so `-mquickfix` is a message.
const gap = String.raw`(?:[ \t]|\\\r?\n)+`
const quietCommitPattern = new RegExp(
  String.raw`${commitCommand}(?:${gap}(?:"(?:[^"\\]|\\[\s\S])*"|'[^']*'|[^\s;&|"'])+)*?${gap}(?:--quiet|-[abd-ln-su-zABDEG-Z]*q[A-Za-z]*)(?=[\s;&|)"'\\]|$)`,
)

/** A `git commit`, also after global options such as `-C <dir>`, `-c <key=value>` or `--no-pager`. */
export const isCommit = (command: string) => commitPattern.test(command)

/**
 * A `git commit` told to print nothing. In a command that goes on to print other things (a test run, a `git log`), the
 * output then neither shows git's commit line nor is empty. Words in quotes that hold the option, as in
 * `echo "run git commit -q"`, read the same as `bash -lc "git commit -q"` and count too.
 */
export const isQuietCommit = (command: string) => quietCommitPattern.test(command)

/**
 * The line git prints for a commit it made: `[main 5815a99] Fix the parser`. A command that only names a commit (an
 * echo, a dry run) or hides its failure behind a pipe prints none, and neither does a quiet one (`-q`), which pointer
 * mode finds in HEAD's reflog (`isCommitLogged`).
 */
const committedLine = /^\[[^\]\n]+ [0-9a-f]{7,40}\] /m

/**
 * The newest entries of HEAD's reflog in the session's folder, each the time in seconds and what moved HEAD:
 * `HEAD@{1762934400}<tab>commit: Fix the parser`. A worktree has its own. `--no-show-signature`: a `log.showSignature`
 * setting would print a signature check above each entry.
 */
export const reflogArguments = ['reflog', '-n', '20', '--no-show-signature', '--date=unix', '--format=%gd%x09%gs']
const reflogEntry = /^\S+@\{(\d+)\}\t(.*)$/
// What `git commit` writes, in English whatever the language: `commit:`, or `commit (<kind>):` for an amend, a first
// commit, or one that ends a merge, a cherry-pick or a rebase. A rebase, a cherry-pick, a pull, a checkout or a reset
// writes its own name.
const commitEntry = /^commit(?: \([a-z-]+\))?: /

/**
 * Whether HEAD's reflog has a commit made between `startedAt` and `endedAt`: how a quiet commit, which prints nothing
 * that says so, is found, and a commit a hook rejected is not. A commit followed by a checkout in the same command
 * still counts. Git keeps whole seconds, so a commit made earlier in the second the call started counts too. An entry
 * dated after the read (a commit date set ahead, a clock running fast) is not from this call. A failed read concludes
 * nothing. With `command`, the commit's subject must also be one the command gives (`commitSubjects`).
 */
export const isCommitLogged = (
  run: { exitCode: number; stdout: string } | { error: string },
  startedAt: number,
  endedAt: number,
  command?: string,
): boolean => {
  if ('error' in run || run.exitCode !== 0) return false
  const since = Math.floor(startedAt / 1000)
  const until = Math.floor(endedAt / 1000)
  const given = command === undefined ? undefined : new Set(commitSubjects(command).map(words))
  return run.stdout.split('\n').some(line => {
    const entry = reflogEntry.exec(line.trimEnd())
    const time = Number(entry?.[1])
    const subject = entry?.[2]
    if (subject === undefined || time < since || time > until || !commitEntry.test(subject)) return false
    if (given === undefined) return true
    const logged = words(subject.replace(commitEntry, ''))
    return logged !== '' && given.has(logged)
  })
}

// Letters and digits only, each run of anything else one space, so quoting, escaping and case do not count.
const words = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

// What git logs as the subject: the first line that is not blank, trimmed.
const firstLine = (text: string) => text.split(/\r?\n/).map(line => line.trim()).find(line => line !== '') ?? ''

const commitGlobal = new RegExp(commitCommand, 'g')
// The first message after `-m` or `--message` (with `=`, a space, or a quote right after it): in double quotes (with
// `\"` or PowerShell's `""` inside), in escaped double quotes inside a `bash -c "..."`, a PowerShell here-string, ANSI-C
// quotes, single quotes (with PowerShell's `''` inside), or one word.
const messageOption =
  /(?:^|\s)(?:-[a-zA-Z]*m|--message)(?:=|\s+|(?=["'$@\\]))(?:"((?:[^"\\]|\\.|"")*)"|\\+"([\s\S]*?)\\+"|@["']\r?\n([\s\S]*?)\r?\n\s*["']@|\$'((?:[^'\\]|\\.)*)'|'((?:[^']|'')*)'|([^\s;&|)]+))/
// A message read from standard input, which a heredoc then gives: `-F -`, `-F-`, `--file=-`, `--file -`.
const messageFromInput = /(?:^|\s)(?:-[a-zA-Z]*F\s*-|--file(?:=|\s+)-)(?=\s|$)/
const heredocStart = /(?<!<)<<-?(?!<)\s*\\?["']?\w+/

/** The first line that is not blank in the heredoc that `text` opens first, or '' without one. */
const heredocSubject = (text: string) => {
  const start = text.search(heredocStart)
  const bodyStart = start === -1 ? -1 : text.indexOf('\n', start)
  return bodyStart === -1 ? '' : firstLine(text.slice(bodyStart + 1))
}

/**
 * The subjects of the messages a command gives its commits, one for each `git commit` with one: what the subject of a
 * commit it made in another worktree is compared with, word for word, so a commit another session made there at the
 * same moment, with its own subject, is not taken for this command's. The message is the first `-m` after the commit,
 * or a heredoc after `-F -`; a `-m "$(cat <<'EOF' ...)"` gives the heredoc's. Not given are a message from a file
 * (`-F msg.txt`), `--amend --no-edit`, `-C <commit>`, `--fixup`, a `<<<` string, and a bash `'\''` inside quotes;
 * a message with a shell variable or `$(...)` in its first line never matches what git logged.
 */
export const commitSubjects = (command: string): string[] => {
  const commits = [...command.matchAll(commitGlobal)]
  const subjects = commits.map((commit, index) => {
    const after = command.slice((commit.index ?? 0) + commit[0].length, commits[index + 1]?.index ?? command.length)
    const option = messageOption.exec(after)
    if (option) {
      const [, doubled, escaped, hereString, ansi, single, word] = option
      if (ansi !== undefined) return firstLine(ansi.replace(/\\n/g, '\n'))
      const message = doubled ?? escaped ?? hereString ?? single ?? word ?? ''
      return heredocStart.test(firstLine(message)) ? heredocSubject(message) : firstLine(message)
    }
    const input = messageFromInput.exec(after)
    return input ? heredocSubject(after.slice(input.index)) : ''
  })
  return subjects.filter(subject => subject !== '')
}

/** The worktrees of the session folder's repository, one `worktree <path>` line each, the session folder's own too. */
export const worktreeListArguments = ['worktree', 'list', '--porcelain']

/** The paths in `git worktree list --porcelain`. A path git had to quote (it holds a newline or a quote) is left out. */
export const worktreePaths = (stdout: string): string[] =>
  stdout
    .split('\n')
    .filter(line => line.startsWith('worktree ') && !line.startsWith('worktree "'))
    .map(line => line.slice('worktree '.length).trimEnd())
    .filter(path => path !== '')

// The most worktrees whose reflog one command reads, each with the reflog's time limit.
const maxWorktreeReads = 4
const drivePath = /^([A-Za-z]):\/(.*)$/
const withSlashes = (path: string) => path.replace(/\\/g, '/').replace(/(?<=.)\/+$/, '')
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// A Windows path compares without case, so `c:/Users` is `C:/Users`.
const isInside = (path: string, folder: string) => {
  const [inner, outer] = drivePath.test(folder) ? [path.toLowerCase(), folder.toLowerCase()] : [path, folder]
  return inner === outer || inner.startsWith(outer.endsWith('/') ? outer : `${outer}/`)
}

/**
 * How a shell command can spell a folder: its full path, on Windows also as Git Bash and WSL write it (`/c/Users/...`,
 * `/mnt/c/Users/...`), and under the home folder with `~` or `$HOME`. A path relative to the session folder (`../fix`)
 * is not one of them: it was 3 of about 600 commit commands that moved to another folder in my transcripts.
 */
const pathSpellings = (path: string, home: string | undefined): string[] => {
  const spellings = [path]
  const drive = drivePath.exec(path)
  if (drive) spellings.push(`/${drive[1]?.toLowerCase()}/${drive[2]}`, `/mnt/${drive[1]?.toLowerCase()}/${drive[2]}`)
  // A home folder as Git Bash or WSL writes it (`/c/Users/ada`), where git writes the worktree's path `C:/...`.
  const homeFolder = (home ? withSlashes(home) : '').replace(/^\/(?:mnt\/|cygdrive\/)?([a-zA-Z])(?=\/|$)/, (spelled, letter: string) =>
    drive ? `${letter.toUpperCase()}:` : spelled,
  )
  if (homeFolder !== '' && homeFolder !== '/' && path.length > homeFolder.length && isInside(path, homeFolder)) {
    const rest = path.slice(homeFolder.length + 1)
    spellings.push(`~/${rest}`, `$HOME/${rest}`, `\${HOME}/${rest}`)
  }
  return spellings
}

/** Whether a command could name a folder as `namedWorktrees` reads it: without one, the worktrees are not listed. */
export const mayNamePath = (command: string) => /[/\\~]|\$\{?HOME\b/.test(command)

/**
 * The worktrees, other than the one that holds the session folder, whose path `command` names: where a commit made
 * after a `cd` or a `git -C` into another worktree is looked for, since each worktree has its own HEAD reflog. A
 * worktree the command does not name is never read. A path counts where it stands alone or is followed by a folder in
 * it (`/repo/src`), whatever the command does with it; the longest paths are matched first, so a worktree inside
 * another (`/repo/.claude/worktrees/fix`) does not also name `/repo`. They come in the order the command names them.
 */
export const namedWorktrees = (command: string, paths: readonly string[], cwd: string, home: string | undefined): string[] => {
  const folders = [...new Set(paths.map(withSlashes))].sort((first, second) => second.length - first.length)
  const sessionFolder = withSlashes(cwd)
  const own = folders.find(folder => sessionFolder !== '' && isInside(sessionFolder, folder))
  // Doubled backslashes, as an escaped Windows path has them, are one separator.
  let rest = command.replace(/\\+/g, '/')
  const firstNamed = new Map<string, number>()
  for (const folder of folders) {
    for (const spelling of pathSpellings(folder, home)) {
      const pattern = new RegExp(`(^|[\\s'"=(;&|\`])${escapeRegExp(spelling)}(?=$|[\\s'"/;&|)\`])`, drivePath.test(folder) ? 'gi' : 'g')
      // Replaced by as many characters, so the places of later matches stay where they were.
      rest = rest.replace(pattern, (_, before: string, offset: number) => {
        if (folder !== own) firstNamed.set(folder, Math.min(firstNamed.get(folder) ?? offset, offset))
        return `${before}${'\u0000'.repeat(spelling.length)}`
      })
    }
  }
  return [...firstNamed.entries()]
    .sort((first, second) => first[1] - second[1])
    .map(([folder]) => folder)
    .slice(0, maxWorktreeReads)
}

// The lines that follow it, which are what is left when a pipe keeps only the end: ` 2 files changed, 3 insertions(+)`
// and ` create mode 100644 a.ts`. A diff or a pull prints them too, so they count only for the reminder, where the
// command also holds a `git commit` and a wrong guess costs one note.
const commitSummaryLine = /^ \d+ files? changed\b|^ (?:create|delete) mode \d{6} /m

// What the model reads for a shell command that printed nothing: `(Bash completed with no output)`.
const noOutput = /^\(\w+ completed with no output\)$/

/** A result with no output: a command that ran with `-q` or sent its output away. */
const isSilent = (text: string) => text.trim() === '' || noOutput.test(text.trim())

// On Windows the model commits through either shell.
const shellTools = ['Bash', 'PowerShell']

/** A shell tool call whose command holds a `git commit`. */
export const isCommitCall = (tool: string, input: Record<string, unknown>): boolean =>
  shellTools.includes(tool) && typeof input.command === 'string' && isCommit(input.command)

/**
 * Whether a shell call that did not fail counts as a commit for the reminder: its command holds a `git commit`, and its
 * output has a line git prints for a commit. The words alone are not enough: a command that passes them on in a
 * prompt, a commit message or an `echo` commits nothing. Four cases go by the command, as all did before 0.12.0:
 * - a quiet commit (`-q`), which prints no such line whatever else the command prints;
 * - no output at all (a commit with its output sent away), since nothing says it did not commit;
 * - no `text`, which is another hook's answer and carries no output;
 * - a `busy` mark: the reminder then only asks whether the step is done, and it is what gets a stale mark replaced.
 */
export const isRemindableCommit = (tool: string, input: Record<string, unknown>, text: string | undefined, current: Mark | null): boolean =>
  isCommitCall(tool, input) &&
  (current?.state === 'busy' ||
    text === undefined ||
    committedLine.test(text) ||
    commitSummaryLine.test(text) ||
    isSilent(text) ||
    isQuietCommit(String(input.command)))

/**
 * Read right after a commit's result. The tool description alone is often missed, so the reminder
 * comes at the moment a boundary is most likely.
 */
export const commitReminder = (toolName: string, current: Mark | null) =>
  current?.state === 'busy'
    ? `compact-timing: the mark is \`busy\`. If the step whose details exist only in the conversation is done, call ${toolName} with \`boundary\` and a focus: the next step and open decisions.`
    : [
        `compact-timing: this commit saved work outside the conversation. If a task or milestone is done, call ${toolName} with \`boundary\` and a focus: the next step and open decisions. If steps of the current request remain, add \`resume\` true and end the turn.`,
        'If the work continues and its details exist only in the conversation, call it with `busy` instead.',
      ].join(' ')

/**
 * Whether a commit gets the reminder: when a boundary mark can compact at this size, or when a busy
 * mark is set, since the reminder is what makes the model replace it.
 */
export const shouldRemind = (current: Mark | null, tokens: number | undefined, limits: Limits): boolean =>
  current?.state === 'busy' || (tokens !== undefined && tokens >= limits.boundaryTokens)

/**
 * At the end of a main turn: the mark the next turn starts with, and whether to compact now. A boundary
 * counts only at the end of the turn that set it, also when the turn was interrupted, since an interrupt
 * often means the boundary no longer holds. An interrupted turn never compacts.
 */
export const turnEnd = (
  current: Mark | null,
  tokens: number | undefined,
  isAborted: boolean,
  limits: Limits,
): { next: Mark | null; compact: boolean; resume: boolean } => {
  const compact = !isAborted && shouldCompact(current, tokens, limits)
  return { next: current?.state === 'boundary' ? null : current, compact, resume: compact && current?.resume === true }
}

/**
 * Steps handed to the user are not the model's own pending tasks, and a summary once dropped a test the model had
 * asked the user to run. Commands stay exact and the rest stays short, so the list does not grow with each compaction.
 */
export const openUserSteps =
  'Keep every step, command or question the assistant gave the user that the user has not yet reported done or answered: commands exactly, the rest briefly, with what each one is for.'

/**
 * Claude Code appends the transcript path to the summary and says to read it, but a transcript holds one long JSON
 * record per line, so reading it whole refills the context the compaction freed. `command` skips a shell function
 * named grep (such as one calling ugrep, which rejects this window as too complex).
 */
export const transcriptSearchHow =
  "search the full transcript with command grep -oE '.{0,200}<term>.{0,200}' rather than reading it whole: each line is one long JSON record."
export const transcriptSearch = `End the summary with this line: "For exact details the summary dropped (error text, paths, numbers), ${transcriptSearchHow}"`

const maxCommitLines = 40
const maxLastReply = 3000
const firstRequests = 3
const lastRequests = 5
const maxRequestLength = 2000
const maxFiles = 40
const fileWritingTools: Record<string, string> = { Write: 'file_path', Edit: 'file_path', NotebookEdit: 'notebook_path' }

/** A request as the pointer keeps it: one kind of line break, at most maxRequestLength characters; null when empty. */
export const userRequest = (prompt: string): string | null => {
  const text = prompt.replace(/\r\n?/g, '\n').trim()
  if (!text) return null
  return text.length > maxRequestLength ? `${text.slice(0, maxRequestLength)} ...(cut here; the rest is in the transcript)` : text
}

/** Adds a request: the first few and the newest few are kept, the ones between only counted. */
export const addRequest = (record: SessionRecord, request: string): SessionRecord => {
  const requests = [...record.requests, request]
  if (requests.length <= firstRequests + lastRequests) return { ...record, requests }
  requests.splice(firstRequests, 1)
  return { ...record, requests, omittedRequests: record.omittedRequests + 1 }
}

/** Adds a written file once; past the limit, further writes to other files are only counted. */
export const addFile = (record: SessionRecord, path: string): SessionRecord => {
  if (record.files.includes(path)) return record
  if (record.files.length >= maxFiles) return { ...record, omittedFiles: record.omittedFiles + 1 }
  return { ...record, files: [...record.files, path] }
}

/** The path a file-writing tool call wrote, or null for any other tool. */
export const writtenPath = (tool: string, input: Record<string, unknown>): string | null => {
  const field = fileWritingTools[tool]
  const path = field === undefined ? undefined : input[field]
  return typeof path === 'string' && path.trim() !== '' ? path.trim() : null
}

/** The requests part of the pointer, oldest first, with a count where some were left out. */
export const requestsText = (record: SessionRecord): string => {
  if (record.requests.length === 0) return 'None recorded.'
  const lines = record.requests.map(request => `- ${request.replace(/\n/g, '\n  ')}`)
  if (record.omittedRequests > 0)
    lines.splice(firstRequests, 0, `- ... ${record.omittedRequests} more between these; search the transcript for them`)
  return lines.join('\n')
}

/** The files part of the pointer, in the order first written. */
export const filesText = (record: SessionRecord): string => {
  if (record.files.length === 0) return 'None recorded.'
  const more = record.omittedFiles > 0 ? [`... and ${record.omittedFiles} more writes to files not listed`] : []
  return [...record.files, ...more].join('\n')
}

// Said in both parts when the record could not be read, so a failure does not read as an empty session.
const unreadRecord = 'Not available: the plugin could not read its record. Search the transcript.'

/** The `git log` part of the pointer: the commits, none, or why git gave none. Never throws, so a failed git keeps the pointer. */
export const commitsText = (
  run: { exitCode: number; stdout: string; stderr: string } | { error: string },
  directory: string,
  since: string,
): string => {
  const where = `in ${directory} since ${since}`
  if ('error' in run) return `git log failed ${where} (${run.error}). If the work is in a repository elsewhere, run git log there.`
  if (run.exitCode !== 0) {
    const reason = run.stderr.trim().split('\n')[0] || `exit code ${run.exitCode}`
    return `git log failed ${where} (${reason}). If the work is in a repository elsewhere, run git log there.`
  }
  const lines = run.stdout.split('\n').filter(line => line.trim() !== '')
  if (lines.length === 0) return `None ${where}.`
  const shown = lines.slice(0, maxCommitLines)
  const more = lines.length > shown.length ? [`... and ${lines.length - shown.length} older`] : []
  return [`${lines.length} ${where}, newest first:`, ...shown, ...more].join('\n')
}

const maxStatusLines = 40

/**
 * The `git status` part of the pointer: files changed through a shell command are in no other part, and the work digest
 * does not say what is still unsaved. The run asks for porcelain output with untracked files and plain paths, so the
 * user's git settings do not change it. Never throws.
 */
export const uncommittedText = (
  run: { exitCode: number; stdout: string; stderr: string; isStdoutTruncated?: boolean } | { error: string },
  directory: string,
): string => {
  if ('error' in run) return `git status failed in ${directory} (${run.error}).`
  if (run.exitCode !== 0) return `git status failed in ${directory} (${run.stderr.trim().split('\n')[0] || `exit code ${run.exitCode}`}).`
  // Not trimmed: the two status letters start the line, and the first may be a space.
  const lines = run.stdout.split('\n').filter(line => line.trim() !== '')
  // An output that was cut ends in a partial line, and the count is then a lower bound.
  const isCut = run.isStdoutTruncated === true
  if (isCut) lines.pop()
  if (lines.length === 0 && !isCut) return `None: the working tree in ${directory} was clean when this message was made.`
  const shown = lines.slice(0, maxStatusLines)
  const hidden = lines.length - shown.length
  // git's output is cut only when it is very long, so in practice a cut one also has hidden lines.
  const more = [...(hidden > 0 ? [`... and ${hidden} more`] : []), ...(isCut ? ['... and others: the output of git status was cut'] : [])]
  return [
    `${lines.length}${isCut ? ' or more' : ''} in ${directory} when this message was made (\`git status --porcelain\`: two status letters, then the path from the repository root):`,
    ...shown,
    ...more,
  ].join('\n')
}

/** Whether a git run gave its answer. */
const isGitAnswer = (run: { exitCode: number } | { error: string }) => 'exitCode' in run && run.exitCode === 0

/**
 * A git run that never throws: a git that cannot start or does not finish in time gives `{ error }`, as does a host
 * where `$.process` throws before it returns a promise.
 */
const runGit = async (
  $: { process: { run: (argv: readonly string[], init?: ProcessRunInit) => Promise<ProcessRunResult> } },
  gitArguments: readonly string[],
  init: ProcessRunInit,
): Promise<ProcessRunResult | { error: string }> => {
  try {
    return await $.process.run(['git', ...gitArguments], init)
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Whether a commit command made a commit, by HEAD's reflog in the session folder or, when that answered and shows
 * none, in another worktree of its repository that the command names (`namedWorktrees`), where the commit's subject
 * must also be one the command gives (`commitSubjects`): a command can name a path it only reads in. The end of the
 * window is taken before those reads, so a commit made while they run is not this command's.
 */
const isCommitFound = async (
  $: Parameters<typeof runGit>[0] & {
    session: { cwd: () => Promise<string> }
    env: { get: (name: string) => Promise<string | undefined> }
  },
  command: string,
  startedAt: number,
): Promise<boolean> => {
  const own = await runGit($, reflogArguments, { timeoutMs: reflogTimeout })
  const endedAt = Date.now()
  if (isCommitLogged(own, startedAt, endedAt)) return true
  if (!isGitAnswer(own) || !mayNamePath(command)) return false
  const [list, cwd, home] = await Promise.all([
    runGit($, worktreeListArguments, { timeoutMs: reflogTimeout }),
    $.session.cwd().catch(() => ''),
    // An empty HOME is unset too.
    $.env.get('HOME').then(async value => value || (await $.env.get('USERPROFILE'))).catch(() => undefined),
  ])
  if (!('exitCode' in list) || list.exitCode !== 0) return false
  const named = namedWorktrees(command, worktreePaths(list.stdout), cwd, home)
  const runs = await Promise.all(named.map(folder => runGit($, reflogArguments, { cwd: folder, timeoutMs: reflogTimeout })))
  return runs.some(run => isCommitLogged(run, startedAt, endedAt, command))
}

/**
 * The model's last message with text: the mark is set inside a turn, so steps given to the user in the turn's closing
 * message come after it. The end is kept, since a closing message ends with what it asks.
 */
export const lastReply = (messages: readonly Pick<SessionMessage, 'role' | 'text'>[]): string => {
  const text = messages[lastReplyIndex(messages)]?.text.trim() ?? ''
  return text.length > maxLastReply ? `...${text.slice(-maxLastReply)}` : text
}

/** Where the model's last message with text is, or -1. */
const lastReplyIndex = (messages: readonly Pick<SessionMessage, 'role' | 'text'>[]): number => {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.role === 'assistant' && message.text.trim() !== '') return index
  }
  return -1
}

const maxWork = 20_000
const maxWorkReply = 1500
const maxWorkCall = 300
const maxWorkResult = 600
const maxWorkOutput = 200
const minFocus = 200
// Tools whose result is on disk or can be had again by the same call, so the digest names the call alone.
const repeatableTools = ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'NotebookEdit']

/** The start of a text, with a note where it was cut. */
const clipEnd = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit)} ...(cut)` : text)

/** The start and the end of a text: an error names itself first, and a test run sums up last. */
const clipMiddle = (text: string, limit: number) => {
  if (text.length <= limit) return text
  const head = Math.floor(limit / 3)
  return `${text.slice(0, head)} ...(cut)... ${text.slice(-(limit - head))}`
}

type WorkToolUse = Pick<ToolUseSummary, 'tool' | 'input' | 'text' | 'isError'> & Partial<Pick<ToolUseSummary, 'tool_use_id'>>
type WorkMessage = Pick<SessionMessage, 'role' | 'text'> & { toolUses?: readonly WorkToolUse[] }

/** A tool call in one line: the command or the file when it has one, else its input. */
const callBrief = (use: WorkToolUse): string => {
  const input = use.input ?? {}
  const named = input.command ?? input.file_path ?? input.notebook_path
  return `${use.tool}: ${clipEnd(typeof named === 'string' ? named.trim() : JSON.stringify(input), maxWorkCall)}`
}

/** One line or block of the work digest. `isCommit` for a shell call that committed. */
export type WorkEntry = { text: string; isCommit: boolean }

/** What the digest keeps of a call's result: a failure and any result that cannot be had again, cut; of a shell output, the end. */
const callOutcome = (use: WorkToolUse): string => {
  const output = (use.text ?? '').trim()
  if (use.isError === true) return `\nfailed: ${clipMiddle(output, maxWorkResult) || 'no output'}`
  if (isSilent(output) || repeatableTools.includes(use.tool)) return ''
  return shellTools.includes(use.tool) ? `\noutput ends: ${output.slice(-maxWorkOutput)}` : `\nresult: ${clipMiddle(output, maxWorkResult)}`
}

/**
 * The model's side of the conversation as short entries, oldest first: what it said, and each tool call with the text
 * of a failure, the end of a shell output, or the start and end of a result that cannot be had again (a subagent's
 * report, an answer from the user, a fetched page). The user's requests have their own part of the pointer, recorded by
 * origin: a user message here may be a skill body or another plugin's prompt. The model's last message has its own
 * part too, and the mark call says nothing the focus does not.
 *
 * A shell call committed when its command holds a `git commit`, it did not fail, and either its output has git's commit
 * line or its id is one of `committedCallIds`, the calls whose commit HEAD's reflog shows (`isCommitLogged`). The words
 * and a `-q` alone are not taken for a commit, as the reminder takes them: a wrong guess here drops work from the digest.
 */
export const workEntries = (messages: readonly WorkMessage[], toolName: string, committedCallIds: readonly string[] = []): WorkEntry[] => {
  const replyIndex = lastReplyIndex(messages)
  const logged = new Set(committedCallIds)
  const entries: WorkEntry[] = []
  // A line after the first is indented, so a reply or a result of several lines reads as one entry and never as a
  // heading of the pointer.
  const add = (text: string, flags: Omit<WorkEntry, 'text'>) => entries.push({ text: text.replace(/\n/g, '\n  '), ...flags })
  messages.forEach((message, index) => {
    if (message.role !== 'assistant') return
    const text = (message.text ?? '').trim()
    if (text && index !== replyIndex) add(`You: ${clipEnd(text, maxWorkReply)}`, { isCommit: false })
    for (const use of message.toolUses ?? []) {
      if (use.tool === toolName) continue
      add(`${callBrief(use)}${callOutcome(use)}`, {
        isCommit:
          use.isError !== true &&
          isCommitCall(use.tool, use.input ?? {}) &&
          (committedLine.test(use.text ?? '') || (use.tool_use_id !== undefined && logged.has(use.tool_use_id))),
      })
    }
  })
  return entries
}

/** The entries after the last commit, and whether there was one: what a commit holds needs no digest. */
export const afterLastCommit = (entries: readonly WorkEntry[]): { entries: readonly WorkEntry[]; isCommitted: boolean } => {
  let commitIndex = -1
  entries.forEach((entry, index) => {
    if (entry.isCommit) commitIndex = index
  })
  return { entries: entries.slice(commitIndex + 1), isCommitted: commitIndex >= 0 }
}

/**
 * The work part of the pointer: the newest entries after the last commit, up to maxWork characters. A focus written
 * at a clean boundary has little after the commit, so the part is short; work that was never committed is what only
 * the conversation held, and it gets the room.
 */
export const workText = (messages: readonly WorkMessage[], toolName: string, committedCallIds: readonly string[] = []): string => {
  const work = afterLastCommit(workEntries(messages, toolName, committedCallIds))
  const heading = work.isCommitted ? '## Your work after the last commit' : '## Your work since the conversation started or was last compacted'
  if (work.entries.length === 0) return `${heading}\nNothing but your last message.`
  const kept: string[] = []
  let size = 0
  for (const entry of [...work.entries].reverse()) {
    size += entry.text.length
    if (size > maxWork && kept.length > 0) break
    kept.unshift(entry.text)
  }
  const cut = work.entries.length - kept.length
  return [
    heading,
    'A digest the plugin made, oldest first: what you said, each tool call, the end of a shell output, the text of a failure and the start and end of other results. Results of file reads, searches and edits are left out.',
    ...(cut > 0 ? [`... ${cut} earlier ${cut === 1 ? 'entry' : 'entries'} cut; search the transcript for them`] : []),
    ...kept,
  ].join('\n')
}

/** The work part for the pointer; a failure to make it (a message of an unexpected shape) must not cost the pointer. */
export const workPart = (messages: readonly WorkMessage[], toolName: string, committedCallIds: readonly string[] = []): string => {
  try {
    return workText(messages, toolName, committedCallIds)
  } catch (error) {
    return `## Your work after the last commit\nNot available: the plugin could not read the conversation (${error instanceof Error ? error.message : String(error)}). Search the transcript.`
  }
}

// Past this many tool calls after a failed command, the work has moved on from it.
const maxCallsAfterFailure = 20

/**
 * The last shell command, in one line, when it failed and at most maxCallsAfterFailure tool calls came after it; else
 * null. A commit is a shell command that did not fail, so nothing was committed after the one found. A search that
 * matched nothing fails too, so what a caller says about it is worded as a condition. Read from the end, since the
 * summary hook calls this on every compaction.
 */
export const lastFailedShell = (messages: readonly WorkMessage[], toolName: string): string | null => {
  let laterCalls = 0
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.role !== 'assistant') continue
    for (const use of [...(message.toolUses ?? [])].reverse()) {
      if (use.tool === toolName) continue
      if (shellTools.includes(use.tool)) return use.isError === true ? clipEnd(callBrief(use).split('\n')[0] ?? '', 120) : null
      if (++laterCalls > maxCallsAfterFailure) return null
    }
  }
  return null
}

/**
 * Asked of a summary when the last shell command failed and nothing was committed after it: no model set `busy` while
 * debugging in the tests, so a compaction can land inside an unfinished step with no mark and no focus to keep its
 * details. Empty when `lastFailedShell` finds none, and when the conversation cannot be read: a compaction must not
 * fail over this.
 */
export const unfinishedStep = (messages: readonly WorkMessage[], toolName: string): string => {
  try {
    const failed = lastFailedShell(messages, toolName)
    return failed === null
      ? ''
      : `The last shell command in the conversation failed and nothing was committed after it (${failed}). If the step it belongs to is unfinished, keep what was being tried, the exact error text and what was already ruled out.`
  } catch {
    return ''
  }
}

/**
 * What the mark tool adds to its answer in pointer mode, while the model still has the conversation: a pointer is only
 * as good as its focus, and nothing after the compaction can ask for a better one. A second call replaces the mark, so
 * the advice says to repeat the other inputs.
 */
export const pointerAdvice = (current: Mark, messages: readonly WorkMessage[], toolName: string): string[] => {
  if (current.state !== 'boundary') return []
  if (!current.focus) return ['Pointer mode: the mark has no focus, so the plugin will make a summary instead of a pointer. For a pointer, call again with a focus.']
  const advice: string[] = []
  if (current.focus.length < minFocus)
    advice.push(
      `Pointer mode: the focus is ${current.focus.length} characters, and it is all the next context gets from you about the goal, what is done, the next step, open decisions and what you ruled out. If it leaves one of those out, call again before you end the turn, with a fuller focus and \`resume\` and \`userSteps\` as you gave them: a new call replaces the mark.`,
    )
  const failed = lastFailedShell(messages, toolName)
  if (failed !== null)
    advice.push(
      `Pointer mode: your last shell command failed and nothing was committed after it (${failed}). The pointer keeps a digest of that work, not the full output. If the step is unfinished, call again with \`busy\` and go on with it; if it is finished, make sure the focus says what failed and why it no longer matters.`,
    )
  return advice
}

/** The one user message that replaces the conversation in pointer mode. Its first line labels it, as summaryLabel does a summary. */
export const pointerText = (parts: PointerParts, reply: string, work: string) =>
  [
    `Compacted by the compact-timing plugin at ${thousands(parts.tokens)} tokens, at a \`boundary\` mark, in pointer mode: this message replaced the conversation, and no summary was made.`,
    `compact-timing: an automatic message from a plugin, not written by the user. You wrote the focus, the open steps and the last message; the plugin added the user\'s requests, the digest of your work, the files written${parts.uncommitted ? ', the uncommitted changes' : ''}, the transcript path and the commits.`,
    `## Focus\n${parts.focus || 'None given.'}`,
    `## The user's requests\nVerbatim, oldest first; a later request can change an earlier one.\n${parts.requests}`,
    `## Open steps you gave the user\n${parts.userSteps || 'None listed.'}`,
    work,
    `## Your last message\n${reply || 'None found.'}`,
    `## Files written this session with Write, Edit or NotebookEdit\nFiles changed through Bash are not listed.\n${parts.files}`,
    // Left out where git answers neither question, as outside a repository: the commits part already says why.
    ...(parts.uncommitted ? [`## Uncommitted changes\n${parts.uncommitted}`] : []),
    `## Transcript\n${parts.transcriptPath}\nFor anything else from the conversation (requests left out above, error text, paths, numbers), ${transcriptSearchHow} Search it before asking the user for something they may already have given, and before acting on a command, an error or a value the focus names without giving it exactly.`,
    `## Commits\n${parts.commits}`,
  ].join('\n\n')

/**
 * Instructions for every compaction of the main conversation: the ones given, or the mark's focus for a compaction
 * Claude Code starts itself (trigger `auto` or `precompute`), followed by the request for an unfinished step when there
 * is one (`unfinishedStep`), the open user steps and the transcript search, which stays last since it names the
 * summary's last line. Only a `busy` mark outlives its turn, so the focus keeps the details of an unfinished step.
 */
export const compactInstructions = (trigger: string, instructions: string | undefined, current: Mark | null, unfinished = '') => {
  const isEngine = trigger === 'auto' || trigger === 'precompute'
  const given = instructions?.trim() || (isEngine ? current?.focus : '')
  return [given, unfinished, openUserSteps, transcriptSearch].filter(Boolean).join('\n\n')
}

/**
 * Whether a prompt gets the context note: once when the context reaches `boundaryTokens`, and again only
 * after it fell below that (a compaction or a fresh session). Returns the new `noted` flag with the decision.
 */
export const contextNoteDue = (tokens: number | undefined, noted: boolean, limits: Limits): { due: boolean; noted: boolean } => {
  if (tokens === undefined) return { due: false, noted }
  if (tokens < limits.boundaryTokens) return { due: false, noted: false }
  return { due: !noted, noted: true }
}

/**
 * Sent with the prompt that finds the context large. A topic switch without a commit gets no boundary mark,
 * and a plugin cannot compact before the prompt runs, so the model is asked to suggest a fresh session.
 */
export const contextNote = (tokens: number, toolName: string) =>
  [
    'compact-timing: an automatic note from a plugin, not written by the user, who does not see it.',
    `- The context holds ${thousands(tokens)} tokens. From now on, when a request starts new work: if it continues the current work, call ${toolName} with \`boundary\` at the next natural break; if it is unrelated and needs nothing from this conversation, suggest a fresh session (/clear or a new terminal); if it is new but needs a few facts from here, suggest a short handoff and then a fresh session. If the current request already starts new work, apply this now. Suggest it at most once; the user decides.`,
  ].join('\n')

/** A positive number from the settings, else the default: an empty or misspelled value must not compact every turn. */
export const limitOption = (value: unknown, fallback: number): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/** A failure the user should see: a toast in the terminal, and a transcript line, which an SDK host such as T3 Code shows too. */
const report = ($: { ui: { toast: (text: string) => void; log: (text: string) => void } }, text: string) => {
  $.ui.toast(text)
  $.ui.log(text)
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

  on('session.start', async ($, e, next) => {
    const registered = await $.tool.register({
      name: 'mark',
      description: ruleText(limits, isPointerMode),
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
          advice = pointerAdvice(parsed, parsed.focus ? await $.session.messages() : [], markTool)
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
          } else if (!marked.focus) {
            // Without a focus the pointer would hold no goal and no next step: the summary keeps more.
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
          report($, `compact-timing: pointer failed, making a summary (${error instanceof Error ? error.message : String(error)})`)
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
      if (parts !== null && !isPointer) $.ui.log('compact-timing: pointer mode fell back to a summary for this compaction')
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
    if (isPointerMode && e.agentId === undefined && e.trigger === 'manual') {
      const [own, parts, commits] = await Promise.all([
        read($, ownCompact).catch(() => null),
        read($, pointer).catch(() => null),
        read($, commitCalls).catch(() => []),
      ])
      // A stored value of another shape finds no commit by the reflog rather than costing the digest.
      const committed = Array.isArray(commits) ? commits.filter(id => typeof id === 'string') : []
      if (own === 'pending' && parts)
        pointed = { messages: [{ role: 'user', text: pointerText(parts, lastReply(e.messages), workPart(e.messages, markTool, committed)), toolUses: [] }] }
    }
    // Another plugin's direct compaction carries its own instructions. This plugin's runs as `/compact` (`manual`).
    if (pointed === null && e.agentId === undefined && e.trigger !== 'plugin') {
      const current = await read($, mark).catch(() => null)
      e = { ...e, instructions: compactInstructions(e.trigger, e.instructions, current, unfinishedStep(e.messages, markTool)) }
    }
    const result = pointed ?? (await next(e))
    if (e.agentId === undefined && e.trigger === 'manual') {
      const isPointer = pointed !== null
      await update($, ownCompact, previous => (previous === 'pending' ? { skip: result.skip ?? null, ...(isPointer ? { isPointer } : {}) } : previous)).catch(
        () => undefined,
      )
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
