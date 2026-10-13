---
name: dsh-actions-authoring
description: Use whenever discovering, running, monitoring, cancelling, creating, updating, or deleting DSH Actions, or when authoring actions.json definitions. Covers actions_query/actions_run/actions_cancel/actions_configure, layer precedence, inputs, approvals, and run conflicts.
---

# DSH Actions authoring guide

DSH Actions exposes one deterministic task definition to people in the Web panel and to agents through four tools: `actions_query`, `actions_run`, `actions_cancel`, and `actions_configure`. At session start, concise summaries of currently callable Actions and this tool mapping are injected into runtime context; use `actions_query` for progressive disclosure of full details and output.

## Core constraints

- Definitions live only in `~/.dsh/actions.json`, `<workspace>/.dsh/actions.json`, the session layer, or a session-selected folder. Do not create a second registry.
- Every file declares `"version": "1.0.0"`.
- Runs are session-owned. The Host never interrupts an active run implicitly; stop it with `actions_cancel` before rerunning.
- Respect `approval-declined`; never retry or bypass approval through shell.
- Configuration approval and execution approval are separate decisions.
- Never persist secrets in input defaults or environment values.
- All `actions_*` tools are bound to the calling session workspace and expose the same catalog as its Actions panel. They cannot target another workspace; editing files in a nested repository does not change the session workspace.

## Route to a reference

- Creating or editing definitions, choosing fields/layers, or using inheritance: read [references/authoring.md](references/authoring.md).
- Discovering, running, inspecting output, cancelling, or configuring through tools: read [references/operating.md](references/operating.md).

The installed tool descriptions are the authoritative argument reference.
