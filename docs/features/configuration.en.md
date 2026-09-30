# Configuration reference: every `actions.json` field

[简体中文](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/configuration.md) ｜ **English**

> Back to [README](https://github.com/pure-craft/dsh-actions/blob/main/README.en.md) ｜ related: scenarios ([Curating scattered script entry points](https://github.com/pure-craft/dsh-actions/blob/main/docs/scenarios/01-curate-scripts.en.md) / [CI pipeline](https://github.com/pure-craft/dsh-actions/blob/main/docs/scenarios/02-ci-pipeline.en.md) / [Session scratchpad](https://github.com/pure-craft/dsh-actions/blob/main/docs/scenarios/03-session-scratchpad.en.md)) ｜ [The panel](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/panel.en.md) ｜ [The session layer](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/session-layer.en.md)

The single source of Action definitions is a standalone `actions.json` (**JSONC** — comments and trailing commas are allowed). It is read from three layers, merged in increasing priority:

| Layer | Path | Applies to |
| --- | --- | --- |
| Global | `~/.dsh/actions.json` (`DSH_HOME` can override the root) | personal, cross-workspace |
| Workspace | `<workspace>/.dsh/actions.json` | shared by the project, committed with the repo (the default choice) |
| Session | `<dshHome>/sessions/<projectKey>/<sessionId>/actions.json` | visible to this session only, written by `actions_register` (see [the session layer](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/session-layer.en.md)) |

Every file must declare `"version": "1.0.0"` — this is an enum allowlist gate, not semver; any other value demotes the whole layer to `unsupported-version`.

## Full field list

| Field | Required | Meaning |
| --- | --- | --- |
| `label` | yes | display name; also the cross-layer merge key and the basis of the stable id (`<layer>:<label>`) |
| `command` | yes (may be omitted on an `extends` entry, which inherits the base definition) | shell command, run through `shell -c` inside the workspace sandbox boundary; may reference `${input:id}` |
| `detail` | no | one-line description, shown in the panel and by `actions_list` alike — **the agent judges whether a task fits by this line, so always write it** |
| `visibility` | no | `all` (default, panel + agent) / `ui` (panel only) / `agent` (agent tools only) |
| `approval` | no | `never` (default) / `agent` / `always` — the approval requirement before a run, see below |
| `options.cwd` | no | working directory, relative to the workspace root (default: the workspace root) |
| `options.env` | no | extra environment variables |
| `runOptions.instanceLimit` | no | maximum concurrent instances, clamped to ≥ 1 (default 1) |
| `runOptions.instancePolicy` | no | `reuse` (default — a duplicate run returns the existing instance as `already-running`) / `reject` (exclusive, returns `rejected`) |
| `presentation.panel` | no | `new` (default) / `dedicated` / `append` — panel presentation mode, see below |
| `inputs` | no | declarative parameter list, see below |
| `extends` | no | reference another Action id as the base definition to inherit from, see below |

## `inputs` (declarative parameters)

Only two types are kept: `string` and `select`. Reference them as `${input:id}` in `command`, in `options.cwd` / `options.env` values, and in `detail`:

| Parameter field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | identifier, referenced as `${input:id}` |
| `type` | yes | `string` (free text) / `select` (one of `options`) |
| `description` | no | shown in the panel form, and helps the agent pick a value |
| `required` | no | when true, a run with no value and no `default` errors out (`invalid-params`, listing the missing ids) |
| `default` | no | fallback when no value is supplied; for `select` it must be one of `options` |
| `options` | required for `select` | the allowed values, non-empty |

Two rules matter: **substitution is literal — no quoting, no escaping** (if a value may contain spaces or shell metacharacters, the author quotes it in the command); and **parameters take part in conflict detection** — two runs of the same Action with different parameters do not conflict. At run time the resolution chain is explicit argument > session-pinned value > config `default` (see [the session layer](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/session-layer.en.md) and [the panel](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/panel.en.md)).

## `approval` (approval requirement)

- `never` (default): no prompt.
- `agent`: an agent tool call asks the user first, through the host's approval channel; the panel is unaffected.
- `always`: the agent asks; the panel additionally shows a confirmation dialog (an acknowledge checkbox) before running.

If the user declines, the result is `approval-declined` (no instance is started). Anything irreversible — deleting data, deploying, writing to external systems — must be marked `agent` or `always`. Approval happens before parameter evaluation.

## `presentation.panel` (presentation mode)

Decides how a new run relates to tabs in the panel's run tab workspace (pure presentation; it does not affect run semantics):

- `new` (default): every run opens a new tab, older runs stay as separate tabs;
- `dedicated`: the task owns one tab, a re-run replaces its contents in place (the previous output is dropped from the view, the run record is kept);
- `append`: same as `dedicated`, but new output is appended below the previous output with a boundary line in between.

For panel behavior detail, see [the panel](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/panel.en.md).

## `extends` (inheritance)

`extends: "<layer>:<label>"` references another Action visible in this session as the base definition: it inherits that Action's `command` / `options` / `inputs` / `runOptions` and so on, and fields written on this entry override them. Resolution rules:

- it resolves against **each layer's original entries** (before merging) — an entry that a higher layer overrides can still be referenced explicitly, so `extends: "global:build"` hits the global file's own `build`;
- chained inheritance (a extends b extends c) does not depend on declaration order;
- when a reference cannot be resolved the entry is kept with a marker, and running it reports `unknown-extends`.

## Merge rules and fault tolerance

Entries with the same `label` merge field by field across layers (VS Code assign semantics): a field the higher layer writes overrides, one it does not write is inherited; `options.env` merges by key, `inputs` merges by `id`, and `extends` follows this entry's own reference. An entry missing `label`/`command` or carrying an invalid field → that entry is skipped and a source-level error is recorded, everything else loads normally; the degradation reason and error detail are shown in the panel's source banner.

## Variable substitution and when changes take effect

`${workspaceFolder}`, `${workspaceFolderBasename}`, `${userHome}`, `${env:NAME}`, `${input:id}`; re-evaluated on every run. **Saving any `actions.json` takes effect immediately** — the Host polls each layer's config and pushes the refreshed catalog to every open panel, and the refresh button in the panel toolbar is the manual fallback.

Not supported: `type: process`, command-type inputs, `dependsOn`, `problemMatcher`, platform override blocks, and similar.
