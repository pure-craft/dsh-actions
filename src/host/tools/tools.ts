/**
 * Agent tools: `actions_list` / `actions_run` / `actions_inspect` /
 * `actions_cancel` / `actions_set_params` / `actions_register`,
 * registered through `ctx.tools.register`.
 *
 * Design source: docs/v1-goals.md (deliverable 6). Progressive disclosure:
 * `actions_list` returns only summaries, `actions_inspect` reveals the full
 * definition plus captured output. `actions_run` returns the structured
 * conflict-protocol outcome and never interrupts an active instance
 * implicitly. The agent entry only sees `visibility: all | agent` actions.
 *
 * The workspace resolves from the calling session (`ToolRunContext.agent →
 * session.header.cwd`, the same path the built-in bash tool uses); when it
 * cannot be resolved the caller must pass the `workspace` parameter.
 *
 * Session binding (T15): run state is scoped to the calling session
 * (`exec.agent.id`). An explicit `workspace` argument only retargets which
 * workspace's configuration is read — it never widens the runtime scope.
 * Agentless calls may list definitions (run state reports `idle`), but
 * run/inspect/cancel are rejected.
 */

import type { ActionEntryConfig, ActionRunSummary, ActionsCatalog, AgentActionView, ProjectActionSummary, RunStartResult } from '../../contract.js';
import { validateActionEntryConfig } from '../../wire.js';
import { RunServiceError } from '../run/service.js';
import { evaluateAction } from '../run/service.js';
import type { RunInspection, RunService, SandboxExecutionPolicyLike } from '../run/service.js';
import type { SessionParamStore } from '../run/session-params.js';
import { normalizeParams } from '../config/params.js';

// ---------------------------------------------------------------------------
// Structural mirrors of the DSH host `tools` service surface we consume
// ---------------------------------------------------------------------------

export interface TextBlockLike {
  type: 'text';
  text: string;
}

export interface ToolAgentLike {
  readonly id: string;
  readonly session?: { readonly header?: { readonly cwd?: string | undefined } | undefined } | undefined;
}

export interface ToolRunContextLike {
  readonly agent?: ToolAgentLike | undefined;
  /** Correlation id of this tool call (forwarded to approval requests). */
  readonly callId?: string | undefined;
  /** Live cancellation signal of the tool call (forwarded to approval requests). */
  readonly signal?: AbortSignal | undefined;
}

export interface ToolOutputDefinitionLike {
  readonly schema: Record<string, unknown>;
  render(args: unknown, value: unknown): TextBlockLike[];
}

export interface ToolDefinitionLike {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly output: ToolOutputDefinitionLike;
  execute(args: unknown, exec: ToolRunContextLike): Promise<unknown>;
  isConcurrencySafe?(args: unknown): boolean;
}

/** Mirrors the subset of `ctx.tools` the registration helper consumes. */
export interface ToolsLike {
  register(definition: ToolDefinitionLike): () => void;
}

// ---------------------------------------------------------------------------
// Dependencies and errors
// ---------------------------------------------------------------------------

/** Normalized catalog source; wired to the T2 loader by the composition layer. */
export interface ActionCatalogProvider {
  loadCatalog(workspace: string, sessionId?: string): Promise<ActionsCatalog>;
}

/**
 * Mirrors `ctx.sandboxPolicy`: resolves the sandbox policy of the calling
 * session (same pattern as the built-in bash tool:
 * `ctx.get('sandboxPolicy').resolve({ session: exec.agent.session })`).
 */
export interface SandboxPolicyResolverLike {
  resolve(scope: { session?: unknown }): SandboxExecutionPolicyLike | undefined;
}

/**
 * Mirrors `ctx.approval` (dsh-user-approval): one readonly same-process ask
 * per call. `'allowed-once'` is the only grant; every other outcome declines.
 */
export type ApprovalOutcomeLike = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';

