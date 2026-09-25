/**
 * PanelStore unit tests (T16): session-scoped run lifecycle with a fake
 * ActionsApi — UI-initiated runs, realtime discovery of agent-initiated runs,
 * and hard session isolation.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ActionInputConfig,
  ActionRunStatus,
  ActionRunSummary,
  ActionsCatalog,
  ProjectActionSummary,
  RunStartResult,
  RunStreamFrame,
} from '../src/contract.js';
import { ActionsApiError, createHttpApi } from '../src/client/api.js';
import type { ActionsApi, CatalogEventFrame, RunDiscoveryFrame, RunInspection } from '../src/client/api.js';
import { PanelStore, resolveParamValues, selectRunTabs } from '../src/client/store.js';
import type { RunViewState } from '../src/client/store.js';
import { AUTHORING_SKILL, buildCtaDraft, ctaPromptKey, mergeCtaDraft, sourceNeedsCta } from '../src/client/cta.js';
import { buildActionBadges, extendsLabel } from '../src/client/badges.js';
import type { Translate } from '../src/client/locale.js';
import {
  actionCandidates,
  actionLexicon,
  buildActionToken,
  sectionKeyOf,
  serializeActionRef,
} from '../src/client/references.js';

// ---------------------------------------------------------------------------
// In-memory run engine (inlined from the deleted src/client/mock.ts — it is
// pure test infrastructure, never wired into the panel).
// ---------------------------------------------------------------------------

interface MockRunEngine {
  run(action: ProjectActionSummary): RunStartResult;
  cancel(runId: string): ActionRunSummary | undefined;
  forget(runId: string): boolean;
  inspect(runId: string, offset?: number): RunInspection | undefined;
  stream(
    runId: string,
    sinceOffset: number,
    onFrame: (frame: RunStreamFrame) => void,
    signal?: AbortSignal,
  ): Promise<void>;
}

interface MockRunRecord {
  summary: ActionRunSummary;
  chunks: { offset: number; text: string }[];
  listeners: Set<(frame: RunStreamFrame) => void>;
  timers: ReturnType<typeof setTimeout>[];
  settled: boolean;
}

const MOCK_TERMINAL: readonly ActionRunStatus[] = ['succeeded', 'failed', 'cancelled'];

function mockIsTerminal(status: ActionRunStatus): boolean {
  return MOCK_TERMINAL.includes(status);
}

const mockEncoder = new TextEncoder();

function mockOutputLines(action: ProjectActionSummary): string[] {
  return [
    `$ ${action.command}\n`,
    `[mock] resolving ${action.label} in ${action.cwd}\n`,
    '[mock] step 1/4 · preparing environment\n',
    '[mock] step 2/4 · executing\n',
    '[mock] step 3/4 · executing\n',
    '[mock] step 4/4 · collecting results\n',
    '[mock] done\n',
  ];
}

function createMockRunEngine(now: () => number = () => Date.now()): MockRunEngine {
  const records = new Map<string, MockRunRecord>();
  let counter = 0;

  const emit = (record: MockRunRecord, frame: RunStreamFrame): void => {
    for (const listener of record.listeners) listener(frame);
  };

  const settle = (record: MockRunRecord, status: ActionRunStatus, exitCode: number | null): void => {
    if (record.settled) return;
    record.settled = true;
    for (const timer of record.timers) clearTimeout(timer);
    record.timers = [];
    record.summary = {
      ...record.summary,
      status,
      finishedAt: now(),
      exitCode,
    };
    emit(record, { type: 'status', run: record.summary });
  };

  const activeFor = (actionId: string): MockRunRecord | undefined => {
    for (const record of records.values()) {
      if (record.summary.actionId === actionId && !mockIsTerminal(record.summary.status)) return record;
    }
    return undefined;
  };

  return {
    run(action) {
      const active = activeFor(action.id);
      if (active !== undefined) {
        return action.runOptions.instancePolicy === 'reject'
          ? { kind: 'rejected', reason: 'exclusive', run: active.summary }
          : { kind: 'already-running', run: active.summary };
      }
      counter += 1;
      const record: MockRunRecord = {
        summary: {
          id: `mock-run-${String(counter)}`,
          actionId: action.id,
          workspace: action.cwd,
          status: 'queued',
          startedAt: now(),
        },
        chunks: [],
        listeners: new Set(),
        timers: [],
        settled: false,
      };
      records.set(record.summary.id, record);
      record.timers.push(setTimeout(() => {
        record.summary = { ...record.summary, status: 'running' };
        emit(record, { type: 'status', run: record.summary });
      }, 60));
      const lines = mockOutputLines(action);
      let offset = 0;
      lines.forEach((text, index) => {
        const chunk = { offset, text };
        offset += mockEncoder.encode(text).length;
        record.timers.push(setTimeout(() => {
          if (record.settled) return;
          record.chunks.push(chunk);
          emit(record, { type: 'output', runId: record.summary.id, offset: chunk.offset, text: chunk.text });
        }, 200 + index * 240));
      });
      record.timers.push(setTimeout(() => {
        settle(record, 'succeeded', 0);
      }, 200 + lines.length * 240 + 200));
      return { kind: 'started', run: record.summary };
    },
    cancel(runId) {
      const record = records.get(runId);
      if (record === undefined) return undefined;
      settle(record, 'cancelled', null);
      return record.summary;
    },
    forget(runId) {
      return records.delete(runId);
    },
    inspect(runId, offset = 0) {
      const record = records.get(runId);
      if (record === undefined) return undefined;
      return {
        run: record.summary,
        output: record.chunks.filter((chunk) => chunk.offset >= offset).map((chunk) => chunk.text).join(''),
        truncated: false,
      };
    },
    stream(runId, sinceOffset, onFrame, signal) {
      const record = records.get(runId);
      if (record === undefined) return Promise.resolve();
      return new Promise<void>((resolve) => {
        let finished = false;
        const finish = (): void => {
          if (finished) return;
          finished = true;
          record.listeners.delete(listener);
          resolve();
        };
        const listener = (frame: RunStreamFrame): void => {
          onFrame(frame);
          if (frame.type === 'status' && mockIsTerminal(frame.run.status)) finish();
        };
        const onAbort = (): void => { finish(); };
        // Replay buffered chunks first, then ride live frames.
        for (const chunk of record.chunks) {
          if (chunk.offset >= sinceOffset) {
            onFrame({ type: 'output', runId, offset: chunk.offset, text: chunk.text });
          }
        }
        if (record.settled) {
          onFrame({ type: 'status', run: record.summary });
          finish();
          return;
        }
        record.listeners.add(listener);
        if (signal !== undefined) {
          if (signal.aborted) { finish(); return; }
          signal.addEventListener('abort', onAbort, { once: true });
        }
      });
    },
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });
/** Mock engine settles a run after ~2.1s of simulated output. */
const SETTLE_MS = 2600;

/**
 * Fake Host: one mock engine per session, ownership checks identical to the
 * T15 RPC (foreign runId answers like a 404), and a discovery bus matching
 * the confirmed T16 contract (leading snapshot, then live status frames).
 */
class FakeApi implements ActionsApi {
  readonly calls: string[] = [];
  private readonly workspaces: Record<string, string>;
  private readonly engines = new Map<string, MockRunEngine>();
  private readonly runSessions = new Map<string, string>();
  private readonly listeners = new Map<string, Set<(frame: RunDiscoveryFrame) => void>>();
  private readonly catalogListeners = new Map<string, Set<(frame: CatalogEventFrame) => void>>();
  /** Catalog overrides per session for T22 event frames. */
  private readonly catalogOverrides = new Map<string, ActionsCatalog>();
  /** Runs injected directly by a test (no engine timers — instant lifecycle). */
  private readonly fabricated = new Map<string, { sessionId: string; run: ActionRunSummary; output: string }>();

  constructor(workspaces: Record<string, string>) {
    this.workspaces = workspaces;
  }

  private engineFor(sessionId: string): MockRunEngine {
    let engine = this.engines.get(sessionId);
    if (engine === undefined) {
      engine = createMockRunEngine();
      this.engines.set(sessionId, engine);
    }
    return engine;
  }

  private stamp(run: ActionRunSummary, sessionId: string): ActionRunSummary {
    return { ...run, sessionId };
  }

  summaryOf(runId: string, sessionId: string): ActionRunSummary {
    const fab = this.fabricated.get(runId);
    if (fab !== undefined) return fab.run;
    const inspection = this.engineFor(sessionId).inspect(runId);
    if (inspection === undefined) throw new Error(`unknown run: ${runId}`);
    return this.stamp(inspection.run, sessionId);
  }

  /** Test helper: inject a run in any state and announce it over discovery. */
  injectRun(sessionId: string, run: ActionRunSummary, output = 'injected output\n'): void {
    const stamped = this.stamp(run, sessionId);
    this.fabricated.set(run.id, { sessionId, run: stamped, output });
    this.runSessions.set(run.id, sessionId);
    this.emit(sessionId, { type: 'status', run: stamped });
  }

