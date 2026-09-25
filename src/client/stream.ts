import type { RunStreamFrame } from '../contract.js';
import { parseRunStreamFrame } from '../wire.js';

/** Structured endpoint failure: carries the Host error code when one was sent. */
export class ActionsApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, code: string | undefined, message: string) {
    super(message);
    this.name = 'ActionsApiError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Shape a failed endpoint Response into an ActionsApiError, preserving the
 * Host's `{ error: { code, message } }` body when present.
 */
export async function toApiError(response: Response): Promise<ActionsApiError> {
  let code: string | undefined;
  let message = `HTTP ${String(response.status)}`;
  try {
    const body = await response.json() as { error?: { code?: unknown; message?: unknown } };
    if (typeof body.error?.code === 'string') code = body.error.code;
    if (typeof body.error?.message === 'string') message = body.error.message;
  } catch {
    // Non-JSON failure body; keep the HTTP fallback message.
  }
  return new ActionsApiError(response.status, code, message);
}

/**
 * Read one NDJSON stream from an authenticated fetch `Response`. Each line is
 * one JSON value handed to `onValue`; resolves when the stream ends, rejects
 * on transport/parse failure so the caller can resume or resync.
 */
export async function readNdjson(
  response: Response,
  onValue: (value: unknown) => void,
): Promise<void> {
  if (!response.ok) throw await toApiError(response);
  const body = response.body;
  if (body === null) throw new Error('stream-unavailable');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const drain = (flush: boolean): void => {
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length > 0) onValue(JSON.parse(line));
      index = buffer.indexOf('\n');
    }
    if (flush) {
      const tail = buffer.trim();
      buffer = '';
      if (tail.length > 0) onValue(JSON.parse(tail));
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      drain(false);
    }
    buffer += decoder.decode();
    drain(true);
  } finally {
    reader.releaseLock();
  }
}

/**
 * Read one NDJSON stream of `RunStreamFrame`s (POST /api/dsh-actions/runs/stream).
 */
export async function readRunStream(
  response: Response,
  onFrame: (frame: RunStreamFrame) => void,
): Promise<void> {
  await readNdjson(response, (value) => { onFrame(parseRunStreamFrame(value)); });
}
