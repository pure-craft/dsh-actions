import { describe, expect, it } from 'vitest';
import type { ProjectActionSummary } from '../src/contract.js';
import { OutputRingBuffer } from '../src/host/run/buffer.js';
import { resolveRunCapabilities } from '../src/host/run/host.js';
import { createSessionParamStore } from '../src/host/run/session-params.js';
import type {
  JobHooksLike,
  JobsLike,
  RunOutputFrame,
  RunServiceDeps,
  ShellExecRequestLike,
  ShellProcessLike,
  ShellProcessReadLike,
} from '../src/host/run/service.js';
import { createRunService, RunServiceError } from '../src/host/run/service.js';
import type { ActionRunSummary } from '../src/contract.js';

const WORKSPACE = '/ws';
const SESSION = 'session-1';

function makeAction(overrides: Partial<ProjectActionSummary> = {}): ProjectActionSummary {
  return {
    id: 'workspace:build',
    label: 'build',
    sourceLayer: 'workspace',
    visibility: 'all',
    approval: 'never',
    command: 'pnpm build',
    cwd: '/ws',
    runOptions: { instanceLimit: 1, instancePolicy: 'reuse' },
    ...overrides,
  };
}

class FakeShellProcess implements ShellProcessLike {
  exitCode: number | null = null;
  killed = false;
  pendingRead: Partial<ShellProcessReadLike> | undefined;
  private pending = '';
  private resolveDone!: () => void;
  readonly done = new Promise<void>((resolve) => {
    this.resolveDone = resolve;
  });

  emit(text: string): void {
    this.pending += text;
  }

  readOutput(): ShellProcessReadLike {
    if (this.pendingRead !== undefined) {
      const read: ShellProcessReadLike = { delta: '', lossy: false, ...this.pendingRead };
      this.pendingRead = undefined;
      return read;
    }
    const delta = this.pending;
    this.pending = '';
    return { delta, lossy: false };
  }

  kill(): boolean {
    if (!this.killed) {
      this.killed = true;
      this.resolveDone();
    }
    return true;
  }

  finish(exitCode: number, lastOutput?: string): void {
    if (lastOutput !== undefined) this.emit(lastOutput);
    this.exitCode = exitCode;
    this.resolveDone();
  }
}

class FakeShell {
  requests: ShellExecRequestLike[] = [];
  processes: FakeShellProcess[] = [];
  startError: Error | undefined;

  resolve(request: ShellExecRequestLike): unknown {
    this.requests.push(request);
    return request;
  }

  execute(): Promise<ShellProcessLike> {
    if (this.startError !== undefined) {
      const error = this.startError;
      this.startError = undefined;
      return Promise.reject(error);
    }
    const proc = new FakeShellProcess();
    this.processes.push(proc);
    return Promise.resolve(proc);
  }
}

interface FakeJobEntry {
  label: string;
  hooks: JobHooksLike;
  killed: boolean;
}

class FakeJobs implements JobsLike {
  entries = new Map<string, FakeJobEntry>();
  private sequence = 0;

  start(spec: { kind: 'bash'; label: string; run(): JobHooksLike }): string {
    this.sequence += 1;
    const id = `bash-${this.sequence}`;
    this.entries.set(id, { label: spec.label, hooks: spec.run(), killed: false });
    return id;
  }

  kill(id: string): 'requested' | 'already-finished' {
    const entry = this.entries.get(id);
    if (entry === undefined || entry.killed) return 'already-finished';
    entry.killed = true;
    entry.hooks.cancel('test kill');
    return 'requested';
  }
}

function makeService(overrides: Partial<RunServiceDeps> = {}) {
  const shell = new FakeShell();
  const jobs = new FakeJobs();
  const service = createRunService({
    shell,
    jobs,
    pollIntervalMs: 1,
    ...overrides,
  });
  return { service, shell, jobs };
}

function startedRunId(result: Awaited<ReturnType<ReturnType<typeof createRunService>['run']>>): string {
  if (result.kind !== 'started') throw new Error(`expected started, got ${result.kind}`);
  return result.run.id;
}

