/**
 * Run service: bounded action runner with the unified conflict protocol.
 *
 * Design source: docs/v1-goals.md ("并发模型：统一冲突协议" and
 * "DSH 能力映射"). Execution maps to the DSH host `shell` service
 * (resolve → start → incremental readOutput → done/kill) and runs register
 * with the host `jobs` service as `bash` jobs. Both are injected, so tests
 * run against fakes; the real services are resolved through `ctx.get()` in
 * `./host.js`.
 *
 * Session isolation (T14): every run belongs to one runtime session,
 * mirroring the `ctx.jobs` owner model. The conflict key is
 * (sessionId, actionId, paramsSignature) (T33) — the same action in the
 * same workspace does not conflict across sessions, and distinct parameter
 * values of one action run in parallel — while listing/retention stay
 * per-session. `${input:id}` placeholders from the catalog are evaluated per
 * run through `normalizeParams` + `substituteVariables`.
 */

import type { ActionRunStatus, ActionRunSummary, ProjectActionSummary, RunStartResult } from '../../contract.js';
import { resolve } from 'node:path';
import { normalizeParams } from '../config/params.js';
import type { SessionParamStore } from './session-params.js';
import { substituteVariables } from '../config/variables.js';
import { OutputRingBuffer } from './buffer.js';
import type { RingBufferSnapshot } from './buffer.js';

/** Default cap of retained per-run output: 256 KiB. */
export const DEFAULT_OUTPUT_LIMIT_BYTES = 256 * 1024;

const DEFAULT_POLL_INTERVAL_MS = 200;

/** Default cap of terminal run records retained per session (S3/T14). */
export const DEFAULT_TERMINAL_RETENTION_PER_SESSION = 50;

// ---------------------------------------------------------------------------
// Structural mirrors of the DSH host services (minimal surface we consume)
// ---------------------------------------------------------------------------

export type SandboxModeLike = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface SandboxExecutionPolicyLike {
  mode: SandboxModeLike;
  workspaceRoot: string;
  sessionId?: string | undefined;
}

export interface ShellExecRequestLike {
  command: string;
  workdir?: string | undefined;
  timeoutMs?: number | undefined;
  stdoutMaxBytes?: number | undefined;
  env?: Record<string, string> | undefined;
  sandboxPolicy?: SandboxExecutionPolicyLike | undefined;
}

export interface ShellProcessReadLike {
  delta: string;
  lossy: boolean;
  stdoutSpillPath?: string | undefined;
  stderrSpillPath?: string | undefined;
}

export interface ShellProcessLike {
  readonly done: Promise<void>;
  readonly exitCode: number | null;
  readOutput(): ShellProcessReadLike;
  kill(): boolean;
}

/** Mirrors `ctx.shell` (0.1.7: `resolve` + `execute`); the resolved spec type stays opaque to us. */
export interface ShellLike {
  resolve(request: ShellExecRequestLike): unknown;
  execute(spec: unknown): Promise<ShellProcessLike>;
}

export interface AgentLike {
  readonly id: string;
}

export interface JobOutcomeLike {
  status: 'completed' | 'killed' | 'failed';
  detail?: string | undefined;
  output?: string | undefined;
}

export interface JobHooksLike {
  cancel(reason?: string): void;
  done: Promise<JobOutcomeLike>;
  readOutput?(): string;
}

/** Mirrors the subset of `ctx.jobs` the run service consumes. */
export interface JobsLike {
  start(spec: {
    kind: 'bash';
    label: string;
    outputLimitBytes?: number | undefined;
    owner?: AgentLike | undefined;
    run(): JobHooksLike;
  }): string;
  kill(id: string, caller?: AgentLike, reason?: string): 'requested' | 'already-finished';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type RunServiceErrorCode = 'shell-unavailable' | 'start-failed' | 'run-not-found' | 'disposed' | 'invalid-params' | 'run-active';

export class RunServiceError extends Error {
  override readonly name = 'RunServiceError';

