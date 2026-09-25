/**
 * Session binding helpers.
 *
 * The tab body lives in the session-scoped `sidebar.right.pane.tab` seat, so
 * its standard props carry `sessionId`, and `useSessions`
 * (SnapshotSelectorHook over the ui-session snapshot) resolves that session's
 * workspace path. Only the fields we read are declared here.
 */

export interface SessionItemLike {
  readonly cwd?: string | undefined;
}

export interface SessionSnapshotLike {
  readonly byId: Record<string, SessionItemLike | undefined>;
}

export type UseSessionsLike = <S>(
  select: (snapshot: SessionSnapshotLike) => S,
  eq?: (a: S, b: S) => boolean,
) => S;

const EMPTY_SNAPSHOT: SessionSnapshotLike = { byId: {} };

/** Used when the host predates the useSessions standard prop: no session resolves. */
export function fallbackUseSessions<S>(select: (snapshot: SessionSnapshotLike) => S): S {
  return select(EMPTY_SNAPSHOT);
}