  /** Test helper: transition a fabricated run and announce it. */
  transitionRun(runId: string, status: ActionRunSummary['status'], exitCode?: number): void {
    const fab = this.fabricated.get(runId);
    if (fab === undefined) throw new Error(`unknown fabricated run: ${runId}`);
    fab.run = {
      ...fab.run,
      status,
      finishedAt: Date.now(),
      exitCode: exitCode ?? null,
    };
    this.emit(fab.sessionId, { type: 'status', run: fab.run });
  }

  private runsOf(sessionId: string): ActionRunSummary[] {
    return [...this.runSessions.entries()]
      .filter(([, owner]) => owner === sessionId)
      .map(([runId]) => this.summaryOf(runId, sessionId));
  }

  private assertOwner(sessionId: string, runId: string): void {
    if (this.runSessions.get(runId) !== sessionId) throw new Error(`404 run-not-found: ${runId}`);
  }

  private emit(sessionId: string, frame: RunDiscoveryFrame): void {
    for (const listener of this.listeners.get(sessionId) ?? []) listener(frame);
  }

  /** The mock engine never declines approvals, so its results always carry a run. */
  private startRun(sessionId: string, actionId: string, params?: Record<string, string>): Extract<RunStartResult, { run: ActionRunSummary }> {
    const result = this.engineFor(sessionId).run(this.actionFor(sessionId, actionId));
    if (result.kind === 'approval-declined') throw new Error('mock engine unexpectedly declined');
    const run = this.stamp(result.run, sessionId);
    const stamped = {
      ...result,
      run: params === undefined ? run : { ...run, params },
    } as Extract<RunStartResult, { run: ActionRunSummary }>;
    if (result.kind === 'started') this.runSessions.set(result.run.id, sessionId);
    this.emit(sessionId, { type: 'status', run: stamped.run });
    return stamped;
  }

  actionFor(sessionId: string, actionId: string, inputs?: ProjectActionSummary['inputs']): ProjectActionSummary {
    const workspace = this.workspaces[sessionId] ?? '/ws/unknown';
    return {
      id: actionId,
      label: actionId,
      sourceLayer: 'workspace',
      visibility: 'all',
      approval: 'never',
      command: `echo ${actionId}`,
      cwd: workspace,
      runOptions: { instanceLimit: 1, instancePolicy: 'reuse' },
      ...(inputs === undefined ? {} : { inputs }),
    };
  }

  /** Test helper: the Agent entry starts a run in `sessionId`. */
  agentStart(sessionId: string, actionId: string): Extract<RunStartResult, { run: ActionRunSummary }> {
    return this.startRun(sessionId, actionId);
  }

  /** Test helper: the Agent entry cancels a run in `sessionId`. */
  agentCancel(sessionId: string, runId: string): void {
    this.assertOwner(sessionId, runId);
    this.engineFor(sessionId).cancel(runId);
    this.emit(sessionId, { type: 'status', run: this.summaryOf(runId, sessionId) });
  }

  /** Test helper: push a raw discovery frame (including hostile ones). */
  pushFrame(sessionId: string, frame: RunDiscoveryFrame): void {
    this.emit(sessionId, frame);
  }

  /** Session pin board (T38/T39): sessionId -> actionId -> pinned values. */
  private readonly pinBoards = new Map<string, Map<string, Record<string, string>>>();

  private pinsOf(sessionId: string): Map<string, Record<string, string>> {
    let board = this.pinBoards.get(sessionId);
    if (board === undefined) {
      board = new Map();
      this.pinBoards.set(sessionId, board);
    }
    return board;
  }

  /** Actions deleted through the endpoint (T51), removed from later catalogs. */
  private readonly deletedActions = new Set<string>();

  catalogFor(sessionId: string): ActionsCatalog {
    const catalog = this.catalogOverrides.get(sessionId) ?? {
      apiVersion: 1,
      workspace: this.workspaces[sessionId] ?? '/ws/unknown',
      sources: [],
      actions: [this.actionFor(sessionId, 'build')],
      runs: this.runsOf(sessionId),
    };
    const visible = this.deletedActions.size === 0
      ? catalog
      : { ...catalog, actions: catalog.actions.filter((action) => !this.deletedActions.has(`${sessionId}:${action.id}`)) };
    const board = this.pinBoards.get(sessionId);
    return board === undefined || board.size === 0
      ? visible
      : { ...visible, sessionParams: Object.fromEntries([...board.entries()].map(([key, value]) => [key, { ...value }])) };
  }

  deleteAction(sessionId: string, actionId: string): Promise<void> {
    this.calls.push(`delete:${sessionId}:${actionId}`);
    this.deletedActions.add(`${sessionId}:${actionId}`);
    // The Host republishes catalog frames after a delete.
    const catalog = this.catalogFor(sessionId);
    for (const listener of this.catalogListeners.get(sessionId) ?? []) {
      listener({ type: 'catalog', catalog });
    }
    return Promise.resolve();
  }

  saveSessionParams(
    sessionId: string,
    actionId: string,
    values: Record<string, string> | undefined,
  ): Promise<Record<string, string>> {
    this.calls.push(values === undefined ? `unpin:${sessionId}:${actionId}` : `pin:${sessionId}:${actionId}`);
    const board = this.pinsOf(sessionId);
    if (values === undefined || Object.keys(values).length === 0) board.delete(actionId);
    else board.set(actionId, { ...values });
    // The Host republishes catalog frames after a pin write.
    const catalog = this.catalogFor(sessionId);
    for (const listener of this.catalogListeners.get(sessionId) ?? []) {
      listener({ type: 'catalog', catalog });
    }
    return Promise.resolve(values === undefined ? {} : { ...values });
  }

  listCatalog(sessionId: string): Promise<ActionsCatalog> {
    this.calls.push(`catalog:${sessionId}`);
    return Promise.resolve(this.catalogFor(sessionId));
  }

  /** Test helper: emit a catalog event frame (T22) to subscribers. */
  pushCatalogFrame(sessionId: string, catalog: ActionsCatalog): void {
    this.catalogOverrides.set(sessionId, catalog);
    for (const listener of this.catalogListeners.get(sessionId) ?? []) {
      listener({ type: 'catalog', catalog });
    }
  }

  subscribeCatalog(
    sessionId: string,
    onFrame: (frame: CatalogEventFrame) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    this.calls.push(`subscribe-catalog:${sessionId}`);
    onFrame({ type: 'catalog', catalog: this.catalogFor(sessionId) });
    let set = this.catalogListeners.get(sessionId);
    if (set === undefined) {
      set = new Set();
      this.catalogListeners.set(sessionId, set);
    }
    set.add(onFrame);
    return new Promise((resolve) => {
      const release = (): void => {
        set.delete(onFrame);
        resolve();
      };
      if (signal?.aborted === true) {
        release();
        return;
      }
      signal?.addEventListener('abort', release, { once: true });
    });
  }

  /** Actions (by id) that answer 409 confirmation-required until confirmed:true. */
  readonly confirmationRequiredFor = new Set<string>();
  /** Next runAction returns this approval-declined outcome instead of starting. */
  declineNext: { outcome: 'rejected' | 'cancelled' | 'unavailable' } | undefined;
  /** Actions (by id) whose params fail evaluation with 400 invalid-params. */
  readonly invalidParamsFor = new Set<string>();
  /** Params recorded per run call (same index as the matching `run:*` calls). */
  readonly paramsCalls: (Record<string, string> | undefined)[] = [];
  /** Runs whose stream answers 404 run-not-found (Host LRU eviction). */
  readonly stream404For = new Set<string>();
  /** Runs whose inspect answers 404 run-not-found. */
  readonly inspect404For = new Set<string>();
  /** Runs whose cancel fails outright. */
  readonly failCancelFor = new Set<string>();
  /** Runs whose first stream attempt fails with a transient error. */
  readonly failStreamOnce = new Set<string>();

  runAction(
    sessionId: string,
    actionId: string,
    options?: { confirmed?: boolean; params?: Record<string, string> },
  ): Promise<RunStartResult> {
    this.calls.push(`run:${sessionId}:${actionId}${options?.confirmed === true ? ':confirmed' : ''}`);
    this.paramsCalls.push(options?.params);
    if (this.declineNext !== undefined) {
      const decline = this.declineNext;
      this.declineNext = undefined;
      return Promise.resolve({ kind: 'approval-declined', actionId, outcome: decline.outcome });
    }
    if (this.confirmationRequiredFor.has(actionId) && options?.confirmed !== true) {
      return Promise.reject(new ActionsApiError(409, 'confirmation-required', `Action "${actionId}" requires explicit confirmation`));
    }
    if (this.invalidParamsFor.has(actionId)) {
      return Promise.reject(new ActionsApiError(400, 'invalid-params', `Missing required parameter for action "${actionId}"`));
    }
    return Promise.resolve(this.startRun(sessionId, actionId, options?.params));
  }

