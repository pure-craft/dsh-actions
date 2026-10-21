/** Agent-facing Actions tools: query, run, cancel, and configure. */
import type { ActionEntryConfig, ActionRunSummary, ActionsCatalog, AgentActionView, ProjectActionSummary, RunStartResult } from '../../contract.js';
import { validateActionEntryConfig } from '../../wire.js';
import { normalizeParams } from '../config/params.js';
import { isInsideOrEqual } from '../config/paths.js';
import type { ActionChange, ActionLayerSnapshot, ConfigurableActionLayer } from '../config/action-store.js';
import { ActionStoreError } from '../config/action-store.js';
import { evaluateAction, RunServiceError } from '../run/service.js';
import type { RunInspection, RunRequestOptions, RunService, SandboxExecutionPolicyLike } from '../run/service.js';

export interface TextBlockLike { type: 'text'; text: string }
export interface ToolAgentLike { readonly id: string; readonly session?: { readonly header?: { readonly cwd?: string } } }
export interface ToolRunContextLike { readonly agent?: ToolAgentLike; readonly callId?: string; readonly signal?: AbortSignal }
export interface ToolOutputDefinitionLike { readonly schema: Record<string, unknown>; render(args: unknown, value: unknown): TextBlockLike[] }
export interface ToolDefinitionLike { readonly name: string; readonly description: string; readonly parameters: Record<string, unknown>; readonly output: ToolOutputDefinitionLike; execute(args: unknown, exec: ToolRunContextLike): Promise<unknown>; isConcurrencySafe?(args: unknown): boolean }
export interface ToolsLike { register(definition: ToolDefinitionLike): () => void }
export interface ActionCatalogProvider { loadCatalog(workspace: string, sessionId?: string): Promise<ActionsCatalog> }
export interface SandboxPolicyResolverLike { resolve(scope: { session?: unknown; mode?: SandboxExecutionPolicyLike['mode'] }): SandboxExecutionPolicyLike | undefined }
export type ApprovalOutcomeLike = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';
export interface ApprovalServiceLike { request(request: { agent: ToolAgentLike; toolName: string; callId?: string; reason?: string; signal?: AbortSignal }): Promise<ApprovalOutcomeLike> }
export interface ActionLayerStoreLike {
  inspect(layer: ConfigurableActionLayer, label: string, workspace: string, sessionId: string): Promise<ActionLayerSnapshot>;
  create(layer: ConfigurableActionLayer, entry: ActionEntryConfig, workspace: string, sessionId: string): Promise<{ path: string }>;
  update(layer: ConfigurableActionLayer, label: string, expectedRevision: string, changes: readonly ActionChange[], workspace: string, sessionId: string): Promise<{ path: string; before: ActionEntryConfig; after: ActionEntryConfig }>;
  delete(layer: ConfigurableActionLayer, label: string, expectedRevision: string, workspace: string, sessionId: string): Promise<{ path: string; before: ActionEntryConfig }>;
}
export interface ActionToolsDeps { catalog: ActionCatalogProvider; runs: RunService; sandboxPolicy?: SandboxPolicyResolverLike | undefined; approval?: ApprovalServiceLike | undefined; actionLayers?: ActionLayerStoreLike | undefined; notifyCatalogChanged?: ((workspace: string) => void) | undefined }
export type ActionToolErrorCode = 'invalid-arguments' | 'workspace-unresolved' | 'action-not-found' | 'run-not-found' | 'shell-unavailable' | 'start-failed' | 'disposed' | 'session-required' | 'invalid-params' | 'unknown-extends' | 'already-exists' | 'not-found' | 'stale-revision' | 'invalid-entry' | 'invalid-file';
export class ActionToolError extends Error { override readonly name = 'ActionToolError'; constructor(readonly code: ActionToolErrorCode, message: string, readonly details?: unknown) { super(message); } }

