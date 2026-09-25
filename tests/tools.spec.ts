import { describe, expect, it } from 'vitest';
import type {
  ActionRunSummary,
  ActionsCatalog,
  ProjectActionSummary,
  RunStartResult,
} from '../src/contract.js';
import type {
  RunInspection,
  RunListFilter,
  RunOutputSnapshot,
  RunRequestOptions,
  RunService,
  SandboxExecutionPolicyLike,
} from '../src/host/run/index.js';
import { createSessionParamStore, RunServiceError } from '../src/host/run/index.js';
import type {
  ActionCatalogProvider,
  ApprovalOutcomeLike,
  ApprovalServiceLike,
  ToolDefinitionLike,
  ToolRunContextLike,
  ToolsLike,
} from '../src/host/tools/index.js';
import { ActionToolError, createActionToolDefinitions, registerActionTools } from '../src/host/tools/index.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

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

function makeCatalog(actions: ProjectActionSummary[]): ActionsCatalog {
  return { apiVersion: 1, workspace: '/ws', sources: [], actions, runs: [] };
}

function makeRun(overrides: Partial<ActionRunSummary> = {}): ActionRunSummary {
  return {
    id: 'run-1',
    actionId: 'workspace:build',
    workspace: '/ws',
    sessionId: 'session-1',
    status: 'running',
    startedAt: 1,
    ...overrides,
  };
}

class FakeRunService implements RunService {
  runs: ActionRunSummary[] = [];
  runCalls: Array<{ action: ProjectActionSummary; options: RunRequestOptions }> = [];
  nextRunResult: RunStartResult = { kind: 'started', run: makeRun() };
  runError: RunServiceError | undefined;
  inspections = new Map<string, RunInspection>();

  listRuns(filter?: RunListFilter): ActionRunSummary[] {
    return this.runs.filter(
      (run) =>
        (filter?.workspace === undefined || run.workspace === filter.workspace) &&
        (filter?.actionId === undefined || run.actionId === filter.actionId) &&
        (filter?.sessionId === undefined || run.sessionId === filter.sessionId),
    );
  }

  async run(action: ProjectActionSummary, options: RunRequestOptions): Promise<RunStartResult> {
    this.runCalls.push({ action, options });
    if (this.runError !== undefined) throw this.runError;
    return this.nextRunResult;
  }

  inspect(runId: string): RunInspection {
    const inspection = this.inspections.get(runId);
    if (inspection !== undefined) return inspection;
    const run = this.runs.find((candidate) => candidate.id === runId);
    if (run !== undefined) {
      return {
        run: { ...run },
        action: makeAction({ id: run.actionId }),
        output: { text: '', offset: 0, nextOffset: 0, truncated: false },
      };
    }
    throw new RunServiceError('run-not-found', `Unknown action run: ${runId}`);
  }

  cancel(runId: string): ActionRunSummary {
    const run = this.runs.find((candidate) => candidate.id === runId);
    if (run === undefined) throw new RunServiceError('run-not-found', `Unknown action run: ${runId}`);
    run.status = 'cancelled';
    return { ...run };
  }

  forget(runId: string): void {
    const index = this.runs.findIndex((candidate) => candidate.id === runId);
    if (index === -1) throw new RunServiceError('run-not-found', `Unknown action run: ${runId}`);
    this.runs.splice(index, 1);
  }

  readOutput(): RunOutputSnapshot {
    return { text: '', offset: 0, nextOffset: 0, truncated: false };
  }

  waitForSettled(): Promise<ActionRunSummary> {
    return Promise.resolve(makeRun({ status: 'succeeded' }));
  }

  onDidChangeRun(): () => void {
    return () => undefined;
  }

  onDidOutput(): () => void {
    return () => undefined;
  }

  dispose(): void {}
}

class FakeTools implements ToolsLike {
  definitions = new Map<string, ToolDefinitionLike>();

  register(definition: ToolDefinitionLike): () => void {
    this.definitions.set(definition.name, definition);
    return () => {
      this.definitions.delete(definition.name);
    };
  }
}

const AGENT_EXEC: ToolRunContextLike = {
  agent: { id: 'session-1', session: { header: { cwd: '/ws' } } },
};

function makeFixture(actions: ProjectActionSummary[] = [makeAction()]) {
  const catalog: ActionCatalogProvider = { loadCatalog: () => Promise.resolve(makeCatalog(actions)) };
  const runs = new FakeRunService();
  const tools = new FakeTools();
  const sessionParams = createSessionParamStore();
  const dispose = registerActionTools(tools, { catalog, runs, sessionParams });
  const get = (name: string): ToolDefinitionLike => {
    const definition = tools.definitions.get(name);
    if (definition === undefined) throw new Error(`tool not registered: ${name}`);
    return definition;
  };
  return { catalog, runs, tools, dispose, get, sessionParams };
}

