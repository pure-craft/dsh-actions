# Feature: agent integration

[简体中文](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/agent-integration.md) ｜ **English**

> Back to [README](https://github.com/pure-craft/dsh-actions/blob/main/README.en.md) ｜ related: [Configuration reference](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/configuration.en.md) ｜ [The session layer](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/session-layer.en.md) ｜ [The panel](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/panel.en.md)

One Action is offered in two forms: a click in the panel (for a person), and a set of structured tools (for an agent). The semantics on both sides are identical — the same catalog, the same conflict protocol, the same approval gate.

When a new session starts, the plugin injects concise summaries of the Actions available to the agent into runtime context: stable id, label, detail, approval requirement, and input hints, together with the role of each of the four tools. `visibility: ui` Actions are excluded. Full commands and configuration remain progressively disclosed through `actions_query`, rather than bloating the initial prompt with the whole catalog.

## Agent tools

| Tool | What it does |
| --- | --- |
| `actions_query` | lists the normalized task summaries for the current workspace (id, label, detail, source layer, approval requirement, latest run state in this session) — the first level of progressive disclosure |
| `actions_run` | starts a task by id, optionally with `params`; with `wait: true` it blocks synchronously until a terminal state (capped at 60s, returning the current state on timeout) — short tasks (check/test/lint) get a terminal state with zero polling, long ones (dev/publish) omit it and follow up with `actions_query`; returns a structured result (below) |
| `actions_query` | reads the full definition and run output (by `runId` or `actionId`; the `actionId` form supports byte-offset incremental reads) |
| `actions_cancel` | cancels a run in this session (the only way to stop something explicitly; safe to call on a run already in a terminal state) |
| `actions_configure` | strictly creates, updates, or deletes Actions in the `global`, `workspace`, or `session` layer; create rereads the current layer after approval and rejects label collisions, while update/delete use entry revisions to prevent overwrites; every write **always requires user approval** |

None of the four tools accepts a `workspace` argument. They are always bound to the calling session's workspace and use the same catalog as that session's Actions panel. They cannot query, run, or configure another workspace; merely editing files in a nested repository does not change the session workspace.

The result of `actions_run` is a discriminated union: `started` (new instance), `already-running` (reuse — the existing instance is returned), `rejected` (exclusive policy), `approval-declined` (approval not granted, no instance started). After a conflict result the agent must **never interrupt implicitly** — cancellation is always an explicit `actions_cancel`.

## Approval flow

For a task with `approval: "agent"` or `"always"`, an agent calling `actions_run` asks the user first, through the host's approval channel; the answer comes back as `approval-declined` (`rejected` / `cancelled` / `unavailable` — the last means the deployment has no approval channel, in which case it fails closed). The agent's correct posture is to respect the refusal: no automatic retry, no shell detour. `actions_configure` likewise always requires approval (an agent authoring an executable command for itself is high-risk by definition).


### One-time elevation and failure retry

- `approval: never`: inherit the session sandbox, with no automatic elevation.
- `approval: agent/always`: evaluate parameters first; show the actual command, directory and one-time `danger-full-access` in one combined approval. The session policy is unchanged. Rejected, cancelled or unavailable approval starts nothing.
- Failure summaries record `sandboxMode`. `failureKind: sandbox-denied` means the Host reported a denial; `permission-error` means output only suggests a permission problem, not a confirmed sandbox denial. `failureHint` provides recovery guidance; ordinary business failures do not recommend elevation.
- Inspect output and partial side effects first, then request a retry as below. Do not combine it with `actionId` or `params`. Only retained failed runs in this session and workspace are eligible; runs already using full access cannot be escalated again.

```json
{ "retryRunId": "run-3", "justification": "git fetch needs worktree Git metadata outside the workspace; verified the previous attempt did not create an MR", "wait": true }
```

Retries reuse the original evaluated command, directory, Action environment overrides and parameters, without reading the current catalog or substituting variables again. Script contents and the inherited Host environment are not frozen. Every retry requires a new approval and executes the entire Action; the new run links to the failed record through `retryOf`. Records are memory-only; evicted records and records from before a Host restart cannot be retried. Normal conflict rules apply; active instances are never stopped implicitly.

## Composer integration

- **Referencing**: typing `/` in the composer opens a menu to pick a task (candidates carry the `actions:` prefix), inserting a `☰ actions:<label>` chip; the @ button on a panel row inserts the same reference token. On send, the codec expands the chip into an **action brief** — "use Action `<label>` (id: …). Required: … (select options)" — which is what lets the agent call it precisely (the full command text is available afterwards via `actions_query`). Referencing a panel-only task (`visibility: ui`) explicitly tells the agent it cannot run it and should hand it back to the user.
- **Sending into the conversation**: the @ button on a task row inserts that same reference token into the composer — "keep working on this failed output" goes from copy-paste to one click.

## Authoring guidance shipped with the package

The plugin bundles a `dsh-actions-authoring` skill (versioned with the package, registered by the Host): it gives the full field reference and curation guidance when writing config, and the query→run→query→cancel rhythm plus conflict/approval rules when operating tasks. Schema changes update it in lockstep with the plugin (enforced by the project's contributor convention).

## Visibility and isolation

The agent only sees tasks with `visibility: all | agent`; run state is isolated per session — an agent can see and cancel only runs from its own session, and cross-session access is always `run-not-found`. Within one session, the person and the agent share the same view of runs.