describe('RunService lifecycle', () => {
  it('starts a run through the shell without a policy when the caller passes none', async () => {
    const { service, shell } = makeService();
    const action = makeAction({ env: { NODE_ENV: 'test' } });
    const result = await service.run(action, { workspace: WORKSPACE, sessionId: SESSION });

    expect(result.kind).toBe('started');
    if (result.kind !== 'started') return;
    expect(result.run.status).toBe('running');
    expect(result.run.actionId).toBe(action.id);
    expect(result.run.workspace).toBe(WORKSPACE);
    expect(result.run.sessionId).toBe(SESSION);
    expect(shell.requests).toHaveLength(1);
    expect(shell.requests[0]).toMatchObject({
      command: 'pnpm build',
      workdir: '/ws',
      env: { NODE_ENV: 'test' },
    });
    // T8-B1: no policy field — the shell falls back to the deployment default.
    expect('sandboxPolicy' in (shell.requests[0] ?? {})).toBe(false);
  });

  it('passes a caller-resolved sandbox policy through with the run workspace as root', async () => {
    const { service, shell } = makeService();
    // The session resolved read-only (e.g. a read-only harness session): the
    // policy must reach the shell verbatim except for the workspace root.
    await service.run(makeAction(), {
      workspace: WORKSPACE,
      sessionId: SESSION,
      sandboxPolicy: { mode: 'read-only', workspaceRoot: '/elsewhere', sessionId: SESSION },
    });

    expect(shell.requests[0]?.sandboxPolicy).toEqual({
      mode: 'read-only',
      workspaceRoot: WORKSPACE,
      sessionId: 'session-1',
    });
  });

  it('settles succeeded on exit code 0 with captured output', async () => {
    const { service, shell } = makeService();
    const runId = startedRunId(await service.run(makeAction(), { workspace: WORKSPACE, sessionId: SESSION }));
    shell.processes[0]?.finish(0, 'build ok\n');

    const settled = await service.waitForSettled(runId);
    expect(settled.status).toBe('succeeded');
    expect(settled.exitCode).toBe(0);
    expect(settled.finishedAt).toBeTypeOf('number');
    expect(service.inspect(runId).output.text).toBe('build ok\n');
  });

  it('settles failed on a nonzero exit code', async () => {
    const { service, shell } = makeService();
    const runId = startedRunId(await service.run(makeAction(), { workspace: WORKSPACE, sessionId: SESSION }));
    shell.processes[0]?.finish(3);

    const settled = await service.waitForSettled(runId);
    expect(settled.status).toBe('failed');
    expect(settled.exitCode).toBe(3);
  });

  it('registers a bash job and reports the outcome', async () => {
    const { service, shell, jobs } = makeService();
    const runId = startedRunId(await service.run(makeAction(), { workspace: WORKSPACE, sessionId: SESSION }));
    expect(jobs.entries.size).toBe(1);
    const entry = [...jobs.entries.values()][0];
    expect(entry?.label).toBe('action: build');

    shell.processes[0]?.finish(0, 'done');
    await service.waitForSettled(runId);
    const outcome = await entry?.hooks.done;
    expect(outcome).toMatchObject({ status: 'completed', output: 'done' });
  });

  it('runs without a jobs registry (optional degradation)', async () => {
    const shell = new FakeShell();
    const service = createRunService({ shell, pollIntervalMs: 1 });
    const runId = startedRunId(await service.run(makeAction(), { workspace: WORKSPACE, sessionId: SESSION }));
    shell.processes[0]?.finish(0);
    expect((await service.waitForSettled(runId)).status).toBe('succeeded');
  });

  it('rejects with shell-unavailable when the host shell is missing', async () => {
    const service = createRunService({});
    const failure = await service.run(makeAction(), { workspace: WORKSPACE, sessionId: SESSION }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RunServiceError);
    expect((failure as RunServiceError).code).toBe('shell-unavailable');
    expect(service.listRuns()).toHaveLength(0);
  });

  it('marks the run failed when shell start rejects', async () => {
    const { service, shell } = makeService();
    shell.startError = new Error('spawn denied');
    const failure = await service.run(makeAction(), { workspace: WORKSPACE, sessionId: SESSION }).catch((error: unknown) => error);
    expect((failure as RunServiceError).code).toBe('start-failed');
    const runs = service.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('failed');
  });
});

