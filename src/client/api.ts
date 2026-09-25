/**
 * Replaceable Host communication module.
 *
 * The panel only talks to the `ActionsApi` surface below; the factory body
 * (see {@link createActionsApi}) is the single swap point.
 *
 * Endpoint shape (T4 + T11 + T15, authenticated connection.fetch channel):
 * - POST {base}/catalog      { sessionId }                      -> ActionsCatalog (Host resolves the session cwd)
 * - POST {base}/runs         { sessionId, actionId }            -> RunStartResult
 * - POST {base}/runs/inspect { sessionId, runId, offset? }      -> { run, action, output: RunOutputSnapshot }
 * - POST {base}/runs/cancel  { sessionId, runId }               -> ActionRunSummary
 * - POST {base}/runs/stream  { sessionId, runId, sinceOffset }  -> NDJSON RunStreamFrame lines
 * - POST {base}/runs/events  { sessionId }                      -> NDJSON RunDiscoveryFrame lines (T16)
 * - POST {base}/catalog/events { sessionId }                    -> NDJSON CatalogEventFrame lines (T22)
 *
 * T15: run state is isolated per session — every run-scoped call carries the
 * sessionId and foreign runs answer 404. T16: the events endpoint streams the
 * caller session's run lifecycle for realtime UI/agent sync.
 */
import { ACTIONS_PLUGIN_ID } from '../contract.js';
import type {
  ActionRunSummary,
  ActionsCatalog,
  CatalogEventFrame,
  RunDiscoveryFrame,
  RunStartResult,
  RunStreamFrame,
} from '../contract.js';
import {
  parseActionRunSummary,
  parseActionsCatalog,
  parseCatalogEventFrame,
  parseRunDiscoveryFrame,
  parseRunStartResult,
} from '../wire.js';
import { readNdjson, readRunStream, toApiError } from './stream.js';

export { ActionsApiError } from './stream.js';

/** T4 route prefix; adjusted in one place if the channel mount differs. */
export const ACTIONS_API_BASE = `/api/${ACTIONS_PLUGIN_ID}`;

export interface RunInspection {
  run: ActionRunSummary;
  output: string;
  truncated: boolean;
}

// T16/T21 frames: the shared contract types + wire validators (the Host side
// landed both — the earlier local mirrors are gone). Re-exported so existing
// consumers (store) keep their import site.
export type { CatalogEventFrame, RunDiscoveryFrame };

export interface ActionsApi {
  /** @param sessionId - the panel-bound session; the Host resolves its workspace cwd (T11). */
  listCatalog(sessionId: string, signal?: AbortSignal): Promise<ActionsCatalog>;
  /**
   * @param options.confirmed - T29: `approval: "always"` actions answer 409
   *   confirmation-required until the caller resends with `confirmed: true`.
   * @param options.params - T33: resolved `${input:*}` values for this run
   *   (400 invalid-params when a required value is missing or invalid).
   */
  runAction(
    sessionId: string,
    actionId: string,
    options?: { confirmed?: boolean; params?: Record<string, string> },
    signal?: AbortSignal,
  ): Promise<RunStartResult>;
  inspectRun(sessionId: string, runId: string, offset?: number, signal?: AbortSignal): Promise<RunInspection>;
  cancelRun(sessionId: string, runId: string, signal?: AbortSignal): Promise<ActionRunSummary>;
  /** Remove a settled run record (the chips' "remove record" action); 404 for foreign, 409 when still active. */
  forgetRun(sessionId: string, runId: string, signal?: AbortSignal): Promise<void>;
  /**
   * Deliver run frames starting at byte `sinceOffset`. Resolves when the run
   * reaches a terminal state (or the stream ends); rejects on transport
   * failure — the caller resumes from its last applied offset.
   */
  streamRun(
    sessionId: string,
    runId: string,
    sinceOffset: number,
    onFrame: (frame: RunStreamFrame) => void,
    signal?: AbortSignal,
  ): Promise<void>;
  /**
   * Subscribe to the session's run lifecycle (T16). Resolves when the stream
   * ends; rejects on transport failure — the caller resubscribes and the
   * leading snapshot frame makes every resync idempotent.
   */
  subscribeRuns(
    sessionId: string,
    onFrame: (frame: RunDiscoveryFrame) => void,
    signal?: AbortSignal,
  ): Promise<void>;
  /**
   * Subscribe to catalog changes for the session's workspace (T22). Resolves
   * when the stream ends; rejects on transport failure — the caller
   * resubscribes and the leading snapshot frame makes every resync idempotent.
   */
  subscribeCatalog(
    sessionId: string,
    onFrame: (frame: CatalogEventFrame) => void,
    signal?: AbortSignal,
  ): Promise<void>;
  /**
   * T38: pin input values for an action to this session (or clear the pin
   * with `values: undefined`). Resolves with the action's resulting pinned
   * map (empty after a clear). The Host republishes catalog frames.
   */
  saveSessionParams(
    sessionId: string,
    actionId: string,
    values: Record<string, string> | undefined,
    signal?: AbortSignal,
  ): Promise<Record<string, string>>;
  /**
   * T50/T51: permanently remove an action from its config file. 404 unknown
   * or invisible, 400 invalid id. The catalog event stream repushes.
   */
  deleteAction(sessionId: string, actionId: string, signal?: AbortSignal): Promise<void>;
}

