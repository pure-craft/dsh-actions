/**
 * Actions API: authenticated command/query + streaming endpoints.
 *
 * All traffic rides the host `connection.fetch` channel (see
 * docs/v1-goals.md — the package-private `harness.handle`/`host.call` RPC is
 * reserved for dynamic-sandbox packages and unavailable to compiled bundles).
 * Routes are ordinary Fetch `Request`/`Response` handlers; authentication is
 * owned by the channel itself.
 *
 * Endpoints (all POST, JSON bodies unless noted):
 * - /api/dsh-actions/catalog        { workspace | sessionId }   -> ActionsCatalog
 * - /api/dsh-actions/runs           { sessionId, actionId }     -> RunStartResult
 * - /api/dsh-actions/runs/inspect   { sessionId, runId, offset? }      -> RunInspection
 * - /api/dsh-actions/runs/cancel    { sessionId, runId }        -> ActionRunSummary
 * - /api/dsh-actions/runs/forget    { sessionId, runId }        -> { forgotten }
 * - /api/dsh-actions/runs/stream    { sessionId, runId, sinceOffset? } -> NDJSON RunStreamFrame lines
 * - /api/dsh-actions/runs/events    { sessionId }               -> NDJSON RunDiscoveryFrame lines
 * - /api/dsh-actions/catalog/events { sessionId }               -> NDJSON CatalogEventFrame lines
 * - /api/dsh-actions/params         { sessionId, actionId, values? | clear:true } -> pinned values (T38)
 * - /api/dsh-actions/actions/delete { sessionId, actionId }     -> { deleted, actionId } (T50)
 *
 * Session binding (T15): run state is isolated per session. Starting a run
 * REQUIRES a sessionId whose session cwd resolves — never a workspace-derived
 * pseudo-scope; the run's workspace is always the session's own cwd.
 * inspect/cancel/stream require the sessionId and only serve runs owned by
 * that session (foreign ids answer 404, leaking nothing). The catalog
 * endpoint still reads configuration by workspace, but only attaches runs of
 * the caller's own resolvable session — never a cross-session view.
 */

import { ACTIONS_PLUGIN_ID } from '../../contract.js';
import type { ActionSourceLayer, ActionsCatalog, CatalogEventFrame, RunDiscoveryFrame, RunStreamFrame } from '../../contract.js';
import { RunServiceError } from '../run/service.js';
import type { RunInspection, RunService } from '../run/service.js';
import type { SessionParamStore } from '../run/session-params.js';

/** Structural mirror of the connection.fetch route shape the host consumes. */
export interface ConnectionFetchRouteLike {
  readonly path: string;
  readonly methods: readonly ('GET' | 'HEAD' | 'POST')[];
  readonly requestBody: 'buffered' | 'streaming';
  readonly fetch: (request: Request) => Promise<Response>;
}

export interface ActionsApiDeps {
  /** Fresh catalog load per call: configuration may change between requests. sessionId adds the session layer (T47). */
  loadCatalog(workspace: string, sessionId?: string): Promise<ActionsCatalog>;
  runs: RunService;
  /**
   * Resolve a session-bound caller's workspace from its session id
   * (composition wires this to the agents registry's session cwd).
   */
  resolveSessionWorkspace?(sessionId: string): string | undefined;
  /**
   * Polling configuration watcher (T21), wired from `createConfigWatcher`.
   * Without it /catalog/events serves only the first-frame snapshot.
   */
  watchCatalogChanges?(workspace: string, listener: () => void): () => void;
  /** Session pin board for input values (T38). */
  sessionParams?: SessionParamStore | undefined;
  /**
   * Manual catalog-change trigger (T38): after a pin write, /catalog/events
   * subscribers of this workspace republish their assembled catalog frame.
   */
  notifyCatalogChanged?(workspace: string): void;
  /** T47: enroll a session's actions file into the workspace's config poller. */
  watchSession?(workspace: string, sessionId: string): void;
  /**
   * T50: remove one entry (by label) from the layer's actions file and write
   * it back atomically. Returns false when the entry is absent. Wired by the
   * composition to `deleteActionEntryFromFile` + the layer's path.
   */
  deleteActionEntry?(
    layer: ActionSourceLayer,
    label: string,
    workspace: string,
    sessionId: string,
  ): Promise<boolean>;
}

const API_PREFIX = `/api/${ACTIONS_PLUGIN_ID}` as const;

