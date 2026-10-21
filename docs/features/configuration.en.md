# Configuration reference: every `actions.json` field

[简体中文](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/configuration.md) ｜ **English**

> Back to [README](https://github.com/pure-craft/dsh-actions/blob/main/README.en.md) ｜ related: scenarios ([Curating scattered script entry points](https://github.com/pure-craft/dsh-actions/blob/main/docs/scenarios/01-curate-scripts.en.md) / [CI pipeline](https://github.com/pure-craft/dsh-actions/blob/main/docs/scenarios/02-ci-pipeline.en.md) / [Session scratchpad](https://github.com/pure-craft/dsh-actions/blob/main/docs/scenarios/03-session-scratchpad.en.md)) ｜ [The panel](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/panel.en.md) ｜ [The session layer](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/session-layer.en.md)

The single source of Action definitions is a standalone `actions.json` (**JSONC** — comments and trailing commas are allowed). It is read from three independent layers:

| Layer | Path | Applies to |
| --- | --- | --- |
| Global | `~/.dsh/actions.json` (`DSH_HOME` can override the root) | personal, cross-workspace |
| Workspace | `<workspace>/.dsh/actions.json` | shared by the project, committed with the repo (the default choice) |
| Session | `<dshHome>/sessions/<projectKey>/<sessionId>/actions.json` | visible to this session only, written by `actions_configure` (see [the session layer](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/session-layer.en.md)) |

Every file must declare `"version": "1.0.0"` — this is an enum allowlist gate, not semver; any other value demotes the whole layer to `unsupported-version`.

The top level may also contain session-only `folders: string[]`: it loads each listed directory's own `.dsh/actions.json`. Paths are relative to the session workspace (absolute paths are used as written); omission or an empty array means no extra directories; duplicates collapse into one source; writing it in a workspace or global file is ignored and reported as an error; a directory may be neither the workspace root nor a place that declares its own `folders`. It does not participate in three-layer merging and never rewrites a directory's config: Actions in a selected directory keep an independent identity (`folder:<relative path>:<label>`), and their `${workspaceFolder}` and default cwd point at that directory. See [the session layer](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/session-layer.en.md) for the complete semantics.

## Full field list

| Field | Required | Meaning |
| --- | --- | --- |
| `label` | yes | display name and stable-id basis (`<layer>:<label>`); unique within one source file |
| `command` | yes (may be omitted on an `extends` entry, which inherits the base definition) | shell command, run through `shell -c` under the entry- and approval-selected permissions; may reference `${input:id}` |
| `detail` | no | one-line description, shown in the panel and by `actions_query` alike — **the agent judges whether a task fits by this line, so always write it** |
| `agentVisible` | no | boolean, default true; false excludes Agent discovery/execution, not the panel |
| `favorite` | no | UI-only favorite flag, default false; never inherited through `extends` |
| `icon` | no | UI-only Iconify icon code; omitted from normal Agent projections along with `favorite` |
| `visibility` | no | deprecated: `ui` maps to false, `all`/`agent` to true; explicit `agentVisible` wins; load emits warnings |
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

Two rules matter: **substitution is literal — no quoting, no escaping** (if a value may contain spaces or shell metacharacters, the author quotes it in the command); and **parameters take part in conflict detection** — two runs of the same Action with different parameters do not conflict. At run time the resolution chain is explicit argument > config `default`; there is no session-level parameter memory (see [the session layer](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/session-layer.en.md) and [the panel](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/panel.en.md)).

## `approval` (approval requirement)

- `never` (default): no prompt.
- `agent`: an agent tool call asks the user first, through the host's approval channel; the panel is unaffected.
- `always`: the agent asks; the panel additionally shows a confirmation dialog (an acknowledge checkbox) before running.

If the user declines, the result is `approval-declined` (no instance is started). Anything irreversible — deleting data, deploying, writing to external systems — must be marked `agent` or `always`. Parameters are evaluated before approval so it shows the actual execution.

For Agent calls, `never` inherits the session sandbox; `agent/always` explicitly requests one-time `danger-full-access` in the same approval, without changing session policy. Permission failures can request new approval through `actions_run` with `retryRunId` and `justification`.

## `presentation.panel` (presentation mode)

Decides how a new run relates to tabs in the panel's run tab workspace (pure presentation; it does not affect run semantics):

- `new` (default): every run opens a new tab, older runs stay as separate tabs;
- `dedicated`: the task owns one tab, a re-run replaces its contents in place (the previous output is dropped from the view, the run record is kept);
- `append`: same as `dedicated`, but new output is appended below the previous output with a boundary line in between.

For panel behavior detail, see [the panel](https://github.com/pure-craft/dsh-actions/blob/main/docs/features/panel.en.md).

## `extends` (inheritance)

`extends: "<layer>:<label>"` references another Action visible in this session as the base definition: it inherits that Action's `command` / `options` / `inputs` / `runOptions` and so on, and fields written on this entry override them. Resolution rules:

- references resolve against source-qualified original entries: `extends: "global:build"` always means the global definition, independently of other same-label entries;
- chained inheritance (a extends b extends c) does not depend on declaration order;
- when a reference cannot be resolved the entry is kept with a marker, and running it reports `unknown-extends`.

## Independent sources and fault tolerance

All sources are independent. Same-label Actions across layers coexist, without overriding or inheriting fields. Reuse requires explicit `extends`; within that inheritance, `options.env` merges by key and `inputs` by `id`, but `favorite` never inherits. All occurrences of a duplicate label within one file are excluded with source errors; other labels still load. Invalid entries have field-specific errors. Configuration inspection/writes reject duplicate-label files with `invalid-file`, never silently choosing one occurrence.

## Variable substitution and when changes take effect

`${workspaceFolder}`, `${workspaceFolderBasename}`, `${userHome}`, `${env:NAME}`, `${input:id}`; re-evaluated on every run. **Saving any `actions.json` takes effect immediately** — the Host polls each layer's config and pushes the refreshed catalog to every open panel, and the refresh button in the panel toolbar is the manual fallback.

Not supported: `type: process`, command-type inputs, `dependsOn`, `problemMatcher`, platform override blocks, and similar.
