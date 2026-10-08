# Feature: the session layer

[简体中文](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/session-layer.md) ｜ **English**

> Back to [README](https://github.com/pure-craft/dsh-actions/blob/main/README.en.md) ｜ related: [Configuration reference](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/configuration.en.md) ｜ [Agent integration](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/agent-integration.en.md) ｜ scenario: [The session scratchpad](https://github.com/pure-craft/dsh-actions/blob/main/docs/scenarios/03-session-scratchpad.en.md)

The top layer of the three-layer model: the session layer. It answers the "this task only makes sense in this session" case — one-off commands, pinning a task's parameters to one setting, a workflow the agent just worked out in-session.

## Storage and visibility

- Path: `<dshHome>/sessions/<projectKey(cwd)>/<sessionId>/actions.json` — it reuses the host's session persistence layout and lives in the session's own directory.
- Visible to that session only: merge priority is global < workspace < session, and the session layer wins every merge it takes part in.
- **An empty layer is a normal state**: before the first registration the file does not exist (`available: true` + `exists: false`); the panel hides the "open config" button based on the `exists` signal, and the file appears once the first task is registered.

## Dynamic Action directories: `folders`

When the workspace is merely an aggregate parent of several Git repositories, each repository still keeps its definitions in its own `<folder>/.dsh/actions.json`. The session layer can select only the directories involved in the current work:

```jsonc
{
  "version": "1.0.0",
  "folders": ["frontend", "services/api"],
  "actions": []
}
```

The rules are deliberately small:

- `folders` is valid only in the session layer; the same field in a global or workspace file is ignored and reported as an error on that source — never silently honored;
- each value is a directory relative to the current session workspace and loads `<folder>/.dsh/actions.json`; absolute paths are used as written;
- it is the complete session selection and does not inherit, union, or override anything from another layer; entries that resolve to the same directory collapse into one source;
- an omitted field and an empty array both mean no extra directories; global, root-workspace, and session-local `actions` still load normally;
- selected repository definitions are neither copied nor rewritten; another session may select a completely different set;
- a selected directory may not be the workspace root itself (that already loads as the workspace layer), and it may not declare its own `folders` — recursive selection is refused, so a repository cannot widen what it can reach.

**Each directory is an independent source and merges with nothing.** When repository A and repository B both define `build`, you get two Actions that never override each other, with ids like `folder:frontend:build` (`folder:<path relative to the workspace>:<label>`). Inside such an Action:

- `${workspaceFolder}` / `${workspaceFolderBasename}` point at that repository directory, not at the session workspace;
- `options.cwd` resolves against that directory, and the default cwd is that directory;
- a relative cwd may still climb out with `../` — the directory is a resolution base, not a write boundary;
- a directory without `.dsh/actions.json` is a **normal empty source** (`available: true` + `exists: false`): selecting a repository is not a claim that it has Actions;
- a broken config in one directory degrades only that source; the others still load.

Because the definitions stay in the repositories, the panel offers no delete entry for these Actions: the file belongs to the repository, the session only points at it.

## Write path: who writes the session layer

- **An agent writes Action definitions** through `actions_register` (see below).
- **Changing the `folders` selection**: a host plugin calls the `dshActions` Service method `setSessionFolders(sessionId, workspace, folders)`, which atomically replaces the session layer's complete `folders` array, preserves existing session Actions, and immediately notifies catalog subscribers; editing the session layer's `actions.json` directly works too (the session section's edit button in the panel opens exactly that file, once it exists). There is **no** folder-picker UI and **no** agent tool today: the selection belongs to the user or the host plugin, and agents only consume it (`actions_list` carries the caller's session, so a selected directory's Actions show up).

## Write path: `actions_register`

The agent writes new tasks into the session layer through `actions_register`, and **registration always requires user approval** (an agent authoring an executable command for itself is high-risk by definition). Two granularities are supported:

- a standalone command: a complete new task definition;
- a variant: `extends: "<layer>:<label>"` inherits an existing task's definition (cwd/env/inputs/runOptions and so on), with `params` pinning one setting — for example deriving a session-only "deploy to staging" variant from `workspace:deploy`.

`extends` resolves against each layer's original entries (an entry a higher layer overrode can still be referenced explicitly); chained inheritance does not depend on declaration order; when a reference cannot be resolved, running reports `unknown-extends`. Detail is in the [configuration reference](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/configuration.en.md).

## Lifecycle and promotion

- The session layer file lives and dies with the session directory; different sessions cannot see each other's.
- Session **parameter pins** (`actions_set_params`) are a different thing: purely in-memory, dying with the session — do not confuse the two: the session layer stores task definitions, the pinboard stores parameter values.
- Session tasks that prove themselves should be promoted to a file layer: the panel's session section offers a review and "promote" entry (review-and-persist); once a person confirms, it is written into the workspace/global config and goes through the normal git review.
