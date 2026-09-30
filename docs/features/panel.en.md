# Feature: the Actions panel

[简体中文](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/panel.md) ｜ **English**

> Back to [README](https://github.com/pure-craft/dsh-actions/blob/main/README.en.md) ｜ related: [Configuration reference](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/configuration.en.md) ｜ [Agent integration](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/agent-integration.en.md) ｜ [The session layer](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/session-layer.en.md)

The panel is the main entry point for people: the **Actions** card on the **Start** page of DSH Web's right sidebar (bound to the current session's workspace; there is also a live-status pill on the composer stats bar that jumps straight to it). It has exactly one design goal — make running a project task a single click.

## Task list

- **Grouped by the three layers**: workspace / global / session sections show the normalized task list; the edit button in each section header opens that layer's `actions.json` in DSH's native right-sidebar file viewer (the button is hidden when that layer's file is missing or fails to load).
- **Semantic badges**: each task row translates raw config into behavioral hints — approval requirement (`agent` / `always`, with a shield mark for `always`), presentation mode (`dedicated` / `append`), panel-only visibility (`ui`), and inheritance from another Action (`extends`). Defaults are not rendered (quiet defaults); the tooltip carries the raw config value.
- **Empty-state CTA**: an empty layer or empty config gets a "have the agent create it for me" button in its section header, with a prompt draft attached per layer (scan the workspace's script entry points, create a global/session task).
- **Seeded example**: on first use the global layer is seeded with an annotated `dsh-update` example (a `.seeded` marker guarantees it happens once).
- **Delete**: an Action you no longer need can be deleted from the panel — after a strong confirmation it is removed atomically from the corresponding layer's config file; historical run records are unaffected and live instances are left alone.

## Run tab workspace

The lower half of the panel is a permanent run workspace, modeled on VS Code's tasks + terminals:

- each run is a tab (runs across tasks line up on one tab strip; it scrolls horizontally on overflow with edge fade); clicking a task in the list only focuses its newest tab, it does not replace the whole area; the workspace collapses/expands as a whole with a fixed height, and renders nothing when there is no run at all.
- output and cancellation are independent per tab and never mix; an active tab can be stopped, a finished one can be forgotten (closing an active tab first goes through a "terminate and close" confirmation).
- focus rules differ by presentation mode: `new` does not steal focus (it follows a new run only if you are already looking at the latest run), while `dedicated` / `append` refresh the tab in place. The three modes are described in the [configuration reference](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/configuration.en.md).

## Running and conflicts

- Clicking run starts the command inside the workspace sandbox boundary and streams output live.
- Triggering a task that is already running does not start a second one: it locates the existing instance's log (`already-running`) and offers, right there, "run once more when it finishes" (watch the terminal state, then re-run automatically) and "stop and re-run" (explicit cancel + explicit re-run).
- A task with `approval: "always"` shows a confirmation dialog before running (with an acknowledge checkbox); on decline you get a light toast and no instance is started.

## Parameter form

A task declaring `inputs` renders a form at run time: prefilled by a three-level chain of last run's parameters > session-pinned value > `default`, with `select` rendered as a dropdown; checking "pin to this session" means later runs need no re-entry (the pinned value dies with the session and is never written into the config file). Field semantics are in the [configuration reference](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/configuration.en.md), and the agent-side counterpart is in [the session layer](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/session-layer.en.md).

## Live sync

- Runs started by the agent in the same session appear in the panel live (subscribed to the session-level run discovery stream, with automatic re-subscription on disconnect and idempotent snapshot resync).
- Saving any `actions.json` takes effect automatically (the Host polls each layer and pushes a full snapshot); the toolbar refresh button is the manual fallback.
- Run state is isolated per session: two sessions in the same workspace cannot see each other's runs and do not block each other.