export interface ApprovalServiceLike {
  request(request: {
    agent: ToolAgentLike;
    toolName: string;
    callId?: string | undefined;
    reason?: string | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<ApprovalOutcomeLike>;
}

export interface ActionToolsDeps {
  catalog: ActionCatalogProvider;
  runs: RunService;
  /** Session sandbox policy resolver; when absent, runs fall back to the shell's deployment default. */
  sandboxPolicy?: SandboxPolicyResolverLike | undefined;
  /**
   * Approval service (T29). Actions with `approval: agent|always` ask through
   * it before starting; when absent, such actions fail closed as
   * `approval-declined: unavailable` — the gate is never skipped silently.
   */
  approval?: ApprovalServiceLike | undefined;
  /**
   * Session pin board (T38): actions_run falls back to pinned values when
   * the call passes no explicit params; actions_set_params manages the pins.
   */
  sessionParams?: SessionParamStore | undefined;
  /** T47: session-layer writer backing actions_register. */
  sessionActions?: SessionActionWriterLike | undefined;
  /** T47: republish catalog frames after a session-layer write. */
  notifyCatalogChanged?: ((workspace: string) => void) | undefined;
}

/** T47: writes one entry into the session layer's actions file. */
export interface SessionActionWriterLike {
  write(sessionId: string, workspace: string, entry: ActionEntryConfig): Promise<{ path: string }>;
}

export type ActionToolErrorCode =
  | 'invalid-arguments'
  | 'workspace-unresolved'
  | 'action-not-found'
  | 'run-not-found'
  | 'shell-unavailable'
  | 'start-failed'
  | 'disposed'
  | 'session-required'
  | 'invalid-params'
  | 'unknown-extends';

export class ActionToolError extends Error {
  override readonly name = 'ActionToolError';

  constructor(
    readonly code: ActionToolErrorCode,
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function asRecord(args: unknown): Record<string, unknown> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new ActionToolError('invalid-arguments', 'Tool arguments must be an object.');
  }
  return args as Record<string, unknown>;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new ActionToolError('invalid-arguments', `Argument "${key}" must be a non-empty string.`);
  }
  return value;
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = optionalString(args, key);
  if (value === undefined) {
    throw new ActionToolError('invalid-arguments', `Missing required argument "${key}".`);
  }
  return value;
}

/** Optional string-valued object argument (T33 `params`, T38 `values`). */
function optionalStringMap(args: Record<string, unknown>, field: string): Record<string, string> | undefined {
  const value = args[field];
  if (value === undefined) return undefined;
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !Object.values(value).every((entry) => typeof entry === 'string')
  ) {
    throw new ActionToolError('invalid-arguments', `Argument "${field}" must be an object with string values.`);
  }
  return value as Record<string, string>;
}

/**
 * T33: enrich a params failure with the action's declared inputs so the
 * agent can self-correct and resend.
 */
function enrichParamsError(message: string, action: ProjectActionSummary): string {
  const inputs = action.inputs ?? [];
  if (inputs.length === 0) return message;
  const lines = inputs.map(
    (input) =>
      `- ${input.id} (${input.required === true ? 'required' : 'optional'})${input.description === undefined ? '' : `: ${input.description}`}`,
  );
  return `${message}\nDeclared inputs:\n${lines.join('\n')}`;
}

function optionalOffset(args: Record<string, unknown>): number | undefined {
  const value = args.offset;
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ActionToolError('invalid-arguments', 'Argument "offset" must be a non-negative finite number.');
  }
  return value;
}

function resolveWorkspace(args: Record<string, unknown>, exec: ToolRunContextLike): string {
  const explicit = optionalString(args, 'workspace');
  if (explicit !== undefined) return explicit;
  const cwd = exec.agent?.session?.header?.cwd;
  if (typeof cwd === 'string' && cwd.length > 0) return cwd;
  throw new ActionToolError(
    'workspace-unresolved',
    'Could not resolve the calling session workspace; pass the "workspace" argument explicitly.',
  );
}

function isTerminal(status: ActionRunSummary['status']): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

/**
 * The agent entry sees `all` and `agent` actions; `ui`-only actions stay
 * panel-exclusive. T47: a known session merges its own session layer.
 */
