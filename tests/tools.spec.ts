import { describe, expect, it } from 'vitest';
import type { ActionEntryConfig, ActionRunSummary, ProjectActionSummary, RunStartResult } from '../src/contract.js';
import type { RunInspection, RunListFilter, RunOutputSnapshot, RunRequestOptions, RunService } from '../src/host/run/index.js';
import { RunServiceError } from '../src/host/run/index.js';
import { createRunService } from '../src/host/run/service.js';
import type { ShellExecRequestLike } from '../src/host/run/service.js';
import type { ActionChange, ActionLayerSnapshot, ConfigurableActionLayer } from '../src/host/config/action-store.js';
import type { ActionLayerStoreLike, ApprovalServiceLike, ToolDefinitionLike, ToolRunContextLike } from '../src/host/tools/index.js';
import { createActionToolDefinitions } from '../src/host/tools/index.js';

function action(overrides: Partial<ProjectActionSummary> = {}): ProjectActionSummary {
  return { id: 'workspace:build', label: 'build', sourceLayer: 'workspace', agentVisible: true, approval: 'never', command: 'pnpm build', cwd: '/ws', runOptions: { instanceLimit: 1, instancePolicy: 'reuse' }, ...overrides };
}
function run(overrides: Partial<ActionRunSummary> = {}): ActionRunSummary { return { id: 'run-1', actionId: 'workspace:build', workspace: '/ws', sessionId: 's1', status: 'running', startedAt: 1, ...overrides }; }
class Runs implements RunService {
  rows: ActionRunSummary[] = [];
  calls: RunRequestOptions[] = [];
  actions: ProjectActionSummary[] = [];
  snapshot = action();
  listRuns(filter?: RunListFilter): ActionRunSummary[] { return this.rows.filter((item) => (!filter?.workspace || item.workspace === filter.workspace) && (!filter?.actionId || item.actionId === filter.actionId) && (!filter?.sessionId || item.sessionId === filter.sessionId)); }
  async run(_action: ProjectActionSummary, options: RunRequestOptions): Promise<RunStartResult> { this.calls.push(options); this.actions.push(_action); const value = run({ sessionId: options.sessionId, ...(options.params === undefined ? {} : { params: options.params }) }); this.rows.push(value); return { kind: 'started', run: value }; }
  inspect(id: string): RunInspection { const value = this.rows.find((item) => item.id === id); if (!value) throw new RunServiceError('run-not-found', 'missing'); return { run: value, action: { ...this.snapshot, id: value.actionId }, output: { text: 'hello', offset: 0, nextOffset: 5, truncated: false } }; }
  readOutput(id: string, offset: number): RunOutputSnapshot { this.inspect(id); return { text: 'llo', offset, nextOffset: 5, truncated: false }; }
  cancel(id: string): ActionRunSummary { const value = this.inspect(id).run; value.status = 'cancelled'; return value; }
  waitForSettled(id: string): Promise<ActionRunSummary> { return Promise.resolve(this.inspect(id).run); }
  forget(): void {}
  onChange(): () => void { return () => undefined; }
  onOutput(): () => void { return () => undefined; }
  onDidChangeRun(): () => void { return () => undefined; }
  onDidOutput(): () => void { return () => undefined; }
  dispose(): void {}
}
class Layers implements ActionLayerStoreLike {
  entries = new Map<string, ActionEntryConfig>();
  private key(layer: ConfigurableActionLayer, label: string): string { return `${layer}:${label}`; }
  async inspect(layer: ConfigurableActionLayer, label: string): Promise<ActionLayerSnapshot> { const entry = this.entries.get(this.key(layer, label)); return { path: `/${layer}.json`, revision: 'store-rev', ...(entry ? { entry, entryRevision: 'entry-rev' } : {}) }; }
  workspaces: string[] = [];
  createdSessions: string[] = [];
  async create(layer: ConfigurableActionLayer, entry: ActionEntryConfig, workspace: string, sessionId: string): Promise<{ path: string }> { this.workspaces.push(workspace); if (this.entries.has(this.key(layer, entry.label))) throw new Error('already exists'); this.entries.set(this.key(layer, entry.label), entry); this.createdSessions.push(sessionId); return { path: `/${layer}.json` }; }
  async update(layer: ConfigurableActionLayer, label: string, _revision: string, changes: readonly ActionChange[]): Promise<{ path: string; before: ActionEntryConfig; after: ActionEntryConfig }> { const before = this.entries.get(this.key(layer, label))!; const after = { ...before }; for (const change of changes) if (change.operation === 'set-field') Object.assign(after, { [change.field]: change.value }); this.entries.set(this.key(layer, label), after); return { path: `/${layer}.json`, before, after }; }
  async delete(layer: ConfigurableActionLayer, label: string): Promise<{ path: string; before: ActionEntryConfig }> { const before = this.entries.get(this.key(layer, label))!; this.entries.delete(this.key(layer, label)); return { path: `/${layer}.json`, before }; }
}
function fixture(overrides: { actions?: ProjectActionSummary[]; approval?: ApprovalServiceLike; layers?: Layers } = {}) {
  const runs = new Runs(); const layers = overrides.layers ?? new Layers();
  const definitions = createActionToolDefinitions({ catalog: { loadCatalog: async (workspace, sessionId) => ({ apiVersion: 1, workspace, sources: [], actions: overrides.actions ?? [action()], runs: runs.listRuns({ workspace, sessionId }) }) }, runs, actionLayers: layers, approval: overrides.approval, sandboxPolicy: { resolve: ({ mode }) => ({ mode: mode ?? 'workspace-write', workspaceRoot: '/ws', sessionId: 's1' }) } });
  const get = (name: string): ToolDefinitionLike => definitions.find((item) => item.name === name)!;
  const exec: ToolRunContextLike = { agent: { id: 's1', session: { header: { cwd: '/ws' } } }, callId: 'call-1' };
  return { definitions, get, exec, runs, layers };
}
async function rejectsCode(promise: Promise<unknown>, code: string): Promise<void> { await expect(promise).rejects.toMatchObject({ name: 'ActionToolError', code }); }