  inspectRun(sessionId: string, runId: string, offset = 0): Promise<RunInspection> {
    this.calls.push(`inspect:${sessionId}:${runId}`);
    if (this.inspect404For.has(runId)) {
      return Promise.reject(new ActionsApiError(404, 'run-not-found', `Unknown action run: ${runId}`));
    }
    this.assertOwner(sessionId, runId);
    const fab = this.fabricated.get(runId);
    if (fab !== undefined) {
      return Promise.resolve({ run: fab.run, output: fab.output, truncated: false });
    }
    const inspection = this.engineFor(sessionId).inspect(runId, offset);
    if (inspection === undefined) return Promise.reject(new Error(`404 run-not-found: ${runId}`));
    return Promise.resolve({ ...inspection, run: this.stamp(inspection.run, sessionId) });
  }

  cancelRun(sessionId: string, runId: string): Promise<ActionRunSummary> {
    this.calls.push(`cancel:${sessionId}:${runId}`);
    if (this.failCancelFor.has(runId)) {
      return Promise.reject(new ActionsApiError(500, 'internal', 'cancel failed'));
    }
    this.assertOwner(sessionId, runId);
    const fab = this.fabricated.get(runId);
    if (fab !== undefined) {
      fab.run = { ...fab.run, status: 'cancelled', finishedAt: Date.now(), exitCode: null };
      return Promise.resolve(fab.run);
    }
    const run = this.engineFor(sessionId).cancel(runId);
    if (run === undefined) return Promise.reject(new Error(`404 run-not-found: ${runId}`));
    return Promise.resolve(this.stamp(run, sessionId));
  }

  forgetRun(sessionId: string, runId: string): Promise<void> {
    this.calls.push(`forget:${sessionId}:${runId}`);
    this.assertOwner(sessionId, runId);
    const fab = this.fabricated.get(runId);
    if (fab !== undefined) {
      this.fabricated.delete(runId);
      return Promise.resolve();
    }
    if (!this.engineFor(sessionId).forget(runId)) {
      return Promise.reject(new Error(`404 run-not-found: ${runId}`));
    }
    return Promise.resolve();
  }

  streamRun(
    sessionId: string,
    runId: string,
    sinceOffset: number,
    onFrame: (frame: RunStreamFrame) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    this.calls.push(`stream:${sessionId}:${runId}`);
    if (this.stream404For.has(runId)) {
      return Promise.reject(new ActionsApiError(404, 'run-not-found', `Unknown action run: ${runId}`));
    }
    if (this.failStreamOnce.delete(runId)) {
      return Promise.reject(new Error('transient stream failure'));
    }
    this.assertOwner(sessionId, runId);
    const fab = this.fabricated.get(runId);
    if (fab !== undefined) {
      if (fab.output.length > 0) onFrame({ type: 'output', runId, offset: 0, text: fab.output });
      onFrame({ type: 'status', run: fab.run });
      if (fab.run.status === 'succeeded' || fab.run.status === 'failed' || fab.run.status === 'cancelled') {
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        if (signal === undefined || signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener('abort', () => { resolve(); }, { once: true });
      });
    }
    return this.engineFor(sessionId).stream(runId, sinceOffset, onFrame, signal);
  }

  subscribeRuns(
    sessionId: string,
    onFrame: (frame: RunDiscoveryFrame) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    this.calls.push(`subscribe:${sessionId}`);
    onFrame({ type: 'snapshot', runs: this.runsOf(sessionId) });
    let set = this.listeners.get(sessionId);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(onFrame);
    return new Promise((resolve) => {
      const release = (): void => {
        set.delete(onFrame);
        resolve();
      };
      if (signal?.aborted === true) {
        release();
        return;
      }
      signal?.addEventListener('abort', release, { once: true });
    });
  }
}

async function bind(store: PanelStore, sessionId: string): Promise<void> {
  store.setSession(sessionId, '');
  await sleep(30);
}

function makeRun(id: string, actionId: string, startedAt: number, status: ActionRunSummary['status']): ActionRunSummary {
  return { id, actionId, workspace: '/ws/a', status, startedAt };
}

describe('PanelStore session-scoped runs (T16)', () => {
  it('UI-initiated run carries sessionId on every run-scoped call', { timeout: 15000 }, async () => {
    const api = new FakeApi({ s1: '/ws/a' });
    const store = new PanelStore(api);
    await bind(store, 's1');

    await store.runAction('build');
    await sleep(SETTLE_MS);

    const runId = store.state.latestRunByAction.build;
    expect(runId).toBeDefined();
    expect(store.state.runs[runId as string]?.run.status).toBe('succeeded');
    expect(store.state.runs[runId as string]?.output).toContain('echo build');
    expect(api.calls).toContain('run:s1:build');
    expect(api.calls).toContain(`stream:s1:${runId as string}`);
    store.dispose();
  });

  it('agent-started run appears in realtime, associates the action, and streams output', { timeout: 15000 }, async () => {
    const api = new FakeApi({ s1: '/ws/a' });
    const store = new PanelStore(api);
    await bind(store, 's1');
    expect(api.calls).toContain('subscribe:s1');

    const result = api.agentStart('s1', 'build');
    const runId = result.run.id;
    await sleep(30);

    // Associated + marked running before the output stream finishes.
    const view = store.state.runs[runId];
    expect(view).toBeDefined();
    expect(store.state.latestRunByAction.build).toBe(runId);
    expect(api.calls).toContain(`stream:s1:${runId}`);

    await sleep(SETTLE_MS);
    expect(store.state.runs[runId]?.run.status).toBe('succeeded');
    expect(store.state.runs[runId]?.output).toContain('echo build');
    store.dispose();
  });

  it('agent-side cancel updates the run in realtime', { timeout: 15000 }, async () => {
    const api = new FakeApi({ s1: '/ws/a' });
    const store = new PanelStore(api);
    await bind(store, 's1');

    const result = api.agentStart('s1', 'build');
    await sleep(30);
    api.agentCancel('s1', result.run.id);
    await sleep(30);

    expect(store.state.runs[result.run.id]?.run.status).toBe('cancelled');
    store.dispose();
  });

  it('two sessions on the same cwd never see each other\'s runs', { timeout: 15000 }, async () => {
    const api = new FakeApi({ s1: '/ws/shared', s2: '/ws/shared' });
    const store = new PanelStore(api);
    await bind(store, 's1');

    api.agentStart('s2', 'build'); // same action id, foreign session
    await sleep(50);

    expect(Object.keys(store.state.runs)).toHaveLength(0);
    expect(store.state.latestRunByAction.build).toBeUndefined();

    // The store's own run stays isolated the other way too: s2's catalog
    // never lists it.
    await store.runAction('build');
    const runId = store.state.latestRunByAction.build as string;
    expect(runId).toBeDefined();
    const s2Catalog = await api.listCatalog('s2');
    expect(s2Catalog.runs.map((run) => run.id)).not.toContain(runId);
    store.dispose();
  });

  it('ignores a leaked discovery frame naming another session', { timeout: 15000 }, async () => {
    const api = new FakeApi({ s1: '/ws/a' });
    const store = new PanelStore(api);
    await bind(store, 's1');

    const foreign: ActionRunSummary = {
      id: 'foreign-run',
      actionId: 'build',
      workspace: '/ws/a',
      status: 'running',
      startedAt: Date.now(),
      sessionId: 'someone-else',
    };
    api.pushFrame('s1', { type: 'status', run: foreign });
    await sleep(20);

    expect(store.state.runs['foreign-run']).toBeUndefined();
    store.dispose();
  });

  it('switching sessions unsubscribes, resets, and never replays the old session', { timeout: 15000 }, async () => {
    const api = new FakeApi({ s1: '/ws/a', s2: '/ws/b' });
    const store = new PanelStore(api);
    await bind(store, 's1');
    api.agentStart('s1', 'build');
    await sleep(30);
    expect(Object.keys(store.state.runs)).toHaveLength(1);

    store.setSession('s2', '');
    await sleep(30);

    expect(api.calls).toContain('subscribe:s2');
    expect(store.state.catalog?.workspace).toBe('/ws/b');
    expect(Object.keys(store.state.runs)).toHaveLength(0);

    // Old-session activity after the switch must not surface.
    api.agentStart('s1', 'build');
    await sleep(50);
    expect(Object.keys(store.state.runs)).toHaveLength(0);
    store.dispose();
  });

  it('keeps runIdsByAction newest-first; selectAction defaults to the newest run', { timeout: 15000 }, async () => {
    const api = new FakeApi({ s1: '/ws/a' });
    const store = new PanelStore(api);
    await bind(store, 's1');

    api.injectRun('s1', makeRun('r1', 'build', 1000, 'succeeded'));
    api.injectRun('s1', makeRun('r2', 'build', 2000, 'succeeded'));
    await sleep(30);

    expect(store.state.runIdsByAction.build).toEqual(['r2', 'r1']);
    expect(store.state.latestRunByAction.build).toBe('r2');
    expect(store.runsOfAction('build').map((view) => view.run.id)).toEqual(['r2', 'r1']);
    // Discovery auto-selected the newest while nothing was being watched.
    expect(store.state.selectedRunId).toBe('r2');

    // Re-selecting the action always lands on the newest run and loads it.
    store.selectRun('r1');
    await sleep(30);
    expect(store.state.selectedRunId).toBe('r1');
    store.selectAction('build');
    await sleep(30);
    expect(store.state.selectedRunId).toBe('r2');
    expect(api.calls).toContain('inspect:s1:r2');
    store.dispose();
  });

  it('auto-selects a discovered run only when watching the newest, never steals focus', { timeout: 15000 }, async () => {
    const api = new FakeApi({ s1: '/ws/a' });
    const store = new PanelStore(api);
    await bind(store, 's1');
    store.selectAction('build');

    api.injectRun('s1', makeRun('r1', 'build', 1000, 'running'), 'one\n');
    await sleep(30);
    expect(store.state.selectedRunId).toBe('r1');

    api.injectRun('s1', makeRun('r2', 'build', 2000, 'running'), 'two\n');
    await sleep(30);
    expect(store.state.selectedRunId).toBe('r2'); // was watching the newest

    store.selectRun('r1'); // user inspects the older run
    await sleep(30);
    api.injectRun('s1', makeRun('r3', 'build', 3000, 'running'), 'three\n');
    await sleep(30);

    expect(store.state.selectedRunId).toBe('r1'); // focus not stolen
    expect(store.state.latestRunByAction.build).toBe('r3');
    expect(store.state.runIdsByAction.build).toEqual(['r3', 'r2', 'r1']);
    store.dispose();
  });

  it('snapshot prune removes run ids and repairs the selected run', { timeout: 15000 }, async () => {
    const api = new FakeApi({ s1: '/ws/a' });
    const store = new PanelStore(api);
    await bind(store, 's1');

    api.injectRun('s1', makeRun('r1', 'build', 1000, 'succeeded'));
    api.injectRun('s1', makeRun('r2', 'build', 2000, 'succeeded'));
    await sleep(30);
    store.selectRun('r1');
    await sleep(50); // settle r1 via inspect
    expect(store.state.runs.r1?.settled).toBe(true);

    // Host evicted r1; the snapshot only retains r2.
    api.pushFrame('s1', { type: 'snapshot', runs: [api.summaryOf('r2', 's1')] });
    await sleep(30);

    expect(store.state.runs.r1).toBeUndefined();
    expect(store.state.runIdsByAction.build).toEqual(['r2']);
    expect(store.state.selectedRunId).toBe('r2');
    store.dispose();
  });

  it('cancels each active run independently', { timeout: 15000 }, async () => {
    const api = new FakeApi({ s1: '/ws/a' });
    const store = new PanelStore(api);
    await bind(store, 's1');

    api.injectRun('s1', makeRun('r1', 'build', 1000, 'running'), '');
    api.injectRun('s1', makeRun('r2', 'build', 2000, 'running'), '');
    await sleep(30);

    await store.cancelRun('r1');
    expect(api.calls).toContain('cancel:s1:r1');
    expect(store.state.runs.r1?.run.status).toBe('cancelled');
    expect(store.state.runs.r2?.run.status).toBe('running');
    store.dispose();
  });

  it('snapshot frames prune runs the Host no longer retains', { timeout: 15000 }, async () => {
    const api = new FakeApi({ s1: '/ws/a' });
    const store = new PanelStore(api);
    await bind(store, 's1');

    const result = api.agentStart('s1', 'build');
    await sleep(SETTLE_MS);
    expect(store.state.runs[result.run.id]?.settled).toBe(true);

    // Host evicted the terminal run (LRU): the next snapshot omits it.
    api.pushFrame('s1', { type: 'snapshot', runs: [] });
    await sleep(20);

    expect(store.state.runs[result.run.id]).toBeUndefined();
    expect(store.state.latestRunByAction.build).toBeUndefined();
    store.dispose();
  });

  it('forgetRun removes the record and repairs indexes and selection', { timeout: 15000 }, async () => {
    const api = new FakeApi({ s1: '/ws/a' });
    const store = new PanelStore(api);
    await bind(store, 's1');

    api.injectRun('s1', makeRun('r1', 'build', 1000, 'succeeded'), '');
    api.injectRun('s1', makeRun('r2', 'build', 2000, 'succeeded'), '');
    await sleep(30);
    store.selectRun('r2');
    expect(store.state.selectedRunId).toBe('r2');

    expect(await store.forgetRun('r2')).toBe(true);
    expect(api.calls).toContain('forget:s1:r2');
    expect(store.state.runs.r2).toBeUndefined();
    expect(store.state.runIdsByAction.build).toEqual(['r1']);
    expect(store.state.latestRunByAction.build).toBe('r1');
    // Selection falls back to the action's newest remaining run.
    expect(store.state.selectedRunId).toBe('r1');

    // Forgetting the last record clears the action's indexes entirely.
    expect(await store.forgetRun('r1')).toBe(true);
    expect(store.state.runIdsByAction.build).toBeUndefined();
    expect(store.state.latestRunByAction.build).toBeUndefined();
    expect(store.state.selectedRunId).toBeNull();
    store.dispose();
  });
});