async function visibleActions(
  deps: ActionToolsDeps,
  workspace: string,
  sessionId?: string,
): Promise<ProjectActionSummary[]> {
  const catalog = await deps.catalog.loadCatalog(workspace, sessionId);
  return catalog.actions.filter((action) => action.visibility !== 'ui');
}

function findVisibleAction(actions: ProjectActionSummary[], actionId: string): ProjectActionSummary {
  const action = actions.find((candidate) => candidate.id === actionId);
  if (action === undefined) {
    const available = actions.map((candidate) => candidate.id).join(', ') || '(none)';
    throw new ActionToolError('action-not-found', `Unknown or agent-invisible action "${actionId}". Available: ${available}`);
  }
  return action;
}

/**
 * T15: the runtime scope of every run-state operation. Agentless callers have
 * no session — they may read definitions but never run state.
 */
function requireSessionAgent(exec: ToolRunContextLike): ToolAgentLike {
  const agent = exec.agent;
  if (agent === undefined) {
    throw new ActionToolError(
      'session-required',
      'Run state is session-scoped and this call has no agent session; only actions_list is available agentless.',
    );
  }
  return agent;
}

function latestActiveRun(
  deps: ActionToolsDeps,
  workspace: string,
  actionId: string,
  sessionId: string,
): ActionRunSummary | undefined {
  return deps.runs
    .listRuns({ workspace, actionId, sessionId })
    .filter((run) => !isTerminal(run.status))
    .at(-1);
}

function mapRunServiceError(error: unknown): never {
  if (error instanceof RunServiceError) {
    const code: ActionToolErrorCode =
      error.code === 'shell-unavailable'
        ? 'shell-unavailable'
        : error.code === 'start-failed'
          ? 'start-failed'
          : error.code === 'disposed'
            ? 'disposed'
            : 'run-not-found';
    throw new ActionToolError(code, error.message);
  }
  throw error;
}

/**
 * T15: load a run only when the calling session owns it. Foreign ids read as
 * run-not-found — session ownership is not leaked.
 */
function ownedInspection(deps: ActionToolsDeps, runId: string, sessionId: string): RunInspection {
  try {
    const inspection = deps.runs.inspect(runId);
    if (inspection.run.sessionId !== sessionId) {
      throw new ActionToolError('run-not-found', `Unknown action run: ${runId}`);
    }
    return inspection;
  } catch (error) {
    mapRunServiceError(error);
  }
}

function text(value: string): TextBlockLike[] {
  return [{ type: 'text', text: value }];
}

/**
 * T29: gate an `approval: agent | always` action through `ctx.approval`
 * (same pattern as dsh-sandbox's approveEscalation: `'allowed-once'` is the
 * only grant; everything else declines). Returns the structured
 * `approval-declined` outcome — distinct from the conflict protocol's
 * `rejected` — or undefined when the run may proceed.
 *
 * T37: the ask carries the FULLY EVALUATED command, cwd, and params — the
 * user consents to the real command line, never to a `${input}` template.
 */
async function requestRunApproval(
  deps: ActionToolsDeps,
  action: ProjectActionSummary,
  evaluated: ProjectActionSummary,
  values: Record<string, string>,
  exec: ToolRunContextLike,
  agent: ToolAgentLike,
): Promise<Extract<RunStartResult, { kind: 'approval-declined' }> | undefined> {
  if (action.approval === 'never') return undefined;
  const approval = deps.approval;
  if (approval === undefined) {
    // Fail closed: a gated action without an approval channel must not start.
    return { kind: 'approval-declined', actionId: action.id, outcome: 'unavailable' };
  }
  const paramText =
    Object.keys(values).length > 0
      ? `\n参数：${Object.entries(values)
          .map(([key, value]) => `${key}=${value}`)
          .join(', ')}`
      : '';
  const outcome = await approval.request({
    agent,
    toolName: 'actions_run',
    callId: exec.callId,
    reason: `运行项目任务「${action.label}」（${action.id}）\n命令：${evaluated.command}\n目录：${evaluated.cwd}${paramText}`,
    signal: exec.signal,
  });
  if (outcome === 'allowed-once') return undefined;
  return { kind: 'approval-declined', actionId: action.id, outcome };
}

