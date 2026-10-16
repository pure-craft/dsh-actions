# Changelog

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