describe('PanelStore catalog events (T22)', () => {
  const catalogWith = (sessionId: string, labels: string[], api: FakeApi): ActionsCatalog => ({
    apiVersion: 1,
    workspace: '/ws/a',
    sources: [],
    actions: labels.map((label) => api.actionFor(sessionId, label)),
    runs: [],
  });

  it('applies catalog event frames without a manual refresh', { timeout: 15000 }, async () => {
    const api = new FakeApi({ s1: '/ws/a' });
    const store = new PanelStore(api);
    await bind(store, 's1');
    expect(api.calls).toContain('subscribe-catalog:s1');
    expect(store.state.catalog?.actions.map((action) => action.id)).toEqual(['build']);

    // The Host reports a config change: new action + a degraded source.
    api.pushCatalogFrame('s1', {
      ...catalogWith('s1', ['build', 'test'], api),
      sources: [{
        layer: 'workspace',
        path: '/ws/a/.dsh/actions.json',
        available: false,
        reason: 'parse-error',
        errors: ['bad entry'],
      }],
    });
    await sleep(20);

    expect(store.state.catalog?.actions.map((action) => action.id)).toEqual(['build', 'test']);
    expect(store.state.catalog?.sources[0]?.available).toBe(false);
    expect(store.state.phase).toBe('ready');
    store.dispose();
  });

  it('falls back to the first action when the selected one disappears', { timeout: 15000 }, async () => {
    const api = new FakeApi({ s1: '/ws/a' });
    const store = new PanelStore(api);
    await bind(store, 's1');
    api.pushCatalogFrame('s1', catalogWith('s1', ['build', 'test'], api));
    await sleep(20);
    store.selectAction('test');
    expect(store.state.selectedActionId).toBe('test');

    // The selected action was removed from the config.
    api.pushCatalogFrame('s1', catalogWith('s1', ['build'], api));
    await sleep(20);

    expect(store.state.selectedActionId).toBe('build');
    expect(store.state.selectedRunId).toBeNull();
    store.dispose();
  });

  it('catalog frames never clobber live run state', { timeout: 15000 }, async () => {
    const api = new FakeApi({ s1: '/ws/a' });
    const store = new PanelStore(api);
    await bind(store, 's1');

    api.injectRun('s1', makeRun('r1', 'build', 1000, 'running'), 'live output\n');
    await sleep(50);
    expect(store.state.runs.r1?.output).toContain('live output');

    // A catalog snapshot that does not mention the active run.
    api.pushCatalogFrame('s1', catalogWith('s1', ['build'], api));
    await sleep(20);

    const view = store.state.runs.r1;
    expect(view?.run.status).toBe('running');
    expect(view?.output).toContain('live output');
    expect(store.state.runIdsByAction.build).toEqual(['r1']);
    store.dispose();
  });

  it('ignores catalog frames from a previous session after switching', { timeout: 15000 }, async () => {
    const api = new FakeApi({ s1: '/ws/a', s2: '/ws/b' });
    const store = new PanelStore(api);
    await bind(store, 's1');

    store.setSession('s2', '');
    await sleep(30);
    expect(api.calls).toContain('subscribe-catalog:s2');
    expect(store.state.catalog?.workspace).toBe('/ws/b');

    // A late s1 frame must not reach the s2-bound store.
    api.pushCatalogFrame('s1', {
      ...catalogWith('s1', ['build', 'intruder'], api),
      workspace: '/ws/a',
    });
    await sleep(30);

    expect(store.state.catalog?.workspace).toBe('/ws/b');
    expect(store.state.catalog?.actions.map((action) => action.id)).toEqual(['build']);
    store.dispose();
  });
});

describe('empty-state CTA logic (T28)', () => {
  it('writes the authoring skill reference as a plain-text draft', () => {
    const draft = buildCtaDraft('scan the workspace');
    expect(draft.startsWith(`${AUTHORING_SKILL} `)).toBe(true);
    expect(draft).toContain('scan the workspace');
    expect(AUTHORING_SKILL).toBe('/dsh-actions-authoring');
  });

  it('picks the prompt by config layer (T44/T48)', () => {
    expect(ctaPromptKey('workspace')).toBe('ctaPrompt');
    expect(ctaPromptKey('global')).toBe('ctaPromptGlobal');
    expect(ctaPromptKey('session')).toBe('ctaPromptSession');
  });

  it('earns the CTA only when a layer\'s config file is missing', () => {
    const base = { layer: 'workspace' as const, path: '/ws/a/.dsh/actions.json', errors: [] };
    expect(sourceNeedsCta({ ...base, available: false, reason: 'definition-not-found' })).toBe(true);
    expect(sourceNeedsCta({ ...base, available: false, reason: 'parse-error' })).toBe(false);
    expect(sourceNeedsCta({ ...base, available: false, reason: 'unsupported-version' })).toBe(false);
    expect(sourceNeedsCta({ ...base, available: false })).toBe(false);
    expect(sourceNeedsCta({ ...base, available: true })).toBe(false);
  });
});