function paramsEqual(left: Record<string, string> | undefined, right: Record<string, string>): boolean {
  const given = left ?? {};
  const keys = new Set([...Object.keys(given), ...Object.keys(right)]);
  for (const key of keys) {
    if ((given[key] ?? '') !== (right[key] ?? '')) return false;
  }
  return true;
}

/**
 * T37: lightweight conflict precheck so an already-running / exclusive
 * rejection never triggers an approval prompt. RunService.run repeats the
 * check authoritatively in its synchronous section — a race here only
 * wastes nothing: run() still returns the structured conflict outcome.
 */
function conflictPrecheck(
  deps: ActionToolsDeps,
  action: ProjectActionSummary,
  sessionId: string,
  values: Record<string, string>,
): RunStartResult | undefined {
  const rawLimit = action.runOptions.instanceLimit;
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.floor(rawLimit)) : 1;
  const active = deps.runs
    .listRuns({ sessionId, actionId: action.id })
    .filter((run) => !isTerminal(run.status) && paramsEqual(run.params, values));
  const existing = active.at(-1);
  if (existing === undefined || active.length < limit) return undefined;
  if (action.runOptions.instancePolicy === 'reject') {
    return { kind: 'rejected', reason: 'exclusive', run: existing };
  }
  return { kind: 'already-running', run: existing };
}

