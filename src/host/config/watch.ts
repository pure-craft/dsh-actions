/**
 * Polling-based configuration watcher (T21).
 *
 * Design decision (lead): poll rather than `fs.watch` — every
 * `pollIntervalMs` both layers (`<workspace>/.dsh/actions.json` and the
 * global `${DSH_HOME}/actions.json`) are statted and the (mtimeMs, size)
 * signature is compared. Polling is platform-consistent and treats
 * missing/created/deleted/renamed files uniformly; stat failures (ENOENT &c)
 * count as "file absent". `fs.watch` stays a future optimization.
 *
 * Files that are not layers are *enrolled* into the same poll set as they are
 * discovered: a session's own layer (T47) and each Action folder that session
 * selected (T66). Without the latter, editing a repository's
 * `.dsh/actions.json` would not refresh the panel, breaking the documented
 * "saving any actions.json takes effect immediately" promise.
 *
 * Watchers share one poller per workspace; the last unsubscribe stops it.
 * Stat and the clock are injected for tests.
 */

import { stat as nodeStat } from 'node:fs/promises';
import { folderActionsPath, resolveActionsLayerPaths, resolveDshHome, sessionActionsPath } from './paths.js';
import type { ActionsLayerPaths } from './paths.js';

export interface FileStatLike {
  mtimeMs: number;
  size: number;
}

/** Stat one file; must reject (e.g. ENOENT) when the file is absent. */
export type StatFile = (path: string) => Promise<FileStatLike>;

/** Injectable interval clock; the returned function cancels the interval. */
export type IntervalClock = (callback: () => void, intervalMs: number) => () => void;

export const DEFAULT_CONFIG_POLL_INTERVAL_MS = 1500;

export interface ConfigWatcherDeps {
  stat?: StatFile | undefined;
  clock?: IntervalClock | undefined;
  pollIntervalMs?: number | undefined;
  /** Layer path resolution; defaults to the real two-layer paths. */
  resolvePaths?: ((workspace: string) => ActionsLayerPaths) | undefined;
  /** Session-layer file path (T47); defaults to the host session layout. */
  sessionPath?: ((workspace: string, sessionId: string) => string) | undefined;
}

/** Listener fires after any layer's (mtimeMs, size) signature changes. Errors are contained. */
export type ConfigChangeListener = () => void;

export interface ConfigWatcher {
  /** Subscribe to configuration changes for `workspace`; returns the unsubscriber. */
  watchWorkspace(workspace: string, listener: ConfigChangeListener): () => void;
  /**
   * T47: enroll a session's actions file into the workspace's poll set
   * (sessions that have issued catalog/run requests). Idempotent; a newly
   * enrolled file establishes its baseline silently (no spurious fire).
   */
  watchSession(workspace: string, sessionId: string): void;
  /**
   * T66: enroll one Action folder's config into the workspace's poll set.
   * Called with the folders a catalog load actually resolved, so a folder
   * dropped from the session's selection simply stops being requested — the
   * stale path stays in the set and costs one stat, which is harmless.
   * Idempotent, with the same silent-baseline rule as {@link watchSession}.
   */
  watchFolder(workspace: string, folder: string): void;
  /** Active per-workspace pollers (diagnostics/tests). */
  readonly activeWatchCount: number;
}

const defaultStat: StatFile = (path) => nodeStat(path);

const defaultClock: IntervalClock = (callback, intervalMs) => {
  const timer = setInterval(callback, intervalMs);
  return () => {
    clearInterval(timer);
  };
};

interface WorkspacePoller {
  /**
   * Subscriptions keyed by token, not by listener function: the same function
   * subscribed twice is two independent subscriptions, and unsubscribing one
   * must not silence the other (or stop the poller early).
   */
  listeners: Map<symbol, ConfigChangeListener>;
  /** Extra enrolled files (session layers T47, Action folders T66) polled beside the two layers. */
  extraPaths: Set<string>;
  stop: () => void;
}