describe('PanelStore approval flow (T29/T32)', () => {
  it('approval-declined leaves runs untouched and raises a light notice', { timeout: 15000 }, async () => {
    const api = new FakeApi({ s1: '/ws/a' });
    const store = new PanelStore(api);
    await bind(store, 's1');

    api.declineNext = { outcome: 'rejected' };
    await store.runAction('build');

    expect(store.state.declined).toEqual({ actionId: 'build', outcome: 'rejected' });
    expect(Object.keys(store.state.runs)).toHaveLength(0);
    expect(store.state.conflict).toBeNull();
    expect(store.state.confirmation).toBeNull();
    expect(store.state.actionError).toBe(false);

    store.dismissDeclined();
    expect(store.state.declined).toBeNull();
    store.dispose();
  });

  it('confirmation-required opens the confirmation; confirming resends with confirmed:true', { timeout: 15000 }, async () => {
    const api = new FakeApi({ s1: '/ws/a' });
    api.confirmationRequiredFor.add('build');
    const store = new PanelStore(api);
    await bind(store, 's1');

    await store.runAction('build');
    expect(store.state.confirmation).toEqual({ actionId: 'build' });
    expect(Object.keys(store.state.runs)).toHaveLength(0);
    expect(api.calls).toContain('run:s1:build');
    expect(api.calls).not.toContain('run:s1:build:confirmed');

    await store.confirmAndRun('build');
    expect(api.calls).toContain('run:s1:build:confirmed');
    expect(store.state.confirmation).toBeNull();
    const runId = store.state.latestRunByAction.build as string;
    expect(runId).toBeDefined();
    await store.cancelRun(runId); // stop the simulated run promptly
    store.dispose();
  });

  it('cancelling the confirmation closes quietly without resending', { timeout: 15000 }, async () => {
    const api = new FakeApi({ s1: '/ws/a' });
    api.confirmationRequiredFor.add('build');
    const store = new PanelStore(api);
    await bind(store, 's1');

    await store.runAction('build');
    expect(store.state.confirmation).toEqual({ actionId: 'build' });

    store.dismissConfirmation();
    expect(store.state.confirmation).toBeNull();
    expect(store.state.actionError).toBe(false);
    expect(api.calls).not.toContain('run:s1:build:confirmed');
    expect(Object.keys(store.state.runs)).toHaveLength(0);
    store.dispose();
  });

  it('a session switch clears any pending confirmation and declined notice', { timeout: 15000 }, async () => {
    const api = new FakeApi({ s1: '/ws/a', s2: '/ws/b' });
    api.confirmationRequiredFor.add('build');
    const store = new PanelStore(api);
    await bind(store, 's1');
    await store.runAction('build');
    expect(store.state.confirmation).not.toBeNull();

    store.setSession('s2', '');
    await sleep(30);
    expect(store.state.confirmation).toBeNull();
    expect(store.state.declined).toBeNull();
    store.dispose();
  });
});

describe('PanelStore parameter form (T34)', () => {
  const INPUTS: ActionInputConfig[] = [
    { id: 'target', type: 'string', description: 'Build target', required: true, default: 'all' },
    { id: 'mode', type: 'select', options: ['dev', 'prod'], default: 'dev' },
  ];

  const catalogWithInputs = (api: FakeApi): ActionsCatalog => ({
    apiVersion: 1,
    workspace: '/ws/a',
    sources: [],
    actions: [api.actionFor('s1', 'build', INPUTS)],
    runs: [],
  });

  it('actions without inputs run directly, no form', { timeout: 15000 }, async () => {
    const api = new FakeApi({ s1: '/ws/a' });
    const store = new PanelStore(api);
    await bind(store, 's1');

    store.requestRun('build');
    await sleep(30);
    expect(store.state.pendingParams).toBeNull();
    expect(api.calls).toContain('run:s1:build');
    const runId = store.state.latestRunByAction.build as string;
    await store.cancelRun(runId);
    store.dispose();
  });

  it('actions with inputs open the form prefilled with defaults', { timeout: 15000 }, async () => {
    const api = new FakeApi({ s1: '/ws/a' });
    const store = new PanelStore(api);
    await bind(store, 's1');
    api.pushCatalogFrame('s1', catalogWithInputs(api));
    await sleep(30);

    store.requestRun('build');
    expect(store.state.pendingParams).toEqual({
      actionId: 'build',
      values: { target: 'all', mode: 'dev' },
      error: null,
      pin: false,
    });
    expect(api.calls).not.toContain('run:s1:build');
    store.dispose();
  });

  it('submitting passes params through; unpinned values fall back to defaults', { timeout: 15000 }, async () => {
    const api = new FakeApi({ s1: '/ws/a' });
    const store = new PanelStore(api);
    await bind(store, 's1');
    api.pushCatalogFrame('s1', catalogWithInputs(api));
    await sleep(30);

    store.requestRun('build');
    store.updateParamValue('target', 'web');
    await store.submitParamForm();
    await sleep(30);

    expect(api.paramsCalls[api.paramsCalls.length - 1]).toEqual({ target: 'web', mode: 'dev' });
    expect(store.state.pendingParams).toBeNull();

    // T39: without a pin there is no client-side memory — defaults return.
    const runId = store.state.latestRunByAction.build as string;
    await store.cancelRun(runId);
    store.requestRun('build');
    expect(store.state.pendingParams?.values.target).toBe('all');
    store.dispose();
  });

  it('invalid-params keeps the form open with an inline error', { timeout: 15000 }, async () => {
    const api = new FakeApi({ s1: '/ws/a' });
    api.invalidParamsFor.add('build');
    const store = new PanelStore(api);
    await bind(store, 's1');
    api.pushCatalogFrame('s1', catalogWithInputs(api));
    await sleep(30);

    store.requestRun('build');
    store.updateParamValue('target', '');
    await store.submitParamForm();
    await sleep(30);

    const form = store.state.pendingParams;
    expect(form).not.toBeNull();
    expect(form?.error).toContain('Missing required parameter');
    expect(Object.keys(store.state.runs)).toHaveLength(0);
    // Editing clears the inline error.
    store.updateParamValue('target', 'web');
    expect(store.state.pendingParams?.error).toBeNull();
    store.dispose();
  });

  it('rerun prefill uses the run params ahead of memory and defaults', { timeout: 15000 }, async () => {
    // Pure helper: prefill > memory > default.
    expect(resolveParamValues(INPUTS, { target: 'docs' }, { target: 'web', mode: 'prod' }))
      .toEqual({ target: 'docs', mode: 'prod' });
    expect(resolveParamValues(INPUTS, undefined, { target: 'web' }))
      .toEqual({ target: 'web', mode: 'dev' });
    expect(resolveParamValues(INPUTS)).toEqual({ target: 'all', mode: 'dev' });

    const api = new FakeApi({ s1: '/ws/a' });
    const store = new PanelStore(api);
    await bind(store, 's1');
    api.pushCatalogFrame('s1', catalogWithInputs(api));
    await sleep(30);

    store.requestRun('build', { target: 'docs', mode: 'prod' });
    expect(store.state.pendingParams?.values).toEqual({ target: 'docs', mode: 'prod' });
    store.dispose();
  });

  it('the confirmation resend carries the form params', { timeout: 15000 }, async () => {
    const api = new FakeApi({ s1: '/ws/a' });
    api.confirmationRequiredFor.add('build');
    const store = new PanelStore(api);
    await bind(store, 's1');
    api.pushCatalogFrame('s1', catalogWithInputs(api));
    await sleep(30);

    store.requestRun('build');
    store.updateParamValue('target', 'web');
    await store.submitParamForm();
    await sleep(30);

    // Approval gate fires first: the form stays open and the confirmation opens.
    expect(store.state.confirmation).toEqual({ actionId: 'build' });
    expect(store.state.pendingParams).not.toBeNull();

    await store.confirmAndRun('build');
    await sleep(30);

    expect(api.calls).toContain('run:s1:build:confirmed');
    expect(api.paramsCalls[api.paramsCalls.length - 1]).toEqual({ target: 'web', mode: 'dev' });
    expect(store.state.confirmation).toBeNull();
    expect(store.state.pendingParams).toBeNull();
    const runId = store.state.latestRunByAction.build as string;
    await store.cancelRun(runId);
    store.dispose();
  });
});

