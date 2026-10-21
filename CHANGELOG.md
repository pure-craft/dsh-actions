# Changelog

## 0.5.0 — 2026-10-21

### Added

- Reorder Actions within their source section by dragging the row, with live previews, smooth reduced-motion-aware animations and a keyboard-only sorting control.
- Toggle always-visible favorite stars. `favorite` is stored in the source definition, does not pin or reorder entries, does not inherit through `extends`, and is omitted from normal Agent output.
- Presentation writes preserve JSONC comments and unrelated fields, use source revisions to reject stale changes, and leave running processes and run tabs untouched.

### Fixed

- Global, workspace and session sources now remain independent: same-label Actions coexist under source-qualified ids instead of silently merging. Duplicate labels within one file are reported and all conflicting entries are excluded; other valid entries remain available.

### Configuration migration

- Use `agentVisible` (default `true`) instead of `visibility`. All valid Actions are always visible in the UI.
- Legacy `visibility` values remain readable with per-source migration warnings: `ui` maps to `agentVisible: false`; `all` and `agent` map to `true`. An explicit `agentVisible` takes precedence. Configuration version remains `1.0.0`.
- Configurations that relied on implicit same-label merging must provide complete definitions or use explicit `extends` references. Deleting an entry no longer reveals a lower-layer fallback.

### Verified

- Typecheck, lint and 480 automated tests passed; Host and Client production bundles built successfully.
- Local user acceptance covered ordering, favorites and the refined drag interaction. Automated checks cover configuration, RPC, store and source-level UI contracts; they are not browser drag simulation.

## 0.4.1 — 2026-10-18

### Fixed

- Support current Host synchronous route registration and asynchronous disposal, including late registration and cleanup failures.
- Align Jobs integration with session-id ownership, `result` outcomes and independent byte-offset output sources.
- Resolve optional execution services at use time instead of permanently caching missing services during startup.
- Supply the newer terminal component's command-line labels, fixing a blank Actions panel when displaying a run.

### Changed

- Every manual run now opens the shared run dialog, including Actions without parameters.
- The footer's “Notify Agent when finished” checkbox defaults to off for each manual run. Unchecked runs remain managed by Actions without Jobs registration; checked runs also register with Host Jobs for completion reporting.
- Agent-started runs retain their Jobs notification path. No new `actions.json` fields or Agent tool parameters are required.
- Standalone runs retain output, history, explicit cancellation and plugin-disposal cleanup, but do not appear in Host Jobs or inherit Jobs owner-disposal cleanup.

### Verified

- Typecheck, lint and 440 tests passed; Host and Client production bundles built successfully.
- Local user acceptance covered the updated run dialog and execution behavior on DSH 0.2.1-rc.2. Historical supported Hosts were not exhaustively retested.

## 0.4.0 — 2026-10-16

### Permission behavior change

Agent runs with `approval: agent` or `always` now request **one combined execution and one-time `danger-full-access` approval**. Approved runs use Host local-user permissions outside the DSH file sandbox, not outside OS permissions. The session policy is unchanged. Each new run requires a fresh approval; no persistent grant is stored. `approval: never` continues to inherit the session sandbox.

### Added

- `actions_run({ retryRunId, justification, wait? })` requests fresh approval to replay a retained failed run owned by the current session/workspace.
- Retries preserve the original evaluated command, cwd, Action environment overrides and input values, and link the new record through `retryOf`. Script contents and inherited Host environment are not frozen.
- Run summaries expose `sandboxMode`, conservative `failureKind` classification and actionable `failureHint` recovery guidance. Inspect partial side effects before retrying; retries execute the entire Action.

### Fixed

- Cancellation during asynchronous process startup now kills a late-published process.
- Startup failures retain output and expose the failed run id.
- Permission evidence survives bounded output-buffer rollover.
- Evaluated run snapshots are deep-copied and are not substituted again on replay.

### Verified

- Typecheck, lint and 416 tests passed; production bundles built successfully.
- Local Host integration: approved initial run succeeded; sandboxed run was denied; explicitly approved retry succeeded and retained its original-run link.