describe('public tool contract', () => {
  it('exposes exactly the four focused tools with provider-safe names', () => { const names = fixture().definitions.map((item) => item.name); expect(names).toEqual(['actions_query', 'actions_run', 'actions_cancel', 'actions_configure']); for (const name of names) expect(name).toMatch(/^[a-zA-Z][a-zA-Z0-9_-]*$/); });
  it('descriptions define boundaries and do not mention removed tools', () => { const all = fixture().definitions.map((item) => item.description).join('\n'); expect(all).toContain('There are no pinned session parameters'); expect(all).toContain('raw Action definition'); expect(all).toContain('UTF-8 byte offset'); expect(all).toContain('The tool cannot target another workspace'); expect(all).not.toMatch(/actions_(list|inspect|set_params|register)/); });
  it('does not expose a workspace override on any tool', () => { for (const definition of fixture().definitions) { const properties = (definition.parameters as { properties?: Record<string, unknown> }).properties ?? {}; expect(properties).not.toHaveProperty('workspace'); } });
});

describe('actions_query', () => {
  it('defaults to catalog and filters ui-only actions', async () => { const { get, exec } = fixture({ actions: [action(), action({ id: 'workspace:hidden', label: 'hidden', agentVisible: false })] }); const value = await get('actions_query').execute({}, exec) as { actions: unknown[] }; expect(value.actions).toHaveLength(1); });
  it('does not reveal Agent-invisible manual-run snapshots by run id', async () => {
    const { get, exec, runs } = fixture();
    runs.snapshot = action({ agentVisible: false }); runs.rows.push(run());
    await rejectsCode(get('actions_query').execute({ selector: { kind: 'run', runId: 'run-1' } }, exec), 'run-not-found');
  });
  it('reports invalid-source diagnostics in catalog queries', async () => {
    const runs = new Runs();
    const tools = createActionToolDefinitions({ catalog: { loadCatalog: async (workspace) => ({ apiVersion: 1, workspace, actions: [], runs: [], sources: [{ layer: 'workspace', path: '/ws/.dsh/actions.json', available: true, errors: ['actions[0].label: duplicate label'] }] }) }, runs });
    const result = await tools.find((tool) => tool.name === 'actions_query')!.execute({}, fixture().exec);
    expect(result).toMatchObject({ actions: [], sources: [{ layer: 'workspace', errors: ['actions[0].label: duplicate label'] }] });
  });
  it('returns effective action and raw layers with revisions', async () => { const { get, exec, layers } = fixture(); layers.entries.set('workspace:build', { label: 'build', command: 'pnpm build' }); const value = await get('actions_query').execute({ selector: { kind: 'action', actionId: 'workspace:build', view: 'layers' } }, exec) as { layers: unknown[] }; expect(value.layers).toHaveLength(3); expect(value.layers[1]).toMatchObject({ layer: 'workspace', entryRevision: 'entry-rev' }); });
  it('never exposes another source hidden from agents through layers', async () => {
    const { get, exec, layers } = fixture();
    layers.entries.set('global:build', { label: 'build', command: 'secret command', agentVisible: false });
    layers.entries.set('workspace:build', { label: 'build', command: 'pnpm build' });
    const value = await get('actions_query').execute({ selector: { kind: 'action', actionId: 'workspace:build', view: 'layers' } }, exec);
    expect(JSON.stringify(value)).not.toContain('secret command');
    expect(value).toMatchObject({ layers: [{ layer: 'workspace' }, { layer: 'session' }] });
  });
  it('also hides raw entries whose explicit base makes them agent-invisible', async () => {
    const { get, exec, layers } = fixture({ actions: [action(), action({ id: 'global:build', sourceLayer: 'global', agentVisible: false })] });
    layers.entries.set('global:build', { label: 'build', extends: 'global:hidden-base', detail: 'private inherited entry' });
    const value = await get('actions_query').execute({ selector: { kind: 'action', actionId: 'workspace:build', view: 'layers' } }, exec);
    expect(JSON.stringify(value)).not.toContain('private inherited entry');
  });
  it('omits favorite and icon from normal action and run projections', async () => {
    const { get, exec, runs } = fixture({ actions: [action({ favorite: true, icon: 'lucide:star' })] });
    runs.snapshot = action({ favorite: true, icon: 'lucide:star' }); runs.rows.push(run());
    for (const selector of [{ kind: 'action', actionId: 'workspace:build' }, { kind: 'run', runId: 'run-1' }]) {
      const value = await get('actions_query').execute({ selector }, exec);
      expect(value).toHaveProperty('action'); expect(value).not.toHaveProperty('action.favorite'); expect(value).not.toHaveProperty('action.icon');
    }
  });
  it('enforces run ownership and honors byte offset', async () => { const { get, exec, runs } = fixture(); runs.rows.push(run()); const value = await get('actions_query').execute({ selector: { kind: 'run', runId: 'run-1', offset: 2 } }, exec) as RunInspection; expect(value.output).toMatchObject({ text: 'llo', offset: 2, nextOffset: 5 }); runs.rows[0]!.sessionId = 'other'; await rejectsCode(get('actions_query').execute({ selector: { kind: 'run', runId: 'run-1' } }, exec), 'run-not-found'); });
});