describe('PanelStore session parameter pins (T39)', () => {
  const PIN_INPUTS: ActionInputConfig[] = [
    { id: 'target', type: 'string', required: true, default: 'all' },
    { id: 'mode', type: 'select', options: ['dev', 'prod'], default: 'dev' },
  ];

  const catalogWithInputsAndPins = (api: FakeApi, pins: Record<string, Record<string, string>>): ActionsCatalog => ({
    apiVersion: 1,
    workspace: '/ws/a',
    sources: [],
    actions: [api.actionFor('s1', 'build', PIN_INPUTS)],
    runs: [],
    sessionParams: pins,
  });

  it('prefills from the session pin board ahead of defaults (run params still win)', { timeout: 15000 }, async () => {
    // Pure helper, three levels: prefill > session pins > default.
    expect(resolveParamValues(PIN_INPUTS, { target: 'docs' }, { target: 'web', mode: 'prod' }))
      .toEqual({ target: 'docs', mode: 'prod' });
    expect(resolveParamValues(PIN_INPUTS, undefined, { target: 'web', mode: 'prod' }))
      .toEqual({ target: 'web', mode: 'prod' });

    const api = new FakeApi({ s1: '/ws/a' });
    const store = new PanelStore(api);
    await bind(store, 's1');
    api.pushCatalogFrame('s1', catalogWithInputsAndPins(api, { build: { target: 'web', mode: 'prod' } }));
    await sleep(30);

    store.requestRun('build');
    expect(store.state.pendingParams?.values).toEqual({ target: 'web', mode: 'prod' });

    // A rerun prefill (the run's own params) still outranks the pin board.
    store.requestRun('build', { target: 'docs' });
    expect(store.state.pendingParams?.values).toEqual({ target: 'docs', mode: 'prod' });
    store.dispose();
  });

  it('pinning on submit writes the session params and prefills from them afterwards', { timeout: 15000 }, async () => {
    const api = new FakeApi({ s1: '/ws/a' });
    const store = new PanelStore(api);
    await bind(store, 's1');
    api.pushCatalogFrame('s1', catalogWithInputsAndPins(api, {}));
    await sleep(30);

    store.requestRun('build');
    store.updateParamValue('target', 'web');
    store.updateParamPin(true);
    await store.submitParamForm();
    await sleep(50);

    expect(api.calls).toContain('pin:s1:build');
    expect(store.sessionParamsOf('build')).toEqual({ target: 'web', mode: 'dev' });

    const runId = store.state.latestRunByAction.build as string;
    await store.cancelRun(runId);
    store.requestRun('build');
    expect(store.state.pendingParams?.values.target).toBe('web');
    store.dispose();
  });

  it('unpinning clears the board via the params endpoint', { timeout: 15000 }, async () => {
    const api = new FakeApi({ s1: '/ws/a' });
    const store = new PanelStore(api);
    await bind(store, 's1');
    api.pushCatalogFrame('s1', catalogWithInputsAndPins(api, { build: { target: 'web' } }));
    await sleep(30);
    expect(store.sessionParamsOf('build')).toEqual({ target: 'web' });

    await store.unpinParams('build');
    await sleep(30);

    expect(api.calls).toContain('unpin:s1:build');
    expect(store.sessionParamsOf('build')).toBeUndefined();

    store.requestRun('build');
    expect(store.state.pendingParams?.values.target).toBe('all');
    store.dispose();
  });

  it('catalog frames update the pin board used for prefill', { timeout: 15000 }, async () => {
    const api = new FakeApi({ s1: '/ws/a' });
    const store = new PanelStore(api);
    await bind(store, 's1');
    api.pushCatalogFrame('s1', catalogWithInputsAndPins(api, {}));
    await sleep(30);

    api.pushCatalogFrame('s1', catalogWithInputsAndPins(api, { build: { target: 'docs', mode: 'prod' } }));
    await sleep(30);

    expect(store.sessionParamsOf('build')).toEqual({ target: 'docs', mode: 'prod' });
    store.requestRun('build');
    // The required input is satisfied by the session layer — the form is complete.
    expect(store.state.pendingParams?.values).toEqual({ target: 'docs', mode: 'prod' });
    expect(Object.values(store.state.pendingParams?.values ?? {}).every((value) => value !== '')).toBe(true);
    store.dispose();
  });
});

describe('PanelStore eviction and loading fixes (T37)', () => {
  it('applying a catalog auto-loads the selected run output', { timeout: 15000 }, async () => {
    const api = new FakeApi({ s1: '/ws/a' });
    const store = new PanelStore(api);
    api.injectRun('s1', makeRun('r1', 'build', 1000, 'succeeded'), 'old output\n');
    await bind(store, 's1');
    await sleep(50);

    expect(api.calls).toContain('inspect:s1:r1');
    expect(store.state.runs.r1?.output).toContain('old output');
    expect(store.state.runs.r1?.settled).toBe(true);
    store.dispose();
  });

  it('follow settles a run whose stream answers 404, harvesting once, never retrying', { timeout: 15000 }, async () => {
    const api = new FakeApi({ s1: '/ws/a' });
    const store = new PanelStore(api);
    await bind(store, 's1');

    api.stream404For.add('r1');
    api.injectRun('s1', makeRun('r1', 'build', 1000, 'running'), 'partial\n');
    await sleep(50);

    expect(api.calls).toContain('stream:s1:r1');
    expect(api.calls).toContain('inspect:s1:r1'); // final harvest
    expect(store.state.runs.r1?.output).toContain('partial');
    expect(store.state.runs.r1?.settled).toBe(true);

    await sleep(1500); // would cover one backoff cycle if it retried
    expect(api.calls.filter((call) => call === 'stream:s1:r1')).toHaveLength(1);
    store.dispose();
  });

  it('a failed inspect marks the run settled and never retries', { timeout: 15000 }, async () => {
    const api = new FakeApi({ s1: '/ws/a' });
    const store = new PanelStore(api);
    await bind(store, 's1');

    api.inspect404For.add('r1');
    api.injectRun('s1', makeRun('r1', 'build', 1000, 'succeeded'));
    await sleep(50);

    expect(store.state.runs.r1?.settled).toBe(true);
    const attempts = api.calls.filter((call) => call === 'inspect:s1:r1').length;
    expect(attempts).toBeGreaterThanOrEqual(1);
    await store.ensureRunLoaded('r1');
    await sleep(30);
    expect(api.calls.filter((call) => call === 'inspect:s1:r1')).toHaveLength(attempts);
    store.dispose();
  });

  it('follow retries a transient stream failure and then streams normally', { timeout: 15000 }, async () => {
    const api = new FakeApi({ s1: '/ws/a' });
    const store = new PanelStore(api);
    await bind(store, 's1');

    api.failStreamOnce.add('r1');
    api.injectRun('s1', makeRun('r1', 'build', 1000, 'running'), 'recovered\n');
    await sleep(1400); // one base backoff + margin

    expect(api.calls.filter((call) => call === 'stream:s1:r1').length).toBeGreaterThanOrEqual(2);
    expect(store.state.runs.r1?.output).toContain('recovered');
    store.dispose();
  });

  it('stopAndRerun restarts only when the cancel went through', { timeout: 15000 }, async () => {
    const api = new FakeApi({ s1: '/ws/a' });
    const store = new PanelStore(api);
    await bind(store, 's1');

    const result = api.agentStart('s1', 'build');
    await sleep(30);
    await store.runAction('build'); // reuse policy -> already-running conflict
    expect(store.state.conflict?.kind).toBe('already-running');

    api.failCancelFor.add(result.run.id);
    const runCallsBefore = api.calls.filter((call) => call.startsWith('run:')).length;
    await store.stopAndRerun();

    expect(api.calls.filter((call) => call.startsWith('run:'))).toHaveLength(runCallsBefore);
    expect(store.state.actionError).toBe(true);
    // The cancel failed, so the existing instance must not have been cancelled.
    expect(store.state.runs[result.run.id]?.run.status).not.toBe('cancelled');
    store.dispose();
  });

  it('merges the CTA draft without clobbering the composer', () => {
    const draft = '/dsh-actions-authoring go';
    expect(mergeCtaDraft('', draft)).toBe(draft);
    expect(mergeCtaDraft('   ', draft)).toBe(draft);
    expect(mergeCtaDraft('hello', draft)).toBe(`hello\n${draft}`);
    expect(mergeCtaDraft('hello\n', draft)).toBe(`hello\n${draft}`);
    // Already queued: left untouched (no duplicate skill reference).
    expect(mergeCtaDraft('/dsh-actions-authoring old', draft)).toBe('/dsh-actions-authoring old');
  });
});