  constructor(
    readonly code: RunServiceErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export interface RunOutputFrame {
  runId: string;
  /** Absolute byte offset of this chunk in the run's full output. */
  offset: number;
  text: string;
  /** True when the shell reported a lossy read (see the spill path on inspect). */
  truncated?: boolean | undefined;
}

export interface RunOutputSnapshot extends RingBufferSnapshot {
  spillPath?: string | undefined;
}

export interface RunInspection {
  run: ActionRunSummary;
  action: ProjectActionSummary;
  output: RunOutputSnapshot;
}

export interface RunRequestOptions {
  /** Absolute workspace root the run binds to (cwd confinement and sandbox root). */
  workspace: string;
  /**
   * Runtime session scope (T14): the run belongs to exactly one session.
   * Conflict keys, `listRuns` filtering, and terminal retention are all
   * isolated per session, mirroring the `ctx.jobs` owner model.
   */
  sessionId: string;
  /**
   * Provided values for the action's declared inputs (T33). Validated and
   * normalized against `action.inputs`; the canonical signature joins the
   * conflict key, so distinct values never conflict.
   */
  params?: Record<string, string> | undefined;
  /** Owning agent, forwarded to `ctx.jobs` for owner fencing. */
  owner?: AgentLike | undefined;
  /**
   * Sandbox policy resolved for the *calling session* (via
   * `ctx.sandboxPolicy.resolve({ session })` at the entry layer). Passed to
   * the shell verbatim except `workspaceRoot`, which is always this run's
   * workspace. When omitted the shell request carries no policy field and
   * the shell falls back to the deployment default — the run service never
   * hardcodes a mode (T8-B1).
   */
  sandboxPolicy?: SandboxExecutionPolicyLike | undefined;
}

export interface RunListFilter {
  workspace?: string | undefined;
  actionId?: string | undefined;
  /** Session isolation (T14): only runs owned by this session. */
  sessionId?: string | undefined;
}

export interface RunService {
  /** All known runs, oldest first, optionally filtered. Fresh copies. */
  listRuns(filter?: RunListFilter): ActionRunSummary[];
  /**
   * Request a run. Resolves with the structured conflict-protocol outcome;
   * never implicitly interrupts an active instance. Rejects with
   * {@link RunServiceError} when execution itself is impossible.
   */
  run(action: ProjectActionSummary, options: RunRequestOptions): Promise<RunStartResult>;
  /** Full definition + current status + retained output. Throws `run-not-found`. */
  inspect(runId: string): RunInspection;
  /**
   * Cancel a run (idempotent: terminal runs return their summary unchanged).
   * Throws `run-not-found`.
   */
  cancel(runId: string, reason?: string): ActionRunSummary;
  /** Offset-based output read for the streaming endpoint's resume. Throws `run-not-found`. */
  readOutput(runId: string, offset?: number): RunOutputSnapshot;
  /** Resolves with the terminal summary once the run settles. Throws `run-not-found`. */
  waitForSettled(runId: string): Promise<ActionRunSummary>;
  /** Fires on every status transition. Listener errors are contained. */
  onDidChangeRun(listener: (run: ActionRunSummary) => void): () => void;
  /** Fires for every appended output chunk. Listener errors are contained. */
  onDidOutput(listener: (frame: RunOutputFrame) => void): () => void;
  /** Cancel every active run and release listeners. */
  dispose(): void;
  /**
   * Forget a settled run record entirely (removes it from listings and the
   * discovery snapshots — the chips' "remove record" action). Throws
   * `run-not-found` for unknown ids and `run-active` for a still-active run
   * (stopping is `cancel`'s job, not forgetting's).
   */
  forget(runId: string): void;
}

export interface RunServiceDeps {
  shell?: ShellLike | undefined;
  /** Session pin board for input values (T38); absent means no middle level. */
  sessionParams?: SessionParamStore | undefined;
  jobs?: JobsLike | undefined;
  /** Per-run retained-output cap. Default 256 KiB. */
  outputLimitBytes?: number | undefined;
  /** Output pump poll interval. Default 200ms. */
  pollIntervalMs?: number | undefined;
  /** Terminal run records retained per session (LRU, oldest settled first). Default 50. Active runs are never evicted. */
  terminalRetentionPerSession?: number | undefined;
  now?: (() => number) | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

interface RunRecord {
  summary: ActionRunSummary;
  action: ProjectActionSummary;
  /** Owning runtime session (T14); mirrors `summary.sessionId`, always set. */
  sessionId: string;
  /** Canonical params signature (T33); joins the conflict key. */
  signature: string;
  buffer: OutputRingBuffer;
  owner?: AgentLike | undefined;
  proc?: ShellProcessLike | undefined;
  jobId?: string | undefined;
  settled: boolean;
  cancelRequested: boolean;
  settle: (summary: ActionRunSummary) => void;
  settledPromise: Promise<ActionRunSummary>;
}

function isTerminalStatus(status: ActionRunStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

/**
 * T14: conflicts are per session — the workspace is deliberately NOT part of
 * the key. T33: the canonical params signature joins the key, so the same
 * action with different input values never conflicts. JSON-encoded tuple:
 * no separator ambiguity whatever the ids contain (T37).
 */
function conflictKey(sessionId: string, actionId: string, signature: string): string {
  return JSON.stringify([sessionId, actionId, signature]);
}

function clampInstanceLimit(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.floor(value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * T33: evaluate `${input:id}` placeholders for one run. The catalog keeps
 * them verbatim; here the normalized values are substituted into
 * command/cwd/env/detail. Other variables were already resolved at catalog
 * load, so the context carries the inputs only (env stays verbatim).
 */
export function evaluateAction(
  action: ProjectActionSummary,
  workspace: string,
  values: Record<string, string>,
): ProjectActionSummary {
  if (action.inputs === undefined || action.inputs.length === 0) return action;
  const substitute = (text: string): string =>
    substituteVariables(text, { workspaceFolder: workspace, userHome: '', env: {}, inputs: values });
  const evaluated: ProjectActionSummary = {
    ...action,
    command: substitute(action.command),
    cwd: resolve(workspace, substitute(action.cwd)),
  };
  if (action.detail !== undefined) evaluated.detail = substitute(action.detail);
  if (action.env !== undefined) {
    evaluated.env = Object.fromEntries(Object.entries(action.env).map(([key, value]) => [key, substitute(value)]));
  }
  return evaluated;
}

export function createRunService(deps: RunServiceDeps = {}): RunService {
  const outputLimitBytes = deps.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES;
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const terminalRetention = Math.max(0, Math.floor(deps.terminalRetentionPerSession ?? DEFAULT_TERMINAL_RETENTION_PER_SESSION));
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const records = new Map<string, RunRecord>();
  const changeListeners = new Set<(run: ActionRunSummary) => void>();
  const outputListeners = new Set<(frame: RunOutputFrame) => void>();
  let sequence = 0;
  let disposed = false;

  function copySummary(record: RunRecord): ActionRunSummary {
    // T37: params is a nested record — copy it too, or callers could mutate
    // the run's own values through the summary.
    const summary = { ...record.summary };
    if (record.summary.params !== undefined) summary.params = { ...record.summary.params };
    return summary;
  }

  function emitChange(record: RunRecord): void {
    const summary = copySummary(record);
    for (const listener of changeListeners) {
      try {
        listener(summary);
      } catch {
        // contained: one bad listener must not break the run loop
      }
    }
  }

  function emitOutput(record: RunRecord, offset: number, text: string, truncated: boolean): void {
    const frame: RunOutputFrame = { runId: record.summary.id, offset, text };
    if (truncated) frame.truncated = true;
    for (const listener of outputListeners) {
      try {
        listener(frame);
      } catch {
        // contained
      }
    }
  }

  /**
   * Evict oldest settled records beyond the per-session retention cap (T14).
   * Active runs are never evicted. Evicted ids become `run-not-found`.
   */
  function evictTerminalRuns(sessionId: string): void {
    if (terminalRetention === 0) {
      for (const [id, record] of records) {
        if (record.settled && record.sessionId === sessionId) records.delete(id);
      }
      return;
    }
    let terminalCount = 0;
    for (const record of records.values()) {
      if (record.settled && record.sessionId === sessionId) terminalCount += 1;
    }
    // Map iteration is insertion-ordered, so the first settled entries are the oldest.
    for (const [id, record] of records) {
      if (terminalCount <= terminalRetention) return;
      if (record.settled && record.sessionId === sessionId) {
        records.delete(id);
        terminalCount -= 1;
      }
    }
  }

  function transition(record: RunRecord, status: ActionRunStatus, exitCode?: number | null): void {
    record.summary.status = status;
    if (exitCode !== undefined) record.summary.exitCode = exitCode;
    if (isTerminalStatus(status) && !record.settled) {
      record.settled = true;
      record.summary.finishedAt = now();
      record.settle(copySummary(record));
      emitChange(record);
      evictTerminalRuns(record.sessionId);
      return;
    }
    emitChange(record);
  }

  function ingest(record: RunRecord, read: ShellProcessReadLike): void {
    if (read.lossy) {
      record.buffer.spillPath = read.stdoutSpillPath ?? read.stderrSpillPath ?? record.buffer.spillPath;
    }
    const appended = record.buffer.append(read.delta);
    if (appended !== undefined) {
      emitOutput(record, appended.offset, appended.text, read.lossy);
    }
  }

  /** First-wins terminal settlement; later transitions are ignored. */
  function terminate(record: RunRecord, status: 'succeeded' | 'failed' | 'cancelled', exitCode: number | null): void {
    if (record.settled) return;
    transition(record, status, exitCode);
  }

  function killProcess(record: RunRecord): void {
    try {
      record.proc?.kill();
    } catch {
      // best-effort: the run is already marked cancelled
    }
  }

  function cancelRecord(record: RunRecord, reason: string | undefined, killJob: boolean): ActionRunSummary {
    if (record.settled) return copySummary(record);
    record.cancelRequested = true;
    terminate(record, 'cancelled', null);
    if (killJob && record.jobId !== undefined && deps.jobs !== undefined) {
      try {
        deps.jobs.kill(record.jobId, record.owner, reason ?? 'actions_cancel');
      } catch {
        // best-effort: process kill below still stops the work
      }
    }
    killProcess(record);
    return copySummary(record);
  }

  function settleFromProcess(record: RunRecord, proc: ShellProcessLike): void {
    try {
      ingest(record, proc.readOutput());
    } catch {
      // a failing final read must not block settlement
    }
    if (record.settled) return; // cancel won the race (first-wins)
    const exitCode = proc.exitCode;
    terminate(record, exitCode === 0 ? 'succeeded' : 'failed', exitCode);
  }

  async function pump(record: RunRecord, proc: ShellProcessLike): Promise<void> {
    while (!record.settled) {
      await sleep(pollIntervalMs);
      if (record.settled) return;
      try {
        ingest(record, proc.readOutput());
      } catch {
        return; // a broken handle settles via done/kill paths instead
      }
    }
  }

  function registerJob(record: RunRecord): void {
    const jobs = deps.jobs;
    if (jobs === undefined) return; // jobs registry is optional; runs degrade without it
    const jobDone = new Promise<JobOutcomeLike>((resolve) => {
      void record.settledPromise.then((summary) => {
        const output = record.buffer.snapshot();
        if (summary.status === 'succeeded') {
          resolve({ status: 'completed', output: output.text });
        } else if (summary.status === 'cancelled') {
          resolve({ status: 'killed', output: output.text });
        } else {
          resolve({
            status: 'failed',
            detail: `Action exited with code ${summary.exitCode ?? 'unknown'}`,
            output: output.text,
          });
        }
      });
    });
    try {
      record.jobId = jobs.start({
        kind: 'bash',
        label: `action: ${record.action.label}`,
        outputLimitBytes,
        owner: record.owner,
        run: () => ({
          cancel: (reason?: string) => {
            cancelRecord(record, reason, false);
          },
          done: jobDone,
          readOutput: () => record.buffer.snapshot().text,
        }),
      });
    } catch {
      // registration is best-effort; the run itself is already live
    }
  }

  function requireRecord(runId: string): RunRecord {
    const record = records.get(runId);
    if (record === undefined) {
      throw new RunServiceError('run-not-found', `Unknown action run: ${runId}`);
    }
    return record;
  }

  function outputSnapshot(record: RunRecord, offset?: number): RunOutputSnapshot {
    const snapshot = offset === undefined ? record.buffer.snapshot() : record.buffer.read(offset);
    const result: RunOutputSnapshot = { ...snapshot };
    if (record.buffer.spillPath !== undefined) result.spillPath = record.buffer.spillPath;
    return result;
  }

  const service: RunService = {
    listRuns(filter) {
      const runs: ActionRunSummary[] = [];
      for (const record of records.values()) {
        if (filter?.workspace !== undefined && record.summary.workspace !== filter.workspace) continue;
        if (filter?.actionId !== undefined && record.summary.actionId !== filter.actionId) continue;
        if (filter?.sessionId !== undefined && record.sessionId !== filter.sessionId) continue;
        runs.push(copySummary(record));
      }
      return runs;
    },

    async run(action, options) {
      if (disposed) throw new RunServiceError('disposed', 'Run service is disposed');

      // 0. Parameter evaluation (T33 × T38): the three-level chain — explicit
      // call params win over the session pin board, pins win over config
      // defaults (a pin also SATISFIES `required`). Validate/normalize the
      // merged values BEFORE anything else; the canonical signature joins
      // the conflict key below.
      const effectiveParams = { ...deps.sessionParams?.get(options.sessionId, action.id), ...options.params };
      let normalized;
      try {
        normalized = normalizeParams(action.inputs, effectiveParams);
      } catch (error) {
        throw new RunServiceError('invalid-params', `Action "${action.label}": ${errorMessage(error)}`, {
          cause: error,
        });
      }
      const evaluated = evaluateAction(action, options.workspace, normalized.values);

      // 1. Unified conflict protocol: key (sessionId, actionId, signature) —
      // the same action in the same workspace does not conflict across
      // sessions (T14), and distinct parameter values never conflict (T33);
      // never implicit interruption.
      const key = conflictKey(options.sessionId, action.id, normalized.signature);
      const active: RunRecord[] = [];
      for (const record of records.values()) {
        if (!record.settled && conflictKey(record.sessionId, record.summary.actionId, record.signature) === key) {
          active.push(record);
        }
      }
      const limit = clampInstanceLimit(action.runOptions.instanceLimit);
      const existing = active[active.length - 1];
      if (existing !== undefined && active.length >= limit) {
        if (action.runOptions.instancePolicy === 'reject') {
          return { kind: 'rejected', reason: 'exclusive', run: copySummary(existing) };
        }
        return { kind: 'already-running', run: copySummary(existing) };
      }

      // 2. Execution capability: the host shell service is required.
      const shell = deps.shell;
      if (shell === undefined) {
        throw new RunServiceError(
          'shell-unavailable',
          'The host shell service (ctx.shell) is not available; action runs cannot start.',
        );
      }

      // 3. Create the record synchronously so concurrent requests see it.
      sequence += 1;
      let settle!: (summary: ActionRunSummary) => void;
      const settledPromise = new Promise<ActionRunSummary>((resolve) => {
        settle = resolve;
      });
      const record: RunRecord = {
        summary: {
          id: `run-${sequence}`,
          actionId: action.id,
          workspace: options.workspace,
          sessionId: options.sessionId,
          status: 'queued',
          startedAt: now(),
        },
        action: evaluated,
        sessionId: options.sessionId,
        signature: normalized.signature,
        buffer: new OutputRingBuffer(outputLimitBytes),
        owner: options.owner,
        settled: false,
        cancelRequested: false,
        settle,
        settledPromise,
      };
      // T33: the wire summary carries the resolved values when the action
      // declares inputs (actions_inspect shows what the run actually used).
      if (action.inputs !== undefined && action.inputs.length > 0) record.summary.params = normalized.values;
      records.set(record.summary.id, record);
      emitChange(record);

      // 4. Launch through the host shell. The sandbox policy is the calling
      // session's own resolution, passed through with the run's workspace as
      // root; when the caller supplies none, the request carries no policy
      // field and the shell falls back to the deployment default (T8-B1).
      const request: ShellExecRequestLike = {
        command: evaluated.command,
        workdir: evaluated.cwd,
      };
      if (options.sandboxPolicy !== undefined) {
        request.sandboxPolicy = { ...options.sandboxPolicy, workspaceRoot: options.workspace };
      }
      if (evaluated.env !== undefined) request.env = evaluated.env;
      let proc: ShellProcessLike;
      try {
        proc = await shell.execute(shell.resolve(request));
      } catch (error) {
        terminate(record, 'failed', null);
        throw new RunServiceError('start-failed', `Failed to start action "${action.label}": ${errorMessage(error)}`, {
          cause: error,
        });
      }
      if (record.settled) {
        // Cancelled while start was in flight: stop the just-published
        // process. The result still reports 'started' with the already-
        // cancelled summary — first-wins keeps the cancel authoritative.
        killProcess(record);
        return { kind: 'started', run: copySummary(record) };
      }
      record.proc = proc;
      transition(record, 'running');
      registerJob(record);
      void pump(record, proc);
      void proc.done.then(() => {
        settleFromProcess(record, proc);
      });
      return { kind: 'started', run: copySummary(record) };
    },

    inspect(runId) {
      const record = requireRecord(runId);
      // T37: hand out a copy of the evaluated definition, not the record's own.
      return { run: copySummary(record), action: { ...record.action }, output: outputSnapshot(record) };
    },

    cancel(runId, reason) {
      return cancelRecord(requireRecord(runId), reason, true);
    },

    forget(runId) {
      const record = requireRecord(runId);
      if (!record.settled) {
        throw new RunServiceError('run-active', `Cannot forget the active run: ${runId} (cancel it first)`);
      }
      records.delete(runId);
    },

    readOutput(runId, offset) {
      return outputSnapshot(requireRecord(runId), offset);
    },

    waitForSettled(runId) {
      return requireRecord(runId).settledPromise;
    },

    onDidChangeRun(listener) {
      changeListeners.add(listener);
      return () => {
        changeListeners.delete(listener);
      };
    },

    onDidOutput(listener) {
      outputListeners.add(listener);
      return () => {
        outputListeners.delete(listener);
      };
    },

    dispose() {
      disposed = true;
      // Snapshot: cancelRecord settles records, which may evict from the map.
      for (const record of Array.from(records.values())) {
        cancelRecord(record, 'run-service-disposed', true);
      }
      changeListeners.clear();
      outputListeners.clear();
    },
  };

  return service;
}