function renderJson(value: unknown): TextBlockLike[] {
  return text(JSON.stringify(value, null, 2));
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const WORKSPACE_PARAMETER = {
  type: 'string',
  description:
    'Absolute workspace root. Optional when the calling session has a cwd; required otherwise.',
} as const;

function createListTool(deps: ActionToolsDeps): ToolDefinitionLike {
  return {
    name: 'actions_list',
    description:
      'List project actions discovered from .dsh/actions.json (global + workspace layers). ' +
      'Returns summaries only — id, label, detail, source layer, approval requirement, and current run status. ' +
      'Run status is scoped to your own session; other sessions may run the same action concurrently. ' +
      'Use actions_run with an id to start one, actions_inspect for the full definition or run output.',
    parameters: {
      type: 'object',
      properties: { workspace: WORKSPACE_PARAMETER },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => {
        const result = value as { workspace: string; actions: Array<{ id: string; label: string; status: string }> };
        if (result.actions.length === 0) return text(`No project actions in ${result.workspace}.`);
        const lines = result.actions.map((action) => `- ${action.label} (${action.id}) — ${action.status}`);
        return text(`Project actions in ${result.workspace}:\n${lines.join('\n')}`);
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const record = asRecord(args);
      const workspace = resolveWorkspace(record, exec);
      const actions = await visibleActions(deps, workspace, exec.agent?.id);
      // T15: run state only from the caller's own session; agentless callers
      // get definitions with an empty (idle) run state.
      const sessionId = exec.agent?.id;
      return {
        workspace,
        actions: actions.map((action: AgentActionView) => {
          const active = sessionId === undefined ? undefined : latestActiveRun(deps, workspace, action.id, sessionId);
          const entry: Record<string, unknown> = {
            id: action.id,
            label: action.label,
            sourceLayer: action.sourceLayer,
            status: active?.status ?? 'idle',
            // T29: surface the approval cost before the agent decides to run.
            approval: action.approval,
          };
          if (action.detail !== undefined) entry.detail = action.detail;
          if (active !== undefined) entry.runId = active.id;
          // T33: surface declared inputs so the agent can supply values up front.
          if (action.inputs !== undefined && action.inputs.length > 0) {
            entry.inputs = action.inputs.map((input) => {
              const summary: Record<string, unknown> = { id: input.id, required: input.required === true };
              if (input.description !== undefined) summary.description = input.description;
              if (input.type === 'select' && input.options !== undefined) summary.options = input.options;
              return summary;
            });
          }
          return entry;
        }),
      };
    },
  };
}

function createRunTool(deps: ActionToolsDeps): ToolDefinitionLike {
  return {
    name: 'actions_run',
    description:
      'Start a project action by id (from actions_list). Returns a structured result: ' +
      '"started" (new instance launched), "already-running" (an identical instance is already active — no new one), ' +
      '"rejected" (the action is exclusive and an instance is active), or "approval-declined" (the action ' +
      'requires user approval and it was not granted — nothing was started; respect the decision and do not ' +
      'retry without new user intent). Run state is scoped to your session; another session may run the same ' +
      'action concurrently. This tool never stops an active instance implicitly: on already-running/rejected, ' +
      'watch output with actions_inspect, and stop only through an explicit actions_cancel call. ' +
      'When params are omitted, values pinned via actions_set_params apply (explicit params win).',
    parameters: {
      type: 'object',
      properties: {
        actionId: { type: 'string', description: 'Action id from actions_list (e.g. "workspace:build").' },
        params: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description:
            'Values for the action\'s declared inputs (see the inputs summary in actions_list). ' +
            'Missing required inputs fail with a structured error listing what to provide.',
        },
        workspace: WORKSPACE_PARAMETER,
      },
      required: ['actionId'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => {
        const result = value as RunStartResult;
        if (result.kind === 'started') return text(`Started ${result.run.id} (${result.run.status}).`);
        if (result.kind === 'already-running') {
          return text(`Already running as ${result.run.id} (${result.run.status}); no new instance was started.`);
        }
        if (result.kind === 'approval-declined') {
          return text(`Approval ${result.outcome}: the action was not started.`);
        }
        return text(`Rejected: action is exclusive and ${result.run.id} is still active.`);
      },
    },
    async execute(args, exec) {
      const record = asRecord(args);
      // T15: starting runs is session-bound; agentless calls are rejected.
      const agent = requireSessionAgent(exec);
      const actionId = requiredString(record, 'actionId');
      const params = optionalStringMap(record, 'params');
      const workspace = resolveWorkspace(record, exec);
      const action = findVisibleAction(await visibleActions(deps, workspace, agent.id), actionId);
      // T47: an extends reference that stayed unresolved at load errors at run.
      if (action.extends !== undefined) {
        throw new ActionToolError(
          'unknown-extends',
          `Action "${action.label}" extends unknown action "${action.extends}". Register or define it first.`,
        );
      }
      // T37 order (supersedes the earlier approval-first design): evaluate
      // params FIRST — invalid values answer invalid-params with NO approval
      // prompt; then a lightweight conflict precheck — already-running /
      // exclusive rejections answer with NO prompt either. Approval is asked
      // LAST, with the fully evaluated command/cwd/params in the reason.
      // RunService.run repeats every step authoritatively; these prechecks
      // only avoid pointless prompts (a lost race surfaces as the same
      // structured conflict outcome from run()).
      let normalized;
      try {
        // T38: three-level chain — explicit call params > session pins >
        // config defaults. The merged map mirrors RunService.run's own
        // merge, so this evaluation matches the authoritative one exactly.
        const effective = { ...deps.sessionParams?.get(agent.id, actionId), ...params };
        normalized = normalizeParams(action.inputs, effective);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new ActionToolError('invalid-params', enrichParamsError(`Action "${action.label}": ${message}`, action));
      }
      const evaluated = evaluateAction(action, workspace, normalized.values);
      const conflict = conflictPrecheck(deps, action, agent.id, normalized.values);
      if (conflict !== undefined) return conflict;
      const declined = await requestRunApproval(deps, action, evaluated, normalized.values, exec, agent);
      if (declined !== undefined) return declined;
      const options: {
        workspace: string;
        sessionId: string;
        owner?: ToolAgentLike;
        sandboxPolicy?: SandboxExecutionPolicyLike;
        params?: Record<string, string>;
      } = {
        workspace,
        sessionId: agent.id,
        // Pass the real Agent through (S5): the jobs registry's owner fencing
        // and scope semantics rely on the object itself, not a synthetic {id}.
        owner: agent,
      };
      // Stamp the calling session's resolved sandbox policy (T8-B1); when no
      // resolver is wired, the run falls back to the shell deployment default.
      const sandboxPolicy = deps.sandboxPolicy?.resolve({ session: agent.session });
      if (sandboxPolicy !== undefined) options.sandboxPolicy = sandboxPolicy;
      // T38: pass the merged map down; RunService.run's own merge with the
      // pin board is then a no-op (explicit keys win identically).
      options.params = normalized.values;
      try {
        return await deps.runs.run(action, options);
      } catch (error) {
        // T33: params failures list the declared inputs so the agent can
        // self-correct and resend with values.
        if (error instanceof RunServiceError && error.code === 'invalid-params') {
          throw new ActionToolError('invalid-params', enrichParamsError(error.message, action));
        }
        mapRunServiceError(error);
      }
    },
  };
}

function createInspectTool(deps: ActionToolsDeps): ToolDefinitionLike {
  return {
    name: 'actions_inspect',
    description:
      'Show the full definition, current status, and captured output of an action run. ' +
      'Pass runId for a specific run, or actionId for the definition plus its latest run. ' +
      'Only runs owned by your session are visible. Use after actions_list/actions_run for details; ' +
      'list stays summary-only.',
    parameters: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'Run id from actions_run or actions_list.' },
        actionId: { type: 'string', description: 'Action id; inspects the action definition and its latest run.' },
        offset: { type: 'number', description: 'Byte offset to read output from (stream resume). Default: retained window.' },
        workspace: WORKSPACE_PARAMETER,
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => renderJson(value),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const record = asRecord(args);
      // T15: run state is session-scoped; agentless calls are rejected.
      const agent = requireSessionAgent(exec);
      const runId = optionalString(record, 'runId');
      const actionId = optionalString(record, 'actionId');
      const offset = optionalOffset(record);
      if (runId !== undefined) {
        const inspection = ownedInspection(deps, runId, agent.id);
        // T37: honor offset here too (was silently ignored; the actionId
        // branch and the RPC endpoint already support it).
        if (offset === undefined) return inspection;
        try {
          return { ...inspection, output: deps.runs.readOutput(runId, offset) };
        } catch (error) {
          mapRunServiceError(error);
        }
      }
      if (actionId === undefined) {
        throw new ActionToolError('invalid-arguments', 'Pass either "runId" or "actionId".');
      }
      const workspace = resolveWorkspace(record, exec);
      const action = findVisibleAction(await visibleActions(deps, workspace, agent.id), actionId);
      const runs = deps.runs.listRuns({ workspace, actionId, sessionId: agent.id });
      const latest = runs.at(-1);
      if (latest === undefined) {
        return { action, run: null, output: null };
      }
      const inspection = ownedInspection(deps, latest.id, agent.id);
      try {
        return offset === undefined
          ? inspection
          : { action, run: inspection.run, output: deps.runs.readOutput(latest.id, offset) };
      } catch (error) {
        mapRunServiceError(error);
      }
    },
  };
}