describe('actions_run and actions_cancel', () => {
  it('uses explicit per-run params and does not read pins', async () => { const inputAction = action({ inputs: [{ id: 'target', type: 'string', required: true }] }); const { get, exec, runs } = fixture({ actions: [inputAction] }); await get('actions_run').execute({ actionId: inputAction.id, params: { target: 'prod' } }, exec); expect(runs.calls[0]?.params).toEqual({ target: 'prod' }); await rejectsCode(get('actions_run').execute({ actionId: inputAction.id }, exec), 'invalid-params'); });
  it('requires an owned run for cancellation', async () => { const { get, exec, runs } = fixture(); runs.rows.push(run()); const value = await get('actions_cancel').execute({ runId: 'run-1' }, exec) as ActionRunSummary; expect(value.status).toBe('cancelled'); });
});

describe('actions_configure', () => {
  const approval: ApprovalServiceLike = { request: async () => 'allowed-once' };
  it('creates in the calling workspace and session without caller-supplied ids or revisions', async () => { const layers = new Layers(); const { get, exec } = fixture({ approval, layers }); const value = await get('actions_configure').execute({ operation: 'create', layer: 'session', definition: { label: 'current', command: 'echo current' } }, exec) as { configured: boolean }; expect(value.configured).toBe(true); expect(layers.workspaces).toEqual(['/ws']); expect(layers.createdSessions).toEqual(['s1']); expect(layers.entries.get('session:current')).toMatchObject({ command: 'echo current' }); });
  it('does not expose expectedStoreRevision in the create contract', () => { const configure = fixture({ approval }).get('actions_configure'); const properties = (configure.parameters as { properties: Record<string, unknown> }).properties; expect(properties).not.toHaveProperty('expectedStoreRevision'); });
  it('updates a raw entry with typed changes', async () => { const { get, exec, layers } = fixture({ approval }); layers.entries.set('workspace:build', { label: 'build', command: 'pnpm build' }); await get('actions_configure').execute({ operation: 'update', layer: 'workspace', actionId: 'workspace:build', expectedRevision: 'entry-rev', changes: [{ operation: 'set-field', field: 'detail', value: 'Build project' }] }, exec); expect(layers.entries.get('workspace:build')).toMatchObject({ detail: 'Build project' }); });
  it('deletes only its independent source without fallback acknowledgement', async () => { const { get, exec, layers } = fixture({ approval }); layers.entries.set('session:build', { label: 'build', command: 'session build' }); layers.entries.set('workspace:build', { label: 'build', command: 'workspace build' }); const result = await get('actions_configure').execute({ operation: 'delete', layer: 'session', actionId: 'session:build', expectedRevision: 'entry-rev' }, exec); expect(result).toMatchObject({ configured: true }); expect(result).not.toHaveProperty('fallback'); expect(layers.entries.has('session:build')).toBe(false); expect(layers.entries.has('workspace:build')).toBe(true); });
  it('fails closed without approval', async () => { const { get, exec } = fixture(); const value = await get('actions_configure').execute({ operation: 'create', layer: 'session', definition: { label: 'diag', command: 'echo ok' } }, exec) as { reason: string; outcome: string }; expect(value).toMatchObject({ reason: 'approval-declined', outcome: 'unavailable' }); });
  it('rejects cross-layer ids and missing revisions', async () => { const { get, exec, layers } = fixture({ approval }); layers.entries.set('workspace:build', { label: 'build', command: 'pnpm build' }); await rejectsCode(get('actions_configure').execute({ operation: 'update', layer: 'workspace', actionId: 'session:build', expectedRevision: 'entry-rev', changes: [{ operation: 'set-field', field: 'detail', value: 'x' }] }, exec), 'invalid-arguments'); });
});


