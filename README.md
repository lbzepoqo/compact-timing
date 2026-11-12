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

- **After a `git commit`** (through Bash or PowerShell), when the context has reached `boundaryTokens` or the mark is `busy`: set the mark. A commit is the most common task boundary. The command must have committed: its output has a line git prints for a commit (`[main 5815a99] Fix the parser`, ` 2 files changed`, ` create mode 100644 a.ts`), or the commit ran with `-q`, or the command printed nothing at all. A command that holds the words and prints something else, such as an `echo`, a dry run or a prompt passed to another program, gets no reminder, unless the words include `-q`. Neither does a commit whose own output was sent away while the rest of the command printed (`git commit -m x >/dev/null && git log -1`), except in pointer mode, where the plugin reads git's record of HEAD after the command (see [The work digest](#the-work-digest)). Under a `busy` mark the words are enough, as before 0.12.0: that reminder only asks whether the step is done, and it is what gets a stale mark replaced.
- **Inside a long turn**, on the first tool result at `softTokens` or more: at the next saved point, set `boundary` with `resume` and end the turn. Once per compaction. A commit reminder at that moment carries the same advice and replaces it, except under a `busy` mark, whose reminder does not mention `resume`: then both come. Before 0.13.0 the busy reminder replaced it too, and a turn that set `busy` early got no word about its size.
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

A commit counts when a Bash or PowerShell command holds `git commit`, did not fail, and either:

- its output has the line git prints for a commit (`[main 5815a99] Fix the parser`), or
- HEAD's reflog in the session's folder has a commit made since the command was sent. The reflog is git's record of every change to HEAD, each with its time and what made it (`commit: Fix the parser`, `commit (amend): ...`, `checkout: moving from fix to main`). After each such command in the main conversation, the plugin reads its newest 20 entries with `git reflog`, with a 3-second limit, or
- that reflog shows no commit, and the reflog of another worktree of the same repository whose path the command names has a commit made in that time whose subject is a message the command gives. Each worktree has its own HEAD reflog, so for a command that holds a `/`, `\`, `~` or `$HOME` the plugin lists the worktrees with `git worktree list` and then reads, at the same time, the reflog of each one whose path is in the command, the first 4 it names: the full path (on Windows also as `/c/...` or `/mnt/c/...`), or the path under your home folder with `~` or `$HOME`. A command can name a path it only reads in (`cat`, `diff`), so the commit's subject must also equal the subject of a message the command gives a `git commit`: the first line that is not blank of its first `-m` or `--message`, or of the heredoc it reads with `-F -` (also inside `-m "$(cat <<'EOF' ...)"`), with case, punctuation and quoting ignored; a commit another session makes there at the same moment has its own subject. Each of these runs has the 3-second limit, so such a command can wait up to about 6 seconds more when git is slow, 9 in all.

The reflog is what finds a quiet commit: the models commit with `-q` about 80% of the time, and git then prints no line (see [Results and limits](#results-and-limits)). A commit that a hook rejected writes no entry, also when the command goes on to print the previous commit with `git log -1`. A rebase, a cherry-pick, a pull, a checkout or a reset writes its own kind of entry, which does not count, and a commit followed by a checkout in the same command still counts. A commit in another worktree counts only when the command names that worktree's path and gives the commit's subject as a message.

Still missed, which only makes the digest longer than it needs to be:

- a quiet commit in another repository than the session folder's (after `cd`, with `git -C`, through `wsl`), and every quiet commit when the session's folder is not a repository;
- a quiet commit in another worktree that the command reaches by a relative path (`cd ../fix`) or a shell variable, or names no path for because an earlier command already moved the shell there; one past the first 4 worktrees the command names; and one whose message is not in the command as written (`-F msg.txt`, `--amend --no-edit`, `-C <commit>`, `--fixup`, a `<<<` string, a bash `'\''` inside the quotes, a message with `$VERSION` or `$(...)` in its first line). Of 1,059 commit commands in my transcripts that changed folder first, the plugin reads a subject from 1,008;
- a command run in the background, which has only started when its call returns;
- a commit when git does not answer within 3 seconds, or in a repository whose reflog is turned off (`core.logAllRefUpdates`);
- a commit followed in the same command by 20 or more other changes to HEAD (a rebase of many commits), and one whose date was set in the past (`GIT_COMMITTER_DATE`). A reflog entry dated after the read is not taken for this command's.

One wrong guess is left: a command whose own commit failed quietly while something else committed in the session's folder between the moment the command was sent and its end (another session, a subagent). That time includes any wait for you to approve the command. Git keeps whole seconds, so a commit made earlier in the second the command was sent counts too. The words and a `-q` alone are not taken for a commit, and neither is a command without output, as the commit reminder takes them: a wrong guess there would drop work from the digest.

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
- **Size nudge in daily use.** In my sessions started from 0.9.0 (2026-11-04) to 2026-11-12, 12 stretches between compactions passed 200k. In the 9 where the nudge came, the context peaked at 220k at most. In 1, a commit reminder under a `busy` mark had taken its place (fixed in 0.13.0), and it grew to 345k. In the other 2, the commit reminder that names `resume` came instead and the model did not act on it (241k, 381k).
- **Marks.** After committing a bug fix, Opus, Sonnet and Haiku each set `boundary` with a useful focus. None set `busy` while searching for the bug. Without the commit reminder, Opus set no mark at all.
- **Search line.** On a manual `/compact` of a short session, the summaries of Opus, Sonnet and Haiku each ended with the transcript search line.
- **Headless sessions.** Before 0.9.1 the plugin never compacted in SDK sessions, and the only sign was a toast those hosts do not show. The `/compact` path is tested in an SDK session and in the terminal.
- **Pointer mode.** Tested in two headless stream-json sessions with Haiku: 28k tokens became 0.4k in 5 ms with no summary request. With `resume`, Haiku checked `git status` and `git log`, then did the remaining step from the focus, but did not search the transcript for a command the focus only described. Not yet compared with summaries in daily use.
- **Commit reminder, uncommitted changes and the shorter tool (0.12.0).** Tested in one headless session with Haiku: a commit, then a staged file and `git commit --dry-run`, then a `boundary` mark. The reminder came after the commit and not after the dry run, the pointer listed the staged file under the uncommitted changes, and Haiku still filled in `focus` and `userSteps` with their descriptions cut to one line. In pointer mode the tool's description and schema went from 2,990 to 2,454 characters, which every request carries. The request to keep an unfinished step in a summary is covered by unit tests only.
- **Work digest and mark answer.** Tested in one headless session with Haiku: a commit, then a shell command that failed, then a `boundary` mark with a 28-character focus. The tool's answer named the short focus and the failed command, and the pointer's digest held only that command and its error, not the committed steps before it. Haiku ended the turn without writing a fuller focus, so the answer informs the model but does not make it act.
- **Commits in daily use.** Counted over my own transcripts from 2026-09-21 to 2026-11-12: 1,303 shell commands held `git commit` as shell code and did not fail, and about 80% of all commit commands used `-q`. Git's commit line was in the output of only 3 of those that ran in a repository, so before the digest read the reflog it found almost no commit.
  - 955 ran in a session whose folder is a git repository with reflog entries going back to that time. The other 348 ran where the folder is not a repository (229) or before its oldest reflog entry (119).
  - 379 of the 955 committed in the session's folder itself, without `cd` or `git -C`. The reflog shows a commit made during 376 of them; the other 3 committed nothing.
  - The other 576 changed folder first, and the session folder's reflog shows a commit during 125 of them. In 280 a commit made during the call is on a branch of the repository but not in that reflog; the ones looked at had gone into another worktree. The plugin now also reads the reflog of a worktree the command names; how many of the 280 that finds was not measured. Two wider counts over all my transcripts, without the date and reflog limits above: of the commit commands that did not fail in a repository folder and changed folder first, 489 named the folder by full path, 102 by a `~` path, 3 by a relative path and 9 by a shell variable; of all commit commands that changed folder first, failed ones included, 1,137 of 1,201 gave the message with `-m` or a heredoc, which the subject check needs.
- **Commits by the reflog.** Tested in one headless session with Haiku in pointer mode: `git switch -q -c fix && git add -A && git commit -qm one && git switch -q -`, which printed nothing and ended on the branch it started from, then `git add -A; git commit -qm reject-two; git log --oneline -1`, which a commit-msg hook rejected while the command still printed the previous commit. The pointer's digest started after the first command and held the second with its `lint failed`. The reminder for a commit whose own output was sent away is covered by unit tests only.

## Develop

```sh
claude plugin validate .
claude plugin test .
```