function asRecord(args: unknown): Record<string, unknown> { if (typeof args !== 'object' || args === null || Array.isArray(args)) throw new ActionToolError('invalid-arguments', 'Tool arguments must be an object.'); return args as Record<string, unknown>; }
function optionalString(args: Record<string, unknown>, key: string): string | undefined { const value = args[key]; if (value === undefined) return undefined; if (typeof value !== 'string' || value.length === 0) throw new ActionToolError('invalid-arguments', `Argument "${key}" must be a non-empty string.`); return value; }
function requiredString(args: Record<string, unknown>, key: string): string { const value = optionalString(args, key); if (value === undefined) throw new ActionToolError('invalid-arguments', `Missing required argument "${key}".`); return value; }
function optionalStringMap(args: Record<string, unknown>, key: string): Record<string, string> | undefined { const value = args[key]; if (value === undefined) return undefined; if (typeof value !== 'object' || value === null || Array.isArray(value) || !Object.values(value).every((entry) => typeof entry === 'string')) throw new ActionToolError('invalid-arguments', `Argument "${key}" must be an object of string values.`); return value as Record<string, string>; }
function optionalOffset(args: Record<string, unknown>): number | undefined { const value = args.offset; if (value === undefined) return undefined; if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new ActionToolError('invalid-arguments', 'Argument "offset" must be a non-negative finite number.'); return value; }
function resolveWorkspace(exec: ToolRunContextLike): string { const cwd = exec.agent?.session?.header?.cwd; if (cwd) return cwd; throw new ActionToolError('workspace-unresolved', 'Could not resolve the calling session workspace. Actions tools are bound to the current session and cannot target another workspace.'); }
function requireSessionAgent(exec: ToolRunContextLike): ToolAgentLike { if (exec.agent === undefined) throw new ActionToolError('session-required', 'This operation requires an agent session. Catalog queries remain available without one.'); return exec.agent; }
function isTerminal(status: ActionRunSummary['status']): boolean { return status === 'succeeded' || status === 'failed' || status === 'cancelled'; }
function agentAction(action: ProjectActionSummary): AgentActionView {
  const { id, label, sourceLayer, folder, agentVisible, approval, command, cwd, detail, inputs, runOptions, presentation, extends: base } = action;
  return { id, label, sourceLayer, agentVisible, approval, command, cwd, runOptions, ...(presentation === undefined ? {} : { presentation }),
    ...(folder === undefined ? {} : { folder }), ...(detail === undefined ? {} : { detail }),
    ...(inputs === undefined ? {} : { inputs }), ...(base === undefined ? {} : { extends: base }) };
}
function rawAgentVisible(entry: ActionEntryConfig): boolean { return entry.agentVisible ?? entry.visibility !== 'ui'; }
async function visibleActions(deps: ActionToolsDeps, workspace: string, sessionId?: string): Promise<ProjectActionSummary[]> { return (await deps.catalog.loadCatalog(workspace, sessionId)).actions.filter((action) => action.agentVisible !== false); }
function findVisibleAction(actions: ProjectActionSummary[], actionId: string): ProjectActionSummary { const action = actions.find((candidate) => candidate.id === actionId); if (!action) throw new ActionToolError('action-not-found', `Unknown or agent-invisible action "${actionId}". Available: ${actions.map((candidate) => candidate.id).join(', ') || '(none)'}`); return action; }
function latestActiveRun(deps: ActionToolsDeps, workspace: string, actionId: string, sessionId: string): ActionRunSummary | undefined { return deps.runs.listRuns({ workspace, actionId, sessionId }).filter((run) => !isTerminal(run.status)).at(-1); }
function mapRunServiceError(error: unknown): never { if (error instanceof RunServiceError) { const code: ActionToolErrorCode = error.code === 'shell-unavailable' ? 'shell-unavailable' : error.code === 'start-failed' ? 'start-failed' : error.code === 'disposed' ? 'disposed' : 'run-not-found'; throw new ActionToolError(code, error.message); } throw error; }
function mapStoreError(error: unknown): never { if (error instanceof ActionStoreError) { const code = error.code === 'already-exists' ? 'already-exists' : error.code === 'not-found' ? 'not-found' : error.code === 'stale-revision' ? 'stale-revision' : error.code === 'invalid-file' ? 'invalid-file' : 'invalid-entry'; throw new ActionToolError(code, error.message, error.issues); } throw error; }
function ownedInspection(deps: ActionToolsDeps, runId: string, sessionId: string): RunInspection { try { const value = deps.runs.inspect(runId); if (value.run.sessionId !== sessionId) throw new ActionToolError('run-not-found', `Unknown action run: ${runId}`); return value; } catch (error) { mapRunServiceError(error); } }
function publicInspection(value: RunInspection): unknown { return { ...value, action: agentAction(value.action) }; }
function text(value: string): TextBlockLike[] { return [{ type: 'text', text: value }]; }
function renderJson(value: unknown): TextBlockLike[] { return text(JSON.stringify(value, null, 2)); }
function paramsEqual(left: Record<string, string> | undefined, right: Record<string, string>): boolean { const given = left ?? {}; return [...new Set([...Object.keys(given), ...Object.keys(right)])].every((key) => (given[key] ?? '') === (right[key] ?? '')); }
function conflictPrecheck(deps: ActionToolsDeps, action: ProjectActionSummary, sessionId: string, values: Record<string, string>): RunStartResult | undefined { const limit = Number.isFinite(action.runOptions.instanceLimit) ? Math.max(1, Math.floor(action.runOptions.instanceLimit)) : 1; const active = deps.runs.listRuns({ sessionId, actionId: action.id }).filter((run) => !isTerminal(run.status) && paramsEqual(run.params, values)); const existing = active.at(-1); if (!existing || active.length < limit) return undefined; return action.runOptions.instancePolicy === 'reject' ? { kind: 'rejected', reason: 'exclusive', run: existing } : { kind: 'already-running', run: existing }; }
function enrichParamsError(message: string, action: ProjectActionSummary): string { const inputs = action.inputs ?? []; return inputs.length === 0 ? message : `${message} Declared inputs: ${inputs.map((input) => `${input.id}${input.required ? ' (required)' : ''}`).join(', ')}.`; }
async function requestRunApproval(deps: ActionToolsDeps, action: ProjectActionSummary, values: Record<string, string>, exec: ToolRunContextLike, agent: ToolAgentLike, retry?: { runId: string; justification: string }): Promise<Extract<RunStartResult, { kind: 'approval-declined' }> | undefined> {
  if (!deps.approval || !deps.sandboxPolicy) return { kind: 'approval-declined', actionId: action.id, outcome: 'unavailable' };
  const outcome = await deps.approval.request({
    agent, toolName: 'actions_run',
    ...(exec.callId === undefined ? {} : { callId: exec.callId }),
    reason: `运行项目任务「${action.label}」（${action.id}）\n命令：${action.command}\n目录：${action.cwd}\n权限：danger-full-access，仅本次运行使用 Host 本机用户权限，绕过 DSH 文件沙箱；不改变会话权限，不绕过操作系统权限。${Object.keys(values).length ? `\n参数：${Object.entries(values).map(([key, value]) => `${key}=${value}`).join(', ')}` : ''}${retry ? `\n重试原运行：${retry.runId}\n原因：${retry.justification}\n将重新执行整个 Action；原运行可能已产生部分副作用。` : ''}`,
    ...(exec.signal === undefined ? {} : { signal: exec.signal }),
  });
  if (exec.signal?.aborted) return { kind: 'approval-declined', actionId: action.id, outcome: 'cancelled' };
  return outcome === 'allowed-once' ? undefined : { kind: 'approval-declined', actionId: action.id, outcome };
}

