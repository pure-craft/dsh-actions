# Operating project actions with the `actions_*` tools

Read this when your task is running or managing actions, not writing them. For the definition schema, see [authoring.md](authoring.md). Parameter details live in the tool descriptions — this guide covers rhythm and judgment.

## Contents

- [The basic rhythm](#the-basic-rhythm-list--run--inspect--cancel)
- [Handling conflict outcomes](#handling-conflict-outcomes)
- [Parameters and approval](#parameters-and-approval)
- [Session-layer actions](#session-layer-actions)
- [Long-running services](#long-running-services-dev-servers-watchers)
- [Multiple instances and runId addressing](#multiple-instances-and-runid-addressing)
- [What the human sees vs. what you see](#what-the-human-sees-vs-what-you-see)

## The basic rhythm: list → run → inspect → cancel

**1. `actions_list` first.** It returns summaries only: id, label, detail, source layer, approval requirement, and the status of your own session's latest active run (`idle` when none), plus its `runId` when active. Use the ids from here everywhere else. If the human mentions an action you cannot see, the likely cause is `visibility: "ui"` — those entries are panel-only by design; do not try to work around it.

**2. `actions_run` to start.** It returns one of the structured outcomes (next two sections). Keep the returned run's `id` — every later operation addresses runs by `runId`. When the action declares `inputs`, pass their values in the `params` argument.

**3. `actions_inspect` to follow.** Pass `runId` for a specific run, or `actionId` for the definition plus its latest run. Output is the retained window with a byte `offset`; the `actionId` form accepts that offset to read only what is new. Runs owned by other sessions read as `run-not-found` — that is isolation working, not the run being gone.

**4. `actions_cancel` to stop.** This is the only stop operation and it is always explicit. Cancelling an already-finished run is safe and returns its final summary.

## Handling conflict outcomes

`actions_run` never interrupts an active instance. What it returns tells you what happened:

- `started` — a new instance launched. Follow it with `actions_inspect`.
- `already-running` (reuse policy) — **no new instance started**; the returned run is the existing one. This is not an error: attach to the returned `runId` and inspect it. Do not retry `actions_run` in a loop hoping for `started` — you will get the same answer until the current run settles.
- `rejected` (exclusive policy) — the action is configured to never overlap. The current instance keeps running. Wait for it to finish (inspect by the returned `runId`), or, only when stopping is genuinely the intent, cancel it explicitly first.

Never cancel a run just to clear your own path. Cancellation kills a process the human may be watching in the panel; "stop and rerun" is legitimate only as two deliberate steps: `actions_cancel`, then `actions_run`.

## Parameters and approval

**Passing `params`.** Actions may declare `inputs`; supply their values as `actions_run`'s `params` object (string values). Read the declaration first via `actions_list`/`actions_inspect` — each input's `type`, `default`, and `options` tell you what is valid. If a run fails with `invalid-params` naming "missing required input parameter(s): …", that is a request to resend with those ids filled — not a broken action. `select` inputs must receive one of their `options`.

**Session-pinned parameters.** Each session has a pin board keyed by (session, action). The evaluation chain is **explicit call params > session pins > config `default`** — pins satisfy `required` inputs, and explicit params always win. Use `actions_set_params` to manage pins: `{ actionId, values }` to pin, `{ actionId, clear: true }` (or empty values) to unpin, no `actionId` to list your session's pins. Values are validated against the declared inputs and live only as long as the session — nothing is written to `actions.json`.

The point of pinning is session context you already have: when the human's goal fixes a parameter (e.g. this release pipeline targets `staging` all week), pin it **before the first run** — memory/history mechanisms can't help with a first run that hasn't happened yet. Afterwards plain `actions_run` without params picks the pins up automatically. Pin deliberately: a pin changes what later runs default to, so prefer pinning over re-passing the same values, and unpin when the context ends.

**Parameters join the conflict key.** The conflict key is (session, action, params): the same action with different parameter values does not conflict — two `deploy` runs for different environments coexist. `already-running` / `rejected` trigger only when the params match too.

**`approval-declined`.** Actions with `approval: "agent"` or `"always"` ask the user before starting; the answer surfaces as `approval-declined` with outcome `rejected` (declined), `cancelled` (dismissed), or `unavailable` (the deployment has no approval channel — the action fails closed). Respect the refusal: do not retry automatically, do not route around it with shell commands, and do not treat it as a transient error. `approval-declined` means no instance exists at all — unlike the conflict `rejected`, there is nothing to inspect. Only re-attempt when the human explicitly asks.

## Session-layer actions

Beyond the shared file layers there is a per-session layer (`session:<label>` ids), visible only to your session. `actions_register` writes a new action into it — the canonical way to capture a workflow you discovered mid-session. Two facts shape how you use it:

- **Registration always asks the user first.** An agent-authored command is high-risk; expect the approval prompt, and treat a decline as final (same etiquette as `approval-declined` on runs).
- **`extends` inherits, `params` pins.** Registering with `extends: "<layer>:<label>"` bases the new action on any action visible in your session — including a shadowed one: references resolve against each layer's own raw entries, so `extends: "global:build"` hits the global file's `build` even when the workspace overrides it, and chains resolve in any declaration order. Add `params` to pin input values at the same time. An entry whose `extends` target does not resolve stays listed but fails at run with `unknown-extends` — define the target or fix the reference.
- **Invalid input is self-correcting, not fatal.** If registration answers `registered: false, reason: "invalid-entry"`, the attached `issues` list every field-level problem (`path` + `message`) — fix exactly those fields and resend; do not retry unchanged or abandon the task.
- **There is no agent-side delete.** Removing a definition is a panel-only, human-confirmed operation. If a session action should go away, say so and let the human remove it (or simply let it die with the session).

The session layer's file may not exist until the first registration — an empty session layer is normal. When a session action proves durable, suggest the human promote it to a file layer from the panel (review-and-persist) rather than leaving session state to carry project knowledge.

## Long-running services (dev servers, watchers)

- **Start** with `actions_run` and keep the `runId`.
- **Readiness**: there is no ready-pattern or health-check mechanism — do not invent one. Poll `actions_inspect` (the `actionId` form takes an `offset` for incremental reads) and judge readiness from the log text itself (e.g. the "Local: http://…" line a dev server prints).
- **Stop** with `actions_cancel` on the `runId`. **Restart** is cancel + run, two explicit calls.
- Runs live in memory and do not survive a Host restart; if tools suddenly report nothing, `actions_list` again to see the current state.
- If you are authoring such an action, `runOptions.instancePolicy: "reject"` is the right guard against duplicate watchers — see [authoring.md](authoring.md).

## Multiple instances and runId addressing

With `runOptions.instanceLimit` above 1, an action can have several parallel runs. Output and cancellation are per run and never mixed, so always address operations by `runId`, never by assuming "the" run of an action. `actions_list` surfaces the latest active `runId` per action; `actions_inspect` with `actionId` shows the definition plus the latest run — use `runId` for any older instance.

## What the human sees vs. what you see

- A user message may carry an action reference — inserted from the `/` menu or a panel row's send button (its plain-text form is `@actions:<label>`). At send time it expands into readable one-liners: `Action「<label>」（<id>，<layer> 层）：<command>`, followed by `参数：…`, `已记住参数：…` or `注意：仅人工可见——…` when those apply. Treat those lines as an authoritative pointer to the action — no need to re-discover it with `actions_list` before answering. When they note the action is manual-only (`visibility: "ui"`), you cannot run it — explain rather than attempt.
- `presentation.panel` (`new` / `dedicated` / `append`) only affects the panel's run-tab presentation — an own tab per run, one in-place tab per action, or an in-place tab with appended output. `actions_inspect` is always per-run — never expect concatenated output, and do not treat the append boundary line as part of any run's log.
- The human in your session sees your runs appear in their Actions tab in realtime and may cancel them. A run ending in `cancelled` is a normal terminal state — check the status before concluding something failed.
- Other sessions' runs are invisible to you and yours to them. You cannot inspect or cancel theirs (ids read as `run-not-found`), and they cannot block you.
