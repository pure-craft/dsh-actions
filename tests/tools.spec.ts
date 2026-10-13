import { describe, expect, it } from 'vitest';
import type { ActionEntryConfig, ActionRunSummary, ProjectActionSummary, RunStartResult } from '../src/contract.js';
import type { RunInspection, RunListFilter, RunOutputSnapshot, RunRequestOptions, RunService } from '../src/host/run/index.js';
import { RunServiceError } from '../src/host/run/index.js';
import type { ActionChange, ActionLayerSnapshot, ConfigurableActionLayer } from '../src/host/config/action-store.js';
import type { ActionLayerStoreLike, ApprovalServiceLike, ToolDefinitionLike, ToolRunContextLike } from '../src/host/tools/index.js';
import { createActionToolDefinitions } from '../src/host/tools/index.js';

function action(overrides: Partial<ProjectActionSummary> = {}): ProjectActionSummary {
  return { id: 'workspace:build', label: 'build', sourceLayer: 'workspace', visibility: 'all', approval: 'never', command: 'pnpm build', cwd: '/ws', runOptions: { instanceLimit: 1, instancePolicy: 'reuse' }, ...overrides };
}
function run(overrides: Partial<ActionRunSummary> = {}): ActionRunSummary { return { id: 'run-1', actionId: 'workspace:build', workspace: '/ws', sessionId: 's1', status: 'running', startedAt: 1, ...overrides }; }
class Runs implements RunService {
  rows: ActionRunSummary[] = [];
  calls: RunRequestOptions[] = [];
  listRuns(filter?: RunListFilter): ActionRunSummary[] { return this.rows.filter((item) => (!filter?.workspace || item.workspace === filter.workspace) && (!filter?.actionId || item.actionId === filter.actionId) && (!filter?.sessionId || item.sessionId === filter.sessionId)); }
  async run(_action: ProjectActionSummary, options: RunRequestOptions): Promise<RunStartResult> { this.calls.push(options); const value = run({ sessionId: options.sessionId, ...(options.params === undefined ? {} : { params: options.params }) }); this.rows.push(value); return { kind: 'started', run: value }; }
  inspect(id: string): RunInspection { const value = this.rows.find((item) => item.id === id); if (!value) throw new RunServiceError('run-not-found', 'missing'); return { run: value, action: action({ id: value.actionId }), output: { text: 'hello', offset: 0, nextOffset: 5, truncated: false } }; }
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
  async create(layer: ConfigurableActionLayer, entry: ActionEntryConfig, _revision?: string, workspace?: string): Promise<{ path: string }> { if (workspace !== undefined) this.workspaces.push(workspace); this.entries.set(this.key(layer, entry.label), entry); return { path: `/${layer}.json` }; }
  async update(layer: ConfigurableActionLayer, label: string, _revision: string, changes: readonly ActionChange[]): Promise<{ path: string; before: ActionEntryConfig; after: ActionEntryConfig }> { const before = this.entries.get(this.key(layer, label))!; const after = { ...before }; for (const change of changes) if (change.operation === 'set-field') Object.assign(after, { [change.field]: change.value }); this.entries.set(this.key(layer, label), after); return { path: `/${layer}.json`, before, after }; }
  async delete(layer: ConfigurableActionLayer, label: string): Promise<{ path: string; before: ActionEntryConfig }> { const before = this.entries.get(this.key(layer, label))!; this.entries.delete(this.key(layer, label)); return { path: `/${layer}.json`, before }; }
}
function fixture(overrides: { actions?: ProjectActionSummary[]; approval?: ApprovalServiceLike; layers?: Layers } = {}) {
  const runs = new Runs(); const layers = overrides.layers ?? new Layers();
  const definitions = createActionToolDefinitions({ catalog: { loadCatalog: async (workspace, sessionId) => ({ apiVersion: 1, workspace, sources: [], actions: overrides.actions ?? [action()], runs: runs.listRuns({ workspace, sessionId }) }) }, runs, actionLayers: layers, approval: overrides.approval });
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
  it('defaults to catalog and filters ui-only actions', async () => { const { get, exec } = fixture({ actions: [action(), action({ id: 'workspace:hidden', label: 'hidden', visibility: 'ui' })] }); const value = await get('actions_query').execute({}, exec) as { actions: unknown[] }; expect(value.actions).toHaveLength(1); });
  it('returns effective action and raw layers with revisions', async () => { const { get, exec, layers } = fixture(); layers.entries.set('workspace:build', { label: 'build', command: 'pnpm build' }); const value = await get('actions_query').execute({ selector: { kind: 'action', actionId: 'workspace:build', view: 'layers' } }, exec) as { layers: unknown[] }; expect(value.layers).toHaveLength(3); expect(value.layers[1]).toMatchObject({ layer: 'workspace', entryRevision: 'entry-rev' }); });
  it('enforces run ownership and honors byte offset', async () => { const { get, exec, runs } = fixture(); runs.rows.push(run()); const value = await get('actions_query').execute({ selector: { kind: 'run', runId: 'run-1', offset: 2 } }, exec) as RunInspection; expect(value.output).toMatchObject({ text: 'llo', offset: 2, nextOffset: 5 }); runs.rows[0]!.sessionId = 'other'; await rejectsCode(get('actions_query').execute({ selector: { kind: 'run', runId: 'run-1' } }, exec), 'run-not-found'); });
});