const LAYER_SCHEMA = { type: 'string', enum: ['global', 'workspace', 'session'] } as const;

function createQueryTool(deps: ActionToolsDeps): ToolDefinitionLike {
  return { name: 'actions_query', description: 'Read Actions and session-owned runs from the current session workspace—the same catalog shown in its Actions panel. Omit selector (or use kind "catalog") for visible summaries. Use kind "action" for one effective definition; view "layers" returns agent-visible raw entries and revisions from independent global/workspace/session sources and is required before configuration changes. Use kind "run" with a runId for status and retained output; offset is a UTF-8 byte offset and the response contains nextOffset/truncated metadata. This tool never starts, cancels, or modifies anything, and never exposes another session\'s runs.', parameters: { type: 'object', properties: { selector: { oneOf: [{ type: 'object', properties: { kind: { const: 'catalog' } }, required: ['kind'], additionalProperties: false }, { type: 'object', properties: { kind: { const: 'action' }, actionId: { type: 'string' }, view: { type: 'string', enum: ['effective', 'layers'] } }, required: ['kind', 'actionId'], additionalProperties: false }, { type: 'object', properties: { kind: { const: 'run' }, runId: { type: 'string' }, offset: { type: 'number', minimum: 0 } }, required: ['kind', 'runId'], additionalProperties: false }] } }, additionalProperties: false }, output: { schema: { type: 'object' }, render: (_args, value) => renderJson(value) }, isConcurrencySafe: () => true,
    async execute(args, exec) {
      const record = asRecord(args); const workspace = resolveWorkspace(exec); const selector = record.selector === undefined ? { kind: 'catalog' } : asRecord(record.selector); const kind = selector.kind;
      if (kind === 'catalog') { const loaded = await deps.catalog.loadCatalog(workspace, exec.agent?.id); const actions = loaded.actions.filter((action) => action.agentVisible !== false); return { workspace, sources: loaded.sources.filter((source) => source.errors.length > 0).map((source) => ({ layer: source.layer, ...(source.folder === undefined ? {} : { folder: source.folder }), errors: source.errors })), actions: actions.map((action: AgentActionView) => { const active = exec.agent ? latestActiveRun(deps, workspace, action.id, exec.agent.id) : undefined; const result: Record<string, unknown> = { id: action.id, label: action.label, sourceLayer: action.sourceLayer, approval: action.approval, status: active?.status ?? 'idle' }; if (action.detail) result.detail = action.detail; if (active) result.runId = active.id; if (action.inputs?.length) result.inputs = action.inputs.map((input) => ({ id: input.id, type: input.type, required: input.required === true, ...(input.description === undefined ? {} : { description: input.description }), ...(input.default === undefined ? {} : { default: input.default }), ...(input.options === undefined ? {} : { options: input.options }) })); return result; }) }; }
      if (kind === 'run') { const agent = requireSessionAgent(exec); const runId = requiredString(selector, 'runId'); const inspection = ownedInspection(deps, runId, agent.id); if (inspection.action.agentVisible === false || (await deps.catalog.loadCatalog(workspace, agent.id)).actions.some((action) => action.id === inspection.action.id && action.agentVisible === false)) throw new ActionToolError('run-not-found', `Unknown action run: ${runId}`); const offset = optionalOffset(selector); return offset === undefined ? { ...inspection, action: agentAction(inspection.action) } : { ...inspection, action: agentAction(inspection.action), output: deps.runs.readOutput(runId, offset) }; }
      if (kind !== 'action') throw new ActionToolError('invalid-arguments', 'selector.kind must be catalog, action, or run.');
      const actionId = requiredString(selector, 'actionId'); const action = findVisibleAction(await visibleActions(deps, workspace, exec.agent?.id), actionId); const runs = exec.agent ? deps.runs.listRuns({ workspace, actionId, sessionId: exec.agent.id }) : []; const latest = runs.at(-1); const result: Record<string, unknown> = { workspace, action: agentAction(action), latestRun: latest ? publicInspection(ownedInspection(deps, latest.id, exec.agent!.id)) : null };
      if (selector.view === 'layers') { if (action.sourceLayer === 'folder') throw new ActionToolError('invalid-arguments', 'Folder actions are repository-owned and do not have configurable layered entries.'); const agent = requireSessionAgent(exec); if (!deps.actionLayers) throw new ActionToolError('shell-unavailable', 'Action layer store is not wired.'); const hiddenIds = new Set((await deps.catalog.loadCatalog(workspace, agent.id)).actions.filter((entry) => entry.agentVisible === false).map((entry) => entry.id)); const layers = (await Promise.all((['global', 'workspace', 'session'] as const).map(async (layer) => { const snapshot = await deps.actionLayers!.inspect(layer, action.label, workspace, agent.id); return snapshot.entry && (!rawAgentVisible(snapshot.entry) || hiddenIds.has(`${layer}:${action.label}`)) ? null : { layer, ...snapshot }; }))).filter((entry) => entry !== null); result.layers = layers; result.provenance = { definition: action.sourceLayer }; }
      return result;
    } };
}

