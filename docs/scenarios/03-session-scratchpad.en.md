# Scenario: the session scratchpad (session-layer temporary tasks)

[简体中文](https://github.com/pure-craft/dsh-actions/blob/main/docs/scenarios/03-session-scratchpad.md) ｜ **English**

> Back to [README](https://github.com/pure-craft/dsh-actions/blob/main/README.en.md) ｜ related: [The session layer](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/session-layer.en.md) ｜ scenarios: [Curating scattered script entry points](https://github.com/pure-craft/dsh-actions/blob/main/docs/scenarios/01-curate-scripts.en.md) ｜ [CI pipeline](https://github.com/pure-craft/dsh-actions/blob/main/docs/scenarios/02-ci-pipeline.en.md)

## The pain

Debugging always produces commands that "only make sense in this session": an Action's parameters pinned to the values this task needs, a diagnostic command thrown together on the spot, a multi-step flow the agent just figured out. Pinning them into `actions.json` is not worth it (this is session context, not project definition), but retyping them every time is a chore.

## How

Have the agent register it as a **session-level Action**:

```text
You: this diagnostic flow is good, save it, I'll need it again later in this session.
Agent: → actions_register({ label: "diag-slow-requests", command: "...", detail: "..." })
       (it asks for your approval before registering — an agent authoring an executable command
        for itself is high-risk by definition)
```

Once registered it appears in the panel's session section (`session:<label>`), one click to run and streaming output exactly like a file-layer task. Two granularities are supported:

- **Standalone command**: a complete new task;
- **Variant**: `extends` to inherit an existing task + `params` to pin values — for example deriving "deploy to staging (this session only)" from `workspace:deploy`.

## Lifecycle

- The session layer definition lives in the session's own directory (`<dshHome>/sessions/.../actions.json`) and is visible to that session only; other sessions simply cannot see it.
- It is archived when the session ends — temporary tasks leave with the session directory and never pollute project config.

## From temporary to permanent: review-and-persist

Do not let a good temporary task rot inside a session: the panel's session section offers a review entry, and when you confirm it is worth keeping, **promote it to a file layer** (written into the workspace or global `actions.json`), going through normal git review and becoming a shared project capability. That is exactly the evolution path DSH Actions wants: agent-driven discovery → trial inside the session → human review → pinned down and shared.