async function postJson(url: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: signal ?? null,
  });
  if (!response.ok) throw await toApiError(response);
  return response.json();
}

function parseInspection(value: unknown): RunInspection {
  if (typeof value !== 'object' || value === null) throw new Error('invalid inspection payload');
  const record = value as Record<string, unknown>;
  // Host shape (T4+): `output` is a RunOutputSnapshot object — parse text and
  // truncated from it. The flat legacy shape stays as a fallback so older
  // adapters/mocks keep working.
  const output = record.output;
  if (typeof output === 'object' && output !== null) {
    const snapshot = output as Record<string, unknown>;
    return {
      run: parseActionRunSummary(record.run),
      output: typeof snapshot.text === 'string' ? snapshot.text : '',
      truncated: snapshot.truncated === true,
    };
  }
  return {
    run: parseActionRunSummary(record.run),
    output: typeof output === 'string' ? output : '',
    truncated: record.truncated === true,
  };
}

/** Real endpoint implementation (the panel default). */
export function createHttpApi(base: string = ACTIONS_API_BASE): ActionsApi {
  const postStream = async (url: string, body: unknown, signal?: AbortSignal): Promise<Response> =>
    fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal ?? null,
    });

  return {
    async listCatalog(sessionId, signal) {
      return parseActionsCatalog(await postJson(`${base}/catalog`, { sessionId }, signal));
    },
    async runAction(sessionId, actionId, options, signal) {
      const body: Record<string, unknown> = { sessionId, actionId };
      if (options?.confirmed === true) body.confirmed = true;
      if (options?.params !== undefined) body.params = options.params;
      return parseRunStartResult(await postJson(`${base}/runs`, body, signal));
    },
    async inspectRun(sessionId, runId, offset, signal) {
      return parseInspection(await postJson(`${base}/runs/inspect`, { sessionId, runId, offset }, signal));
    },
    async cancelRun(sessionId, runId, signal) {
      return parseActionRunSummary(await postJson(`${base}/runs/cancel`, { sessionId, runId }, signal));
    },
    async forgetRun(sessionId, runId, signal) {
      await postJson(`${base}/runs/forget`, { sessionId, runId }, signal);
    },
    async streamRun(sessionId, runId, sinceOffset, onFrame, signal) {
      const response = await postStream(`${base}/runs/stream`, { sessionId, runId, sinceOffset }, signal);
      await readRunStream(response, onFrame);
    },
    async subscribeRuns(sessionId, onFrame, signal) {
      const response = await postStream(`${base}/runs/events`, { sessionId }, signal);
      await readNdjson(response, (value) => { onFrame(parseRunDiscoveryFrame(value)); });
    },
    async subscribeCatalog(sessionId, onFrame, signal) {
      const response = await postStream(`${base}/catalog/events`, { sessionId }, signal);
      await readNdjson(response, (value) => { onFrame(parseCatalogEventFrame(value)); });
    },
    async saveSessionParams(sessionId, actionId, values, signal) {
      const body: Record<string, unknown> = { sessionId, actionId };
      if (values === undefined) body.clear = true;
      else body.values = values;
      const result = await postJson(`${base}/params`, body, signal);
      if (typeof result !== 'object' || result === null) throw new Error('invalid params payload');
      const record = (result as Record<string, unknown>).sessionParams;
      if (typeof record !== 'object' || record === null) return {};
      const pinned: Record<string, string> = {};
      for (const [key, value] of Object.entries(record as Record<string, unknown>)) {
        if (typeof value === 'string') pinned[key] = value;
      }
      return pinned;
    },
    async deleteAction(sessionId, actionId, signal) {
      await postJson(`${base}/actions/delete`, { sessionId, actionId }, signal);
    },
  };
}

/** Panel default: the real T4 endpoints over the authenticated fetch channel. */
export function createActionsApi(): ActionsApi {
  return createHttpApi();
}
