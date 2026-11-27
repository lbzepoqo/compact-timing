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

**Code Mode** needs the other plugin in this repo, `compact-timing-code-mode` (see [Code Mode](#code-mode)). Claude Code turns Code Mode off at startup when an installed mod listens to `tool.call` (and a few other tool events), and this plugin has to, since only a `tool.call` hook can answer its `mark` tool.

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
- A `busy` mark stays until the model replaces it, also through a `/compact` (one you type, or a host's such as T3 Code's idle compaction): the plugin never compacts under it, so that compaction lands in the middle of the step. Claude Code's own compaction (`autoCompactWindow`, a prompt that is too long) still clears it, so a mark the model forgot to replace cannot hold the plugin off for the rest of the session. Before 0.15.2 any compaction cleared it. Each session has its own mark.
- Interrupting a turn drops a `boundary` mark and skips the compaction; a `busy` mark stays.

### Compact and resume

A plugin can compact only between turns, so a long turn (a feature build, a whole debugging session) keeps growing until it ends. When steps of the current request remain, the model sets `boundary` with `resume` at a point where the work is saved. If the context has reached `boundaryTokens`, the tool tells the model to end the turn with a one-line status; the plugin compacts and sends the focus back as a prompt, so the work goes on without you typing "continue".

- An interrupted turn or a skipped compaction sends no prompt.
- A `boundary` without `resume` that can compact gets an answer saying that nothing runs after the compaction until a new prompt arrives: a model waiting for CI, a pull request or a background task should end the turn only when something will send a prompt once it is done, and otherwise wait in the turn or set `resume`. Twice before 0.16.0 a model ended the turn waiting for a CI run that no notice would report, and the thread sat idle until the user asked whether it was stuck.
- After 10 automatic resumes in a row, the plugin stops and asks you to type "continue".
- A message you queue during the long turn may run before or after the resume prompt.

### Reminders to the model

The model often forgets the tool, so the plugin adds short notes at the moments a mark is most useful:

- **After a `git commit`** (through Bash or PowerShell), when the context has reached `boundaryTokens` or the mark is `busy`: set the mark. A commit is the most common task boundary. The command must have committed: its output has a line git prints for a commit (`[main 5815a99] Fix the parser`, ` 2 files changed`, ` create mode 100644 a.ts`), or the commit ran with `-q`, or the command printed nothing at all. A command that holds the words and prints something else, such as an `echo`, a dry run or a prompt passed to another program, gets no reminder, unless the words include `-q`. Neither does a commit whose own output was sent away while the rest of the command printed (`git commit -m x >/dev/null && git log -1`), except in pointer mode, where the plugin reads git's record of HEAD after the command (see [The work digest](#the-work-digest)). Under a `busy` mark the words are enough, as before 0.12.0: that reminder only asks whether the step is done, and it is what gets a stale mark replaced.
- **Inside a long turn**, on the first tool result at `softTokens` or more: as soon as the work is saved (a commit that succeeded among the calls the model just made counts; otherwise the next commit, plan or notes file), set `boundary` with `resume` and end the turn. Once per compaction. A commit reminder at that moment comes with it, since only the nudge says how many tokens the context holds; when that reminder names `resume`, the nudge shrinks to the token count and says this commit is the point to set the mark, on the same result (in Code Mode, a script's commit gets both in the separate note). Before 0.13.0 any commit reminder replaced it, and before 0.15.3 the reminder that names `resume` still did; in 2 of 2 such cases the model did not act on that reminder.
- **On a prompt at `boundaryTokens` or more** (a topic switch without a commit gets no mark): suggest `/clear` if the request is unrelated, a short handoff if it needs a few facts, or set `boundary` at the next break if it continues the work. Once, and again only after the context falls below `boundaryTokens`. Turn off with `contextNote`.

### What every summary keeps

Every summary of the main conversation, including the one for a `/compact` you type and Claude Code's own, gets two extra requests:

- **Your open steps.** Keep each step, command or question the model gave you that you have not yet reported done or answered, commands exact. Claude Code's summary lists the model's own pending tasks but not yours; in one session it dropped a four-step test the model had just asked for, and the model then denied asking.
- **How to search the transcript.** End with a `command grep -oE` line that shows 200 characters around a term (noting to keep `command`, since Claude Code's shell may shadow bare `grep` with `ugrep`, which rejects `.{0,200}` as too complex), since the transcript's lines are long JSON records.

A third request is added when the last shell command failed, nothing was committed after it and at most 20 tool calls followed it (the mark tool's answer in pointer mode uses the same rule): if the step it belongs to is unfinished, keep what was being tried, the exact error text and what was already ruled out. The models tested do not set `busy` while debugging, so without it a compaction at `softTokens` can land inside a debugging step with nothing asking the summary to keep its details. A search that matched nothing counts as failed too, which is why the request is worded as a condition.

When Claude Code compacts on its own (at `autoCompactWindow`, on a prompt that is too long, or while idle, including its precompute), or a bare `/compact` runs, whether you type it or a host sends it (T3 Code's idle compaction), the plugin passes the mark's focus as the instructions, so a `busy` step keeps what it needs. A `/compact` with text of its own keeps that text, and a `busy` focus is added after it. A `busy` focus comes with a line asking the summarizer to keep its details only if the conversation shows the step still unfinished and your text does not say to drop them, and then to say the step is still marked `busy`, since the mark may outlive its step. Another plugin's direct compaction and a subagent's get nothing added. Before 0.15.1 (Code Mode plugin 0.2.1) a bare `/compact` got no focus, and before 0.15.2 (0.2.2) a `/compact` with text dropped it and the focus came without that line.

### How a plugin compaction shows up

The plugin compacts by running `/compact` with a label and the focus, so it works in headless and SDK sessions (T3 Code, `claude -p`) too, and the transcript shows that command as a prompt from the plugin. Claude Code records it with the trigger `manual`, like a `/compact` you type, so the summary starts with a line that tells them apart:

> Compacted by the compact-timing plugin at 214k tokens, at a `boundary` mark

Each compaction also shows a toast with the size. A compaction that fails or is skipped shows a toast and a transcript line, which SDK hosts show too.

## Pointer mode

Off by default. With `pointerMode` on, the plugin's compaction at a `boundary` mark makes no summary. It replaces the conversation with one message that holds:

- the mark's focus, which the model is asked to write as a handoff: goal, what is done, next step, open decisions, what it ruled out and why, file paths;
- the requests you typed this session, verbatim: the first three and the newest five, each up to 2,000 characters, with a count of the ones between, so your own words are there next to the model's paraphrase in the focus. After them comes the newest message an SDK host sent in your place, marked as not yours, with a count of all of them;
- the open user steps, which the model lists in `userSteps` because no summarizer runs to find them;
- a digest of the work after the last commit, up to 20,000 characters, the newest kept (see [The work digest](#the-work-digest));
- the model's last message, up to 3,000 characters (steps it gives you after setting the mark are in there);
- the files the model wrote this session with Write, Edit or NotebookEdit, each once, at most 40 (files changed through Bash are not listed);
- the uncommitted changes: `git status --porcelain` at the moment of the compaction, with untracked files, at most 40 lines, so files changed through a shell command and work that is not yet saved show up. Left out where the folder is not a git repository. The status runs with `--no-optional-locks`, so it cannot block a `git add` or `git commit` you run at that moment;
- the transcript path, with the same search line a summary ends with;
- `git log` since the session started, at most 40 commits with authors, so pulled-in commits stand out. If git fails, the message says why.

The message starts with "Compacted by the compact-timing plugin at 214k tokens, at a `boundary` mark, in pointer mode". A resume after it tells the model to continue from the focus and to check its last message, the commits and `git status` before repeating a step.

### Adaptive: a summary when the pointer would be thin

A pointer is only as good as its focus. With `adaptivePointer` on (the default in pointer mode), the plugin makes a summary instead when:

- the mark has no focus;
- the focus is under 200 characters;
- the last shell command failed with error text, nothing was committed after it, and at most 20 tool calls followed it: an unfinished step whose details a digest cuts. A failure that printed only its exit code (a search that matched nothing, `test -f`, `git diff --quiet`) does not count; the pointer and the mark tool's answer still name it.

The summarizer gets the focus and the request to keep the unfinished step, as any summary does, and the plugin adds one message right after the summary with the pointer's parts a summary paraphrases or cannot know: the focus as written, your requests verbatim, the open user steps, the files written, the uncommitted changes, the transcript path and the commits. The work digest and the last message are left out, since the summary covers them. The message says why a summary was made, and a transcript line says so too. A resume after it reads as after a summary. A summary that is skipped gets nothing added.

This costs the summarizer's time and tokens only where the pointer would be weakest. Set `adaptivePointer` to false for a pointer at every `boundary` mark with a focus, as before 0.15.0.

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
- with a focus under 200 characters: it is all the next context gets, so call again with a fuller one if it leaves something out, keeping `resume` and `userSteps`. In adaptive mode: a summary will be made, and a fuller focus makes it a pointer alone;
- when the last shell command after the last commit failed: set `busy` if the step is unfinished, or say in the focus what failed. In adaptive mode: a summary that keeps the step will be made, and `busy` if the step is unfinished.

Every other compaction still makes a summary: with no mark at `softTokens`, a `/compact` you type, Claude Code's own, and a subagent's. The plugin also falls back to a summary, with a transcript line saying so, when the transcript path is unknown, and with `adaptivePointer` off when the mark has no focus. It learns the path from Claude Code's classic SessionStart and UserPromptSubmit events, since the plugin API has no other way to get it.

The requests and files are recorded as the session runs, because the plugin can read at most 4 MiB of a file and a long transcript is larger. They start from when pointer mode is on, so a session that was already running when you turned it on lacks the earlier ones, and a `/clear` empties them. A request is a prompt that counts as yours for the context note too: typed, from Remote Control or from an SDK host such as T3 Code. Slash commands and the plugin's own resume prompts are left out. An SDK host also sends messages of its own as prompts. Of T3 Code's, the plugin keeps only the newest result of a delegated task, pull request notice or context handoff, outside the requests, since before 0.16.0 they filled the newest five: in 11 of 120 pointers none of the newest five was yours. A context handoff ends with the message you typed, which is kept as a request. A message another agent sends to a delegated thread stays a request: it is that thread's task, and its first line says who sent it.

The plugin answers the pointer compaction itself, so a compaction hook from another plugin that runs after compact-timing's does not run for it. An adaptive summary goes through those hooks as any summary does.

## Code Mode

```sh
claude plugin install compact-timing-code-mode@compact-timing
claude plugin disable compact-timing@compact-timing
```

If you installed `compact-timing` from the `lbzepoqo/claude-plugins` marketplace, disable `compact-timing@lbzepoqo` instead. Keep one of the two plugins enabled, not both: with `compact-timing` enabled Code Mode stays off, and both would compact. The Code Mode plugin listens to no tool event, so Code Mode stays on. What differs:

- **A skill instead of a tool.** The model sets the mark with the `compact-timing-code-mode:mark` skill. Its arguments are lines: the first is `boundary`, `boundary resume` or `busy`, and the focus goes on the lines after it. The plugin answers the skill in its `skill.prompt` hook, so the model reads the plugin's answer (the mark set, and whether to end the turn now) instead of the skill's text.
- **Reminders as text.** The commit reminder and the size nudge are added to the result of the shell call the model made itself. A call the model's JavaScript made in Code Mode is recorded only after the script ran, with no output, so its reminder comes as a separate note, and whether it committed is read from the session folder's HEAD reflog (`git reflog`) since the script started. The scripts of one step get one reminder, so a later commit command of theirs, which may have committed nothing, brings no second one. A command that may commit in another folder (`cd`, `pushd` or `Set-Location` where a command starts, `git -C` before the subcommand, also after git's own options, `--git-dir`, `GIT_DIR=`; not those words in a commit message) gets the reminder without that check when the session folder's reflog shows nothing. A commit in a folder that an earlier command moved the shell to gets no reminder, since the plugin doesn't see that move. Any commit in the session folder since the script started counts, so a script whose commit failed while a subagent or another session committed there still gets the reminder.
- **Subagents.** The skill's hook isn't told which agent called it, so the plugin records each call that may run the skill, with whose it is, and matches the skill's arguments to them. A direct call whose result comes before the skill ran (it was denied or failed) is dropped. In Code Mode both the main conversation and subagents call the skill from a script; the plugin reads a script's arguments when the script is only that call, with the arguments as a plain string, as the model writes it. When two agents have a call waiting at the same time with the same arguments, or a script whose arguments can't be read, the skill's run can be matched to the wrong one. A subagent's call sets no mark.
- **No pointer mode.** The work digest needs each call's output, which those recorded calls don't hold. Every compaction is a summary, with the same instructions as `compact-timing`'s.
- **Settings:** `boundaryTokens`, `softTokens` and `contextNote`, as below, under `compact-timing-code-mode@compact-timing`.

Tested with Claude Code 2.1.325 and Sonnet in the terminal. Both plugins install from this repo's marketplace; the installed `compact-timing` lists no skill and still adds its `mark` tool. The runs below loaded the plugin with `--plugin-dir`, the subagent one from the installed copy:

- With Code Mode on and with it off, the commit reminder reached the model, and after a `boundary resume` call of the skill the plugin ran `/compact` at the end of the turn and sent the focus back as a prompt; the model did the remaining step. The prompt told the model to call the skill, so this does not show how often it calls it unprompted.
- In Code Mode, a subagent's call of the skill was refused and nothing compacted; a call from the main conversation in the same session set the mark.
- In Code Mode, a `git commit` with nothing staged got no reminder, a commit that worked got it, and the size nudge came at `softTokens`.
- Code Mode runs only in an interactive terminal, so SDK and headless sessions were not tested. The skill's arguments arrive as written, except that the engine turns a line that starts with `!` into `\! `; the plugin undoes that.

## Settings

| Option | Default | Meaning |
|---|---|---|
| `boundaryTokens` | 200000 | Context size at which a `boundary` mark compacts |
| `softTokens` | 300000 | Context size at which the plugin compacts without a mark |
| `contextNote` | true | Send the note on a prompt once the context reaches `boundaryTokens` |
| `pointerMode` | false | At a `boundary` mark, replace the conversation with a pointer instead of a summary |
| `adaptivePointer` | true | In pointer mode, make a summary with the pointer's parts after it when the focus is missing or under 200 characters, or the last shell command failed (see [Adaptive](#adaptive-a-summary-when-the-pointer-would-be-thin)) |

Change them with `/plugin configure compact-timing@compact-timing` in Claude Code, or from the shell:

```sh
echo '{"boundaryTokens": "150000"}' | claude plugin configure compact-timing@compact-timing --values-stdin
```

## Results and limits

- **Daily use.** In three weeks of my own sessions (`boundaryTokens` 120k, `softTokens` 200k), Claude Code's hard-limit compaction never ran and the plugin compacted 251 times. 37% of those ran at 200k or more because a long turn kept growing; compact and resume (0.9.0) targets that, and in a live test Sonnet compacted and resumed twice in a three-step task without help.
- **Size nudge in daily use.** In my sessions started from 0.9.0 (2026-11-04) to 2026-11-12, 12 stretches between compactions passed 200k. In the 9 where the nudge came, the context peaked at 220k at most. In 1, a commit reminder under a `busy` mark had taken its place (fixed in 0.13.0), and it grew to 345k. In the other 2, the commit reminder that names `resume` came instead and the model did not act on it (241k, 381k); since 0.15.3 both come.
- **Marks.** After committing a bug fix, Opus, Sonnet and Haiku each set `boundary` with a useful focus. None set `busy` while searching for the bug. Without the commit reminder, Opus set no mark at all.
- **Search line.** On a manual `/compact` of a short session, the summaries of Opus, Sonnet and Haiku each ended with the transcript search line.
- **Headless sessions.** Before 0.9.1 the plugin never compacted in SDK sessions, and the only sign was a toast those hosts do not show. The `/compact` path is tested in an SDK session and in the terminal.
- **Pointer mode.** Tested in two headless stream-json sessions with Haiku: 28k tokens became 0.4k in 5 ms with no summary request. With `resume`, Haiku checked `git status` and `git log`, then did the remaining step from the focus, but did not search the transcript for a command the focus only described.
- **Pointer mode in daily use.** In 2 weeks (0.11.0 to 0.15.5), 120 pointer and 35 boundary-summary compactions (the summaries are from the 8 days before pointer mode); redone work 0/120 vs 0/35, asked again 0/120 vs 0/35, median tokens after compaction 3.2k vs 14.5k (the whole context on the next request in T3 Code sessions: 50.6k vs 50.8k). 52 of 53 automatic resumes after a pointer finished their step without help; the other stopped at the account's usage limit. In the next three turns, 38% of pointers and 26% of summaries led to a search of the session's own transcript, at about 700 tokens each.
- **Commit reminder, uncommitted changes and the shorter tool (0.12.0).** Tested in one headless session with Haiku: a commit, then a staged file and `git commit --dry-run`, then a `boundary` mark. The reminder came after the commit and not after the dry run, the pointer listed the staged file under the uncommitted changes, and Haiku still filled in `focus` and `userSteps` with their descriptions cut to one line. In pointer mode the tool's description and schema went from 2,990 to 2,454 characters, which every request carries. The request to keep an unfinished step in a summary is covered by unit tests only.
- **Work digest and mark answer.** Tested in one headless session with Haiku: a commit, then a shell command that failed, then a `boundary` mark with a 28-character focus. The tool's answer named the short focus and the failed command, and the pointer's digest held only that command and its error, not the committed steps before it. Haiku ended the turn without writing a fuller focus, so the answer informs the model but does not make it act. Adaptive mode (0.15.0) answers that case with a summary, and is covered by unit tests only.
- **Commits in daily use.** Counted over my own transcripts from 2026-09-21 to 2026-11-12: 1,303 shell commands held `git commit` as shell code and did not fail, and about 80% of all commit commands used `-q`. Git's commit line was in the output of only 3 of those that ran in a repository, so before the digest read the reflog it found almost no commit.
  - 955 ran in a session whose folder is a git repository with reflog entries going back to that time. The other 348 ran where the folder is not a repository (229) or before its oldest reflog entry (119).
  - 379 of the 955 committed in the session's folder itself, without `cd` or `git -C`. The reflog shows a commit made during 376 of them; the other 3 committed nothing.
  - The other 576 changed folder first, and the session folder's reflog shows a commit during 125 of them. In 280 a commit made during the call is on a branch of the repository but not in that reflog; the ones looked at had gone into another worktree. The plugin now also reads the reflog of a worktree the command names; how many of the 280 that finds was not measured. Two wider counts over all my transcripts, without the date and reflog limits above: of the commit commands that did not fail in a repository folder and changed folder first, 489 named the folder by full path, 102 by a `~` path, 3 by a relative path and 9 by a shell variable; of all commit commands that changed folder first, failed ones included, 1,137 of 1,201 gave the message with `-m` or a heredoc, which the subject check needs.
- **Commits by the reflog.** Tested in one headless session with Haiku in pointer mode: `git switch -q -c fix && git add -A && git commit -qm one && git switch -q -`, which printed nothing and ended on the branch it started from, then `git add -A; git commit -qm reject-two; git log --oneline -1`, which a commit-msg hook rejected while the command still printed the previous commit. The pointer's digest started after the first command and held the second with its `lint failed`. The reminder for a commit whose own output was sent away is covered by unit tests only.

## Develop

```sh
claude plugin validate .
claude plugin test .
claude plugin validate code-mode
(cd code-mode && claude plugin test .)
```

Both plugins share the logic in `code-mode/hooks/logic.ts`: a plugin can import only files inside its own folder, and `code-mode` sits inside the root plugin's. The root run also picks up `code-mode/tests`; its tests that need the Code Mode plugin's hooks return at once there, so run them from `code-mode`.
