# Authoring `actions.json` — full schema reference

Read this when your task is writing or editing action definitions. For running and managing actions, see [operating.md](operating.md) instead.

## Contents

- [Where definitions live](#where-definitions-live)
- [Minimal example](#minimal-example)
- [Field reference](#field-reference)
- [Variable substitution](#variable-substitution-minimal-set)
- [Parameters (`inputs`)](#parameters-inputs)
- [Approval requirement (`approval`)](#approval-requirement-approval)
- [Inheritance (`extends`)](#inheritance-extends)
- [Merge semantics across layers](#merge-semantics-across-layers)
- [Choosing the layer](#choosing-the-layer)
- [Verify before you finalize](#verify-before-you-finalize)
- [Write complex commands as scripts](#write-complex-commands-as-scripts)
- [Not supported](#not-supported-do-not-author-these)
- [Authoring workflow](#authoring-workflow)

## Where definitions live

Three layers (merge priority ascending), all **JSONC** (comments and trailing commas allowed, like VS Code tasks.json):

- `~/.dsh/actions.json` — global layer (`DSH_HOME` overrides the root). Personal, applies to every workspace.
- `<workspace>/.dsh/actions.json` — workspace layer. Shared with everyone who opens this repository; the right default for project tasks.
- Session layer: `<dshHome>/sessions/<projectKey>/<sessionId>/actions.json` — lives in the session's own directory, visible only to that session, and written by `actions_register` (see [operating.md](operating.md)); you rarely edit it by hand. Its file may legitimately not exist yet — an empty session layer is normal, not an error.

Every file must declare `"version": "1.0.0"` — an enum whitelist gate, not semver: any other value degrades the whole file with an `unsupported-version` source error.

## Minimal example

```jsonc
{
  "version": "1.0.0",
  "actions": [
    { "label": "check", "command": "pnpm check", "detail": "Typecheck + lint + tests" },
    {
      "label": "dev",
      "command": "pnpm run dev",
      "runOptions": { "instancePolicy": "reject" }  // exclusive: one watcher at a time
    },
    {
      "label": "test",
      "command": "pnpm test",
      "presentation": { "panel": "append" }  // re-run output appends below previous runs
    },
    {
      "label": "deploy",
      "command": "./scripts/deploy.sh ${input:env}",
      "detail": "Deploy to the chosen environment",
      "approval": "always",                 // destructive: explicit human confirmation
      "inputs": [
        { "id": "env", "type": "select", "options": ["staging", "production"], "default": "staging" }
      ]
    }
  ]
}
```

## Field reference

| Field | Required | Meaning |
| --- | --- | --- |
| `label` | yes | Display name; also the merge key across layers and the basis of the stable id (`<layer>:<label>`). |
| `command` | yes | Shell command, executed via `shell -c` under the workspace sandbox boundary. May reference `${input:id}` for declared parameters. |
| `detail` | no | One-line description shown in the panel and in `actions_list`. Always write one — it is what an agent reads when deciding whether this action fits its goal. |
| `visibility` | no | `all` (default) exposes to panel + agent tools; `ui` panel-only; `agent` tools-only. |
| `approval` | no | `never` (default) / `agent` / `always` — see [Approval requirement](#approval-requirement-approval). |
| `options.cwd` | no | Working directory, relative to the workspace root (default: workspace root). |
| `options.env` | no | Extra environment variables for the run. |
| `runOptions.instanceLimit` | no | Max concurrent instances, clamped to ≥ 1 (default 1). |
| `runOptions.instancePolicy` | no | `reuse` (default): a duplicate run request returns the existing instance (`already-running`). `reject`: returns `rejected` — for high-risk or exclusive actions. |
| `presentation.panel` | no | How runs appear in the panel's run-tab workspace. `new` (default): every run opens its own tab; older runs stay as tabs. `dedicated`: the action owns a single tab — re-running replaces its content in place (previous output is discarded from view; the run record is kept). `append`: like `dedicated`, but new output appends below the previous runs' output with a boundary line (VS Code shared-terminal style). Presentation-only — runs stay separate internally and `actions_inspect` is unaffected. |
| `inputs` | no | Declared parameters — see [Parameters](#parameters-inputs). |
| `extends` | no | Inherit another action's definition (`"<layer>:<label>"`) as this entry's base — see [Inheritance](#inheritance-extends). |
| `icon` | no | Panel icon as an Iconify code (`collection:name`, `lucide:` recommended). UI-only — agent-facing surfaces are a whitelisted field set that structurally excludes it, so never expect an agent to see it. |

## Variable substitution (minimal set)

`${workspaceFolder}`, `${workspaceFolderBasename}`, `${userHome}`, `${env:NAME}`, and `${input:id}` for declared parameters. Re-evaluated on every rerun.

## Parameters (`inputs`)

Declare parameters in the `inputs` array; reference them as `${input:id}` inside `command`, `options.cwd`, `options.env` values, and `detail`.

| Input field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Identifier referenced as `${input:id}`. Must not contain `}`. |
| `type` | yes | `string` (free text) or `select` (one of `options`). |
| `description` | no | Shown in the panel form and helps agents pick sensible values. |
| `required` | no | When true, running without a value and no `default` fails with a `missing required input` error naming the ids. |
| `default` | no | Fallback when the run provides no value; for `select` it must be one of `options`. This is the project-curated baseline — a session may override it with pinned values (never written back to the file), and explicit call params outrank both. |
| `options` | for `select` | Allowed values; non-empty when `type` is `select`. |

Two rules that matter:

- **Substitution is verbatim** — values are inserted without quoting or escaping (VS Code `${input:*}` semantics). If a value may contain spaces or shell metacharacters, quote the placeholder yourself (`"${input:name}"`), and never feed untrusted text into a placeholder.
- **Parameters join the conflict key** — runs of the same action with *different* parameter values do not conflict; `already-running` / `rejected` only trigger for the same (session, action, params) combination.

In the panel, declared inputs render as a run form prefilled by (last run's params > session-pinned values > `default`), with a "pin to this session" toggle; `select` renders as a dropdown. Agents get the same chain through `actions_set_params` pins.

## Approval requirement (`approval`)

- `never` (default): no asking, zero behavior change.
- `agent`: Agent tool calls (`actions_run`) ask the user through the host approval channel first; the human panel is unaffected.
- `always`: Agent calls ask; the Web entry additionally demands an explicit confirmation (a risk dialog with an acknowledge checkbox) before the run starts.

**Curation guidance**: mark actions that delete data, deploy, publish, or write to external systems with `agent` or `always` — an agent can then never start them silently. Read-only or local build/check actions need no approval.

A declined approval returns `approval-declined` (with outcome `rejected` / `cancelled` / `unavailable`) and starts nothing — this is distinct from the conflict protocol's `rejected`, where an instance already exists. `unavailable` means the deployment has no approval channel: the action fails closed rather than skipping the gate.

## Inheritance (`extends`)

An entry may carry `extends: "<layer>:<label>"` to inherit another action's definition as its base: the base's `command`, `options`, `inputs`, `runOptions`, etc. apply, and fields the entry writes itself win (an extends entry may even omit `command` — it inherits the base's). Typical use: a session-layer variant that pins a workspace action's behavior without copying it.

Resolution rules worth knowing:

- References resolve against the **raw per-layer entries, before merging** — an entry shadowed by a higher layer is still referenceable by its own layer id. `extends: "global:build"` means the global file's own `build`, even when the workspace layer overrides `build`.
- Chains (`a` extends `b` extends `c`) resolve regardless of declaration order.
- An unresolvable or cyclic reference is not silently dropped: the entry keeps its `extends` marker and running it fails with `unknown-extends` naming the missing reference — fix by defining or correcting the target.

## Merge semantics across layers

Same `label` in several layers merges **field by field** (VS Code assign semantics), with priority global < workspace < session: fields a higher layer writes override the lower entry; unwritten fields are inherited. `options.env` merges per key; `options.cwd`, `runOptions.*`, `presentation.panel`, and `approval` override field-wise; `inputs` merge **by `id`** (matched inputs merge field-wise, higher-layer-only inputs append). The merged action takes the winning layer's identity (`id = <layer>:<label>`). Within one file, a later duplicate label wins.

Fault tolerance is per entry: an entry missing `label`/`command` (and not inheriting `command` via `extends`) or carrying an invalid field value is skipped with a source-level error message; the rest of the file still loads. Validation errors are field-precise — the source banner's error details carry strings of the form `actions[<index>].<path>: <message>` (e.g. `actions[0].inputs[0].options: …`), so locate and fix exactly what is named. After editing, check the panel's source banner (or `actions_list`) for degradation errors.

## Choosing the layer

- **Workspace** (`.dsh/actions.json`): anything the project shares — build/check/dev/test commands, codegen, local CI. Commit it with the repo.
- **Global** (`~/.dsh/actions.json`): personal conveniences that should exist in every workspace. Use it sparingly; a workspace entry with the same label overrides it field by field.
- **Session**: nothing to hand-author here — it is written by `actions_register` for session-only actions (see [operating.md](operating.md)); the panel can promote a proven session entry into a file layer.

## Verify before you finalize

An action you just authored has never run — a typo in `command` or a wrong `cwd` means the human's first click fails. How to close that gap depends on side effects:

- **Side-effect-free commands** (queries, checks, listings — anything that only reads): run it once yourself with `actions_run`, confirm the output is what the action promises, and only then consider the job done.
- **Commands with side effects** (builds, deploys, file writes, anything mutating): do **not** run them on the user's behalf just to "verify". Finish the definition, then explicitly tell the user the action is in place and suggest they try it when convenient — the first real run is theirs to choose.

## Write complex commands as scripts

When a command grows multi-step logic, conditionals, or non-trivial quoting, do not cram it into one `command` line. Write a script in the workspace (e.g. `scripts/deploy.mjs` — Node is available) and let the action just run the script:

```jsonc
{
  "label": "deploy",
  "command": "node scripts/deploy.mjs --env ${input:env}",
  "detail": "Build, pack, and deploy to the chosen environment",
  "inputs": [
    { "id": "env", "type": "select", "options": ["staging", "production"], "default": "staging" }
  ]
}
```

```js
// scripts/deploy.mjs
#!/usr/bin/env node
const env = process.argv[process.argv.indexOf('--env') + 1] ?? 'staging';
// …multi-step logic lives here, testable on its own: node scripts/deploy.mjs --env staging
```

Why: JSON string + shell quoting is a double-escaping trap that produces commands nobody can read or review; a script file is versioned with the repo, reviewable in a diff, and debuggable standalone (`node scripts/deploy.mjs …`) without touching the action at all. Keep `command` itself a single boring invocation.

## Not supported (do not author these)

`type: "process"`, `command`-type inputs (the V1 subset is `string`/`select` only), `problemMatcher`, `isBackground`, `dependsOn` / `dependsOrder`, `group`, platform override blocks (`windows`/`osx`/`linux`), `customExecution`, and all other `presentation` fields (`reveal`/`focus`/`clear`/…). They are ignored or rejected — keep definitions inside the supported subset above.

## Authoring workflow

1. Edit (or create) the appropriate layer's `actions.json`. In the panel, each layer header's edit button opens the exact file in DSH's file viewer.
2. Keep `label` short and stable — it is the merge key and the stable-id basis. Put the explanation in `detail`.
3. Set `runOptions.instancePolicy: "reject"` for actions that must never overlap (watchers, migrators, anything stateful); set `approval` for destructive ones.
4. Verify: `actions_list` shows the new/changed entry (respecting `visibility`), or the panel updates automatically — saving a configuration file takes effect without a manual refresh. If an entry is missing, check the source banner for a per-entry validation error.