function createCancelTool(deps: ActionToolsDeps): ToolDefinitionLike {
  return {
    name: 'actions_cancel',
    description:
      'Stop a running action instance by run id (only runs owned by your session). ' +
      'Safe on finished runs — returns the final summary. To "stop and rerun", cancel first, ' +
      'then call actions_run as a separate explicit step.',
    parameters: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'Run id from actions_run or actions_list.' },
      },
      required: ['runId'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => {
        const run = value as ActionRunSummary;
        return text(`Run ${run.id} is ${run.status}.`);
      },
    },
    async execute(args, exec) {
      const record = asRecord(args);
      // T15: cancellation is session-scoped; agentless calls are rejected and
      // foreign runs read as run-not-found (no implicit cross-session stop).
      const agent = requireSessionAgent(exec);
      const runId = requiredString(record, 'runId');
      ownedInspection(deps, runId, agent.id);
      try {
        return deps.runs.cancel(runId, 'actions_cancel tool call');
      } catch (error) {
        mapRunServiceError(error);
      }
    },
  };
}

function createSetParamsTool(deps: ActionToolsDeps): ToolDefinitionLike {
  return {
    name: 'actions_set_params',
    description:
      'Pin input values for an action on your session. Use before the first run: afterwards, actions_run ' +
      'without explicit params falls back to the pinned values (explicit params always win; pins satisfy ' +
      'required inputs). Values live only as long as the session. ' +
      'Call with { actionId, values } to pin, { actionId, clear: true } (or empty values) to unpin, or with no ' +
      'actionId to list every pin of your session. Values must be a subset of the action\'s declared inputs ' +
      '(see actions_list); select values are validated against their options.',
    parameters: {
      type: 'object',
      properties: {
        actionId: { type: 'string', description: 'Action id from actions_list. Omit to list all pins of this session.' },
        values: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Input values to pin (subset of declared inputs). An empty object unpins.',
        },
        clear: { type: 'boolean', description: 'true to unpin the action instead of pinning values.' },
        workspace: WORKSPACE_PARAMETER,
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => renderJson(value),
    },
    async execute(args, exec) {
      const record = asRecord(args);
      // T38: pins are session state; agentless calls are rejected.
      const agent = requireSessionAgent(exec);
      const store = deps.sessionParams;
      if (store === undefined) {
        throw new ActionToolError('shell-unavailable', 'Session params store is not wired.');
      }
      const actionId = optionalString(record, 'actionId');
      if (actionId === undefined) {
        return { sessionId: agent.id, sessionParams: store.list(agent.id) };
      }
      const workspace = resolveWorkspace(record, exec);
      const action = findVisibleAction(await visibleActions(deps, workspace, agent.id), actionId);
      const values = optionalStringMap(record, 'values');
      const wantsClear = record.clear === true || (values !== undefined && Object.keys(values).length === 0);
      if (wantsClear) {
        store.clear(agent.id, actionId);
        return { actionId, sessionParams: {} };
      }
      if (values === undefined) {
        throw new ActionToolError('invalid-arguments', 'Provide "values" to pin, or "clear": true to unpin.');
      }
      // Declaration validation at pin time (subset of declared inputs;
      // select values within options) — same rules as the RPC endpoint.
      const declared = new Map((action.inputs ?? []).map((input) => [input.id, input]));
      for (const [id, value] of Object.entries(values)) {
        const input = declared.get(id);
        if (input === undefined) {
          throw new ActionToolError(
            'invalid-params',
            enrichParamsError(`Unknown input parameter: ${id}`, action),
          );
        }
        if (input.type === 'select' && input.options !== undefined && !input.options.includes(value)) {
          throw new ActionToolError(
            'invalid-params',
            enrichParamsError(
              `Invalid value for select input "${id}": "${value}" (expected one of: ${input.options.join(', ')})`,
              action,
            ),
          );
        }
      }
      store.set(agent.id, actionId, values);
      return { actionId, sessionParams: store.get(agent.id, actionId) };
    },
  };
}

