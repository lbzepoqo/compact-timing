# compact-timing

Claude Code compacts a conversation when it reaches a fixed token count. That can happen in the middle of a debugging session, when the details exist only in the conversation. It can also happen long after a task ended, when compacting would have lost nothing.

This plugin lets the model choose the moment. The model sets a mark when it finishes a task or starts a step that must not be compacted, and the plugin compacts at the end of a turn when the mark and the context size allow it.

## How it works

The plugin gives the model a tool, `mark`, with three inputs: the state, a focus that says what the summary must keep, and `resume` (see Compact and resume). The focus is passed to the compaction as its instructions, together with a request to keep the user's open steps (see below) and to end the summary with how to search the full transcript (`command grep -oE` with a 200-character window around the term), since Claude Code's own pointer says to read it and its lines are long JSON records.

| Mark | Meaning | The plugin compacts at the end of the turn when the context contains |
|---|---|---|
| `boundary` | A task is done and its state is saved (committed, or in a plan file) | 200k tokens or more |
| none | No mark since the last compaction | 300k tokens or more |
| `busy` | A step is in progress whose details exist only in the conversation | never |

The token counts in the table are the defaults of `boundaryTokens` and `softTokens` (see Settings).

A `boundary` mark counts only at the end of the turn in which the model set it. The plugin drops the mark when that turn ends, also when it did not compact, so the mark cannot cause a compaction later in the middle of other work. When you interrupt the turn, the plugin drops the mark and does not compact. A `busy` mark stays until the model replaces it. Any compaction clears the mark. Each session has its own mark.

After a `git commit`, the plugin reminds the model to set the mark when the context has reached `boundaryTokens`, or when the mark is `busy`. A commit is the most common task boundary, and without the reminder the model often forgets the tool. Below `boundaryTokens` a `boundary` mark has no effect, so without a `busy` mark there is no reminder.

### Compact and resume

