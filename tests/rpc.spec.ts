import { describe, expect, it } from 'vitest';
import type { ActionsCatalog, ProjectActionSummary, RunStreamFrame } from '../src/contract.js';
import { ACTIONS_API_PATHS, createActionsApiRoutes } from '../src/host/rpc/index.js';
import type { ActionsApiDeps } from '../src/host/rpc/index.js';
import { createRunService, createSessionParamStore } from '../src/host/run/index.js';
import type { RunService, ShellProcessLike } from '../src/host/run/index.js';

const ACTION: ProjectActionSummary = {
  id: 'workspace:build',
  label: 'build',
  sourceLayer: 'workspace',
  visibility: 'all',
  approval: 'never',
  command: 'echo hi',
  cwd: '/repo',
  runOptions: { instanceLimit: 1, instancePolicy: 'reuse' },
};

function catalog(actions: ProjectActionSummary[] = [ACTION]): ActionsCatalog {
  return { apiVersion: 1, workspace: '/repo', sources: [], actions, runs: [] };
}

interface FakeProcess extends ShellProcessLike {
  readonly killed: boolean;
  finish(exitCode: number): void;
}

function fakeShellProcess(outputs: string[]): FakeProcess {
  let index = 0;
  let killed = false;
  let exitCode: number | null = null;
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  return {
    get killed() {
      return killed;
    },
    get exitCode() {
      return exitCode;
    },
    done,
    readOutput() {
      const delta = index < outputs.length ? (outputs[index] ?? '') : '';
      index += 1;
      return { delta, lossy: false };
    },
    kill() {
      killed = true;
      return true;
    },
    finish(code: number) {
      exitCode = code;
      resolveDone();
    },
  };
}

function createDeps(overrides: Partial<ActionsApiDeps> = {}): ActionsApiDeps & { proc: FakeProcess } {
  const proc = fakeShellProcess(['hello']);
  const runs: RunService =
    overrides.runs ??
    createRunService({
      shell: { resolve: (request) => request, execute: async () => proc },
      pollIntervalMs: 1,
      sleep: () => Promise.resolve(),
    });
  const deps: ActionsApiDeps & { proc: FakeProcess } = {
    loadCatalog: overrides.loadCatalog ?? (async () => catalog()),
    runs,
    proc,
    resolveSessionWorkspace:
      overrides.resolveSessionWorkspace ??
      ((sessionId) => (sessionId === 'session-1' || sessionId === 'session-2' ? '/repo' : undefined)),
  };
  if (overrides.watchCatalogChanges !== undefined) deps.watchCatalogChanges = overrides.watchCatalogChanges;
  if (overrides.sessionParams !== undefined) deps.sessionParams = overrides.sessionParams;
  if (overrides.notifyCatalogChanged !== undefined) deps.notifyCatalogChanged = overrides.notifyCatalogChanged;
  if (overrides.watchSession !== undefined) deps.watchSession = overrides.watchSession;
  if (overrides.deleteActionEntry !== undefined) deps.deleteActionEntry = overrides.deleteActionEntry;
  return deps;
}

/** Reference-counting fake of the T21 config watcher. */
class FakeCatalogWatcher {
  private listeners = new Map<string, Set<() => void>>();

  activeCount(workspace: string): number {
    return this.listeners.get(workspace)?.size ?? 0;
  }

  watch = (workspace: string, listener: () => void): (() => void) => {
    let set = this.listeners.get(workspace);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(workspace, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(workspace);
    };
  };

  trigger(workspace: string): void {
    for (const listener of Array.from(this.listeners.get(workspace) ?? [])) listener();
  }
}

/** Collect NDJSON frames from a streaming response in the background. */
function frameCollector(response: Response): { frames: unknown[]; cancel: () => Promise<void> } {
  const frames: unknown[] = [];
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error('response has no body stream');
  const done = (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return;
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.length > 0) frames.push(JSON.parse(line));
      }
    }
  })();
  return {
    frames,
    cancel: async () => {
      await reader.cancel();
      await done.catch(() => undefined);
    },
  };
}

/**
 * Wait for collected frames. All frame production under test is
 * microtask-driven (stream pushes, run settle callbacks, catalog reloads), so
 * this yields microtasks — never timers, which the run pump's immediate sleep
 * would starve.
 */
async function waitForFrames(frames: unknown[], count: number): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (frames.length >= count) return;
    await Promise.resolve();
  }
  throw new Error(`expected ${count} frames, got ${frames.length}`);
}

/** Flush pending microtask-driven producers before a negative assertion. */
async function flushMicrotasks(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) await Promise.resolve();
}

