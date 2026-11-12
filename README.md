# compact-timing

A Claude Code plugin that compacts the conversation at task boundaries instead of at a fixed token count.

Claude Code compacts when the context reaches a set size. That can land in the middle of a debugging session, when the details exist only in the conversation, or long after a task ended, when compacting earlier would have lost nothing. With this plugin the model sets a mark when it finishes a task or starts a step that must not be compacted, and the plugin compacts at the end of a turn when the mark and the context size allow it.

## Install

```sh
claude plugin marketplace add lbzepoqo/compact-timing
claude plugin install compact-timing@compact-timing
```

Restart Claude Code. The `lbzepoqo/claude-plugins` marketplace also lists it, as `compact-timing@lbzepoqo`, from this repo.

Keep Claude Code's own `autoCompactWindow` above `softTokens` (300k by default), for example `{ "autoCompactWindow": 500000 }`. It stays the hard limit when a `busy` mark is never cleared.

## How it works

The plugin gives the model one tool, `mark`:

| Input | Meaning |
|---|---|
| `state` | `boundary` or `busy` (below) |
| `focus` | What the next context must keep. Passed to the compaction as its instructions; in pointer mode it is the handoff itself |
| `resume` | With `boundary`: steps of the current request remain, so compact and continue (see [Compact and resume](#compact-and-resume)) |
| `userSteps` | Pointer mode only: steps the model gave the user that are still open |

At the end of each turn the plugin compacts when the context holds at least:

| Mark | Meaning | Compacts at |
|---|---|---|
| `boundary` | A task is done and its state is saved (committed, or in a plan file) | `boundaryTokens` (200k) |
| none | No mark since the last compaction | `softTokens` (300k) |
| `busy` | A step is in progress whose details exist only in the conversation | never |

- A `boundary` mark counts only in the turn that set it. It is dropped when that turn ends, whether or not it compacted, so it cannot trigger a compaction later in the middle of other work.
- A `busy` mark stays until the model replaces it. Any compaction clears the mark. Each session has its own mark.
- Interrupting a turn drops the mark and skips the compaction.

### Compact and resume

A plugin can compact only between turns, so a long turn (a feature build, a whole debugging session) keeps growing until it ends. When steps of the current request remain, the model sets `boundary` with `resume` at a point where the work is saved. If the context has reached `boundaryTokens`, the tool tells the model to end the turn with a one-line status; the plugin compacts and sends the focus back as a prompt, so the work goes on without you typing "continue".

- An interrupted turn or a skipped compaction sends no prompt.
- After 10 automatic resumes in a row, the plugin stops and asks you to type "continue".
- A message you queue during the long turn may run before or after the resume prompt.

### Reminders to the model

The model often forgets the tool, so the plugin adds short notes at the moments a mark is most useful:

- **After a `git commit`** (through Bash or PowerShell), when the context has reached `boundaryTokens` or the mark is `busy`: set the mark. A commit is the most common task boundary. The command must have committed: its output has a line git prints for a commit (`[main 5815a99] Fix the parser`, ` 2 files changed`, ` create mode 100644 a.ts`), or the commit ran with `-q`, or the command printed nothing at all. A command that holds the words and prints something else, such as an `echo`, a dry run or a prompt passed to another program, gets no reminder, unless the words include `-q`. Neither does a commit whose own output was sent away while the rest of the command printed (`git commit -m x >/dev/null && git log -1`). Under a `busy` mark the words are enough, as before 0.12.0: that reminder only asks whether the step is done, and it is what gets a stale mark replaced.
- **Inside a long turn**, on the first tool result at `softTokens` or more: at the next saved point, set `boundary` with `resume` and end the turn. Once per compaction.
- **On a prompt at `boundaryTokens` or more** (a topic switch without a commit gets no mark): suggest `/clear` if the request is unrelated, a short handoff if it needs a few facts, or set `boundary` at the next break if it continues the work. Once, and again only after the context falls below `boundaryTokens`. Turn off with `contextNote`.

### What every summary keeps

Every summary of the main conversation, including the one for a `/compact` you type and Claude Code's own, gets two extra requests:

- **Your open steps.** Keep each step, command or question the model gave you that you have not yet reported done or answered, commands exact. Claude Code's summary lists the model's own pending tasks but not yours; in one session it dropped a four-step test the model had just asked for, and the model then denied asking.
- **How to search the transcript.** End with a `command grep -oE` line that shows 200 characters around a term, since the transcript's lines are long JSON records.

A third request is added when the last shell command failed, nothing was committed after it and at most 20 tool calls followed it (the mark tool's answer in pointer mode uses the same rule): if the step it belongs to is unfinished, keep what was being tried, the exact error text and what was already ruled out. The models tested do not set `busy` while debugging, so without it a compaction at `softTokens` can land inside a debugging step with nothing asking the summary to keep its details. A search that matched nothing counts as failed too, which is why the request is worded as a condition.

When Claude Code compacts on its own (at `autoCompactWindow`, on a prompt that is too long, or while idle, including its precompute) and has no instructions of its own, the plugin passes the mark's focus as the instructions, so a `busy` step keeps what it needs.

### How a plugin compaction shows up

The plugin compacts by running `/compact` with a label and the focus, so it works in headless and SDK sessions (T3 Code, `claude -p`) too, and the transcript shows that command as a prompt from the plugin. Claude Code records it with the trigger `manual`, like a `/compact` you type, so the summary starts with a line that tells them apart:

> Compacted by the compact-timing plugin at 214k tokens, at a `boundary` mark

Each compaction also shows a toast with the size. A compaction that fails or is skipped shows a toast and a transcript line, which SDK hosts show too.

## Pointer mode

Off by default. With `pointerMode` on, the plugin's compaction at a `boundary` mark makes no summary. It replaces the conversation with one message that holds:

- the mark's focus, which the model is asked to write as a handoff: goal, what is done, next step, open decisions, what it ruled out and why, file paths;
- the requests you typed this session, verbatim: the first three and the newest five, each up to 2,000 characters, with a count of the ones between, so your own words are there next to the model's paraphrase in the focus;
- the open user steps, which the model lists in `userSteps` because no summarizer runs to find them;
- a digest of the work after the last commit, up to 20,000 characters, the newest kept (see [The work digest](#the-work-digest));
- the model's last message, up to 3,000 characters (steps it gives you after setting the mark are in there);
- the files the model wrote this session with Write, Edit or NotebookEdit, each once, at most 40 (files changed through Bash are not listed);
- the uncommitted changes: `git status --porcelain` at the moment of the compaction, with untracked files, at most 40 lines, so files changed through a shell command and work that is not yet saved show up. Left out where the folder is not a git repository. The status runs with `--no-optional-locks`, so it cannot block a `git add` or `git commit` you run at that moment;
- the transcript path, with the same search line a summary ends with;
- `git log` since the session started, at most 40 commits with authors, so pulled-in commits stand out. If git fails, the message says why.

The message starts with "Compacted by the compact-timing plugin at 214k tokens, at a `boundary` mark, in pointer mode". A resume after it tells the model to continue from the focus and to check its last message, the commits and `git status` before repeating a step.

### The work digest

A pointer is only as good as its focus, and the model does not set `busy` during a debugging session (see [Results and limits](#results-and-limits)), so work that was never committed would otherwise be lost. The plugin therefore adds, from the conversation it is about to replace, what came after the last successful `git commit`:

- what the model said, each message cut at 1,500 characters (your requests are in their own part);
- each tool call in one line: the command, the file, or the input;
- for a shell command, the last 200 characters of its output; for a call that failed, the start and the end of the error, 600 characters; for any other result that cannot be had again (a subagent's report, your answer to a question, a fetched page), its start and end, 600 characters.

Results of Read, Grep, Glob, Write, Edit and NotebookEdit are left out, since the file is on disk. A mark set right after a commit has little after it, so the part is a few lines; work that was never committed gets the room. With no commit in the conversation the digest covers its end. When it is cut, a line at its top says how many entries were left out.

A commit counts when a Bash or PowerShell command holds `git commit`, did not fail, and its output has the line git prints for a commit (`[main 5815a99] Fix the parser`). A commit made with `-q`, or whose output a pipe cut away, is missed, and the digest is then longer than it needs to be. The digest does not take a command without output for a commit, as the commit reminder does: a wrong guess there would drop work from the digest.

### What the mark tool answers

When a `boundary` mark can compact (the context is known to have reached `boundaryTokens`), the tool's answer adds, while the model still has the conversation:

- with no focus: this compaction will make a summary, and a focus makes it a pointer;
- with a focus under 200 characters: it is all the next context gets, so call again with a fuller one if it leaves something out, keeping `resume` and `userSteps`;
- when the last shell command after the last commit failed: set `busy` if the step is unfinished, or say in the focus what failed.

Every other compaction still makes a summary: with no mark at `softTokens`, a `/compact` you type, Claude Code's own, and a subagent's. The plugin also falls back to a summary, with a transcript line saying so, when the mark has no focus or the transcript path is unknown. It learns the path from Claude Code's classic SessionStart and UserPromptSubmit events, since the plugin API has no other way to get it.

The requests and files are recorded as the session runs, because the plugin can read at most 4 MiB of a file and a long transcript is larger. They start from when pointer mode is on, so a session that was already running when you turned it on lacks the earlier ones, and a `/clear` empties them. A request is a prompt that counts as yours for the context note too: typed, from Remote Control or from an SDK host such as T3 Code. Slash commands and the plugin's own resume prompts are left out. An SDK host may also send messages from other sessions as prompts, and those are recorded as requests.

The plugin answers the pointer compaction itself, so a compaction hook from another plugin that runs after compact-timing's does not run for it.

## Settings

| Option | Default | Meaning |
|---|---|---|
| `boundaryTokens` | 200000 | Context size at which a `boundary` mark compacts |
| `softTokens` | 300000 | Context size at which the plugin compacts without a mark |
| `contextNote` | true | Send the note on a prompt once the context reaches `boundaryTokens` |
| `pointerMode` | false | At a `boundary` mark, replace the conversation with a pointer instead of a summary |

Change them with `/plugin configure compact-timing@compact-timing` in Claude Code, or from the shell:

```sh
echo '{"boundaryTokens": "150000"}' | claude plugin configure compact-timing@compact-timing --values-stdin
```

## Results and limits

- **Daily use.** In three weeks of my own sessions (`boundaryTokens` 120k, `softTokens` 200k), Claude Code's hard-limit compaction never ran and the plugin compacted 251 times. 37% of those ran at 200k or more because a long turn kept growing; compact and resume (0.9.0) targets that, and in a live test Sonnet compacted and resumed twice in a three-step task without help.
- **Marks.** After committing a bug fix, Opus, Sonnet and Haiku each set `boundary` with a useful focus. None set `busy` while searching for the bug. Without the commit reminder, Opus set no mark at all.
- **Search line.** On a manual `/compact` of a short session, the summaries of Opus, Sonnet and Haiku each ended with the transcript search line.
- **Headless sessions.** Before 0.9.1 the plugin never compacted in SDK sessions, and the only sign was a toast those hosts do not show. The `/compact` path is tested in an SDK session and in the terminal.
- **Pointer mode.** Tested in two headless stream-json sessions with Haiku: 28k tokens became 0.4k in 5 ms with no summary request. With `resume`, Haiku checked `git status` and `git log`, then did the remaining step from the focus, but did not search the transcript for a command the focus only described. Not yet compared with summaries in daily use.
- **Commit reminder, uncommitted changes and the shorter tool (0.12.0).** Tested in one headless session with Haiku: a commit, then a staged file and `git commit --dry-run`, then a `boundary` mark. The reminder came after the commit and not after the dry run, the pointer listed the staged file under the uncommitted changes, and Haiku still filled in `focus` and `userSteps` with their descriptions cut to one line. In pointer mode the tool's description and schema went from 2,990 to 2,454 characters, which every request carries. The request to keep an unfinished step in a summary is covered by unit tests only.
- **Work digest and mark answer.** Tested in one headless session with Haiku: a commit, then a shell command that failed, then a `boundary` mark with a 28-character focus. The tool's answer named the short focus and the failed command, and the pointer's digest held only that command and its error, not the committed steps before it. Haiku ended the turn without writing a fuller focus, so the answer informs the model but does not make it act.

## Develop

```sh
claude plugin validate .
claude plugin test .
```