async function failureOf(promise: Promise<unknown>): Promise<ActionToolError> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ActionToolError);
  return error as ActionToolError;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe('registerActionTools', () => {
  it('registers all four tools and disposes them together', () => {
    const { tools, dispose } = makeFixture();
    expect([...tools.definitions.keys()].sort()).toEqual(['actions_cancel', 'actions_inspect', 'actions_list', 'actions_register', 'actions_run', 'actions_set_params']);
    dispose();
    expect(tools.definitions.size).toBe(0);
  });

  it('uses provider-legal tool names', () => {
    // OpenAI-compatible function names allow only [a-zA-Z0-9_-] and must start
    // with a letter. DSH passes names through unvalidated, so an illegal name
    // (e.g. a dotted "actions.list") is only rejected by the provider — with
    // INVALID_REQUEST, which fails the whole request and therefore every turn
    // of every session that has this plugin loaded, not just the tool call.
    const { tools } = makeFixture();
    for (const name of tools.definitions.keys()) expect(name).toMatch(/^[a-zA-Z][a-zA-Z0-9_-]*$/);
  });

  it('documents the conflict protocol in the run description', () => {
    const { get } = makeFixture();
    expect(get('actions_run').description).toContain('never stops an active instance');
    expect(get('actions_list').description).toContain('summaries');
    expect(get('actions_list').isConcurrencySafe?.({})).toBe(true);
    expect('isConcurrencySafe' in get('actions_run')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// actions_list
// ---------------------------------------------------------------------------

describe('actions_list', () => {
  it('returns summaries only (id/label/detail/sourceLayer/status)', async () => {
    const { get } = makeFixture([makeAction({ detail: 'Build the project' })]);
    const result = (await get('actions_list').execute({}, AGENT_EXEC)) as {
      workspace: string;
      actions: Array<Record<string, unknown>>;
    };
    expect(result.workspace).toBe('/ws');
    expect(result.actions).toEqual([
      {
        id: 'workspace:build',
        label: 'build',
        sourceLayer: 'workspace',
        status: 'idle',
        detail: 'Build the project',
        approval: 'never',
      },
    ]);
  });

  it('filters visibility: the agent entry sees all|agent, never ui', async () => {
    const { get } = makeFixture([
      makeAction({ id: 'workspace:all', label: 'all', visibility: 'all' }),
      makeAction({ id: 'workspace:ui', label: 'ui-only', visibility: 'ui' }),
      makeAction({ id: 'global:agent', label: 'agent-only', visibility: 'agent', sourceLayer: 'global' }),
    ]);
    const result = (await get('actions_list').execute({}, AGENT_EXEC)) as { actions: Array<{ id: string }> };
    expect(result.actions.map((action) => action.id)).toEqual(['workspace:all', 'global:agent']);
  });

  it('reports the active run status and runId', async () => {
    const { get, runs } = makeFixture();
    runs.runs.push(makeRun({ status: 'running' }));
    runs.runs.push(makeRun({ id: 'run-0', status: 'succeeded', actionId: 'workspace:other' }));
    const result = (await get('actions_list').execute({}, AGENT_EXEC)) as {
      actions: Array<{ status: string; runId?: string }>;
    };
    expect(result.actions[0]).toMatchObject({ status: 'running', runId: 'run-1' });
  });

  it('renders a text summary', async () => {
    const { get } = makeFixture();
    const list = get('actions_list');
    const value = await list.execute({}, AGENT_EXEC);
    const blocks = list.output.render({}, value);
    expect(blocks[0]?.type).toBe('text');
    expect(blocks[0]?.text).toContain('build (workspace:build)');
  });
});

// ---------------------------------------------------------------------------
// Workspace resolution
// ---------------------------------------------------------------------------

describe('workspace resolution', () => {
  it('uses the calling session cwd when no workspace argument is passed', async () => {
    const { get, runs } = makeFixture();
    await get('actions_run').execute({ actionId: 'workspace:build' }, AGENT_EXEC);
    expect(runs.runCalls[0]?.options.workspace).toBe('/ws');
  });

  it('prefers an explicit workspace argument', async () => {
    const { get, runs } = makeFixture();
    await get('actions_run').execute({ actionId: 'workspace:build', workspace: '/other' }, AGENT_EXEC);
    expect(runs.runCalls[0]?.options.workspace).toBe('/other');
  });

  it('requires the workspace argument when the session cwd is unavailable', async () => {
    const { get } = makeFixture();
    const error = await failureOf(get('actions_list').execute({}, { agent: { id: 'session-2' } }));
    expect(error.code).toBe('workspace-unresolved');
  });
});

// ---------------------------------------------------------------------------
// actions_run
// ---------------------------------------------------------------------------

describe('actions_run', () => {
  it('starts a run and returns the structured result with the owner agent', async () => {
    const { get, runs } = makeFixture();
    const result = (await get('actions_run').execute({ actionId: 'workspace:build' }, AGENT_EXEC)) as RunStartResult;
    expect(result.kind).toBe('started');
    // S5: the real Agent object is passed through, not a synthetic { id }.
    expect(runs.runCalls[0]?.options.owner).toBe(AGENT_EXEC.agent);
    // T15: the runtime scope is the calling session's id.
    expect(runs.runCalls[0]?.options.sessionId).toBe('session-1');
  });

  it('T15: rejects agentless run/inspect/cancel while list stays definition-only', async () => {
    const { get, runs } = makeFixture();
    runs.runs.push(makeRun()); // another session's active run exists

    // Agentless list: definitions only, run state empty.
    const listed = (await get('actions_list').execute({ workspace: '/ws' }, {})) as {
      actions: Array<Record<string, unknown>>;
    };
    expect(listed.actions[0]).toMatchObject({ id: 'workspace:build', status: 'idle' });
    expect(listed.actions[0]).not.toHaveProperty('runId');

    expect((await failureOf(get('actions_run').execute({ actionId: 'workspace:build', workspace: '/ws' }, {}))).code).toBe(
      'session-required',
    );
    expect((await failureOf(get('actions_inspect').execute({ runId: 'run-1' }, {}))).code).toBe('session-required');
    expect((await failureOf(get('actions_cancel').execute({ runId: 'run-1' }, {}))).code).toBe('session-required');
  });

  it('T15: run state is scoped to the calling session', async () => {
    const { get, runs } = makeFixture();
    runs.runs.push(makeRun({ id: 'run-foreign', sessionId: 'session-2' }));

    // list ignores other sessions' active runs.
    const listed = (await get('actions_list').execute({}, AGENT_EXEC)) as { actions: Array<Record<string, unknown>> };
    expect(listed.actions[0]).toMatchObject({ status: 'idle' });
    expect(listed.actions[0]).not.toHaveProperty('runId');

    // inspect by foreign runId reads as not-found (no existence leak).
    expect((await failureOf(get('actions_inspect').execute({ runId: 'run-foreign' }, AGENT_EXEC))).code).toBe(
      'run-not-found',
    );

    // cancel of a foreign run reads as not-found and leaves it running.
    expect((await failureOf(get('actions_cancel').execute({ runId: 'run-foreign' }, AGENT_EXEC))).code).toBe(
      'run-not-found',
    );
    expect(runs.runs.find((run) => run.id === 'run-foreign')?.status).toBe('running');

    // inspect by actionId only considers this session's runs.
    const inspection = (await get('actions_inspect').execute({ actionId: 'workspace:build' }, AGENT_EXEC)) as {
      run: null;
    };
    expect(inspection.run).toBeNull();
  });

  it('stamps the calling session sandbox policy onto the run (T8-B1)', async () => {
    const { catalog, runs } = makeFixture();
    const policy: SandboxExecutionPolicyLike = { mode: 'read-only', workspaceRoot: '/ws', sessionId: 'session-1' };
    const tools = new FakeTools();
    registerActionTools(tools, {
      catalog,
      runs,
      sandboxPolicy: {
        resolve: (scope) => (scope.session === undefined ? undefined : policy),
      },
    });
    const run = tools.definitions.get('actions_run');
    if (run === undefined) throw new Error('actions_run not registered');

    await run.execute({ actionId: 'workspace:build' }, AGENT_EXEC);
    expect(runs.runCalls[0]?.options.sandboxPolicy).toBe(policy);

    // T15: agentless run calls are rejected before any policy resolution.
    const error = await failureOf(run.execute({ actionId: 'workspace:build', workspace: '/ws' }, {}));
    expect(error.code).toBe('session-required');
    expect(runs.runCalls).toHaveLength(1);
  });

  it('passes no sandbox policy when no resolver is wired (shell deployment default)', async () => {
    const { get, runs } = makeFixture();
    await get('actions_run').execute({ actionId: 'workspace:build' }, AGENT_EXEC);
    expect(runs.runCalls[0]?.options.sandboxPolicy).toBeUndefined();
  });

  it('passes conflict outcomes through unchanged (never interrupts)', async () => {
    const { get, runs } = makeFixture();
    runs.nextRunResult = { kind: 'already-running', run: makeRun() };
    const reused = (await get('actions_run').execute({ actionId: 'workspace:build' }, AGENT_EXEC)) as RunStartResult;
    expect(reused.kind).toBe('already-running');

    runs.nextRunResult = { kind: 'rejected', reason: 'exclusive', run: makeRun() };
    const rejected = (await get('actions_run').execute({ actionId: 'workspace:build' }, AGENT_EXEC)) as RunStartResult;
    expect(rejected).toMatchObject({ kind: 'rejected', reason: 'exclusive' });
  });

  it('rejects ui-only actions as not found', async () => {
    const { get } = makeFixture([makeAction({ visibility: 'ui' })]);
    const error = await failureOf(get('actions_run').execute({ actionId: 'workspace:build' }, AGENT_EXEC));
    expect(error.code).toBe('action-not-found');
  });

  it('maps RunServiceError codes onto tool errors', async () => {
    const { get, runs } = makeFixture();
    runs.runError = new RunServiceError('shell-unavailable', 'no shell');
    const error = await failureOf(get('actions_run').execute({ actionId: 'workspace:build' }, AGENT_EXEC));
    expect(error.code).toBe('shell-unavailable');

    runs.runError = new RunServiceError('disposed', 'run service is disposed');
    const disposed = await failureOf(get('actions_run').execute({ actionId: 'workspace:build' }, AGENT_EXEC));
    expect(disposed.code).toBe('disposed');
  });

  it('validates required arguments', async () => {
    const { get } = makeFixture();
    expect((await failureOf(get('actions_run').execute({}, AGENT_EXEC))).code).toBe('invalid-arguments');
    expect((await failureOf(get('actions_run').execute('nope', AGENT_EXEC))).code).toBe('invalid-arguments');
  });
});

// ---------------------------------------------------------------------------
// actions_inspect
// ---------------------------------------------------------------------------

describe('actions_inspect', () => {
  it('inspects a run by runId with full definition and output', async () => {
    const { get, runs } = makeFixture();
    runs.inspections.set('run-1', {
      run: makeRun(),
      action: makeAction(),
      output: { text: 'hello', offset: 0, nextOffset: 5, truncated: false },
    });
    const result = (await get('actions_inspect').execute({ runId: 'run-1' }, AGENT_EXEC)) as RunInspection;
    expect(result.action.command).toBe('pnpm build');
    expect(result.output.text).toBe('hello');
  });

  it('inspects the latest run of an action by actionId', async () => {
    const { get, runs } = makeFixture();
    runs.runs.push(makeRun({ status: 'succeeded', finishedAt: 2 }));
    runs.inspections.set('run-1', {
      run: makeRun({ status: 'succeeded' }),
      action: makeAction(),
      output: { text: 'out', offset: 0, nextOffset: 3, truncated: false },
    });
    const result = (await get('actions_inspect').execute({ actionId: 'workspace:build' }, AGENT_EXEC)) as RunInspection;
    expect(result.run.id).toBe('run-1');
  });

  it('returns the definition with null run when the action never ran', async () => {
    const { get } = makeFixture();
    const result = (await get('actions_inspect').execute({ actionId: 'workspace:build' }, AGENT_EXEC)) as {
      action: ProjectActionSummary;
      run: null;
      output: null;
    };
    expect(result.action.id).toBe('workspace:build');
    expect(result.run).toBeNull();
    expect(result.output).toBeNull();
  });

  it('requires runId or actionId and maps unknown runs', async () => {
    const { get } = makeFixture();
    expect((await failureOf(get('actions_inspect').execute({}, AGENT_EXEC))).code).toBe('invalid-arguments');
    expect((await failureOf(get('actions_inspect').execute({ runId: 'run-404' }, AGENT_EXEC))).code).toBe('run-not-found');
  });
});

// ---------------------------------------------------------------------------
// actions_cancel
// ---------------------------------------------------------------------------

describe('actions_cancel', () => {
  it('cancels a run and returns its summary', async () => {
    const { get, runs } = makeFixture();
    runs.runs.push(makeRun());
    const result = (await get('actions_cancel').execute({ runId: 'run-1' }, AGENT_EXEC)) as ActionRunSummary;
    expect(result.status).toBe('cancelled');
  });

  it('maps unknown runs to run-not-found', async () => {
    const { get } = makeFixture();
    const error = await failureOf(get('actions_cancel').execute({ runId: 'run-404' }, AGENT_EXEC));
    expect(error.code).toBe('run-not-found');
  });

  it('renders every tool output without throwing', async () => {
    const { get, runs } = makeFixture();
    runs.runs.push(makeRun());
    runs.inspections.set('run-1', {
      run: makeRun(),
      action: makeAction(),
      output: { text: 'x', offset: 0, nextOffset: 1, truncated: false },
    });
    for (const name of ['actions_list', 'actions_run', 'actions_inspect', 'actions_cancel']) {
      const tool = get(name);
      const args =
        name === 'actions_list' ? {} : name === 'actions_run' ? { actionId: 'workspace:build' } : { runId: 'run-1' };
      const value = await tool.execute(args, AGENT_EXEC);
      const blocks = tool.output.render(args, value);
      expect(blocks.length).toBeGreaterThan(0);
      expect(blocks[0]?.type).toBe('text');
    }
  });
});

// ---------------------------------------------------------------------------
// Definition shape
// ---------------------------------------------------------------------------

describe('tool definition shape', () => {
  it('exposes JSON-schema parameters and stable names', () => {
    const { catalog } = makeFixture();
    const definitions = createActionToolDefinitions({ catalog, runs: new FakeRunService() });
    for (const definition of definitions) {
      expect(definition.name).toMatch(/^actions_[a-z_]+$/);
      expect(definition.parameters).toMatchObject({ type: 'object' });
      expect(typeof definition.description).toBe('string');
      expect(definition.description.length).toBeGreaterThan(40);
    }
    const run = definitions.find((definition) => definition.name === 'actions_run');
    expect(run?.parameters).toMatchObject({ required: ['actionId'] });
  });
});

// ---------------------------------------------------------------------------
// T29: approval gate
// ---------------------------------------------------------------------------

describe('actions_run approval gate (T29)', () => {
  function makeApprovalFixture(approval: 'never' | 'agent' | 'always', outcome?: ApprovalOutcomeLike) {
    const { catalog, runs } = makeFixture([makeAction({ approval })]);
    const requests: Array<Parameters<ApprovalServiceLike['request']>[0]> = [];
    const tools = new FakeTools();
    registerActionTools(tools, {
      catalog,
      runs,
      approval: {
        request: (request) => {
          requests.push(request);
          return Promise.resolve(outcome ?? 'allowed-once');
        },
      },
    });
    const run = tools.definitions.get('actions_run');
    if (run === undefined) throw new Error('actions_run not registered');
    return { run, runs, requests };
  }

  it('never-approval actions skip the gate entirely', async () => {
    const { run, runs, requests } = makeApprovalFixture('never', 'rejected');
    await run.execute({ actionId: 'workspace:build' }, AGENT_EXEC);
    expect(requests).toHaveLength(0);
    expect(runs.runCalls).toHaveLength(1);
  });

  it('allowed-once starts the run after asking', async () => {
    const { run, runs, requests } = makeApprovalFixture('agent', 'allowed-once');
    const result = (await run.execute({ actionId: 'workspace:build' }, AGENT_EXEC)) as RunStartResult;
    expect(result.kind).toBe('started');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.toolName).toBe('actions_run');
    expect(requests[0]?.reason).toContain('pnpm build');
    expect(runs.runCalls[0]?.options.sessionId).toBe('session-1');
  });

  it('rejected/cancelled/unavailable map to the structured approval-declined outcome', async () => {
    for (const outcome of ['rejected', 'cancelled', 'unavailable'] as const) {
      const { run, runs } = makeApprovalFixture('always', outcome);
      const result = (await run.execute({ actionId: 'workspace:build' }, AGENT_EXEC)) as RunStartResult;
      expect(result).toEqual({ kind: 'approval-declined', actionId: 'workspace:build', outcome });
      expect(runs.runCalls).toHaveLength(0); // nothing was ever requested from the run service
    }
  });

  it('fails closed as unavailable when no approval service is wired', async () => {
    const { get, runs } = makeFixture([makeAction({ approval: 'agent' })]);
    const result = (await get('actions_run').execute({ actionId: 'workspace:build' }, AGENT_EXEC)) as RunStartResult;
    expect(result).toEqual({ kind: 'approval-declined', actionId: 'workspace:build', outcome: 'unavailable' });
    expect(runs.runCalls).toHaveLength(0);
  });

  it('renders the approval-declined outcome without throwing', async () => {
    const { run } = makeApprovalFixture('agent', 'rejected');
    const value = await run.execute({ actionId: 'workspace:build' }, AGENT_EXEC);
    const blocks = run.output.render({ actionId: 'workspace:build' }, value);
    expect(blocks[0]?.text).toContain('rejected');
  });
});

// ---------------------------------------------------------------------------
// T33: params in agent tools
// ---------------------------------------------------------------------------

describe('actions params (T33)', () => {
  const PARAM_ACTION = makeAction({
    inputs: [
      { id: 'target', type: 'string', required: true, description: 'Build target' },
      { id: 'mode', type: 'select', options: ['debug', 'release'], default: 'debug' },
    ],
  });

  it('actions_run schema accepts a params object of strings', () => {
    const { get } = makeFixture();
    const schema = get('actions_run').parameters as { properties: Record<string, unknown> };
    expect(schema.properties.params).toMatchObject({ type: 'object', additionalProperties: { type: 'string' } });
  });

  it('missing required inputs fail with a self-correcting listing', async () => {
    const { catalog, runs } = makeFixture([PARAM_ACTION]);
    runs.runError = new RunServiceError('invalid-params', 'Action "build": Missing required input parameter(s): target');
    const tools = new FakeTools();
    registerActionTools(tools, { catalog, runs });
    const run = tools.definitions.get('actions_run');
    if (run === undefined) throw new Error('actions_run not registered');

    const error = await failureOf(run.execute({ actionId: 'workspace:build' }, AGENT_EXEC));
    expect(error.code).toBe('invalid-params');
    expect(error.message).toContain('target');
    expect(error.message).toContain('Declared inputs');
    expect(error.message).toContain('required');
  });

  it('passes params through to the run service', async () => {
    const { get, runs } = makeFixture([PARAM_ACTION]);
    await get('actions_run').execute({ actionId: 'workspace:build', params: { target: 'web' } }, AGENT_EXEC);
    // T38: the tool hands down the normalized map (defaults filled).
    expect(runs.runCalls[0]?.options.params).toEqual({ target: 'web', mode: 'debug' });
  });

  it('actions_list annotates actions with an inputs summary', async () => {
    const { get } = makeFixture([PARAM_ACTION]);
    const result = (await get('actions_list').execute({}, AGENT_EXEC)) as {
      actions: Array<{ inputs?: Array<Record<string, unknown>> }>;
    };
    expect(result.actions[0]?.inputs).toEqual([
      { id: 'target', required: true, description: 'Build target' },
      { id: 'mode', required: false, options: ['debug', 'release'] },
    ]);
  });

  it('actions_inspect exposes the run’s resolved params via the summary', async () => {
    const { get, runs } = makeFixture([PARAM_ACTION]);
    runs.inspections.set('run-1', {
      run: makeRun({ params: { target: 'web', mode: 'debug' } }),
      action: PARAM_ACTION,
      output: { text: '', offset: 0, nextOffset: 0, truncated: false },
    });
    const result = (await get('actions_inspect').execute({ runId: 'run-1' }, AGENT_EXEC)) as RunInspection;
    expect(result.run.params).toEqual({ target: 'web', mode: 'debug' });
  });
});

// ---------------------------------------------------------------------------
// T37: approval order (evaluate → conflict precheck → ask)
// ---------------------------------------------------------------------------

describe('T37 approval ordering', () => {
  const GATED_PARAM_ACTION = makeAction({
    approval: 'always',
    inputs: [{ id: 'target', type: 'string', required: true }],
    command: 'deploy ${input:target}',
    cwd: '/ws/${input:target}',
  });

  function makeGatedFixture(outcome: ApprovalOutcomeLike = 'allowed-once') {
    const { catalog, runs } = makeFixture([GATED_PARAM_ACTION]);
    const requests: Array<Parameters<ApprovalServiceLike['request']>[0]> = [];
    const tools = new FakeTools();
    registerActionTools(tools, {
      catalog,
      runs,
      approval: {
        request: (request) => {
          requests.push(request);
          return Promise.resolve(outcome);
        },
      },
    });
    const run = tools.definitions.get('actions_run');
    if (run === undefined) throw new Error('actions_run not registered');
    return { run, runs, requests };
  }

  it('approval reason carries the EVALUATED command, cwd, and params — never the template', async () => {
    const { run, requests } = makeGatedFixture();
    await run.execute({ actionId: 'workspace:build', params: { target: 'prod' } }, AGENT_EXEC);
    expect(requests).toHaveLength(1);
    const reason = requests[0]?.reason ?? '';
    expect(reason).toContain('deploy prod');
    expect(reason).toContain('/ws/prod');
    expect(reason).toContain('target=prod');
    expect(reason).not.toContain('${input');
  });

  it('invalid params answer without asking approval', async () => {
    const { run, requests } = makeGatedFixture();
    const error = await failureOf(run.execute({ actionId: 'workspace:build' }, AGENT_EXEC));
    expect(error.code).toBe('invalid-params');
    expect(requests).toHaveLength(0);
  });

  it('an existing same-params run answers already-running without asking approval', async () => {
    const { run, runs, requests } = makeGatedFixture();
    runs.runs.push(makeRun({ sessionId: 'session-1', params: { target: 'prod' }, status: 'running' }));
    const result = (await run.execute({ actionId: 'workspace:build', params: { target: 'prod' } }, AGENT_EXEC)) as RunStartResult;
    expect(result.kind).toBe('already-running');
    expect(requests).toHaveLength(0);

    // A different param value has no conflict and DOES ask.
    await run.execute({ actionId: 'workspace:build', params: { target: 'staging' } }, AGENT_EXEC);
    expect(requests).toHaveLength(1);
  });

  it('exclusive policy answers rejected without asking approval', async () => {
    const { catalog, runs } = makeFixture([
      makeAction({ approval: 'always', runOptions: { instanceLimit: 1, instancePolicy: 'reject' } }),
    ]);
    runs.runs.push(makeRun({ status: 'running' }));
    const requests: unknown[] = [];
    const tools = new FakeTools();
    registerActionTools(tools, {
      catalog,
      runs,
      approval: {
        request: (request) => {
          requests.push(request);
          return Promise.resolve('allowed-once');
        },
      },
    });
    const run = tools.definitions.get('actions_run');
    if (run === undefined) throw new Error('actions_run not registered');
    const result = (await run.execute({ actionId: 'workspace:build' }, AGENT_EXEC)) as RunStartResult;
    expect(result).toMatchObject({ kind: 'rejected', reason: 'exclusive' });
    expect(requests).toHaveLength(0);
  });

  it('actions_inspect runId branch honors offset', async () => {
    const { get, runs } = makeFixture();
    runs.inspections.set('run-1', {
      run: makeRun(),
      action: makeAction(),
      output: { text: 'full', offset: 0, nextOffset: 4, truncated: false },
    });
    runs.readOutput = () => ({ text: 'll', offset: 2, nextOffset: 4, truncated: false });
    const result = (await get('actions_inspect').execute({ runId: 'run-1', offset: 2 }, AGENT_EXEC)) as RunInspection;
    expect(result.output).toMatchObject({ text: 'll', offset: 2 });
  });
});

// ---------------------------------------------------------------------------
// T38: actions_set_params and run fallback
// ---------------------------------------------------------------------------

describe('actions_set_params (T38)', () => {
  const PARAM_ACTION = makeAction({
    inputs: [
      { id: 'target', type: 'string', required: true, description: 'Build target' },
      { id: 'mode', type: 'select', options: ['debug', 'release'], default: 'debug' },
    ],
  });

  it('set → list → clear round-trips session pins', async () => {
    const { get, sessionParams } = makeFixture([PARAM_ACTION]);
    const set = get('actions_set_params');

    const pinned = (await set.execute({ actionId: 'workspace:build', values: { target: 'web' } }, AGENT_EXEC)) as {
      sessionParams: Record<string, string>;
    };
    expect(pinned.sessionParams).toEqual({ target: 'web' });

    const listed = (await set.execute({}, AGENT_EXEC)) as { sessionParams: Record<string, Record<string, string>> };
    expect(listed.sessionParams).toEqual({ 'workspace:build': { target: 'web' } });

    const cleared = (await set.execute({ actionId: 'workspace:build', clear: true }, AGENT_EXEC)) as {
      sessionParams: Record<string, string>;
    };
    expect(cleared.sessionParams).toEqual({});
    expect(sessionParams.list('session-1')).toEqual({});
  });

  it('validates declarations at pin time and rejects agentless calls', async () => {
    const { get } = makeFixture([PARAM_ACTION]);
    const set = get('actions_set_params');

    const undeclared = await failureOf(
      set.execute({ actionId: 'workspace:build', values: { nope: 'x' } }, AGENT_EXEC),
    );
    expect(undeclared.code).toBe('invalid-params');
    expect(undeclared.message).toContain('Declared inputs');

    const badSelect = await failureOf(
      set.execute({ actionId: 'workspace:build', values: { mode: 'prod' } }, AGENT_EXEC),
    );
    expect(badSelect.code).toBe('invalid-params');

    expect((await failureOf(set.execute({ actionId: 'workspace:build', values: { target: 'web' } }, {}))).code).toBe(
      'session-required',
    );
  });

  it('actions_run falls back to session pins, and explicit params still win', async () => {
    const { get, runs, sessionParams } = makeFixture([PARAM_ACTION]);
    sessionParams.set('session-1', 'workspace:build', { target: 'web', mode: 'release' });

    await get('actions_run').execute({ actionId: 'workspace:build' }, AGENT_EXEC);
    expect(runs.runCalls[0]?.options.params).toEqual({ target: 'web', mode: 'release' });

    await get('actions_run').execute({ actionId: 'workspace:build', params: { mode: 'debug' } }, AGENT_EXEC);
    expect(runs.runCalls[1]?.options.params).toEqual({ target: 'web', mode: 'debug' });

    // Another session has no pin: required input still missing.
    const other = await failureOf(
      get('actions_run').execute(
        { actionId: 'workspace:build' },
        { agent: { id: 'session-2', session: { header: { cwd: '/ws' } } } },
      ),
    );
    expect(other.code).toBe('invalid-params');
  });

  it('registers actions_set_params with a provider-legal name and pinning description', () => {
    const { get } = makeFixture();
    const tool = get('actions_set_params');
    expect(tool.name).toMatch(/^[a-zA-Z][a-zA-Z0-9_-]*$/);
    expect(tool.description).toContain('pin');
    expect(get('actions_run').description).toContain('actions_set_params');
  });
});


// ---------------------------------------------------------------------------
// T47: actions_register
// ---------------------------------------------------------------------------

describe('actions_register (T47)', () => {
  function makeRegisterFixture(options: { approvalOutcome?: ApprovalOutcomeLike; withApproval?: boolean } = {}) {
    const { catalog, runs } = makeFixture();
    const writes: Array<{ sessionId: string; workspace: string; entry: Record<string, unknown> }> = [];
    const requests: Array<Parameters<ApprovalServiceLike['request']>[0]> = [];
    const notified: string[] = [];
    const tools = new FakeTools();
    registerActionTools(tools, {
      catalog,
      runs,
      sessionParams: createSessionParamStore(),
      sessionActions: {
        write: (sessionId, workspace, entry) => {
          writes.push({ sessionId, workspace, entry: entry as unknown as Record<string, unknown> });
          return Promise.resolve({ path: `/sessions/${sessionId}/actions.json` });
        },
      },
      notifyCatalogChanged: (workspace) => notified.push(workspace),
      ...(options.withApproval === false
        ? {}
        : {
            approval: {
              request: (request) => {
                requests.push(request);
                return Promise.resolve(options.approvalOutcome ?? 'allowed-once');
              },
            },
          }),
    });
    const tool = tools.definitions.get('actions_register');
    if (tool === undefined) throw new Error('actions_register not registered');
    return { tool, writes, requests, notified };
  }

  it('registers after approval and republishes the catalog', async () => {
    const { tool, writes, requests, notified } = makeRegisterFixture();
    const result = (await tool.execute(
      { label: 'scratch', command: 'echo hi', detail: 'Scratch pad', inputs: [{ id: 'who', type: 'string' }] },
      AGENT_EXEC,
    )) as { registered: boolean; actionId: string; path: string };

    expect(result.registered).toBe(true);
    expect(result.actionId).toBe('session:scratch');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.toolName).toBe('actions_register');
    expect(requests[0]?.reason).toContain('echo hi');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      sessionId: 'session-1',
      workspace: '/ws',
      entry: { label: 'scratch', command: 'echo hi', detail: 'Scratch pad' },
    });
    expect(notified).toEqual(['/ws']);
  });

  it('declined approval writes nothing (structured outcome, not an error)', async () => {
    const { tool, writes } = makeRegisterFixture({ approvalOutcome: 'rejected' });
    const result = (await tool.execute({ label: 'x', command: 'rm -rf /tmp/x' }, AGENT_EXEC)) as {
      registered: boolean;
      outcome: string;
    };
    expect(result.registered).toBe(false);
    expect(result.outcome).toBe('rejected');
    expect(writes).toHaveLength(0);
  });

  it('fails closed when no approval service is wired', async () => {
    const { tool, writes } = makeRegisterFixture({ withApproval: false });
    const result = (await tool.execute({ label: 'x', command: 'echo x' }, AGENT_EXEC)) as {
      registered: boolean;
      outcome: string;
    };
    expect(result).toMatchObject({ registered: false, outcome: 'unavailable' });
    expect(writes).toHaveLength(0);
  });

  it('sanitizes: empty label/command and unknown extends are rejected before any write', async () => {
    const { tool, writes, requests } = makeRegisterFixture();
    expect((await failureOf(tool.execute({ command: 'echo x' }, AGENT_EXEC))).code).toBe('invalid-arguments');
    expect((await failureOf(tool.execute({ label: 'x' }, AGENT_EXEC))).code).toBe('invalid-arguments');
    const badExtends = await failureOf(tool.execute({ label: 'x', command: 'echo x', extends: 'workspace:nope' }, AGENT_EXEC));
    expect(badExtends.code).toBe('unknown-extends');
    // Agentless registration is rejected.
    expect((await failureOf(tool.execute({ label: 'x', command: 'echo x' }, {}))).code).toBe('session-required');
    expect(writes).toHaveLength(0);
    expect(requests).toHaveLength(0); // nothing reaches the approval gate
  });

  it('schema failures return a structured invalid-entry result with field-level issues (T63b)', async () => {
    const { tool, writes, requests } = makeRegisterFixture();
    const result = (await tool.execute(
      {
        label: 'bad',
        command: 'echo x',
        visibility: 'hidden', // not in the enum
        inputs: [{ id: 'mode', type: 'select' }], // select without options
      },
      AGENT_EXEC,
    )) as { registered: boolean; reason: string; issues: Array<{ path: string; message: string }> };

    expect(result.registered).toBe(false);
    expect(result.reason).toBe('invalid-entry');
    const paths = result.issues.map((issue) => issue.path);
    expect(paths).toContain('visibility');
    expect(paths).toContain('inputs[0].options');
    const optionsIssue = result.issues.find((issue) => issue.path === 'inputs[0].options');
    expect(optionsIssue?.message).toBe('must declare at least one option');
    // Field-level guidance never reached a write or an approval prompt.
    expect(writes).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  it('pins params atomically after a successful write (validated against declared inputs)', async () => {
    const { catalog, runs } = makeFixture();
    const sessionParams = createSessionParamStore();
    const tools = new FakeTools();
    registerActionTools(tools, {
      catalog,
      runs,
      sessionParams,
      sessionActions: { write: () => Promise.resolve({ path: '/p/actions.json' }) },
      approval: { request: () => Promise.resolve('allowed-once') },
      notifyCatalogChanged: () => undefined,
    });
    const tool = tools.definitions.get('actions_register');
    if (tool === undefined) throw new Error('actions_register not registered');

    const result = (await tool.execute(
      { label: 'greet', command: 'echo ${input:who}', inputs: [{ id: 'who', type: 'string', required: true }], params: { who: 'team' } },
      AGENT_EXEC,
    )) as { registered: boolean };
    expect(result.registered).toBe(true);
    expect(sessionParams.get('session-1', 'session:greet')).toEqual({ who: 'team' });

    const bad = await failureOf(
      tool.execute({ label: 'greet2', command: 'echo x', params: { nope: 'x' } }, AGENT_EXEC),
    );
    expect(bad.code).toBe('invalid-params');
  });

  it('actions_run refuses an unresolved extends with a structured error', async () => {
    const orphan = makeAction({ id: 'session:orphan', label: 'orphan', sourceLayer: 'session' });
    (orphan as { extends?: string }).extends = 'workspace:missing';
    const { get } = makeFixture([orphan]);
    const error = await failureOf(get('actions_run').execute({ actionId: 'session:orphan' }, AGENT_EXEC));
    expect(error.code).toBe('unknown-extends');
  });
});