/** T15: start a run bound to a session through the runs endpoint. */
async function startRun(deps: ActionsApiDeps, sessionId: string, actionId = ACTION.id): Promise<string> {
  const response = await route(deps, ACTIONS_API_PATHS.runs).fetch(post({ sessionId, actionId }));
  const body = (await response.json()) as { kind: string; run: { id: string } };
  if (body.kind !== 'started') throw new Error(`expected started, got ${body.kind}`);
  return body.run.id;
}

function route(deps: ActionsApiDeps, path: string) {
  const found = createActionsApiRoutes(deps).find((candidate) => candidate.path === path);
  if (found === undefined) throw new Error(`Route not registered: ${path}`);
  return found;
}

function post(body: unknown): Request {
  return new Request('http://dsh.local/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function readNdjson(response: Response): Promise<RunStreamFrame[]> {
  const text = await new Response(response.body).text();
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as RunStreamFrame);
}

describe('catalog endpoint', () => {
  it('returns definitions for a workspace-only request with no run state (T15)', async () => {
    const deps = createDeps();
    await startRun(deps, 'session-1');
    const response = await route(deps, ACTIONS_API_PATHS.catalog).fetch(post({ workspace: '/repo' }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as ActionsCatalog;
    expect(body.workspace).toBe('/repo');
    expect(body.actions).toHaveLength(1);
    // No cross-session run view without a sessionId.
    expect(body.runs).toEqual([]);
    deps.runs.dispose();
  });

  it('attaches only the caller session’s runs when a sessionId is sent (T15)', async () => {
    const deps = createDeps();
    const ownRun = await startRun(deps, 'session-1');
    // Same workspace, same action, different session: runs in parallel.
    await startRun(deps, 'session-2');

    const response = await route(deps, ACTIONS_API_PATHS.catalog).fetch(post({ sessionId: 'session-1' }));
    const body = (await response.json()) as ActionsCatalog;
    expect(body.runs.map((run) => run.id)).toEqual([ownRun]);
    deps.runs.dispose();
  });

  it('rejects malformed bodies', async () => {
    const deps = createDeps();
    expect((await route(deps, ACTIONS_API_PATHS.catalog).fetch(post({}))).status).toBe(400);
    expect((await route(deps, ACTIONS_API_PATHS.catalog).fetch(post([]))).status).toBe(400);
    expect(
      (
        await route(deps, ACTIONS_API_PATHS.catalog).fetch(
          new Request('http://dsh.local/', { method: 'POST', body: 'not json' }),
        )
      ).status,
    ).toBe(400);
  });

  it('resolves the workspace from a session id', async () => {
    const deps = createDeps({
      resolveSessionWorkspace: (sessionId) => (sessionId === 'session-1' ? '/repo' : undefined),
    });
    const response = await route(deps, ACTIONS_API_PATHS.catalog).fetch(post({ sessionId: 'session-1' }));
    expect(response.status).toBe(200);
    expect(((await response.json()) as ActionsCatalog).workspace).toBe('/repo');
  });

  it('reports workspace-unresolved when neither form resolves', async () => {
    const deps = createDeps({ resolveSessionWorkspace: () => undefined });
    const missing = await route(deps, ACTIONS_API_PATHS.catalog).fetch(post({}));
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe('workspace-unresolved');
    const unknown = await route(deps, ACTIONS_API_PATHS.catalog).fetch(post({ sessionId: 'session-x' }));
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe('workspace-unresolved');
    const runUnknown = await route(deps, ACTIONS_API_PATHS.runs).fetch(
      post({ sessionId: 'session-x', actionId: ACTION.id }),
    );
    expect(runUnknown.status).toBe(400);
  });

  it('starts a run addressed by session id', async () => {
    const deps = createDeps({
      resolveSessionWorkspace: () => '/repo',
    });
    const response = await route(deps, ACTIONS_API_PATHS.runs).fetch(
      post({ sessionId: 'session-1', actionId: ACTION.id }),
    );
    expect(response.status).toBe(200);
    const result = (await response.json()) as { kind: string; run: { workspace: string } };
    expect(result.kind).toBe('started');
    expect(result.run.workspace).toBe('/repo');
    deps.runs.dispose();
  });

  it('hides agent-only actions and their runs from the web channel', async () => {
    const agentOnly: ProjectActionSummary = { ...ACTION, id: 'workspace:secret', label: 'secret', visibility: 'agent' };
    const deps = createDeps({ loadCatalog: async () => catalog([ACTION, agentOnly]) });
    await startRun(deps, 'session-1');

    const response = await route(deps, ACTIONS_API_PATHS.catalog).fetch(post({ workspace: '/repo' }));
    const body = (await response.json()) as ActionsCatalog;
    expect(body.actions.map((action) => action.id)).toEqual([ACTION.id]);
    deps.runs.dispose();
  });

  it('rejects run requests for agent-only actions as not found', async () => {
    const agentOnly: ProjectActionSummary = { ...ACTION, id: 'workspace:secret', label: 'secret', visibility: 'agent' };
    const deps = createDeps({ loadCatalog: async () => catalog([ACTION, agentOnly]) });
    const response = await route(deps, ACTIONS_API_PATHS.runs).fetch(
      post({ sessionId: 'session-1', actionId: agentOnly.id }),
    );
    expect(response.status).toBe(404);
  });
});

describe('runs endpoint', () => {
  it('starts a run and reports conflicts through the protocol', async () => {
    const deps = createDeps();
    const start = route(deps, ACTIONS_API_PATHS.runs);
    const first = (await (await start.fetch(post({ sessionId: 'session-1', actionId: ACTION.id }))).json()) as {
      kind: string;
    };
    expect(first.kind).toBe('started');
    const second = (await (await start.fetch(post({ sessionId: 'session-1', actionId: ACTION.id }))).json()) as {
      kind: string;
    };
    expect(second.kind).toBe('already-running');
    deps.runs.dispose();
  });

  it('requires a resolvable sessionId — never a workspace-derived scope (T15)', async () => {
    const deps = createDeps();
    // Missing sessionId: explicit workspace must not create a pseudo-scope.
    const missing = await route(deps, ACTIONS_API_PATHS.runs).fetch(post({ workspace: '/repo', actionId: ACTION.id }));
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe('session-required');
    // Unresolvable sessionId.
    const unknown = await route(deps, ACTIONS_API_PATHS.runs).fetch(post({ sessionId: 'session-x', actionId: ACTION.id }));
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe('session-unresolved');
  });

  it('runs the same action concurrently for two sessions in one workspace (T15 acceptance)', async () => {
    const deps = createDeps();
    const start = route(deps, ACTIONS_API_PATHS.runs);
    const first = (await (await start.fetch(post({ sessionId: 'session-1', actionId: ACTION.id }))).json()) as {
      kind: string;
      run: { id: string };
    };
    const second = (await (await start.fetch(post({ sessionId: 'session-2', actionId: ACTION.id }))).json()) as {
      kind: string;
      run: { id: string };
    };
    expect(first.kind).toBe('started');
    expect(second.kind).toBe('started');
    expect(first.run.id).not.toBe(second.run.id);
    deps.runs.dispose();
  });

  it('returns 404 for unknown actions', async () => {
    const deps = createDeps();
    const response = await route(deps, ACTIONS_API_PATHS.runs).fetch(
      post({ sessionId: 'session-1', actionId: 'workspace:nope' }),
    );
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('action-not-found');
  });
});

describe('inspect and cancel endpoints', () => {
  it('inspects a run with output and cancels it idempotently', async () => {
    const deps = createDeps();
    const runId = await startRun(deps, 'session-1');

    const inspected = (await (
      await route(deps, ACTIONS_API_PATHS.inspect).fetch(post({ sessionId: 'session-1', runId }))
    ).json()) as { run: { id: string }; action: { id: string }; output: { text: string } };
    expect(inspected.run.id).toBe(runId);
    expect(inspected.action.id).toBe(ACTION.id);

    const cancelled = (await (
      await route(deps, ACTIONS_API_PATHS.cancel).fetch(post({ sessionId: 'session-1', runId }))
    ).json()) as { status: string };
    expect(cancelled.status).toBe('cancelled');
    const again = (await (
      await route(deps, ACTIONS_API_PATHS.cancel).fetch(post({ sessionId: 'session-1', runId }))
    ).json()) as { status: string };
    expect(again.status).toBe('cancelled');
    deps.runs.dispose();
  });

  it('returns 404 for unknown runs', async () => {
    const deps = createDeps();
    expect((await route(deps, ACTIONS_API_PATHS.inspect).fetch(post({ sessionId: 'session-1', runId: 'run-x' }))).status).toBe(404);
    expect((await route(deps, ACTIONS_API_PATHS.cancel).fetch(post({ sessionId: 'session-1', runId: 'run-x' }))).status).toBe(404);
  });

  it('requires sessionId and refuses foreign runs with a plain 404 (T15)', async () => {
    const deps = createDeps();
    const runId = await startRun(deps, 'session-1');

    // Missing sessionId.
    expect((await route(deps, ACTIONS_API_PATHS.inspect).fetch(post({ runId }))).status).toBe(400);
    expect((await route(deps, ACTIONS_API_PATHS.cancel).fetch(post({ runId }))).status).toBe(400);
    expect((await route(deps, ACTIONS_API_PATHS.stream).fetch(post({ runId }))).status).toBe(400);

    // Another session must not see, cancel, or stream the run.
    for (const path of [ACTIONS_API_PATHS.inspect, ACTIONS_API_PATHS.cancel, ACTIONS_API_PATHS.stream]) {
      const response = await route(deps, path).fetch(post({ sessionId: 'session-2', runId }));
      expect(response.status).toBe(404);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe('run-not-found');
    }
    // The foreign cancel attempt must not have touched the run.
    const alive = (await (
      await route(deps, ACTIONS_API_PATHS.inspect).fetch(post({ sessionId: 'session-1', runId }))
    ).json()) as { run: { status: string } };
    expect(alive.run.status).toBe('running');
    deps.runs.dispose();
  });

  it('forgets a settled run, 409s an active one, and 404s foreign ids', async () => {
    const deps = createDeps();
    const runId = await startRun(deps, 'session-1');

    // Active runs cannot be forgotten.
    const active = await route(deps, ACTIONS_API_PATHS.forget).fetch(post({ sessionId: 'session-1', runId }));
    expect(active.status).toBe(409);
    expect(((await active.json()) as { error: { code: string } }).error.code).toBe('run-active');

    // Foreign sessions get the plain 404, and the record survives.
    const foreign = await route(deps, ACTIONS_API_PATHS.forget).fetch(post({ sessionId: 'session-2', runId }));
    expect(foreign.status).toBe(404);

    // Once settled, the owner forgets it; it disappears from listings.
    deps.proc.finish(0);
    await deps.runs.waitForSettled(runId);
    const ok = await route(deps, ACTIONS_API_PATHS.forget).fetch(post({ sessionId: 'session-1', runId }));
    expect(ok.status).toBe(200);
    expect(deps.runs.listRuns({ sessionId: 'session-1' }).map((run) => run.id)).not.toContain(runId);
    const gone = await route(deps, ACTIONS_API_PATHS.inspect).fetch(post({ sessionId: 'session-1', runId }));
    expect(gone.status).toBe(404);
    deps.runs.dispose();
  });
});

describe('stream endpoint', () => {
  it('replays buffered output and closes on terminal status', async () => {
    const deps = createDeps();
    const runId = await startRun(deps, 'session-1');
    deps.proc.finish(0);
    const settled = await deps.runs.waitForSettled(runId);
    expect(settled.status).toBeDefined();

    const response = await route(deps, ACTIONS_API_PATHS.stream).fetch(post({ sessionId: 'session-1', runId, sinceOffset: 0 }));
    expect(response.headers.get('content-type')).toContain('application/x-ndjson');
    const frames = await readNdjson(response);
    const types = frames.map((frame) => frame.type);
    expect(types).toContain('status');
    const last = frames[frames.length - 1];
    expect(last?.type).toBe('status');
    deps.runs.dispose();
  });

  it('returns 404 for unknown runs instead of opening a stream', async () => {
    const deps = createDeps();
    const response = await route(deps, ACTIONS_API_PATHS.stream).fetch(post({ sessionId: 'session-1', runId: 'run-x' }));
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('run-not-found');
  });
});

describe('runs/events endpoint (T16H, backfilled in T21)', () => {
  function trackChangeListeners(runs: RunService): { wrapped: RunService; count: () => number } {
    let active = 0;
    const wrapped: RunService = {
      ...runs,
      onDidChangeRun(listener) {
        active += 1;
        const off = runs.onDidChangeRun(listener);
        return () => {
          active -= 1;
          off();
        };
      },
    };
    return { wrapped, count: () => active };
  }

  it('requires a resolvable sessionId', async () => {
    const deps = createDeps();
    expect((await route(deps, ACTIONS_API_PATHS.events).fetch(post({}))).status).toBe(400);
    expect((await route(deps, ACTIONS_API_PATHS.events).fetch(post({ sessionId: 'session-x' }))).status).toBe(400);
  });

  it('sends a first-frame snapshot of only the caller session’s runs', async () => {
    const deps = createDeps();
    const ownRun = await startRun(deps, 'session-1');
    await startRun(deps, 'session-2');

    const response = await route(deps, ACTIONS_API_PATHS.events).fetch(post({ sessionId: 'session-1' }));
    expect(response.headers.get('content-type')).toContain('application/x-ndjson');
    const collector = frameCollector(response);
    await waitForFrames(collector.frames, 1);

    const snapshot = collector.frames[0] as { type: string; runs: Array<{ id: string; sessionId?: string }> };
    expect(snapshot.type).toBe('snapshot');
    expect(snapshot.runs.map((run) => run.id)).toEqual([ownRun]);
    await collector.cancel();
    deps.runs.dispose();
  });

  it('pushes status frames for new runs and transitions of the caller session', async () => {
    const deps = createDeps();
    const response = await route(deps, ACTIONS_API_PATHS.events).fetch(post({ sessionId: 'session-1' }));
    const collector = frameCollector(response);
    await waitForFrames(collector.frames, 1); // snapshot

    const runId = await startRun(deps, 'session-1');
    deps.proc.finish(0);
    // snapshot + queued + running + succeeded
    await waitForFrames(collector.frames, 4);

    const statuses = collector.frames
      .slice(1)
      .map((frame) => (frame as { type: string; run: { id: string; status: string } }))
      .filter((frame) => frame.type === 'status' && frame.run.id === runId);
    expect(statuses.length).toBeGreaterThanOrEqual(2);
    expect(statuses.at(-1)?.run.status).toBe('succeeded');
    await collector.cancel();
    deps.runs.dispose();
  });

  it('never forwards another session’s run events', async () => {
    const deps = createDeps();
    const response = await route(deps, ACTIONS_API_PATHS.events).fetch(post({ sessionId: 'session-1' }));
    const collector = frameCollector(response);
    await waitForFrames(collector.frames, 1); // snapshot

    await startRun(deps, 'session-2');
    await flushMicrotasks();
    expect(collector.frames).toHaveLength(1);
    await collector.cancel();
    deps.runs.dispose();
  });

  it('unsubscribes the run listener when the client disconnects', async () => {
    const runs = createRunService({
      shell: { resolve: (request) => request, execute: async () => fakeShellProcess([]) },
      pollIntervalMs: 1,
      sleep: () => Promise.resolve(),
    });
    const tracked = trackChangeListeners(runs);
    const deps = createDeps({ runs: tracked.wrapped });

    const response = await route(deps, ACTIONS_API_PATHS.events).fetch(post({ sessionId: 'session-1' }));
    const collector = frameCollector(response);
    await waitForFrames(collector.frames, 1);
    expect(tracked.count()).toBe(1);

    await collector.cancel();
    expect(tracked.count()).toBe(0);
    runs.dispose();
  });
});

describe('catalog/events endpoint (T21)', () => {
  it('requires a resolvable sessionId', async () => {
    const deps = createDeps();
    expect((await route(deps, ACTIONS_API_PATHS.catalogEvents).fetch(post({}))).status).toBe(400);
    expect((await route(deps, ACTIONS_API_PATHS.catalogEvents).fetch(post({ sessionId: 'session-x' }))).status).toBe(400);
  });

  it('sends the full assembled catalog as the first frame, runs scoped to the caller session', async () => {
    const deps = createDeps();
    const ownRun = await startRun(deps, 'session-1');
    await startRun(deps, 'session-2');

    const response = await route(deps, ACTIONS_API_PATHS.catalogEvents).fetch(post({ sessionId: 'session-1' }));
    const collector = frameCollector(response);
    await waitForFrames(collector.frames, 1);

    const frame = collector.frames[0] as { type: string; catalog: { actions: unknown[]; runs: Array<{ id: string }> } };
    expect(frame.type).toBe('catalog');
    expect(frame.catalog.actions).toHaveLength(1);
    expect(frame.catalog.runs.map((run) => run.id)).toEqual([ownRun]);
    await collector.cancel();
    deps.runs.dispose();
  });

  it('pushes a reloaded catalog when the watcher fires, and dedupes nothing itself', async () => {
    let extraAction: ProjectActionSummary | undefined;
    const deps = createDeps({
      loadCatalog: async () => catalog(extraAction === undefined ? [ACTION] : [ACTION, extraAction]),
    });
    const watcher = new FakeCatalogWatcher();
    deps.watchCatalogChanges = watcher.watch;

    const response = await route(deps, ACTIONS_API_PATHS.catalogEvents).fetch(post({ sessionId: 'session-1' }));
    const collector = frameCollector(response);
    await waitForFrames(collector.frames, 1);
    expect(watcher.activeCount('/repo')).toBe(1);

    extraAction = { ...ACTION, id: 'workspace:lint', label: 'lint' };
    watcher.trigger('/repo');
    await waitForFrames(collector.frames, 2);
    const updated = collector.frames[1] as { catalog: { actions: Array<{ id: string }> } };
    expect(updated.catalog.actions.map((action) => action.id)).toEqual([ACTION.id, 'workspace:lint']);

    await collector.cancel();
    expect(watcher.activeCount('/repo')).toBe(0);
    deps.runs.dispose();
  });

  it('never leaks another session’s runs into pushed catalogs', async () => {
    const deps = createDeps();
    const watcher = new FakeCatalogWatcher();
    deps.watchCatalogChanges = watcher.watch;

    const response = await route(deps, ACTIONS_API_PATHS.catalogEvents).fetch(post({ sessionId: 'session-1' }));
    const collector = frameCollector(response);
    await waitForFrames(collector.frames, 1);

    await startRun(deps, 'session-2'); // foreign run starts after the first frame
    watcher.trigger('/repo');
    await waitForFrames(collector.frames, 2);
    const updated = collector.frames[1] as { catalog: { runs: unknown[] } };
    expect(updated.catalog.runs).toEqual([]);

    await collector.cancel();
    deps.runs.dispose();
  });

  it('serves only the snapshot when no watcher is wired', async () => {
    const deps = createDeps();
    const response = await route(deps, ACTIONS_API_PATHS.catalogEvents).fetch(post({ sessionId: 'session-1' }));
    const collector = frameCollector(response);
    await waitForFrames(collector.frames, 1);
    await flushMicrotasks();
    expect(collector.frames).toHaveLength(1);
    await collector.cancel();
    deps.runs.dispose();
  });
});

describe('runs endpoint confirmation (T29)', () => {
  const GATED: ProjectActionSummary = { ...ACTION, approval: 'always' };

  it('approval:always without confirmed:true answers 409 confirmation-required', async () => {
    const deps = createDeps({ loadCatalog: async () => catalog([GATED]) });
    const response = await route(deps, ACTIONS_API_PATHS.runs).fetch(post({ sessionId: 'session-1', actionId: GATED.id }));
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('confirmation-required');
    expect(deps.runs.listRuns()).toHaveLength(0); // nothing started
  });

  it('confirmed:true starts the gated action', async () => {
    const deps = createDeps({ loadCatalog: async () => catalog([GATED]) });
    const response = await route(deps, ACTIONS_API_PATHS.runs).fetch(
      post({ sessionId: 'session-1', actionId: GATED.id, confirmed: true }),
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as { kind: string }).kind).toBe('started');
    deps.runs.dispose();
  });

  it('approval:agent and never actions do not require the confirmation flag', async () => {
    const agentGated: ProjectActionSummary = { ...ACTION, id: 'workspace:agent-gated', approval: 'agent' };
    const deps = createDeps({ loadCatalog: async () => catalog([ACTION, agentGated]) });
    for (const actionId of [ACTION.id, agentGated.id]) {
      const response = await route(deps, ACTIONS_API_PATHS.runs).fetch(post({ sessionId: 'session-1', actionId }));
      expect(response.status).toBe(200);
    }
    deps.runs.dispose();
  });
});

describe('runs endpoint params (T33)', () => {
  const PARAM_ACTION: ProjectActionSummary = {
    ...ACTION,
    inputs: [{ id: 'target', type: 'string', required: true }],
    command: 'build ${input:target}',
  };

  it('passes params through and evaluates them for the run', async () => {
    const deps = createDeps({ loadCatalog: async () => catalog([PARAM_ACTION]) });
    const response = await route(deps, ACTIONS_API_PATHS.runs).fetch(
      post({ sessionId: 'session-1', actionId: PARAM_ACTION.id, params: { target: 'web' } }),
    );
    expect(response.status).toBe(200);
    const result = (await response.json()) as { kind: string; run: { params?: Record<string, string> } };
    expect(result.kind).toBe('started');
    expect(result.run.params).toEqual({ target: 'web' });
    deps.runs.dispose();
  });

  it('400s on non-string params values and on missing required inputs', async () => {
    const deps = createDeps({ loadCatalog: async () => catalog([PARAM_ACTION]) });
    const badShape = await route(deps, ACTIONS_API_PATHS.runs).fetch(
      post({ sessionId: 'session-1', actionId: PARAM_ACTION.id, params: { target: 5 } }),
    );
    expect(badShape.status).toBe(400);

    const missing = await route(deps, ACTIONS_API_PATHS.runs).fetch(
      post({ sessionId: 'session-1', actionId: PARAM_ACTION.id }),
    );
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe('invalid-params');
    expect(deps.runs.listRuns()).toHaveLength(0);
  });
});

describe('params endpoint and session pin board (T38)', () => {
  const PARAM_ACTION: ProjectActionSummary = {
    ...ACTION,
    inputs: [
      { id: 'target', type: 'string', required: true },
      { id: 'mode', type: 'select', options: ['debug', 'release'], default: 'debug' },
    ],
  };

  function makePinDeps() {
    const watcher = new FakeCatalogWatcher();
    const store = createSessionParamStore();
    const proc = fakeShellProcess(['hello']);
    const deps = createDeps({
      loadCatalog: async () => catalog([PARAM_ACTION]),
      // The API layer and the run service share one store, as in composition.
      runs: createRunService({
        shell: { resolve: (request) => request, execute: async () => proc },
        pollIntervalMs: 1,
        sleep: () => Promise.resolve(),
        sessionParams: store,
      }),
      sessionParams: store,
      watchCatalogChanges: watcher.watch,
      notifyCatalogChanged: (workspace) => watcher.trigger(workspace),
    });
    return { deps, watcher };
  }

  it('set → catalog carries own sessionParams → clear removes them', async () => {
    const { deps } = makePinDeps();
    const set = await route(deps, ACTIONS_API_PATHS.params).fetch(
      post({ sessionId: 'session-1', actionId: PARAM_ACTION.id, values: { target: 'web' } }),
    );
    expect(set.status).toBe(200);
    expect(((await set.json()) as { sessionParams: Record<string, string> }).sessionParams).toEqual({ target: 'web' });

    const withSession = (await (
      await route(deps, ACTIONS_API_PATHS.catalog).fetch(post({ sessionId: 'session-1' }))
    ).json()) as ActionsCatalog & { sessionParams?: Record<string, Record<string, string>> };
    expect(withSession.sessionParams).toEqual({ [PARAM_ACTION.id]: { target: 'web' } });

    // Another session never sees the pin.
    const other = (await (
      await route(deps, ACTIONS_API_PATHS.catalog).fetch(post({ sessionId: 'session-2' }))
    ).json()) as ActionsCatalog & { sessionParams?: Record<string, Record<string, string>> };
    expect(other.sessionParams).toEqual({});

    const cleared = await route(deps, ACTIONS_API_PATHS.params).fetch(
      post({ sessionId: 'session-1', actionId: PARAM_ACTION.id, clear: true }),
    );
    expect(((await cleared.json()) as { sessionParams: Record<string, string> }).sessionParams).toEqual({});
    deps.runs.dispose();
  });

  it('validates declarations at pin time: undeclared ids and bad select values 400', async () => {
    const { deps } = makePinDeps();
    const undeclared = await route(deps, ACTIONS_API_PATHS.params).fetch(
      post({ sessionId: 'session-1', actionId: PARAM_ACTION.id, values: { nope: 'x' } }),
    );
    expect(undeclared.status).toBe(400);
    expect(((await undeclared.json()) as { error: { code: string } }).error.code).toBe('invalid-params');

    const badSelect = await route(deps, ACTIONS_API_PATHS.params).fetch(
      post({ sessionId: 'session-1', actionId: PARAM_ACTION.id, values: { mode: 'prod' } }),
    );
    expect(badSelect.status).toBe(400);

    const unknownAction = await route(deps, ACTIONS_API_PATHS.params).fetch(
      post({ sessionId: 'session-1', actionId: 'workspace:nope', values: { target: 'web' } }),
    );
    expect(unknownAction.status).toBe(404);

    const noValues = await route(deps, ACTIONS_API_PATHS.params).fetch(
      post({ sessionId: 'session-1', actionId: PARAM_ACTION.id }),
    );
    expect(noValues.status).toBe(400);
    deps.runs.dispose();
  });

  it('/runs transparently falls back to pinned values', async () => {
    const { deps } = makePinDeps();
    await route(deps, ACTIONS_API_PATHS.params).fetch(
      post({ sessionId: 'session-1', actionId: PARAM_ACTION.id, values: { target: 'web' } }),
    );
    const response = await route(deps, ACTIONS_API_PATHS.runs).fetch(
      post({ sessionId: 'session-1', actionId: PARAM_ACTION.id }),
    );
    expect(response.status).toBe(200);
    const result = (await response.json()) as { kind: string; run: { params?: Record<string, string> } };
    expect(result.kind).toBe('started');
    expect(result.run.params).toEqual({ target: 'web', mode: 'debug' });
    deps.runs.dispose();
  });

  it('a pin write republishes the catalog events frame', async () => {
    const { deps } = makePinDeps();
    const response = await route(deps, ACTIONS_API_PATHS.catalogEvents).fetch(post({ sessionId: 'session-1' }));
    const collector = frameCollector(response);
    await waitForFrames(collector.frames, 1);

    await route(deps, ACTIONS_API_PATHS.params).fetch(
      post({ sessionId: 'session-1', actionId: PARAM_ACTION.id, values: { target: 'web' } }),
    );
    await waitForFrames(collector.frames, 2);
    const updated = collector.frames[1] as { catalog: { sessionParams?: Record<string, Record<string, string>> } };
    expect(updated.catalog.sessionParams).toEqual({ [PARAM_ACTION.id]: { target: 'web' } });

    await collector.cancel();
    deps.runs.dispose();
  });
});


describe('T47 session layer over RPC', () => {
  it('runs refuses an unresolved extends with 400 unknown-extends', async () => {
    const orphan: ProjectActionSummary = { ...ACTION, id: 'session:orphan', sourceLayer: 'session', extends: 'workspace:missing' };
    const deps = createDeps({ loadCatalog: async () => catalog([orphan]) });
    const response = await route(deps, ACTIONS_API_PATHS.runs).fetch(
      post({ sessionId: 'session-1', actionId: 'session:orphan' }),
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('unknown-extends');
    expect(deps.runs.listRuns()).toHaveLength(0);
  });

  it('catalog requests with a sessionId load the session layer and enroll the session file in the watcher', async () => {
    const seen: Array<{ workspace: string; sessionId?: string }> = [];
    const enrolled: Array<{ workspace: string; sessionId: string }> = [];
    const deps = createDeps({
      loadCatalog: async (workspace, sessionId) => {
        seen.push({ workspace, ...(sessionId === undefined ? {} : { sessionId }) });
        return catalog();
      },
      watchSession: (workspace, sessionId) => enrolled.push({ workspace, sessionId }),
    });
    const response = await route(deps, ACTIONS_API_PATHS.catalog).fetch(post({ sessionId: 'session-1' }));
    expect(response.status).toBe(200);
    expect(seen).toEqual([{ workspace: '/repo', sessionId: 'session-1' }]);

    await startRun(deps, 'session-1');
    expect(enrolled).toEqual([{ workspace: '/repo', sessionId: 'session-1' }]);
    deps.runs.dispose();
  });
});



describe('actions/delete endpoint (T50)', () => {
  function makeDeleteDeps(actions: ProjectActionSummary[] = [ACTION]) {
    const deleted: Array<{ layer: string; label: string; workspace: string; sessionId: string }> = [];
    const notified: string[] = [];
    let live = [...actions];
    const deps = createDeps({
      loadCatalog: async () => catalog(live),
      deleteActionEntry: async (layer, label, workspace, sessionId) => {
        deleted.push({ layer, label, workspace, sessionId });
        const before = live.length;
        live = live.filter((action) => action.id !== `${layer}:${label}`);
        return live.length < before;
      },
      notifyCatalogChanged: (workspace) => notified.push(workspace),
    });
    return { deps, deleted, notified };
  }

  it('deletes a workspace-layer entry and republishes the catalog', async () => {
    const { deps, deleted, notified } = makeDeleteDeps();
    const response = await route(deps, ACTIONS_API_PATHS.deleteAction).fetch(
      post({ sessionId: 'session-1', actionId: ACTION.id }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true, actionId: ACTION.id });
    expect(deleted).toEqual([{ layer: 'workspace', label: 'build', workspace: '/repo', sessionId: 'session-1' }]);
    expect(notified).toEqual(['/repo']);

    // After deletion the catalog no longer lists it.
    const after = (await (
      await route(deps, ACTIONS_API_PATHS.catalog).fetch(post({ sessionId: 'session-1' }))
    ).json()) as { actions: unknown[] };
    expect(after.actions).toEqual([]);
    deps.runs.dispose();
  });

  it('maps each layer prefix to its own file edit', async () => {
    const { deps, deleted } = makeDeleteDeps([
      ACTION,
      { ...ACTION, id: 'global:lint', label: 'lint', sourceLayer: 'global' },
      { ...ACTION, id: 'session:scratch', label: 'scratch', sourceLayer: 'session' },
    ]);
    for (const actionId of ['global:lint', 'session:scratch']) {
      const response = await route(deps, ACTIONS_API_PATHS.deleteAction).fetch(
        post({ sessionId: 'session-1', actionId }),
      );
      expect(response.status).toBe(200);
    }
    expect(deleted.map((entry) => entry.layer)).toEqual(['global', 'session']);
    deps.runs.dispose();
  });

  it('404s unknown actions and keeps run history untouched', async () => {
    const { deps } = makeDeleteDeps();
    const runId = await startRun(deps, 'session-1');

    const missing = await route(deps, ACTIONS_API_PATHS.deleteAction).fetch(
      post({ sessionId: 'session-1', actionId: 'workspace:nope' }),
    );
    expect(missing.status).toBe(404);

    const malformed = await route(deps, ACTIONS_API_PATHS.deleteAction).fetch(
      post({ sessionId: 'session-1', actionId: 'nope' }),
    );
    expect(malformed.status).toBe(400);

    // Deleting the definition must not touch the run record.
    await route(deps, ACTIONS_API_PATHS.deleteAction).fetch(post({ sessionId: 'session-1', actionId: ACTION.id }));
    expect(deps.runs.listRuns({ sessionId: 'session-1' }).map((run) => run.id)).toEqual([runId]);
    deps.runs.dispose();
  });
});