function createRegisterTool(deps: ActionToolsDeps): ToolDefinitionLike {
  return {
    name: 'actions_register',
    description:
      'Register a session-scoped action: writes a definition into your session\'s own layer ' +
      '(visible only to your session, winning over workspace/global entries with the same label) and returns ' +
      'its id (`session:<label>`) for actions_run. Use this to capture a workflow discovered mid-session. ' +
      'Registration always asks the user for approval first. ' +
      '"extends" may reference any action id visible in your session to inherit its cwd/env/inputs. ' +
      'On invalid input, returns a structured invalid-entry result with field-level issues you can fix and resend.',
    parameters: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Display name; same label replaces the existing session entry.' },
        command: { type: 'string', description: 'Shell command (may reference ${input:id} placeholders).' },
        detail: { type: 'string' },
        visibility: { type: 'string', enum: ['all', 'ui', 'agent'] },
        approval: { type: 'string', enum: ['never', 'agent', 'always'] },
        options: { type: 'object', description: '{ cwd?, env? } like the config file schema.' },
        inputs: { type: 'array', description: 'Declared inputs (id/type/description/required/default/options).' },
        runOptions: { type: 'object', description: '{ instanceLimit?, instancePolicy? }.' },
        presentation: { type: 'object', description: '{ panel? }.' },
        extends: { type: 'string', description: 'Existing action id to inherit from (visible in this session).' },
        params: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Also pin these input values on the session (validated against the declared inputs).',
        },
        workspace: WORKSPACE_PARAMETER,
      },
      required: ['label', 'command'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => renderJson(value),
    },
    async execute(args, exec) {
      const record = asRecord(args);
      // T47: the session layer is session state; agentless calls are rejected.
      const agent = requireSessionAgent(exec);
      const writer = deps.sessionActions;
      if (writer === undefined) {
        throw new ActionToolError('shell-unavailable', 'Session action store is not wired.');
      }
      const label = requiredString(record, 'label');
      const command = requiredString(record, 'command');
      const workspace = resolveWorkspace(record, exec);
      const entry: ActionEntryConfig = { label, command };
      // Optional fields pass through schema-validated by the wire parser below.
      for (const key of ['detail', 'visibility', 'approval', 'options', 'inputs', 'runOptions', 'presentation', 'extends'] as const) {
        const value = record[key];
        if (value !== undefined) Object.assign(entry, { [key]: value });
      }
      // T63b: schema validation answers a STRUCTURED invalid-entry result —
      // field-level issues let the agent self-correct and resend, instead of
      // a flat error string.
      const issues = validateActionEntryConfig(entry);
      if (issues.length > 0) {
        return { registered: false, reason: 'invalid-entry', label, issues };
      }
      const visible = await visibleActions(deps, workspace, agent.id);
      if (entry.extends !== undefined && !visible.some((candidate) => candidate.id === entry.extends)) {
        throw new ActionToolError(
          'unknown-extends',
          `"extends" must reference an action id visible in this session. Available: ${visible.map((candidate) => candidate.id).join(', ') || '(none)'}`,
        );
      }
      // Registration always asks: an agent-authored command is high-risk.
      const approval = deps.approval;
      if (approval === undefined) {
        return { registered: false, reason: 'approval-declined', outcome: 'unavailable', label };
      }
      const outcome = await approval.request({
        agent,
        toolName: 'actions_register',
        callId: exec.callId,
        reason: `注册会话级任务「${label}」\n命令：${command}${entry.extends === undefined ? '' : `\n继承自：${entry.extends}`}`,
        signal: exec.signal,
      });
      if (outcome !== 'allowed-once') {
        return { registered: false, reason: 'approval-declined', outcome, label };
      }
      const { path } = await writer.write(agent.id, workspace, entry);
      // Optional atomic pin: values validate against the entry's declared inputs.
      const params = optionalStringMap(record, 'params');
      if (params !== undefined && Object.keys(params).length > 0) {
        const declared = new Map((entry.inputs ?? []).map((input) => [input.id, input]));
        for (const [id, value] of Object.entries(params)) {
          const input = declared.get(id);
          if (input === undefined) {
            throw new ActionToolError('invalid-params', `Unknown input parameter: ${id} (the action was registered; fix the pin and retry)`);
          }
          if (input.type === 'select' && input.options !== undefined && !input.options.includes(value)) {
            throw new ActionToolError('invalid-params', `Invalid value for select input "${id}": "${value}"`);
          }
        }
        deps.sessionParams?.set(agent.id, `session:${label}`, params);
      }
      deps.notifyCatalogChanged?.(workspace);
      return { registered: true, actionId: `session:${label}`, path };
    },
  };
}

export function createActionToolDefinitions(deps: ActionToolsDeps): ToolDefinitionLike[] {
  return [
    createListTool(deps),
    createRunTool(deps),
    createInspectTool(deps),
    createCancelTool(deps),
    createSetParamsTool(deps),
    createRegisterTool(deps),
  ];
}

/** Register all six tools on the host `tools` service; returns a combined disposer. */
export function registerActionTools(tools: ToolsLike, deps: ActionToolsDeps): () => void {
  const disposers = createActionToolDefinitions(deps).map((definition) => tools.register(definition));
  return () => {
    for (const dispose of disposers) dispose();
  };
}