describe('RunService conflict protocol', () => {
  it('reuse returns already-running with the active instance', async () => {
    const { service, shell } = makeService();
    const first = startedRunId(await service.run(makeAction(), { workspace: WORKSPACE, sessionId: SESSION }));
    const second = await service.run(makeAction(), { workspace: WORKSPACE, sessionId: SESSION });

    expect(second.kind).toBe('already-running');
    if (second.kind !== 'already-running') return;
    expect(second.run.id).toBe(first);
    expect(shell.processes).toHaveLength(1);
  });

  it('reject returns a structured exclusive rejection', async () => {
    const { service, shell } = makeService();
    const action = makeAction({ runOptions: { instanceLimit: 1, instancePolicy: 'reject' } });
    const first = startedRunId(await service.run(action, { workspace: WORKSPACE, sessionId: SESSION }));
    const second = await service.run(action, { workspace: WORKSPACE, sessionId: SESSION });

    expect(second).toMatchObject({ kind: 'rejected', reason: 'exclusive' });
    if (second.kind !== 'rejected') return;
    expect(second.run.id).toBe(first);
    expect(shell.processes).toHaveLength(1);
  });

  it('honors instanceLimit above one and clamps invalid limits to one', async () => {
    const { service, shell } = makeService();
    const parallel = makeAction({ runOptions: { instanceLimit: 2, instancePolicy: 'reuse' } });
    await service.run(parallel, { workspace: WORKSPACE, sessionId: SESSION });
    const second = await service.run(parallel, { workspace: WORKSPACE, sessionId: SESSION });
    expect(second.kind).toBe('started');
    const third = await service.run(parallel, { workspace: WORKSPACE, sessionId: SESSION });
    expect(third.kind).toBe('already-running');
    expect(shell.processes).toHaveLength(2);

    const clamped = makeAction({ id: 'workspace:zero', runOptions: { instanceLimit: 0, instancePolicy: 'reuse' } });
    await service.run(clamped, { workspace: WORKSPACE, sessionId: SESSION });
    const conflict = await service.run(clamped, { workspace: WORKSPACE, sessionId: SESSION });
    expect(conflict.kind).toBe('already-running');
  });

  it('T14: conflicts key on (sessionId, actionId) — workspace is not part of the key', async () => {
    const { service } = makeService();
    await service.run(makeAction(), { workspace: WORKSPACE, sessionId: SESSION });
    // Same session + same action, even in another workspace, conflicts.
    const sameSession = await service.run(makeAction(), { workspace: '/other', sessionId: SESSION });
    expect(sameSession.kind).toBe('already-running');
  });

  it('T14: different sessions run the same action in the same workspace in parallel', async () => {
    const { service, shell } = makeService();
    await service.run(makeAction(), { workspace: WORKSPACE, sessionId: SESSION });
    const other = await service.run(makeAction(), { workspace: WORKSPACE, sessionId: 'session-2' });
    expect(other.kind).toBe('started');
    expect(shell.processes).toHaveLength(2);

    // ...and the second session gets its own conflict result independently.
    const conflict = await service.run(makeAction(), { workspace: WORKSPACE, sessionId: 'session-2' });
    expect(conflict.kind).toBe('already-running');
    if (conflict.kind !== 'already-running') return;
    if (other.kind !== 'started') return;
    expect(conflict.run.id).toBe(other.run.id);
  });

  it('never interrupts the active instance implicitly', async () => {
    const { service, shell } = makeService();
    const action = makeAction({ runOptions: { instanceLimit: 1, instancePolicy: 'reject' } });
    await service.run(action, { workspace: WORKSPACE, sessionId: SESSION });
    await service.run(action, { workspace: WORKSPACE, sessionId: SESSION });
    expect(shell.processes[0]?.killed).toBe(false);
    expect(service.listRuns().filter((run) => run.status === 'running')).toHaveLength(1);
  });
});