export function createConfigWatcher(deps: ConfigWatcherDeps = {}): ConfigWatcher {
  const stat = deps.stat ?? defaultStat;
  const clock = deps.clock ?? defaultClock;
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_CONFIG_POLL_INTERVAL_MS;
  const resolvePaths = deps.resolvePaths ?? resolveActionsLayerPaths;
  const sessionPath = deps.sessionPath ?? ((workspace: string, sessionId: string) => sessionActionsPath(resolveDshHome(), workspace, sessionId));

  const pollers = new Map<string, WorkspacePoller>();
  /** Enrolled files registered before any subscriber exists (poller starts lazily). */
  const pendingPaths = new Map<string, Set<string>>();

  async function signatureOf(path: string): Promise<string> {
    try {
      const info = await stat(path);
      return `${info.mtimeMs}:${info.size}`;
    } catch {
      return 'absent';
    }
  }

  function startPoller(workspace: string): WorkspacePoller {
    const paths = resolvePaths(workspace);
    const listeners = new Map<symbol, ConfigChangeListener>();
    const extraPaths = new Set<string>(pendingPaths.get(workspace));
    // Per-path baselines: enrolling a session file mid-stream must not fire —
    // its first observation only establishes its own baseline (T47).
    const baselines = new Map<string, string>();
    let primed = false;
    let polling = false;

    const poll = (): void => {
      // Re-entrancy guard: a slow stat must not stack overlapping polls.
      if (polling) return;
      polling = true;
      void (async () => {
        const watched = [paths.global, paths.workspace, ...extraPaths];
        let changed = false;
        for (const path of watched) {
          const signature = await signatureOf(path);
          const previous = baselines.get(path);
          baselines.set(path, signature);
          if (previous !== undefined && previous !== signature) changed = true;
        }
        if (!primed) {
          primed = true; // first observation only establishes the baselines
          return;
        }
        if (!changed) return; // dedupe: unchanged signatures never fire
        for (const listener of listeners.values()) {
          try {
            listener();
          } catch {
            // contained: one bad listener must not break the poller
          }
        }
      })().finally(() => {
        polling = false;
      });
    };

    const cancelInterval = clock(poll, pollIntervalMs);
    poll(); // establish the baselines immediately
    return {
      listeners,
      extraPaths,
      stop: () => {
        cancelInterval();
        listeners.clear();
      },
    };
  }

  /** Shared enrollment for session layers (T47) and Action folders (T66). */
  function enroll(workspace: string, path: string): void {
    const poller = pollers.get(workspace);
    if (poller !== undefined) {
      poller.extraPaths.add(path);
      return;
    }
    let pending = pendingPaths.get(workspace);
    if (pending === undefined) {
      pending = new Set();
      pendingPaths.set(workspace, pending);
    }
    pending.add(path);
  }

  return {
    get activeWatchCount() {
      return pollers.size;
    },

    watchSession(workspace, sessionId) {
      enroll(workspace, sessionPath(workspace, sessionId));
    },

    watchFolder(workspace, folder) {
      enroll(workspace, folderActionsPath(folder));
    },

    watchWorkspace(workspace, listener) {
      let poller = pollers.get(workspace);
      if (poller === undefined) {
        poller = startPoller(workspace);
        pollers.set(workspace, poller);
      }
      const token = Symbol('dsh-actions-watch-subscription');
      poller.listeners.set(token, listener);
      return () => {
        // Captured poller instance: if the workspace's poller was stopped and
        // restarted since we subscribed, this stale unsubscribe must not tear
        // down the new poller — it only detaches its own (dead) subscription.
        poller.listeners.delete(token);
        if (pollers.get(workspace) !== poller) return;
        if (poller.listeners.size === 0) {
          poller.stop();
          pollers.delete(workspace);
        }
      };
    },
  };
}
