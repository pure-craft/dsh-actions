/**
 * Session param store (T38).
 *
 * In-memory pin board for action input values, keyed by (sessionId,
 * actionId). It lives as long as the Host does and is strictly
 * session-isolated (same T14 semantics as runs — one session can never read
 * or write another session's pins). Values die with the session/Host: this
 * is the main path for pinning session-scoped context BEFORE the first run.
 * Volumes are small (one record per pinned action), so no LRU.
 */

export interface SessionParamStore {
  /** Pinned values for one (sessionId, actionId); a fresh copy, `{}` when none. */
  get(sessionId: string, actionId: string): Record<string, string>;
  /** Every pin of one session: actionId -> values (fresh copies). */
  list(sessionId: string): Record<string, Record<string, string>>;
  /** Replace the pin for one (sessionId, actionId); an empty record clears it. */
  set(sessionId: string, actionId: string, values: Record<string, string>): void;
  clear(sessionId: string, actionId: string): void;
}

export function createSessionParamStore(): SessionParamStore {
  const bySession = new Map<string, Map<string, Record<string, string>>>();

  return {
    get(sessionId, actionId) {
      const values = bySession.get(sessionId)?.get(actionId);
      return values === undefined ? {} : { ...values };
    },

    list(sessionId) {
      const pins = bySession.get(sessionId);
      if (pins === undefined) return {};
      return Object.fromEntries([...pins.entries()].map(([actionId, values]) => [actionId, { ...values }]));
    },

    set(sessionId, actionId, values) {
      if (Object.keys(values).length === 0) {
        this.clear(sessionId, actionId);
        return;
      }
      let pins = bySession.get(sessionId);
      if (pins === undefined) {
        pins = new Map();
        bySession.set(sessionId, pins);
      }
      pins.set(actionId, { ...values });
    },

    clear(sessionId, actionId) {
      const pins = bySession.get(sessionId);
      if (pins === undefined || !pins.delete(actionId)) return;
      if (pins.size === 0) bySession.delete(sessionId);
    },
  };
}
