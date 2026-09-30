# Feature: the session layer

[简体中文](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/session-layer.md) ｜ **English**

> Back to [README](https://github.com/pure-craft/dsh-actions/blob/main/README.en.md) ｜ related: [Configuration reference](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/configuration.en.md) ｜ [Agent integration](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/agent-integration.en.md) ｜ scenario: [The session scratchpad](https://github.com/pure-craft/dsh-actions/blob/main/docs/scenarios/03-session-scratchpad.en.md)

The top layer of the three-layer model: the session layer. It answers the "this task only makes sense in this session" case — one-off commands, pinning a task's parameters to one setting, a workflow the agent just worked out in-session.

## Storage and visibility

- Path: `<dshHome>/sessions/<projectKey(cwd)>/<sessionId>/actions.json` — it reuses the host's session persistence layout and lives in the session's own directory.
- Visible to that session only: merge priority is global < workspace < session, and the session layer wins every merge it takes part in.
- **An empty layer is a normal state**: before the first registration the file does not exist (`available: true` + `exists: false`); the panel hides the "open config" button based on the `exists` signal, and the file appears once the first task is registered.

## Write path: `actions_register`

The agent writes new tasks into the session layer through `actions_register`, and **registration always requires user approval** (an agent authoring an executable command for itself is high-risk by definition). Two granularities are supported:

- a standalone command: a complete new task definition;
- a variant: `extends: "<layer>:<label>"` inherits an existing task's definition (cwd/env/inputs/runOptions and so on), with `params` pinning one setting — for example deriving a session-only "deploy to staging" variant from `workspace:deploy`.

`extends` resolves against each layer's original entries (an entry a higher layer overrode can still be referenced explicitly); chained inheritance does not depend on declaration order; when a reference cannot be resolved, running reports `unknown-extends`. Detail is in the [configuration reference](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/configuration.en.md).

## Lifecycle and promotion

- The session layer file lives and dies with the session directory; different sessions cannot see each other's.
- Session **parameter pins** (`actions_set_params`) are a different thing: purely in-memory, dying with the session — do not confuse the two: the session layer stores task definitions, the pinboard stores parameter values.
- Session tasks that prove themselves should be promoted to a file layer: the panel's session section offers a review and "promote" entry (review-and-persist); once a person confirms, it is written into the workspace/global config and goes through the normal git review.