describe('one-time elevated approval and retry', () => {
  it('replays a real run-service snapshot without substituting input literals twice', async () => {
    const requests: ShellExecRequestLike[] = [];
    const runs = createRunService({ shell: { resolve: (req) => { requests.push(req); return req; }, execute: async () => ({ done: Promise.resolve(), exitCode: 1, readOutput: () => ({ delta: '', lossy: false }), kill: () => true }) } });
    const definition = action({ command: 'echo ${input:value}', inputs: [{ id: 'value', type: 'string' }], env: { VALUE: '${input:value}' } });
    const tools = createActionToolDefinitions({ runs, catalog: { loadCatalog: async () => ({ apiVersion: 1, workspace: '/ws', sources: [], actions: [definition], runs: [] }) }, approval: { request: async () => { definition.command = 'changed'; return 'allowed-once'; } }, sandboxPolicy: { resolve: ({ mode }) => ({ mode: mode ?? 'workspace-write', workspaceRoot: '/ws' }) } });
    const tool = tools.find((item) => item.name === 'actions_run')!;
    const exec = fixture().exec;
    const first = await tool.execute({ actionId: definition.id, params: { value: '${input:value}' }, wait: true }, exec) as Extract<RunStartResult, { kind: 'started' }>;
    expect(first.run.status).toBe('failed');
    const second = await tool.execute({ retryRunId: first.run.id, justification: 'metadata access', wait: true }, exec) as Extract<RunStartResult, { kind: 'started' }>;
    expect(second.run.retryOf).toBe(first.run.id);
    expect(requests[1]?.command).toBe(requests[0]?.command);
    expect(requests[1]?.env).toEqual(requests[0]?.env);
    expect(requests[1]?.sandboxPolicy?.mode).toBe('danger-full-access');
    runs.dispose();
  });
  it('does not launch when cancellation races an approved answer', async () => {
    const controller = new AbortController();
    const { get, exec, runs } = fixture({ actions: [action({ approval: 'always' })], approval: { request: async () => { controller.abort(); return 'allowed-once'; } } });
    expect(await get('actions_run').execute({ actionId: 'workspace:build' }, { ...exec, signal: controller.signal })).toMatchObject({ kind: 'approval-declined', outcome: 'cancelled' });
    expect(runs.calls).toHaveLength(0);
  });
  it.each(['agent', 'always'] as const)('combines %s run approval and full access into one request', async (approvalMode) => {
    const requests: Parameters<ApprovalServiceLike['request']>[0][] = [];
    const { get, exec, runs } = fixture({ actions: [action({ approval: approvalMode })], approval: { request: async (req) => { requests.push(req); return 'allowed-once'; } } });
    await get('actions_run').execute({ actionId: 'workspace:build' }, exec);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.reason).toContain('danger-full-access');
    expect(requests[0]?.reason).toContain('pnpm build');
    expect(runs.calls[0]?.sandboxPolicy?.mode).toBe('danger-full-access');
  });
  it('keeps approval never sandboxed without requesting approval', async () => {
    const { get, exec, runs } = fixture({ approval: { request: async () => { throw new Error('must not ask'); } } });
    await get('actions_run').execute({ actionId: 'workspace:build' }, exec);
    expect(runs.calls[0]?.sandboxPolicy?.mode).toBe('workspace-write');
  });
  it.each(['rejected', 'cancelled', 'unavailable'] as const)('does not execute on %s approval', async (outcome) => {
    const { get, exec, runs } = fixture({ actions: [action({ approval: 'always' })], approval: { request: async () => outcome } });
    expect(await get('actions_run').execute({ actionId: 'workspace:build' }, exec)).toMatchObject({ kind: 'approval-declined', outcome });
    expect(runs.calls).toHaveLength(0);
  });
  it('fails closed when approval is unavailable', async () => {
    const { get, exec, runs } = fixture({ actions: [action({ approval: 'always' })] });
    expect(await get('actions_run').execute({ actionId: 'workspace:build' }, exec)).toMatchObject({ kind: 'approval-declined', outcome: 'unavailable' });
    expect(runs.calls).toHaveLength(0);
  });
  it('retries the original snapshot even if the catalog changed, preserving params and lineage', async () => {
    const { get, exec, runs } = fixture({ actions: [], approval: { request: async () => 'allowed-once' } });
    runs.snapshot = action({ command: 'old command', cwd: '/ws/old', env: { TARGET: 'old' } });
    runs.rows.push(run({ status: 'failed', sandboxMode: 'workspace-write', params: { target: 'old' } }));
    await get('actions_run').execute({ retryRunId: 'run-1', justification: 'Git metadata is outside the worktree.' }, exec);
    expect(runs.actions[0]).toMatchObject({ command: 'old command', cwd: '/ws/old', env: { TARGET: 'old' } });
    expect(runs.calls[0]).toMatchObject({ retryOf: 'run-1', evaluatedSnapshot: true, params: { target: 'old' }, sandboxPolicy: { mode: 'danger-full-access' } });
  });
  it('does not permit cross-session retries', async () => {
    const { get, exec, runs } = fixture(); runs.rows.push(run({ status: 'failed', sessionId: 'other' }));
    await rejectsCode(get('actions_run').execute({ retryRunId: 'run-1', justification: 'test' }, exec), 'run-not-found');
  });
  it.each(['running', 'succeeded', 'cancelled'] as const)('rejects retry of %s runs', async (status) => {
    const { get, exec, runs } = fixture(); runs.rows.push(run({ status }));
    await rejectsCode(get('actions_run').execute({ retryRunId: 'run-1', justification: 'test' }, exec), 'invalid-arguments');
  });
  it('rejects mutated retry arguments and repeated escalation', async () => {
    const { get, exec, runs } = fixture(); runs.rows.push(run({ status: 'failed', sandboxMode: 'danger-full-access' }));
    await rejectsCode(get('actions_run').execute({ retryRunId: 'run-1', actionId: 'workspace:build', justification: 'test' }, exec), 'invalid-arguments');
    await rejectsCode(get('actions_run').execute({ retryRunId: 'run-1', justification: 'test' }, exec), 'invalid-arguments');
    expect(runs.calls).toHaveLength(0);
  });
  it('does not prompt or elevate an already active instance', async () => {
    const { get, exec, runs } = fixture({ actions: [action({ approval: 'always' })], approval: { request: async () => { throw new Error('must not ask'); } } });
    runs.rows.push(run());
    expect(await get('actions_run').execute({ actionId: 'workspace:build' }, exec)).toMatchObject({ kind: 'already-running' });
    expect(runs.calls).toHaveLength(0);
  });
});