describe('PanelStore run-tab workspace (T41)', () => {
  const viewOf = (id: string, actionId: string, startedAt: number): RunViewState => ({
    run: makeRun(id, actionId, startedAt, 'succeeded'),
    output: '',
    offset: 0,
    truncated: false,
    streaming: false,
    settled: true,
  });

  it('selectRunTabs derives per panel mode and sorts newest-first', () => {
    const runs: Record<string, RunViewState> = {
      a1: viewOf('a1', 'a', 1000),
      a2: viewOf('a2', 'a', 3000),
      b1: viewOf('b1', 'b', 2000),
      b2: viewOf('b2', 'b', 4000),
      c1: viewOf('c1', 'c', 5000),
      c2: viewOf('c2', 'c', 6000),
    };
    const runIdsByAction = { a: ['a2', 'a1'], b: ['b2', 'b1'], c: ['c2', 'c1'] };
    const modes: Record<string, 'new' | 'dedicated' | 'append'> = { a: 'new', b: 'dedicated', c: 'append' };
    const tabs = selectRunTabs(runs, runIdsByAction, (id) => modes[id] ?? 'new');

    // 'new' keeps both runs; dedicated/append only their newest; global newest-first.
    expect(tabs.map((tab) => tab.runId)).toEqual(['c2', 'b2', 'a2', 'a1']);
  });

  it('a user tab click raises a collapsed workspace; programmatic selection does not (T49)', { timeout: 15000 }, async () => {
    const api = new FakeApi({ s1: '/ws/a' });
    const store = new PanelStore(api);
    await bind(store, 's1');
    api.injectRun('s1', makeRun('r1', 'build', 1000, 'running'), '');
    api.injectRun('s1', makeRun('r2', 'build', 2000, 'succeeded'), '');
    await sleep(30);

    store.toggleWorkspace(); // user collapses
    expect(store.state.workspaceCollapsed).toBe(true);

    // Programmatic selection (e.g. discovery follow) keeps the collapsed state.
    store.selectRun('r2');
    expect(store.state.selectedRunId).toBe('r2');
    expect(store.state.workspaceCollapsed).toBe(true);

    // A user tab click selects AND raises.
    store.focusRunTab('r1');
    expect(store.state.selectedRunId).toBe('r1');
    expect(store.state.workspaceCollapsed).toBe(false);
    store.dispose();
  });

  it('closing a terminal run tab forgets it directly, no confirmation', { timeout: 15000 }, async () => {
    const api = new FakeApi({ s1: '/ws/a' });
    const store = new PanelStore(api);
    await bind(store, 's1');
    api.injectRun('s1', makeRun('r1', 'build', 1000, 'succeeded'));
    await sleep(30);

    store.requestCloseRun('r1');
    await sleep(30);

    expect(store.state.closeRunConfirm).toBeNull();
    expect(api.calls).toContain('forget:s1:r1');
    expect(store.state.runs.r1).toBeUndefined();
    store.dispose();
  });

  it('closing an active run tab confirms, then cancels and forgets', { timeout: 15000 }, async () => {
    const api = new FakeApi({ s1: '/ws/a' });
    const store = new PanelStore(api);
    await bind(store, 's1');
    api.injectRun('s1', makeRun('r1', 'build', 1000, 'running'), '');
    await sleep(30);

    store.requestCloseRun('r1');
    expect(store.state.closeRunConfirm).toEqual({ runId: 'r1', actionLabel: 'build' });

    await store.confirmCloseRun();
    await sleep(30);

    expect(api.calls).toContain('cancel:s1:r1');
    expect(api.calls).toContain('forget:s1:r1');
    expect(store.state.runs.r1).toBeUndefined();
    expect(store.state.closeRunConfirm).toBeNull();
    store.dispose();
  });

  it('dismissing the close confirmation leaves the run untouched', { timeout: 15000 }, async () => {
    const api = new FakeApi({ s1: '/ws/a' });
    const store = new PanelStore(api);
    await bind(store, 's1');
    api.injectRun('s1', makeRun('r1', 'build', 1000, 'running'), '');
    await sleep(30);

    store.requestCloseRun('r1');
    store.dismissCloseRun();

    expect(store.state.closeRunConfirm).toBeNull();
    expect(store.state.runs.r1?.run.status).toBe('running');
    expect(api.calls).not.toContain('cancel:s1:r1');
    store.dispose();
  });

  it('dedicated mode follows the newest run in place, even from an older run', { timeout: 15000 }, async () => {
    const api = new FakeApi({ s1: '/ws/a' });
    const store = new PanelStore(api);
    await bind(store, 's1');
    api.pushCatalogFrame('s1', {
      apiVersion: 1,
      workspace: '/ws/a',
      sources: [],
      actions: [{ ...api.actionFor('s1', 'build'), presentation: { panel: 'dedicated' as const } }],
      runs: [],
    });
    await sleep(30);

    api.injectRun('s1', makeRun('r1', 'build', 1000, 'running'), 'one\n');
    await sleep(30);
    expect(store.state.selectedRunId).toBe('r1');

    // 'new' mode would NOT steal focus here (T18 semantics); dedicated always
    // refreshes the single tab in place.
    api.injectRun('s1', makeRun('r2', 'build', 2000, 'running'), 'two\n');
    await sleep(30);
    expect(store.state.selectedRunId).toBe('r2');

    // Selecting an older run is possible, but the next discovery still follows.
    store.selectRun('r1');
    await sleep(30);
    api.injectRun('s1', makeRun('r3', 'build', 3000, 'running'), 'three\n');
    await sleep(30);
    expect(store.state.selectedRunId).toBe('r3');
    store.dispose();
  });

  it('new mode still never steals focus from an older run (regression)', { timeout: 15000 }, async () => {
    const api = new FakeApi({ s1: '/ws/a' });
    const store = new PanelStore(api);
    await bind(store, 's1');

    api.injectRun('s1', makeRun('r1', 'build', 1000, 'running'), 'one\n');
    api.injectRun('s1', makeRun('r2', 'build', 2000, 'running'), 'two\n');
    await sleep(30);
    store.selectRun('r1');
    await sleep(30);

    api.injectRun('s1', makeRun('r3', 'build', 3000, 'running'), 'three\n');
    await sleep(30);
    expect(store.state.selectedRunId).toBe('r1'); // untouched
    expect(store.state.latestRunByAction.build).toBe('r3');
    store.dispose();
  });
});

describe('PanelStore delete action (T51)', () => {

  it('confirming a delete calls the endpoint and the repushed catalog drops the action', { timeout: 15000 }, async () => {
    const api = new FakeApi({ s1: '/ws/a' });
    const store = new PanelStore(api);
    await bind(store, 's1');
    expect(store.state.catalog?.actions.map((action) => action.id)).toEqual(['build']);

    store.requestDeleteAction('build');
    expect(store.state.deleteConfirm).toEqual({ actionId: 'build', actionLabel: 'build' });

    const deleted = await store.confirmDeleteAction();
    await sleep(30);

    expect(deleted).toBe(true);
    expect(api.calls).toContain('delete:s1:build');
    expect(store.state.deleteConfirm).toBeNull();
    expect(store.state.catalog?.actions.map((action) => action.id)).toEqual([]);
    expect(store.state.actionError).toBe(false);
    store.dispose();
  });

  it('dismissing the delete confirmation leaves the action untouched', { timeout: 15000 }, async () => {
    const api = new FakeApi({ s1: '/ws/a' });
    const store = new PanelStore(api);
    await bind(store, 's1');

    store.requestDeleteAction('build');
    store.dismissDeleteAction();

    expect(store.state.deleteConfirm).toBeNull();
    expect(api.calls).not.toContain('delete:s1:build');
    expect(store.state.catalog?.actions.map((action) => action.id)).toEqual(['build']);
    store.dispose();
  });
});

describe('PanelStore workspace collapse (T43)', () => {
  it('toggleWorkspace flips the collapsed state', { timeout: 15000 }, async () => {
    const api = new FakeApi({ s1: '/ws/a' });
    const store = new PanelStore(api);
    await bind(store, 's1');

    expect(store.state.workspaceCollapsed).toBe(false);
    store.toggleWorkspace();
    expect(store.state.workspaceCollapsed).toBe(true);
    store.toggleWorkspace();
    expect(store.state.workspaceCollapsed).toBe(false);
    store.dispose();
  });

  it('a newly discovered run raises the workspace; status transitions do not', { timeout: 15000 }, async () => {
    const api = new FakeApi({ s1: '/ws/a' });
    const store = new PanelStore(api);
    await bind(store, 's1');

    api.injectRun('s1', makeRun('r1', 'build', 1000, 'running'), '');
    await sleep(30);
    store.toggleWorkspace(); // user collapses
    expect(store.state.workspaceCollapsed).toBe(true);

    // A status transition of a known run keeps the collapsed state.
    api.transitionRun('r1', 'failed', 1);
    await sleep(30);
    expect(store.state.workspaceCollapsed).toBe(true);

    // A genuinely new run raises it.
    api.injectRun('s1', makeRun('r2', 'build', 2000, 'running'), '');
    await sleep(30);
    expect(store.state.workspaceCollapsed).toBe(false);
    store.dispose();
  });

  it('a started run raises the workspace', { timeout: 15000 }, async () => {
    const api = new FakeApi({ s1: '/ws/a' });
    const store = new PanelStore(api);
    await bind(store, 's1');
    store.toggleWorkspace();
    expect(store.state.workspaceCollapsed).toBe(true);

    await store.runAction('build');
    expect(store.state.workspaceCollapsed).toBe(false);
    const runId = store.state.latestRunByAction.build as string;
    await store.cancelRun(runId);
    store.dispose();
  });

  it('a session switch preserves the collapsed state', { timeout: 15000 }, async () => {
    const api = new FakeApi({ s1: '/ws/a', s2: '/ws/b' });
    const store = new PanelStore(api);
    await bind(store, 's1');
    store.toggleWorkspace();
    expect(store.state.workspaceCollapsed).toBe(true);

    store.setSession('s2', '');
    await sleep(30);
    expect(store.state.workspaceCollapsed).toBe(true);
    expect(store.state.sessionId).toBe('s2');
    store.dispose();
  });
});

