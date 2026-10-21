# Operating project actions with the `actions_*` tools

Read this when discovering, running, monitoring, cancelling, or configuring Actions. For the definition schema, see [authoring.md](authoring.md).

## Query → run → query → cancel

1. Call `actions_query` with no selector (catalog) to discover agent-visible Actions. `agentVisible: false` remains panel-only.
2. Call `actions_run` with the returned `actionId`. Pass string-valued `params` for this run. For a short task, use `wait: true`; for a long task, retain its `runId`.
3. Call `actions_query` with `{ kind: "run", runId, offset }` to read status and retained output. `offset` is a UTF-8 byte offset; resume from `nextOffset`.
4. Call `actions_cancel` only when stopping is intentional. A finished run may safely be cancelled again.

Runs belong to the calling session. Another session's run is reported as `run-not-found`.

## Parameters and conflicts

Parameter precedence is **explicit `actions_run.params` > declared input `default`**. There is no session pinboard and no hidden parameter source. A missing required input returns `invalid-params`; resend with the named inputs. Never persist sensitive one-off values as defaults.

`actions_run` never interrupts an active instance. It returns:

- `started`: a new instance launched.
- `already-running`: reuse policy returned the matching active run.
- `rejected`: exclusive policy kept the matching active run.
- `approval-declined`: no instance launched; respect the user's decision and do not retry without new intent.

Different normalized parameter values have different conflict signatures. Stop-and-rerun is always two explicit calls: cancel, then run.


### One-time elevation and failure retry

- `approval: never`: inherit the session sandbox, with no automatic elevation.
- `approval: agent/always`: evaluate parameters first; show the actual command, directory and one-time `danger-full-access` in one combined approval. The session policy is unchanged. Rejected, cancelled or unavailable approval starts nothing.
- Failure summaries record `sandboxMode`. `failureKind: sandbox-denied` means the Host reported a denial; `permission-error` means output only suggests a permission problem, not a confirmed sandbox denial. `failureHint` provides recovery guidance; ordinary business failures do not recommend elevation.
- Inspect output and partial side effects first, then request a retry as below. Do not combine it with `actionId` or `params`. Only retained failed runs in this session and workspace are eligible; runs already using full access cannot be escalated again.

```json
{ "retryRunId": "run-3", "justification": "git fetch needs worktree Git metadata outside the workspace; verified the previous attempt did not create an MR", "wait": true }
```

Retries reuse the original evaluated command, directory, Action environment overrides and parameters, without reading the current catalog or substituting variables again. Script contents and the inherited Host environment are not frozen. Every retry requires a new approval and executes the entire Action; the new run links to the failed record through `retryOf`. Records are memory-only; evicted records and records from before a Host restart cannot be retried. Normal conflict rules apply; active instances are never stopped implicitly.

## Configuring definitions

All `actions_*` tools are bound to the calling session workspace and expose the same catalog as its Actions panel. They have no `workspace` argument and cannot query, run, or configure another workspace. Editing files in a nested repository does not change the session workspace; switch to a session for that workspace, or select it as a folder source when that support is available.

Use `actions_configure` with an explicit target layer. Folder sources cannot be configured by this tool.

1. Create with the raw definition. The tool resolves the calling workspace and session, rereads the target layer after approval, and fails on label collision—create never upserts.
2. Before update/delete, `actions_query({ selector: { kind: "action", actionId, view: "layers" } })` returns agent-visible raw entries from independent global/workspace/session sources plus entry revisions for the current session workspace.
3. Update with the layer-qualified `actionId`, `expectedRevision`, and typed changes. Update never materializes a merged definition and cannot rename a label.
4. Delete with the layer-qualified id and `expectedRevision`. Delete removes only that source entry; same-label entries in other sources are independent. There is no fallback and the deprecated `acknowledgeFallback` parameter is ignored.

Every write presents its effect for user approval. Update and delete are revision-bound; query a stale entry revision again rather than forcing a last-writer-wins change. Configuration approval does not authorize execution, and started runs keep their own definition snapshot.

## Long-running services

Start without `wait`, retain the `runId`, and query incremental output until the log demonstrates readiness. There is no separate readiness probe. Restart means explicit cancel followed by run. Runs are memory-resident and do not survive a Host restart.