A plugin can compact only between turns, and a long turn (a feature build, a whole debugging session) keeps growing until it ends. So when steps of the current request remain, the model sets `boundary` with `resume` at a point where the work is saved. When the context has reached `boundaryTokens`, the tool answer tells the model to end the turn with a one-line status. The plugin compacts and then sends the focus back as a prompt (after a pointer, a prompt to continue from the pointer's focus), so the work goes on without you typing "continue". An interrupted turn or a skipped compaction sends no prompt. After 10 automatic resumes without a prompt from you, the plugin stops and says so in a toast and a transcript line. A message you queue during the long turn may run before or after the resume prompt.

Inside a turn, the first tool result that finds the context at `softTokens` or more carries a note: at the next saved point, set `boundary` with `resume` and end the turn. The note comes once until the next compaction.

The plugin compacts by running `/compact` with the label and the focus as its arguments, so the transcript shows that command as a prompt from the plugin. It does not use the plugin API's direct compaction, which does not work in a headless or SDK session (T3 Code, `claude -p`). Every plugin compaction shows a toast with the size, and its summary starts with "Compacted by the compact-timing plugin at 214k tokens, at a `boundary` mark" (a pointer starts with the same words; see Pointer mode). Claude Code records a plugin compaction with the trigger `manual`, the same as a `/compact` you type, so without the line neither you nor the model can tell them apart afterward. A compaction that fails or is skipped shows a toast and a line in the transcript, which an SDK host shows too.

### Topic switches

Switching to an unrelated topic without a commit gets no mark, and a plugin cannot compact before a prompt runs. So the first prompt that finds the context at `boundaryTokens` or more carries a note to the model: suggest `/clear` when the request is unrelated, a short handoff when it needs a few facts from the conversation, or set `boundary` at the next break when it continues the work. The note comes once, and again only after the context has fallen below `boundaryTokens`.

A `busy` mark that is never replaced stops the plugin from compacting. Claude Code's own automatic compaction still runs at `autoCompactWindow`. Keep that setting above 300k, for example:

```json
{ "autoCompactWindow": 500000 }
```

Claude Code also compacts on its own: at `autoCompactWindow`, on a prompt that is too long, and while the session is idle before the prompt cache expires. These compactions do not wait for the mark. When one has no instructions of its own, the plugin passes the mark's focus as the instructions. The same holds for the precompute Claude Code runs while the session is idle. So the summary still keeps what a `busy` step needs.

Every compaction of the main conversation gets one more request, also a `/compact` you type. It asks the summary to keep each step, command or question the model gave the user that the user has not yet reported done or answered. Commands stay exact and the rest stays short. Claude Code's summary already lists the model's own pending tasks, but not the user's. In one session the summary dropped a four-step test the model had asked the user to run shortly before the compaction, and the model then said it had never asked for it. Pointer mode makes no summary at a `boundary`, so there the model lists these steps itself (see below).

### Pointer mode

With `pointerMode` on, the plugin's compaction at a `boundary` mark makes no summary. The plugin replaces the conversation with one message, which holds:

- the mark's focus, which the model is asked to write as a handoff: the goal, what is done, the next step, open decisions, file paths;
- the open steps the model gave the user, which it lists in the mark's `userSteps` input;
- the model's last message, capped at 3,000 characters. The model sets the mark inside a turn, so steps it gives the user in the message that ends the turn come after the mark;
- the path of the session's transcript, with the same search line a summary ends with;
- `git log` since the session started, in the session's directory, at most 40 commits, each with its author, so commits a pull brought in can be told apart. If git fails there, the message says why.

The message starts with "Compacted by the compact-timing plugin at 214k tokens, at a `boundary` mark, in pointer mode". A resume after it tells the model to continue from the focus and to check its last message, the commits and `git status` before it repeats a step.

The model lists the open user steps itself because no summarizer runs. The transcript still holds them, but a model that does not know it gave a step does not search for it. That is the failure described above.

All other compactions keep the summary: the plugin's compaction with no mark at `softTokens`, a `/compact` you type, Claude Code's own (`autoCompactWindow`, a prompt that is too long, idle, precompute), and a subagent's. If the plugin does not know the transcript path, or the mark has no focus, it makes a summary and says so in a transcript line. It records the path from Claude Code's classic SessionStart and UserPromptSubmit events: the plugin API has no other call that gives it.

The plugin answers the pointer compaction itself, so another plugin's compaction hook that would run after compact-timing's does not run for it.

## Install

```sh
claude plugin marketplace add lbzepoqo/compact-timing
claude plugin install compact-timing@compact-timing
```

Restart Claude Code. The `lbzepoqo/claude-plugins` marketplace also lists it, as `compact-timing@lbzepoqo`, from this repo.

## Settings

| Option | Default | Meaning |
|---|---|---|
| `boundaryTokens` | 200000 | Context size at which a `boundary` mark causes compaction |
| `softTokens` | 300000 | Context size at which the plugin compacts when there is no mark |
| `contextNote` | true | Send the note about a fresh session when the context reaches `boundaryTokens` |
| `pointerMode` | false | At a `boundary` mark, replace the conversation with a pointer instead of a summary (see Pointer mode) |

Change them with `/plugin configure compact-timing@compact-timing` in Claude Code, or from the shell:

```sh
echo '{"boundaryTokens": "150000"}' | claude plugin configure compact-timing@compact-timing --values-stdin
```

## In daily use

In three weeks of my own sessions (`boundaryTokens` 120k, `softTokens` 200k), Claude Code's hard-limit compaction never ran, and the plugin compacted 251 times. The weak spot was long turns: 37% of those compactions ran at 200k or more, because a turn kept growing until it ended. Compact and resume in 0.9.0 is aimed at that; in a live test Sonnet compacted and resumed twice in a three-step task without help.

## Limits

- In a test, Opus, Sonnet and Haiku each set `boundary` with a useful focus after they committed a bug fix. None of them set `busy` while it searched for the bug. Without the commit reminder, Opus set no mark at all.
- In a test of a manual `/compact` on a short session, the summaries of Opus, Sonnet and Haiku each ended with the transcript search line.
- Before 0.9.1, the plugin never compacted in a headless or SDK session (T3 Code, `claude -p`), and the only sign was a toast that SDK hosts do not show. The `/compact` path was tested in both an SDK session and the terminal.
- Pointer mode was tested in two headless stream-json sessions (the SDK's transport) with Haiku. The pointer replaced the conversation, and no summary request was made: 28k tokens became 0.4k in 5 ms. With `resume`, Haiku checked `git status` and `git log`, then did the remaining step from the pointer's focus. It did not search the transcript for the exact commit command that the focus called "the same way". Pointer mode has not been compared with summaries in daily use yet.

## Develop

```sh
claude plugin validate .
claude plugin test .
```