describe('RunService cancel', () => {
  it('cancels a running instance (process kill + job kill, first-wins)', async () => {
    const { service, shell, jobs } = makeService();
    const runId = startedRunId(await service.run(makeAction(), { workspace: WORKSPACE, sessionId: SESSION }));

    const cancelled = service.cancel(runId);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.exitCode).toBeNull();
    expect(cancelled.finishedAt).toBeTypeOf('number');
    expect(shell.processes[0]?.killed).toBe(true);
    expect([...jobs.entries.values()][0]?.killed).toBe(true);

    const settled = await service.waitForSettled(runId);
    expect(settled.status).toBe('cancelled');
    // idempotent: a second cancel returns the same terminal summary
    expect(service.cancel(runId).status).toBe('cancelled');
  });

  it('maps an external job kill onto the run', async () => {
    const { service, shell, jobs } = makeService();
    const runId = startedRunId(await service.run(makeAction(), { workspace: WORKSPACE, sessionId: SESSION }));
    const jobId = [...jobs.entries.keys()][0];
    expect(jobId).toBeDefined();
    if (jobId === undefined) return;

    expect(jobs.kill(jobId)).toBe('requested');
    expect(service.inspect(runId).run.status).toBe('cancelled');
    expect(shell.processes[0]?.killed).toBe(true);
  });

  it('throws run-not-found for unknown ids', () => {
    const { service } = makeService();
    expect(() => service.cancel('run-404')).toThrowError(RunServiceError);
    expect(() => service.inspect('run-404')).toThrowError(RunServiceError);
    expect(() => service.readOutput('run-404')).toThrowError(RunServiceError);
  });

  it('forgets a settled run and refuses active or unknown ones', async () => {
    const { service, shell } = makeService();
    const runId = startedRunId(await service.run(makeAction(), { workspace: WORKSPACE, sessionId: SESSION }));

    // Active: forgetting is refused (stopping is cancel's job).
    expect(() => service.forget(runId)).toThrowError(RunServiceError);
    expect(() => service.forget(runId)).toThrowError(/active/);

    service.cancel(runId);
    await service.waitForSettled(runId);
    service.forget(runId);
    expect(service.listRuns({ sessionId: SESSION })).toEqual([]);
    expect(() => service.inspect(runId)).toThrowError(RunServiceError);
    // Forgetting twice / unknown ids both answer run-not-found.
    expect(() => service.forget(runId)).toThrowError(RunServiceError);
    expect(() => service.forget('run-404')).toThrowError(RunServiceError);
    expect(shell.processes[0]?.killed).toBe(true);
  });

  it('dispose cancels every active run', async () => {
    const { service, shell } = makeService();
    startedRunId(await service.run(makeAction(), { workspace: WORKSPACE, sessionId: SESSION }));
    service.dispose();
    expect(shell.processes[0]?.killed).toBe(true);
    expect(service.listRuns()[0]?.status).toBe('cancelled');
  });

  it('rejects run requests after dispose with the disposed code', async () => {
    const { service } = makeService();
    service.dispose();
    const failure = await service.run(makeAction(), { workspace: WORKSPACE, sessionId: SESSION }).catch((error: unknown) => error);
    expect((failure as RunServiceError).code).toBe('disposed');
  });
});

describe('RunService output buffer', () => {
  it('caps retained output and reports truncation with offsets', () => {
    const buffer = new OutputRingBuffer(16);
    buffer.append('0123456789abcdef');
    buffer.append('XYZ');

    const snapshot = buffer.snapshot();
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.offset).toBe(3);
    expect(snapshot.nextOffset).toBe(19);
    expect(snapshot.text).toBe('3456789abcdefXYZ');
    expect(Buffer.byteLength(snapshot.text)).toBeLessThanOrEqual(16);
  });

  it('reads from an absolute offset for stream resume', () => {
    const buffer = new OutputRingBuffer(16);
    buffer.append('0123456789abcdef');
    buffer.append('XYZ');

    const resumed = buffer.read(10);
    expect(resumed.offset).toBe(10);
    expect(resumed.text).toBe('abcdefXYZ');
    expect(resumed.truncated).toBe(false);

    const clamped = buffer.read(0);
    expect(clamped.offset).toBe(3);
    expect(clamped.truncated).toBe(true);
  });

  it('clamps offsets beyond the end to nextOffset', () => {
    const buffer = new OutputRingBuffer(16);
    buffer.append('0123456789');

    const beyond = buffer.read(1000);
    expect(beyond.offset).toBe(10);
    expect(beyond.offset).toBe(beyond.nextOffset);
    expect(beyond.text).toBe('');
    expect(beyond.truncated).toBe(false);
  });

  it('exposes truncation through readOutput and inspect', async () => {
    const shell = new FakeShell();
    const service = createRunService({ shell, outputLimitBytes: 16, pollIntervalMs: 1 });
    const runId = startedRunId(await service.run(makeAction(), { workspace: WORKSPACE, sessionId: SESSION }));
    shell.processes[0]?.finish(0, '0123456789abcdefXYZ');
    await service.waitForSettled(runId);

    const output = service.readOutput(runId, 0);
    expect(output.truncated).toBe(true);
    expect(output.text).toBe('3456789abcdefXYZ');
    expect(service.inspect(runId).output.nextOffset).toBe(19);
  });

  it('keeps the shell spill path on lossy reads', async () => {
    const { service, shell } = makeService();
    const runId = startedRunId(await service.run(makeAction(), { workspace: WORKSPACE, sessionId: SESSION }));
    const proc = shell.processes[0];
    if (proc === undefined) throw new Error('missing process');
    proc.pendingRead = { delta: 'partial', lossy: true, stdoutSpillPath: '/tmp/spill.log' };
    proc.finish(1);
    await service.waitForSettled(runId);

    const output = service.inspect(runId).output;
    expect(output.text).toContain('partial');
    expect(output.spillPath).toBe('/tmp/spill.log');
  });
});