describe('composer @ reference source (T53)', () => {
  const action = (
    id: string,
    label: string,
    layer: 'global' | 'workspace' | 'session',
    overrides: Partial<ProjectActionSummary> = {},
  ): ProjectActionSummary => ({
    id,
    label,
    sourceLayer: layer,
    visibility: 'all',
    approval: 'never',
    command: `run ${label}`,
    cwd: '/ws/a',
    runOptions: { instanceLimit: 1, instancePolicy: 'reuse' },
    ...overrides,
  });

  const sectionOf = (layer: 'global' | 'workspace' | 'session'): string =>
    ({ global: 'Global', workspace: 'Workspace', session: 'Session' })[layer];

  it('builds the inline token from a label', () => {
    expect(buildActionToken('build')).toBe('@actions:build ');
  });

  it('maps actions to menu candidates sectioned by layer, with id as the pick payload', () => {
    const candidates = actionCandidates([
      action('workspace:build', 'build', 'workspace', { detail: '构建产物' }),
      action('global:doctor', 'doctor', 'global'),
      action('session:note', 'note', 'session'),
    ], sectionOf);

    expect(candidates.map((candidate) => candidate.name)).toEqual(['actions:build', 'actions:doctor', 'actions:note']);
    expect(candidates.map((candidate) => candidate.value)).toEqual(['workspace:build', 'global:doctor', 'session:note']);
    expect(candidates[0]?.description).toBe('构建产物');
    expect(candidates[1]?.description).toBe('run doctor'); // command fallback
    expect(candidates.map((candidate) => candidate.section)).toEqual(['Workspace', 'Global', 'Session']);
  });

  it('lexicon is the deduped label roll', () => {
    expect(actionLexicon([
      action('workspace:build', 'build', 'workspace'),
      action('global:build', 'build', 'global'),
      action('session:note', 'note', 'session'),
    ])).toEqual(['build', 'note']);
    expect(actionLexicon([])).toEqual([]);
  });

  it('serializes a reference into the full agent-facing context', () => {
    const actions = [
      action('workspace:build', 'build', 'workspace', {
        inputs: [{ id: 'target', type: 'string' }],
      }),
    ];
    const pins = { 'workspace:build': { target: 'web' } };

    expect(serializeActionRef(actions, pins, 'workspace:build'))
      .toBe('使用 Action「build」（id: workspace:build）。可选：target；已记住参数：target=web。');
  });

  it('serializes a minimal action without inputs or pins, and degrades unknown refs', () => {
    const actions = [action('global:doctor', 'doctor', 'global')];

    expect(serializeActionRef(actions, undefined, 'global:doctor'))
      .toBe('使用 Action「doctor」（id: global:doctor）。');
    expect(serializeActionRef(actions, undefined, 'ghost'))
      .toBe('Action ghost（该任务已不在当前目录中）');
  });

  it('warns the agent when the referenced action is manual-only', () => {
    const actions = [action('workspace:deploy', 'deploy', 'workspace', { visibility: 'ui' })];

    const text = serializeActionRef(actions, undefined, 'workspace:deploy');
    expect(text).toContain('仅人工可见');
    expect(text).toContain('你无法运行它');
  });

  it('maps layers onto section locale keys', () => {
    expect(sectionKeyOf('workspace')).toBe('sectionWorkspace');
    expect(sectionKeyOf('global')).toBe('sectionGlobal');
    expect(sectionKeyOf('session')).toBe('sectionSession');
  });
});

describe('action row badges (T54)', () => {
  const fakeT = ((key: string, params?: Record<string, string | number>) =>
    params === undefined
      ? key
      : `${key}(${Object.entries(params).map(([k, v]) => `${k}=${String(v)}`).join(',')})`) as Translate;

  const base: ProjectActionSummary = {
    id: 'workspace:build',
    label: 'build',
    sourceLayer: 'workspace',
    visibility: 'all',
    approval: 'never',
    command: 'pnpm build',
    cwd: '/ws/a',
    runOptions: { instanceLimit: 1, instancePolicy: 'reuse' },
  };

  it('default states render no badges', () => {
    expect(buildActionBadges(base, fakeT)).toEqual([]);
  });

  it('maps approval levels; never stays quiet', () => {
    expect(buildActionBadges({ ...base, approval: 'agent' }, fakeT).map((badge) => badge.key))
      .toEqual(['approval-agent']);
    const always = buildActionBadges({ ...base, approval: 'always' }, fakeT);
    expect(always[0]?.key).toBe('approval-always');
    expect(always[0]?.icon).toBe('shield');
    expect(always[0]?.title).toBe('badgeTipApproval(value=always)');
    expect(buildActionBadges(base, fakeT)).toEqual([]); // approval: 'never'
  });

  it('maps presentation.panel and visibility; defaults stay quiet', () => {
    expect(buildActionBadges({ ...base, presentation: { panel: 'dedicated' } }, fakeT)
      .map((badge) => badge.key)).toEqual(['panel-dedicated']);
    expect(buildActionBadges({ ...base, presentation: { panel: 'append' } }, fakeT)
      .map((badge) => badge.key)).toEqual(['panel-append']);
    expect(buildActionBadges({ ...base, presentation: { panel: 'new' } }, fakeT)).toEqual([]);
    expect(buildActionBadges({ ...base, visibility: 'ui' }, fakeT).map((badge) => badge.key))
      .toEqual(['visibility-ui']);
  });

  it('maps extends refs, showing the label part of the id', () => {
    const badges = buildActionBadges({ ...base, extends: 'workspace:base-build' }, fakeT);
    expect(badges[0]?.key).toBe('extends');
    expect(badges[0]?.text).toBe('badgeExtends(label=base-build)');
    expect(badges[0]?.title).toBe('badgeTipExtends(id=workspace:base-build)');
    expect(extendsLabel('no-colon')).toBe('no-colon');
  });

  it('composes multiple badges in stable order', () => {
    const badges = buildActionBadges({
      ...base,
      approval: 'always',
      presentation: { panel: 'dedicated' },
      visibility: 'ui',
      extends: 'workspace:base',
    }, fakeT);
    expect(badges.map((badge) => badge.key)).toEqual([
      'approval-always',
      'panel-dedicated',
      'visibility-ui',
      'extends',
    ]);
  });
});


// ---------------------------------------------------------------------------
// T60-B1: parseInspection must read the HOST's RunOutputSnapshot object
// ---------------------------------------------------------------------------

describe('createHttpApi inspection parsing (T60-B1)', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    (globalThis as { fetch?: typeof fetch }).fetch = originalFetch;
  });

  const RUN_PAYLOAD = {
    id: 'run-1',
    actionId: 'workspace:build',
    workspace: '/repo',
    sessionId: 'session-1',
    status: 'succeeded',
    startedAt: 1,
    finishedAt: 2,
    exitCode: 0,
  };

  function apiReturning(payload: unknown) {
    const calls: string[] = [];
    const api = createHttpApi('/api/test');
    // Global fetch stub: one JSON response for any call.
    (globalThis as { fetch?: typeof fetch }).fetch = ((url: string) => {
      calls.push(url);
      return Promise.resolve(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ) as Promise<Response>;
    }) as typeof fetch;
    return { api, calls };
  }

  it('extracts output text and truncated from the host snapshot object', async () => {
    const { api } = apiReturning({
      run: RUN_PAYLOAD,
      action: { id: 'workspace:build' },
      output: { text: 'hello world', offset: 0, nextOffset: 11, truncated: true },
    });
    const inspection = await api.inspectRun('session-1', 'run-1');
    expect(inspection.run.id).toBe('run-1');
    expect(inspection.output).toBe('hello world');
    expect(inspection.truncated).toBe(true);
  });

  it('keeps the legacy flat shape working', async () => {
    const { api } = apiReturning({ run: RUN_PAYLOAD, output: 'flat output', truncated: false });
    const inspection = await api.inspectRun('session-1', 'run-1');
    expect(inspection.output).toBe('flat output');
    expect(inspection.truncated).toBe(false);
  });

  it('a terminal run’s streamed-free output loads through the store (B1 end-to-end)', async () => {
    // Store + host-shaped http adapter: the settled inspect path must surface output.
    const { api } = apiReturning({
      run: RUN_PAYLOAD,
      action: { id: 'workspace:build' },
      output: { text: 'terminal output', offset: 0, nextOffset: 15, truncated: false },
    });
    const store = new PanelStore(api as unknown as ActionsApi);
    (store as unknown as { stateValue: PanelStore['state'] }).stateValue = {
      ...store.state,
      sessionId: 'session-1',
      runs: {
        'run-1': { run: RUN_PAYLOAD as never, output: '', offset: 0, truncated: false, streaming: false, settled: false },
      },
    };
    await store.ensureRunLoaded('run-1');
    const view = store.state.runs['run-1'];
    expect(view?.output).toBe('terminal output');
    expect(view?.settled).toBe(true);
    store.dispose();
  });
});