describe('actions_run and actions_cancel', () => {
  it('uses explicit per-run params and does not read pins', async () => { const inputAction = action({ inputs: [{ id: 'target', type: 'string', required: true }] }); const { get, exec, runs } = fixture({ actions: [inputAction] }); await get('actions_run').execute({ actionId: inputAction.id, params: { target: 'prod' } }, exec); expect(runs.calls[0]?.params).toEqual({ target: 'prod' }); await rejectsCode(get('actions_run').execute({ actionId: inputAction.id }, exec), 'invalid-params'); });
  it('requires an owned run for cancellation', async () => { const { get, exec, runs } = fixture(); runs.rows.push(run()); const value = await get('actions_cancel').execute({ runId: 'run-1' }, exec) as ActionRunSummary; expect(value.status).toBe('cancelled'); });
});

describe('actions_configure', () => {
  const approval: ApprovalServiceLike = { request: async () => 'allowed-once' };
  it('always uses the calling session workspace', async () => { const layers = new Layers(); const { get, exec } = fixture({ approval, layers }); await get('actions_configure').execute({ operation: 'create', layer: 'session', expectedStoreRevision: 'store-rev', definition: { label: 'current', command: 'echo current' } }, exec); expect(layers.workspaces).toEqual(['/ws']); });
  it('creates only after approval with an explicit store revision', async () => { const { get, exec, layers } = fixture({ approval }); const value = await get('actions_configure').execute({ operation: 'create', layer: 'session', expectedStoreRevision: 'store-rev', definition: { label: 'diag', command: 'echo ok' } }, exec) as { configured: boolean }; expect(value.configured).toBe(true); expect(layers.entries.get('session:diag')).toMatchObject({ command: 'echo ok' }); });
  it('updates a raw entry with typed changes', async () => { const { get, exec, layers } = fixture({ approval }); layers.entries.set('workspace:build', { label: 'build', command: 'pnpm build' }); await get('actions_configure').execute({ operation: 'update', layer: 'workspace', actionId: 'workspace:build', expectedRevision: 'entry-rev', changes: [{ operation: 'set-field', field: 'detail', value: 'Build project' }] }, exec); expect(layers.entries.get('workspace:build')).toMatchObject({ detail: 'Build project' }); });
  it('requires acknowledgement when delete exposes a lower layer', async () => { const { get, exec, layers } = fixture({ approval }); layers.entries.set('session:build', { label: 'build', command: 'session build' }); layers.entries.set('workspace:build', { label: 'build', command: 'workspace build' }); const first = await get('actions_configure').execute({ operation: 'delete', layer: 'session', actionId: 'session:build', expectedRevision: 'entry-rev' }, exec) as { reason: string }; expect(first.reason).toBe('fallback-ack-required'); expect(layers.entries.has('session:build')).toBe(true); await get('actions_configure').execute({ operation: 'delete', layer: 'session', actionId: 'session:build', expectedRevision: 'entry-rev', acknowledgeFallback: true }, exec); expect(layers.entries.has('session:build')).toBe(false); });
  it('fails closed without approval', async () => { const { get, exec } = fixture(); const value = await get('actions_configure').execute({ operation: 'create', layer: 'session', expectedStoreRevision: 'store-rev', definition: { label: 'diag', command: 'echo ok' } }, exec) as { reason: string; outcome: string }; expect(value).toMatchObject({ reason: 'approval-declined', outcome: 'unavailable' }); });
  it('rejects cross-layer ids and missing revisions', async () => { const { get, exec, layers } = fixture({ approval }); layers.entries.set('workspace:build', { label: 'build', command: 'pnpm build' }); await rejectsCode(get('actions_configure').execute({ operation: 'update', layer: 'workspace', actionId: 'session:build', expectedRevision: 'entry-rev', changes: [{ operation: 'set-field', field: 'detail', value: 'x' }] }, exec), 'invalid-arguments'); });
});