describe('RunService terminal retention', () => {
  it('evicts the oldest terminal runs beyond the per-session cap', async () => {
    const shell = new FakeShell();
    const service = createRunService({ shell, pollIntervalMs: 1, terminalRetentionPerSession: 2 });
    const runOnce = async (): Promise<string> => {
      const id = startedRunId(await service.run(makeAction(), { workspace: WORKSPACE, sessionId: SESSION }));
      shell.processes.at(-1)?.finish(0);
      await service.waitForSettled(id);
      return id;
    };
    const first = await runOnce();
    await runOnce();
    const third = await runOnce();
    const fourth = await runOnce();

    expect(service.listRuns().map((run) => run.id)).toEqual([third, fourth]);
    expect(() => service.inspect(first)).toThrowError(RunServiceError);
    expect(() => service.readOutput(first)).toThrowError(RunServiceError);
    expect(() => service.cancel(first)).toThrowError(RunServiceError);
  });

  it('never evicts active runs and isolates retention per session', async () => {
    const shell = new FakeShell();
    const service = createRunService({ shell, pollIntervalMs: 1, terminalRetentionPerSession: 1 });
    const settle = async (sessionId: string): Promise<string> => {
      const id = startedRunId(await service.run(makeAction(), { workspace: WORKSPACE, sessionId }));
      shell.processes.at(-1)?.finish(0);
      await service.waitForSettled(id);
      return id;
    };
    // An active run in session-1 survives no matter how many terminals settle.
    const activeId = startedRunId(
      await service.run(makeAction({ id: 'workspace:active' }), { workspace: WORKSPACE, sessionId: SESSION }),
    );
    await settle(SESSION);
    await settle(SESSION);
    // Session-2's terminals are capped independently and never touch session-1.
    const otherFirst = await settle('session-2');
    const otherSecond = await settle('session-2');

    const own = service.listRuns({ sessionId: SESSION });
    expect(own.filter((run) => run.status === 'running').map((run) => run.id)).toEqual([activeId]);
    expect(own.filter((run) => run.status !== 'running')).toHaveLength(1);
    expect(service.listRuns({ sessionId: 'session-2' }).map((run) => run.id)).toEqual([otherSecond]);
    expect(() => service.inspect(otherFirst)).toThrowError(RunServiceError);
  });
});