export const ACTIONS_API_PATHS = {
  catalog: `${API_PREFIX}/catalog`,
  runs: `${API_PREFIX}/runs`,
  inspect: `${API_PREFIX}/runs/inspect`,
  cancel: `${API_PREFIX}/runs/cancel`,
  forget: `${API_PREFIX}/runs/forget`,
  stream: `${API_PREFIX}/runs/stream`,
  events: `${API_PREFIX}/runs/events`,
  catalogEvents: `${API_PREFIX}/catalog/events`,
  params: `${API_PREFIX}/params`,
  deleteAction: `${API_PREFIX}/actions/delete`,
} as const;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function failure(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

async function readBody(request: Request): Promise<Record<string, unknown> | Response> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    return failure(400, 'bad-request', 'Request body must be a JSON object');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return failure(400, 'bad-request', 'Request body must be a JSON object');
  }
  return value as Record<string, unknown>;
}

function requireString(body: Record<string, unknown>, field: string): string | Response {
  const value = body[field];
  if (typeof value !== 'string' || value.length === 0) {
    return failure(400, 'bad-request', `Field "${field}" must be a non-empty string`);
  }
  return value;
}

/** Optional string-valued map field (T33 `params`, T38 `values`). */
function optionalStringMap(body: Record<string, unknown>, field: string): Record<string, string> | undefined | Response {
  const value = body[field];
  if (value === undefined) return undefined;
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !Object.values(value).every((entry) => typeof entry === 'string')
  ) {
    return failure(400, 'bad-request', `Field "${field}" must be an object with string values`);
  }
  return value as Record<string, string>;
}

function optionalOffset(body: Record<string, unknown>, field: string): number | undefined | Response {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return failure(400, 'bad-request', `Field "${field}" must be a non-negative number`);
  }
  return Math.floor(value);
}

/**
 * The request's workspace: explicit `workspace` wins; otherwise resolve the
 * caller's session cwd from `sessionId`. Session-bound entries (the
 * right-sidebar tab) send only `sessionId`.
 */
function resolveWorkspace(deps: ActionsApiDeps, body: Record<string, unknown>): string | Response {
  const explicit = body.workspace;
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  if (explicit !== undefined) return failure(400, 'bad-request', 'Field "workspace" must be a non-empty string');
  const sessionId = body.sessionId;
  if (typeof sessionId === 'string' && sessionId.length > 0) {
    const resolved = deps.resolveSessionWorkspace?.(sessionId);
    if (resolved !== undefined) return resolved;
  }
  return failure(
    400,
    'workspace-unresolved',
    'Provide "workspace", or a "sessionId" whose session cwd can be resolved',
  );
}

/** T15: run-scoped endpoints require an explicit session id. */
function requireSessionId(body: Record<string, unknown>): string | Response {
  const value = body.sessionId;
  if (typeof value !== 'string' || value.length === 0) {
    return failure(400, 'session-required', 'Field "sessionId" must be a non-empty string');
  }
  return value;
}

/**
 * T15: resolve the caller's runtime scope. Starting runs is session-bound:
 * the workspace comes from the session's own cwd, never from a
 * workspace-derived pseudo-scope.
 */
function resolveSessionScope(deps: ActionsApiDeps, body: Record<string, unknown>): { sessionId: string; workspace: string } | Response {
  const sessionId = requireSessionId(body);
  if (sessionId instanceof Response) return sessionId;
  const workspace = deps.resolveSessionWorkspace?.(sessionId);
  if (workspace === undefined) {
    return failure(400, 'session-unresolved', `Session "${sessionId}" has no resolvable workspace`);
  }
  // T47: sessions that talk to us get their session-layer file enrolled into
  // the workspace's config poller, so edits/register-writes republish.
  deps.watchSession?.(workspace, sessionId);
  return { sessionId, workspace };
}

/**
 * T15: load a run only when the requesting session owns it. Foreign ids get
 * the same 404 as unknown ones — ownership is not leaked.
 */
function ownedInspection(deps: ActionsApiDeps, runId: string, sessionId: string): RunInspection | Response {
  try {
    const inspection = deps.runs.inspect(runId);
    if (inspection.run.sessionId !== sessionId) {
      return failure(404, 'run-not-found', `Unknown action run: ${runId}`);
    }
    return inspection;
  } catch (error) {
    return mapRunServiceError(error);
  }
}