function createRunTool(deps: ActionToolsDeps): ToolDefinitionLike {
  return {
    name: 'actions_run',
    description: 'Start an Action returned by actions_query using actionId and optional params. There are no pinned session parameters. approval agent/always requests one combined run and danger-full-access approval; approval=never inherits the session sandbox. To retry a failed session-owned run with one-time elevated approval, pass retryRunId and justification instead of actionId/params. Inspect output and partial side effects first. Retry reuses the original evaluated command/cwd/env/params snapshot, not the current catalog. Rejected approval must not be bypassed. Never implicitly stops active runs. wait is capped at 60 seconds.',
    parameters: {
      type: 'object',
      properties: {
        actionId: { type: 'string', description: 'Action id returned by actions_query; mutually exclusive with retryRunId.' },
        params: { type: 'object', additionalProperties: { type: 'string' }, description: 'Initial run inputs only.' },
        retryRunId: { type: 'string', description: 'Failed run owned by this session. Replays its snapshot after elevated approval.' },
        justification: { type: 'string', description: 'Why this failed run needs wider access; required with retryRunId.' },
        wait: { type: 'boolean', description: 'Wait up to 60 seconds for terminal status.' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_args, value) => renderJson(value) },
    async execute(args, exec) {
      const record = asRecord(args);
      const agent = requireSessionAgent(exec);
      const workspace = resolveWorkspace(exec);
      const retryRunId = optionalString(record, 'retryRunId');
      let action: ProjectActionSummary;
      let values: Record<string, string>;
      let retry: { runId: string; justification: string } | undefined;
      if (retryRunId !== undefined) {
        if (record.actionId !== undefined || record.params !== undefined) throw new ActionToolError('invalid-arguments', 'retryRunId cannot be combined with actionId or params.');
        const justification = requiredString(record, 'justification');
        if (!justification.trim()) throw new ActionToolError('invalid-arguments', 'justification must explain why wider access is needed.');
        const original = ownedInspection(deps, retryRunId, agent.id);
        if (original.run.workspace !== workspace) throw new ActionToolError('run-not-found', `Unknown action run: ${retryRunId}`);
        if (original.run.status !== 'failed') throw new ActionToolError('invalid-arguments', 'Only failed runs may be retried with elevated approval.');
        if (original.action.agentVisible === false) throw new ActionToolError('action-not-found', 'UI-only runs cannot be retried by an Agent.');
        if (original.run.sandboxMode === 'danger-full-access') throw new ActionToolError('invalid-arguments', 'This run already used full access; inspect the actual failure instead of escalating again.');
        action = structuredClone(original.action);
        values = { ...original.run.params };
        retry = { runId: retryRunId, justification };
      } else {
        if (record.justification !== undefined) throw new ActionToolError('invalid-arguments', 'justification requires retryRunId.');
        const definition = structuredClone(findVisibleAction(await visibleActions(deps, workspace, agent.id), requiredString(record, 'actionId')));
        if (definition.extends) throw new ActionToolError('unknown-extends', `Action "${definition.label}" extends unknown action "${definition.extends}".`);
        try { values = normalizeParams(definition.inputs, optionalStringMap(record, 'params')).values; }
        catch (error) { throw new ActionToolError('invalid-params', enrichParamsError(`Action "${definition.label}": ${error instanceof Error ? error.message : String(error)}`, definition)); }
        action = structuredClone(evaluateAction(definition, workspace, values));
      }
      const maybeWait = async (result: RunStartResult): Promise<RunStartResult> => {
        if (record.wait !== true || (result.kind !== 'started' && result.kind !== 'already-running')) return result;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const settled = await Promise.race([deps.runs.waitForSettled(result.run.id), new Promise<ActionRunSummary>((resolve) => { timer = setTimeout(() => resolve(deps.runs.inspect(result.run.id).run), 60_000); })]);
          return { ...result, run: settled };
        } finally { clearTimeout(timer); }
      };
      const conflict = conflictPrecheck(deps, action, agent.id, values);
      if (conflict) return maybeWait(conflict);
      const elevated = retry !== undefined || action.approval !== 'never';
      if (elevated) {
        const declined = await requestRunApproval(deps, action, values, exec, agent, retry);
        if (declined) return declined;
      }
      if (exec.signal?.aborted) return { kind: 'approval-declined', actionId: action.id, outcome: 'cancelled' };
      const options: RunRequestOptions = { workspace, sessionId: agent.id, owner: agent, params: values, evaluatedSnapshot: true };
      const policy = deps.sandboxPolicy?.resolve({ session: agent.session, ...(elevated ? { mode: 'danger-full-access' as const } : {}) });
      if (elevated && policy?.mode !== 'danger-full-access') return { kind: 'approval-declined', actionId: action.id, outcome: 'unavailable' };
      if (policy) options.sandboxPolicy = policy;
      if (retry) options.retryOf = retry.runId;
      if (action.folder && !isInsideOrEqual(workspace, action.folder)) options.sandboxRoot = action.folder;
      try { return await maybeWait(await deps.runs.run(action, options)); }
      catch (error) {
        if (error instanceof RunServiceError && error.code === 'start-failed' && error.runId) {
          try { return { kind: 'started', run: ownedInspection(deps, error.runId, agent.id).run }; }
          catch { /* A zero-retention deployment may already have evicted it. */ }
        }
        mapRunServiceError(error);
      }
    },
  };
}