describe('RunService events and listing', () => {
  it('emits status transitions and output frames', async () => {
    const { service, shell } = makeService();
    const statuses: string[] = [];
    const frames: RunOutputFrame[] = [];
    service.onDidChangeRun((run: ActionRunSummary) => statuses.push(run.status));
    service.onDidOutput((frame) => frames.push(frame));

    const runId = startedRunId(await service.run(makeAction(), { workspace: WORKSPACE, sessionId: SESSION }));
    shell.processes[0]?.emit('chunk-1');
    // let the pump (1ms poll) pick the chunk up before the process finishes
    await new Promise((resolve) => setTimeout(resolve, 20));
    shell.processes[0]?.finish(0, 'chunk-2');
    await service.waitForSettled(runId);

    expect(statuses).toEqual(['queued', 'running', 'succeeded']);
    const texts = frames.map((frame) => frame.text).join('');
    expect(texts).toBe('chunk-1chunk-2');
    expect(frames[0]).toMatchObject({ runId, offset: 0, text: 'chunk-1' });
    expect(frames.at(-1)?.text).toBe('chunk-2');
  });

  it('filters listRuns by workspace, actionId, and sessionId', async () => {
    const { service, shell } = makeService();
    await service.run(makeAction(), { workspace: WORKSPACE, sessionId: SESSION });
    await service.run(makeAction({ id: 'workspace:lint', label: 'lint' }), { workspace: WORKSPACE, sessionId: SESSION });
    await service.run(makeAction(), { workspace: WORKSPACE, sessionId: 'session-2' });
    shell.processes.forEach((proc) => proc.finish(0));

    expect(service.listRuns()).toHaveLength(3);
    expect(service.listRuns({ workspace: '/other' })).toHaveLength(0);
    expect(service.listRuns({ workspace: WORKSPACE, actionId: 'workspace:lint' })).toHaveLength(1);
    // T14: session isolation — each session sees exactly its own runs.
    expect(service.listRuns({ sessionId: SESSION })).toHaveLength(2);
    expect(service.listRuns({ sessionId: 'session-2' })).toHaveLength(1);
    expect(service.listRuns({ workspace: WORKSPACE, sessionId: 'session-2' })).toHaveLength(1);
  });
});

describe('resolveRunCapabilities', () => {
  it('resolves shell and jobs from ctx.get with undefined checks', () => {
    const shell = new FakeShell();
    const jobs = new FakeJobs();
    const ctx = {
      get(key: string): unknown {
        if (key === 'shell') return shell;
        if (key === 'jobs') return jobs;
        return undefined;
      },
    };
    const capabilities = resolveRunCapabilities(ctx);
    expect(capabilities.shell).toBe(shell);
    expect(capabilities.jobs).toBe(jobs);
  });

  it('returns undefined for missing or malformed services', () => {
    expect(resolveRunCapabilities({ get: () => undefined })).toEqual({ shell: undefined, jobs: undefined });
    expect(resolveRunCapabilities({ get: () => ({}) })).toEqual({ shell: undefined, jobs: undefined });
  });
});

describe('RunService params evaluation (T33)', () => {
  const PARAM_ACTION = makeAction({
    inputs: [
      { id: 'target', type: 'string', required: true, description: 'Build target' },
      { id: 'mode', type: 'select', options: ['debug', 'release'], default: 'debug' },
    ],
    command: 'build ${input:target} --mode ${input:mode}',
    cwd: '/ws/${input:target}',
    env: { TARGET: '${input:target}' },
  });

  it('substitutes input values into command/cwd/env and carries params on the summary', async () => {
    const { service, shell } = makeService();
    const result = await service.run(PARAM_ACTION, {
      workspace: WORKSPACE,
      sessionId: SESSION,
      params: { target: 'web' },
    });
    expect(result.kind).toBe('started');
    if (result.kind !== 'started') return;
    expect(result.run.params).toEqual({ target: 'web', mode: 'debug' });
    expect(shell.requests[0]).toMatchObject({
      command: 'build web --mode debug',
      workdir: '/ws/web',
      env: { TARGET: 'web' },
    });
    // inspect shows the evaluated definition
    expect(service.inspect(result.run.id).action.command).toBe('build web --mode debug');
    shell.processes[0]?.finish(0);
    await service.waitForSettled(result.run.id);
  });

  it('rejects unknown ids, missing required inputs, and out-of-options select values', async () => {
    const { service } = makeService();
    for (const params of [
      { target: 'web', nope: 'x' },
      { mode: 'debug' },
      { target: 'web', mode: 'prod' },
    ]) {
      const failure = await service
        .run(PARAM_ACTION, { workspace: WORKSPACE, sessionId: SESSION, params })
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(RunServiceError);
      expect((failure as RunServiceError).code).toBe('invalid-params');
    }
    expect(service.listRuns()).toHaveLength(0);
  });

  it('conflict key includes the params signature: different values run in parallel, same values conflict', async () => {
    const { service, shell } = makeService();
    await service.run(PARAM_ACTION, { workspace: WORKSPACE, sessionId: SESSION, params: { target: 'web' } });
    const other = await service.run(PARAM_ACTION, { workspace: WORKSPACE, sessionId: SESSION, params: { target: 'api' } });
    expect(other.kind).toBe('started');
    expect(shell.processes).toHaveLength(2);

    const conflict = await service.run(PARAM_ACTION, {
      workspace: WORKSPACE,
      sessionId: SESSION,
      params: { target: 'web' },
    });
    expect(conflict.kind).toBe('already-running');
    shell.processes.forEach((proc) => proc.finish(0));
  });
});