function mapRunServiceError(error: unknown): Response {
  if (error instanceof RunServiceError) {
    if (error.code === 'run-not-found') return failure(404, error.code, error.message);
    if (error.code === 'invalid-params') return failure(400, error.code, error.message);
    if (error.code === 'run-active') return failure(409, error.code, error.message);
    if (error.code === 'shell-unavailable' || error.code === 'disposed') return failure(503, error.code, error.message);
    return failure(500, error.code, error.message);
  }
  const message = error instanceof Error ? error.message : String(error);
  return failure(500, 'internal', message);
}

function isTerminal(status: string): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

function streamRunOutput(deps: ActionsApiDeps, runId: string, sinceOffset: number | undefined): Response {
  const encoder = new TextEncoder();
  let offOutput: (() => void) | undefined;
  let offChange: (() => void) | undefined;
  const cleanup = (): void => {
    offOutput?.();
    offChange?.();
    offOutput = undefined;
    offChange = undefined;
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const push = (frame: RunStreamFrame): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
        } catch {
          closed = true;
          cleanup();
        }
      };
      const close = (): void => {
        if (closed) return;
        closed = true;
        cleanup();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      // 1. Replay the retained buffer from the requested offset (resume support).
      //
      // Synchronous-window invariant (T8-N9): output is only appended from
      // asynchronous paths (the run service pump / settle callbacks), so the
      // synchronous stretch from this snapshot read through the listener
      // registration below cannot miss or duplicate a chunk. Keep step 1 and
      // step 2 free of awaits — introducing one reopens a replay gap.
      try {
        const snapshot = deps.runs.readOutput(runId, sinceOffset);
        if (snapshot.text.length > 0) {
          const frame: RunStreamFrame = { type: 'output', runId, offset: snapshot.offset, text: snapshot.text };
          if (snapshot.truncated) frame.truncated = true;
          push(frame);
        }
        const inspection = deps.runs.inspect(runId);
        push({ type: 'status', run: inspection.run });
        if (isTerminal(inspection.run.status)) {
          close();
          return;
        }
      } catch (error) {
        closed = true;
        try {
          controller.error(error);
        } catch {
          // ignored
        }
        return;
      }

      // 2. Forward live output and status transitions until the run settles.
      offOutput = deps.runs.onDidOutput((frame) => {
        if (frame.runId !== runId) return;
        const out: RunStreamFrame = { type: 'output', runId: frame.runId, offset: frame.offset, text: frame.text };
        if (frame.truncated === true) out.truncated = true;
        push(out);
      });
      offChange = deps.runs.onDidChangeRun((run) => {
        if (run.id !== runId) return;
        push({ type: 'status', run });
        if (isTerminal(run.status)) close();
      });
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/**
 * T16H: session-scoped run discovery feed. First frame is a snapshot of the
 * session's current runs; afterwards every creation/status transition of THIS
 * session is forwarded. No output content (that stays on the per-run stream),
 * no foreign sessions, and the stream lives until the client disconnects.
 */
function streamRunEvents(deps: ActionsApiDeps, sessionId: string): Response {
  const encoder = new TextEncoder();
  let offChange: (() => void) | undefined;
  const cleanup = (): void => {
    offChange?.();
    offChange = undefined;
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const push = (frame: RunDiscoveryFrame): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
        } catch {
          closed = true;
          cleanup();
        }
      };

      // Synchronous-window invariant (same as streamRunOutput, T8-N9): the
      // snapshot read and the listener registration below contain no awaits,
      // and run transitions are only emitted from asynchronous paths, so no
      // event is missed or duplicated between them. Keep it that way.
      push({ type: 'snapshot', runs: deps.runs.listRuns({ sessionId }) });
      offChange = deps.runs.onDidChangeRun((run) => {
        if (run.sessionId !== sessionId) return;
        push({ type: 'status', run });
      });
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/**
 * Shared catalog assembly (T21): web-audience visibility filter plus the
 * caller session's own runs. Used by both the /catalog route and the
 * /catalog/events first frame so the two never diverge.
 */
async function assembleCatalog(
  deps: ActionsApiDeps,
  workspace: string,
  sessionId: string | undefined,
): Promise<ActionsCatalog> {
  // T47: a resolvable caller session also gets its session layer merged in.
  const sessionLive = sessionId !== undefined && deps.resolveSessionWorkspace?.(sessionId) !== undefined;
  const catalog = await deps.loadCatalog(workspace, sessionLive ? sessionId : undefined);
  // The web entry mirrors the agent tools' audience filter:
  // agent-only actions never leave the Host through this channel.
  // Runs of removed actions stay visible; only agent-only ones are hidden.
  const hidden = new Set(
    catalog.actions.filter((action) => action.visibility === 'agent').map((action) => action.id),
  );
  catalog.actions = catalog.actions.filter((action) => !hidden.has(action.id));
  // T15: only a resolvable caller session gets run state, and only its own —
  // a workspace-only request reads definitions with `runs: []`.
  catalog.runs =
    sessionLive && sessionId !== undefined
      ? deps.runs.listRuns({ workspace, sessionId }).filter((run) => !hidden.has(run.actionId))
      : [];
  // T38: the caller session's pin board rides along (only its own).
  if (sessionLive && sessionId !== undefined) {
    catalog.sessionParams = deps.sessionParams?.list(sessionId) ?? {};
  }
  return catalog;
}

/**
 * T21: catalog change feed. The first frame is the full assembled catalog;
 * every configuration change (polling watcher) reloads and pushes again.
 * The watcher subscription is released when the client disconnects.
 */
function streamCatalogEvents(deps: ActionsApiDeps, workspace: string, sessionId: string): Response {
  const encoder = new TextEncoder();
  let offWatch: (() => void) | undefined;
  const cleanup = (): void => {
    offWatch?.();
    offWatch = undefined;
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let ready = false;
      let dirty = false;
      let publishing = false;
      const push = (frame: CatalogEventFrame): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
        } catch {
          closed = true;
          cleanup();
        }
      };
      const publish = async (): Promise<void> => {
        if (publishing) {
          dirty = true; // coalesce rapid successive changes into one reload
          return;
        }
        publishing = true;
        try {
          const catalog = await assembleCatalog(deps, workspace, sessionId);
          push({ type: 'catalog', catalog });
        } catch (error) {
          closed = true;
          cleanup();
          try {
            controller.error(error);
          } catch {
            // ignored
          }
          return;
        } finally {
          publishing = false;
        }
        if (dirty && !closed) {
          dirty = false;
          void publish();
        }
      };

      // Subscribe BEFORE the first load: a change landing during the initial
      // catalog read only marks the feed dirty and triggers a reload right
      // after the first frame — no gap, no duplicate assembly logic.
      offWatch = deps.watchCatalogChanges?.(workspace, () => {
        if (!ready) {
          dirty = true;
          return;
        }
        void publish();
      });
      void publish().finally(() => {
        ready = true;
        if (dirty && !closed) {
          dirty = false;
          void publish();
        }
      });
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export function createActionsApiRoutes(deps: ActionsApiDeps): ConnectionFetchRouteLike[] {
  return [
    {
      path: ACTIONS_API_PATHS.catalog,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const body = await readBody(request);
        if (body instanceof Response) return body;
        const workspace = resolveWorkspace(deps, body);
        if (workspace instanceof Response) return workspace;
        try {
          const sessionId = typeof body.sessionId === 'string' && body.sessionId.length > 0 ? body.sessionId : undefined;
          return json(await assembleCatalog(deps, workspace, sessionId));
        } catch (error) {
          return mapRunServiceError(error);
        }
      },
    },
    {
      path: ACTIONS_API_PATHS.runs,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const body = await readBody(request);
        if (body instanceof Response) return body;
        // T15: runs are session-bound — the workspace is the session's cwd.
        const scope = resolveSessionScope(deps, body);
        if (scope instanceof Response) return scope;
        const actionId = requireString(body, 'actionId');
        if (actionId instanceof Response) return actionId;
        try {
          const catalog = await deps.loadCatalog(scope.workspace, scope.sessionId);
          const action = catalog.actions.find(
            (candidate) => candidate.id === actionId && candidate.visibility !== 'agent',
          );
          if (action === undefined) return failure(404, 'action-not-found', `Unknown action: ${actionId}`);
          // T47: an extends reference that stayed unresolved at load errors at run.
          if (action.extends !== undefined) {
            return failure(400, 'unknown-extends', `Action "${action.label}" extends unknown action "${action.extends}"`);
          }
          // T37: malformed params 400 before any confirmation round-trip.
          const params = optionalStringMap(body, 'params');
          if (params instanceof Response) return params;
          // T29 × T37: the Web entry has no ctx.approval session waterfall, so
          // `approval: "always"` actions require an explicit confirmed:true —
          // the client shows a confirmation and resends with confirmed +
          // params together; evaluation then happens on the real values
          // inside runs.run, so the confirmation covers the same command the
          // user saw.
          if (action.approval === 'always' && body.confirmed !== true) {
            return failure(
              409,
              'confirmation-required',
              `Action "${action.label}" requires explicit confirmation; resend with "confirmed": true`,
            );
          }
          const result = await deps.runs.run(action, { workspace: scope.workspace, sessionId: scope.sessionId, params });
          return json(result);
        } catch (error) {
          return mapRunServiceError(error);
        }
      },
    },
    {
      path: ACTIONS_API_PATHS.inspect,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const body = await readBody(request);
        if (body instanceof Response) return body;
        const sessionId = requireSessionId(body);
        if (sessionId instanceof Response) return sessionId;
        const runId = requireString(body, 'runId');
        if (runId instanceof Response) return runId;
        const offset = optionalOffset(body, 'offset');
        if (offset instanceof Response) return offset;
        try {
          const inspection = ownedInspection(deps, runId, sessionId);
          if (inspection instanceof Response) return inspection;
          const output = offset === undefined ? inspection.output : deps.runs.readOutput(runId, offset);
          return json({ ...inspection, output });
        } catch (error) {
          return mapRunServiceError(error);
        }
      },
    },
    {
      path: ACTIONS_API_PATHS.cancel,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const body = await readBody(request);
        if (body instanceof Response) return body;
        const sessionId = requireSessionId(body);
        if (sessionId instanceof Response) return sessionId;
        const runId = requireString(body, 'runId');
        if (runId instanceof Response) return runId;
        try {
          const inspection = ownedInspection(deps, runId, sessionId);
          if (inspection instanceof Response) return inspection;
          return json(deps.runs.cancel(runId));
        } catch (error) {
          return mapRunServiceError(error);
        }
      },
    },
    {
      path: ACTIONS_API_PATHS.forget,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const body = await readBody(request);
        if (body instanceof Response) return body;
        const sessionId = requireSessionId(body);
        if (sessionId instanceof Response) return sessionId;
        const runId = requireString(body, 'runId');
        if (runId instanceof Response) return runId;
        try {
          // Ownership pre-check (foreign ids answer plain 404), then remove.
          const inspection = ownedInspection(deps, runId, sessionId);
          if (inspection instanceof Response) return inspection;
          deps.runs.forget(runId);
          return json({ forgotten: true });
        } catch (error) {
          return mapRunServiceError(error);
        }
      },
    },
    {
      path: ACTIONS_API_PATHS.stream,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const body = await readBody(request);
        if (body instanceof Response) return body;
        const sessionId = requireSessionId(body);
        if (sessionId instanceof Response) return sessionId;
        const runId = requireString(body, 'runId');
        if (runId instanceof Response) return runId;
        const sinceOffset = optionalOffset(body, 'sinceOffset');
        if (sinceOffset instanceof Response) return sinceOffset;
        // Pre-check so unknown or foreign runs get a plain 404 instead of a failed stream.
        const inspection = ownedInspection(deps, runId, sessionId);
        if (inspection instanceof Response) return inspection;
        return streamRunOutput(deps, runId, sinceOffset);
      },
    },
    {
      path: ACTIONS_API_PATHS.events,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const body = await readBody(request);
        if (body instanceof Response) return body;
        // T16H: the discovery feed is session-bound — a resolvable sessionId
        // is required, exactly like starting runs (no pseudo-scope).
        const scope = resolveSessionScope(deps, body);
        if (scope instanceof Response) return scope;
        return streamRunEvents(deps, scope.sessionId);
      },
    },
    {
      path: ACTIONS_API_PATHS.params,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const body = await readBody(request);
        if (body instanceof Response) return body;
        // T38: pin writes are session-bound, exactly like runs.
        const scope = resolveSessionScope(deps, body);
        if (scope instanceof Response) return scope;
        const store = deps.sessionParams;
        if (store === undefined) return failure(503, 'params-unavailable', 'Session params store is not wired');
        const actionId = requireString(body, 'actionId');
        if (actionId instanceof Response) return actionId;
        try {
          const catalog = await deps.loadCatalog(scope.workspace, scope.sessionId);
          const action = catalog.actions.find(
            (candidate) => candidate.id === actionId && candidate.visibility !== 'agent',
          );
          if (action === undefined) return failure(404, 'action-not-found', `Unknown action: ${actionId}`);
          const values = optionalStringMap(body, 'values');
          if (values instanceof Response) return values;
          const wantsClear = body.clear === true || (values !== undefined && Object.keys(values).length === 0);
          if (wantsClear) {
            store.clear(scope.sessionId, actionId);
          } else {
            if (values === undefined) {
              return failure(400, 'bad-request', 'Provide "values" to pin, or "clear": true to unpin');
            }
            // Declaration validation at pin time: values must be a subset of
            // the declared inputs, select values within options.
            const declared = new Map((action.inputs ?? []).map((input) => [input.id, input]));
            for (const [id, value] of Object.entries(values)) {
              const input = declared.get(id);
              if (input === undefined) {
                return failure(400, 'invalid-params', `Unknown input parameter: ${id}`);
              }
              if (input.type === 'select' && input.options !== undefined && !input.options.includes(value)) {
                return failure(
                  400,
                  'invalid-params',
                  `Invalid value for select input "${id}": "${value}" (expected one of: ${input.options.join(', ')})`,
                );
              }
            }
            store.set(scope.sessionId, actionId, values);
          }
          // Republish catalog frames so subscribers see the new pin board.
          deps.notifyCatalogChanged?.(scope.workspace);
          return json({ actionId, sessionParams: store.get(scope.sessionId, actionId) });
        } catch (error) {
          return mapRunServiceError(error);
        }
      },
    },
    {
      path: ACTIONS_API_PATHS.deleteAction,
      methods: ['POST'],
      requestBody: 'buffered',
      // T50: deleting an action edits its layer's actions.json — the second
      // INTENTIONAL exception to "the plugin never writes configuration"
      // (the first is the one-time global-example seed): it is user-initiated
      // from the panel behind a strong confirmation, writes atomically, and
      // never touches run history (past runs stay listed; a live instance is
      // unaffected — deleting a definition does not stop its process).
      async fetch(request) {
        const body = await readBody(request);
        if (body instanceof Response) return body;
        const scope = resolveSessionScope(deps, body);
        if (scope instanceof Response) return scope;
        const actionId = requireString(body, 'actionId');
        if (actionId instanceof Response) return actionId;
        const separator = actionId.indexOf(':');
        const layer = separator > 0 ? actionId.slice(0, separator) : '';
        if (layer !== 'global' && layer !== 'workspace' && layer !== 'session') {
          return failure(400, 'bad-request', `Field "actionId" must be "<layer>:<label>", got "${actionId}"`);
        }
        const label = actionId.slice(separator + 1);
        if (label.length === 0) {
          return failure(400, 'bad-request', `Field "actionId" must be "<layer>:<label>", got "${actionId}"`);
        }
        if (deps.deleteActionEntry === undefined) return failure(503, 'delete-unavailable', 'Action deletion is not wired');
        try {
          // The id must resolve in the caller's catalog first (web audience
          // rules apply: agent-only actions answer 404 here too).
          const catalog = await deps.loadCatalog(scope.workspace, scope.sessionId);
          const action = catalog.actions.find(
            (candidate) => candidate.id === actionId && candidate.visibility !== 'agent',
          );
          if (action === undefined) return failure(404, 'action-not-found', `Unknown action: ${actionId}`);
          const removed = await deps.deleteActionEntry(layer, label, scope.workspace, scope.sessionId);
          if (!removed) return failure(404, 'action-not-found', `Unknown action: ${actionId}`);
          deps.notifyCatalogChanged?.(scope.workspace);
          return json({ deleted: true, actionId });
        } catch (error) {
          return mapRunServiceError(error);
        }
      },
    },
    {
      path: ACTIONS_API_PATHS.catalogEvents,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const body = await readBody(request);
        if (body instanceof Response) return body;
        // T21: session-bound like every run-state endpoint; the feed's
        // workspace is the session's own cwd.
        const scope = resolveSessionScope(deps, body);
        if (scope instanceof Response) return scope;
        return streamCatalogEvents(deps, scope.workspace, scope.sessionId);
      },
    },
  ];
}
