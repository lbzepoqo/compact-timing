---
name: mark
description: "Sets the compaction mark; the compact-timing plugin compacts at task boundaries instead of at a fixed token count. Args: first line `boundary` or `busy` (add `resume` after `boundary`), then the focus on the next lines. `boundary`: call after a task or milestone whose state is saved outside the conversation (committed, or in a plan or notes file); the plugin compacts at the end of that turn when the context is past its boundary size, and the mark is dropped when the turn ends either way. `busy`: call before a step whose details exist only in the conversation, such as a debugging sequence or reading test output; nothing compacts while it is set, so call `boundary` when the step is done. Focus: what the summary must keep (the next step, open decisions, file paths). `resume`: steps of the current request remain; end the turn when the answer says so, and the plugin compacts and sends the focus back as a prompt. Without a mark the plugin compacts at its soft limit. Any compaction clears the mark."
---
If this text reaches you, the compact-timing-code-mode plugin did not answer, so no mark was set.

compact-timing mark arguments:
$ARGUMENTS