describe('T37 conflict key encoding', () => {
  it('ids containing the old separator byte never collide', async () => {
    const { service, shell } = makeService();
    // Under the legacy \x01-joined key these two would have collided:
    // ('s', 'a\x01b', '') === ('s\x01a', 'b', '') — JSON tuples keep them distinct.
    await service.run(makeAction({ id: 'ab' }), { workspace: WORKSPACE, sessionId: 's' });
    const other = await service.run(makeAction({ id: 'b' }), { workspace: WORKSPACE, sessionId: 'sa' });
    expect(other.kind).toBe('started');
    expect(shell.processes).toHaveLength(2);
    shell.processes.forEach((proc) => proc.finish(0));
  });
});

describe('RunService session param layer (T38)', () => {
  const PARAM_ACTION = makeAction({
    inputs: [
      { id: 'target', type: 'string', required: true },
      { id: 'mode', type: 'select', options: ['debug', 'release'], default: 'debug' },
    ],
    command: 'build ${input:target} --mode ${input:mode}',
  });

  it('three-level chain: explicit call > session pin > config default', async () => {
    const shell = new FakeShell();
    const store = createSessionParamStore();
    const service = createRunService({ shell, pollIntervalMs: 1, sessionParams: store });
    store.set(SESSION, PARAM_ACTION.id, { mode: 'release' });

    // Pin overrides the config default.
    await service.run(PARAM_ACTION, { workspace: WORKSPACE, sessionId: SESSION, params: { target: 'web' } });
    expect(shell.requests[0]?.command).toBe('build web --mode release');

    // Explicit call value overrides the pin.
    store.clear(SESSION, PARAM_ACTION.id);
    store.set(SESSION, PARAM_ACTION.id, { mode: 'release' });
    await service.run(PARAM_ACTION, { workspace: WORKSPACE, sessionId: SESSION, params: { target: 'api', mode: 'debug' } });
    expect(shell.requests[1]?.command).toBe('build api --mode debug');
    shell.processes.forEach((proc) => proc.finish(0));
  });

  it('a session pin satisfies required inputs', async () => {
    const shell = new FakeShell();
    const store = createSessionParamStore();
    const service = createRunService({ shell, pollIntervalMs: 1, sessionParams: store });
    store.set(SESSION, PARAM_ACTION.id, { target: 'web' });

    const result = await service.run(PARAM_ACTION, { workspace: WORKSPACE, sessionId: SESSION });
    expect(result.kind).toBe('started');
    if (result.kind !== 'started') return;
    expect(result.run.params).toEqual({ target: 'web', mode: 'debug' });
    expect(shell.requests[0]?.command).toBe('build web --mode debug');
    shell.processes[0]?.finish(0);
    await service.waitForSettled(result.run.id);
  });

  it('pins are strictly session-isolated', async () => {
    const shell = new FakeShell();
    const store = createSessionParamStore();
    const service = createRunService({ shell, pollIntervalMs: 1, sessionParams: store });
    store.set(SESSION, PARAM_ACTION.id, { target: 'web' });

    // session-2 has no pin: required input still missing.
    const failure = await service
      .run(PARAM_ACTION, { workspace: WORKSPACE, sessionId: 'session-2' })
      .catch((error: unknown) => error);
    expect((failure as RunServiceError).code).toBe('invalid-params');
    // session-1's pin is invisible to session-2.
    expect(store.list('session-2')).toEqual({});
  });
});