function createCancelTool(deps: ActionToolsDeps): ToolDefinitionLike { return { name: 'actions_cancel', description: 'Request cancellation of a run owned by the calling session. Use a runId returned by actions_run or actions_query. Calling it for a finished run is safe and returns the final summary. It cannot cancel another session, start a replacement run, or delete retained output.', parameters: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'], additionalProperties: false }, output: { schema: { type: 'object' }, render: (_args, value) => renderJson(value) }, async execute(args, exec) { const agent = requireSessionAgent(exec); const runId = requiredString(asRecord(args), 'runId'); ownedInspection(deps, runId, agent.id); try { return deps.runs.cancel(runId, 'actions_cancel tool call'); } catch (error) { mapRunServiceError(error); } } }; }

function parseLayer(record: Record<string, unknown>): ConfigurableActionLayer { const layer = requiredString(record, 'layer'); if (layer !== 'global' && layer !== 'workspace' && layer !== 'session') throw new ActionToolError('invalid-arguments', 'layer must be global, workspace, or session.'); return layer; }
function parseDefinition(value: unknown): ActionEntryConfig { if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ActionToolError('invalid-arguments', 'definition must be an Action object.'); const entry = value as ActionEntryConfig; const issues = validateActionEntryConfig(entry); if (issues.length) throw new ActionToolError('invalid-entry', 'Invalid Action definition.', issues); return entry; }
function parseChanges(value: unknown): ActionChange[] { if (!Array.isArray(value) || value.length === 0) throw new ActionToolError('invalid-arguments', 'changes must be a non-empty array.'); return value as ActionChange[]; }
function idParts(actionId: string, layer: ConfigurableActionLayer): string { const prefix = `${layer}:`; if (!actionId.startsWith(prefix) || actionId.length === prefix.length) throw new ActionToolError('invalid-arguments', `actionId must identify the target raw layer (${prefix}<label>).`); return actionId.slice(prefix.length); }
async function configureApproval(deps: ActionToolsDeps, exec: ToolRunContextLike, agent: ToolAgentLike, reason: string): Promise<ApprovalOutcomeLike> { if (!deps.approval) return 'unavailable'; return deps.approval.request({ agent, toolName: 'actions_configure', ...(exec.callId === undefined ? {} : { callId: exec.callId }), reason, ...(exec.signal === undefined ? {} : { signal: exec.signal }) }); }

function createConfigureTool(deps: ActionToolsDeps): ToolDefinitionLike { return { name: 'actions_configure', description: 'Create, update, or delete one raw Action definition in an explicit global, workspace, or session layer of the current session workspace—the same catalog shown in its Actions panel. The tool cannot target another workspace or session. Editing files in a nested repository does not change the current workspace. All writes require user approval. Create reads the target layer after approval, fails on label collision, and never upserts. Before update/delete, call actions_query with selector kind "action" and view "layers" to obtain the target entry revision; update/delete fail unless that raw layer entry exists. Updates use typed changes and never write a merged effective definition back. Labels cannot be renamed. Delete removes only the target source entry; same-label entries in other sources are independent. This tool does not manage folders or session parameters, does not execute Actions, and configuration approval never authorizes a run. Do not persist secrets in defaults or env.', parameters: { type: 'object', properties: { operation: { type: 'string', enum: ['create', 'update', 'delete'] }, layer: LAYER_SCHEMA, definition: { type: 'object' }, actionId: { type: 'string' }, expectedRevision: { type: 'string' }, changes: { type: 'array', items: { type: 'object' } }, acknowledgeFallback: { type: 'boolean', description: 'Deprecated compatibility parameter; ignored. Sources are independent.' } }, required: ['operation', 'layer'], additionalProperties: false }, output: { schema: { type: 'object' }, render: (_args, value) => renderJson(value) },
  async execute(args, exec) { const record = asRecord(args); const agent = requireSessionAgent(exec); const workspace = resolveWorkspace(exec); const layer = parseLayer(record); const operation = requiredString(record, 'operation'); const store = deps.actionLayers; if (!store) throw new ActionToolError('shell-unavailable', 'Action layer store is not wired.'); try {
    if (operation === 'create') { const definition = parseDefinition(record.definition); const preview = { operation, layer, definition }; const outcome = await configureApproval(deps, exec, agent, `创建 ${layer} 层 Action「${definition.label}」\n${JSON.stringify(preview, null, 2)}`); if (outcome !== 'allowed-once') return { configured: false, reason: 'approval-declined', outcome }; const result = await store.create(layer, definition, workspace, agent.id); deps.notifyCatalogChanged?.(workspace); return { configured: true, operation, layer, actionId: `${layer}:${definition.label}`, ...result };
    }
    const actionId = requiredString(record, 'actionId'); const label = idParts(actionId, layer); const expectedRevision = requiredString(record, 'expectedRevision'); const snapshot = await store.inspect(layer, label, workspace, agent.id); if (!snapshot.entry) throw new ActionToolError('not-found', `Action "${label}" does not exist in the ${layer} layer.`); if (snapshot.entryRevision !== expectedRevision) throw new ActionToolError('stale-revision', 'Action definition changed since it was queried.');
    if (operation === 'update') { const changes = parseChanges(record.changes); const previewAfter = (await import('../config/action-store.js')).applyActionChanges(snapshot.entry, changes); const outcome = await configureApproval(deps, exec, agent, `修改 ${layer} 层 Action「${label}」\n原始定义：${JSON.stringify(snapshot.entry, null, 2)}\n修改后：${JSON.stringify(previewAfter, null, 2)}\nrevision: ${expectedRevision}`); if (outcome !== 'allowed-once') return { configured: false, reason: 'approval-declined', outcome }; const result = await store.update(layer, label, expectedRevision, changes, workspace, agent.id); deps.notifyCatalogChanged?.(workspace); return { configured: true, operation, layer, actionId, ...result };
    }
    if (operation !== 'delete') throw new ActionToolError('invalid-arguments', 'operation must be create, update, or delete.'); const outcome = await configureApproval(deps, exec, agent, `删除 ${layer} 层 Action「${label}」\n原始定义：${JSON.stringify(snapshot.entry, null, 2)}\nrevision: ${expectedRevision}`); if (outcome !== 'allowed-once') return { configured: false, reason: 'approval-declined', outcome }; const result = await store.delete(layer, label, expectedRevision, workspace, agent.id); deps.notifyCatalogChanged?.(workspace); return { configured: true, operation, layer, actionId, ...result };
  } catch (error) { if (error instanceof ActionToolError) throw error; mapStoreError(error); } } }; }

export function createActionToolDefinitions(deps: ActionToolsDeps): ToolDefinitionLike[] { return [createQueryTool(deps), createRunTool(deps), createCancelTool(deps), createConfigureTool(deps)]; }
export function registerActionTools(tools: ToolsLike, deps: ActionToolsDeps): () => void { const disposers = createActionToolDefinitions(deps).map((definition) => tools.register(definition)); return () => { for (const dispose of disposers) dispose(); }; }
