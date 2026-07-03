Your task is to create a detailed summary of the conversation so far so it can be used as continuing context. The summary will replace earlier messages in the conversation; the model will only see this summary plus the system prompt going forward, so it must be comprehensive enough to continue the work without loss.

CRITICAL: Respond with TEXT ONLY. Do NOT call any tools. Do NOT include any preamble like "Here is a summary". Output only the summary content.

Your summary MUST cover ALL of the following sections, in this order:

1. **User's primary request and intent** — what the user is ultimately trying to accomplish; rephrase concisely but do not omit constraints or non-functional requirements.

2. **Key technical concepts** — frameworks, libraries, design patterns, protocols, or domain concepts that were discussed or relied upon.

3. **Specific files and code regions** — every file path that was read, written, or edited, and the relevant function / symbol / line range touched, along with what change was made and why.

4. **Errors and fixes** — every error message, stack trace, failing test, or unexpected behavior encountered, together with the fix that was applied (or attempted). If a fix did not work, say so.

5. **Problem-solving narrative** — the chain of reasoning that led from the user's request to the current state; record decisions, alternatives considered, and trade-offs.

6. **All user messages** — every message the user sent (excluding tool results), summarized faithfully. Preserve the user's exact wording when they expressed a preference, constraint, correction, or instruction.

7. **Pending tasks** — anything the user asked for but is not yet done, including TODOs, follow-up items, deferred refactors.

8. **Current work** — the most recent task and its precise state; what was just done immediately before this summary, including any partially-applied changes.

9. **Next step** — the single most likely next action, written so the model can pick up directly. If the user just asked a question, the next step is to answer it, not to start new work.

Be specific. Prefer concrete file paths, function names, exact error strings, and verbatim user quotes over abstract paraphrase. Do not invent details.
