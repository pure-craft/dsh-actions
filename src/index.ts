import { ACTIONS_PLUGIN_ID } from './contract.js';
import { loadActionsCatalog } from './host/catalog.js';
import { seedGlobalActionsExample } from './host/config/seed.js';
import { createConfigWatcher } from './host/config/watch.js';
import { createActionsApiRoutes } from './host/rpc/index.js';
import type { ConnectionFetchRouteLike } from './host/rpc/index.js';
import { createRunService, resolveRunCapabilities } from './host/run/index.js';
import { resolveActionsLayerPaths, resolveDshHome, sessionActionsPath } from './host/config/paths.js';
import {
  clearSessionActionsFile,
  configureSessionActionsFile,
  deleteActionEntryFromFile,
  writeSessionActionFolders,
} from './host/config/session-file.js';
import { isSkillsLike, registerAuthoringSkill } from './host/skills.js';
import { registerActionTools } from './host/tools/index.js';
import type { ActionLayerStoreLike, ApprovalServiceLike, SandboxPolicyResolverLike, ToolsLike } from './host/tools/index.js';
import type { HostContext } from './host/types.js';
import type { ActionEntryConfig } from './contract.js';
import { registerAvailableActionsContext } from './host/action-context.js';
import { createActionEntry, deleteActionEntry, inspectActionLayer, updateActionEntry } from './host/config/action-store.js';
import type { ConfigurableActionLayer } from './host/config/action-store.js';

export const name = ACTIONS_PLUGIN_ID;
export const ACTIONS_SERVICE = 'dshActions';

export interface DshActionsSessionConfiguration {
  readonly folders: readonly string[];
  readonly actions: readonly ActionEntryConfig[];
}

export interface DshActionsService {
  /** Atomically replace the complete session layer and refresh its catalog. */
  configureSession(
    sessionId: string,
    workspace: string,
    configuration: DshActionsSessionConfiguration,
  ): Promise<void>;
  /** Reset the session layer to empty folders and actions, then refresh. */
  clearSession(sessionId: string, workspace: string): Promise<void>;
  /** Compatibility helper: replace only folders while preserving actions. */
  setSessionFolders(sessionId: string, workspace: string, folders: readonly string[]): Promise<void>;
}

/**
 * Services this bundle depends on.
 *
 * Declaring them is what makes a cold boot work. The bundle layer is applied
 * position-by-position; without `inject` cordis runs `apply` before the tools
 * registry and the web connection channel have been provided, both
 * `ctx.get(...)` lookups come back empty, and the plugin silently no-ops
 * instead of registering anything. A hot reload hides this, because by then
 * every service already exists.
 */
export const inject = ['tools', 'connection', 'agents', 'skills', 'approval', 'systemPrompt'];

interface ConnectionFetchLike {
  register(route: ConnectionFetchRouteLike): Promise<() => void>;
}

interface ConnectionLike {
  fetch: ConnectionFetchLike;
}

/** Minimal mirror of the agents registry: session cwd lookup by session id. */
interface AgentsLike {
  get(id: string): { session?: { header?: { cwd?: string } } } | undefined;
}

function isAgentsLike(value: unknown): value is AgentsLike {
  return typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>).get === 'function';
}

function isConnectionLike(value: unknown): value is ConnectionLike {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = (value as Record<string, unknown>).fetch;
  return typeof candidate === 'object' && candidate !== null && typeof (candidate as Record<string, unknown>).register === 'function';
}

function isToolsLike(value: unknown): value is ToolsLike {
  return typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>).register === 'function';
}

function isSandboxPolicyResolverLike(value: unknown): value is SandboxPolicyResolverLike {
  return typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>).resolve === 'function';
}

function isApprovalServiceLike(value: unknown): value is ApprovalServiceLike {
  return typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>).request === 'function';
}

export interface ApplyInternals {
  /** Test seam: replace the one-time global-example seed with a noop/spy. */
  seedGlobalExample?: () => Promise<boolean>;
}

export function apply(ctx: HostContext, internals: ApplyInternals = {}): void {
  const capabilities = resolveRunCapabilities(ctx);
  const runs = createRunService(capabilities);
  ctx.effect(
    () => () => {
      runs.dispose();
    },
    'dsh-actions: run service',
  );

  // T47: loadCatalog gains the optional session layer (sessionId → its own
  // actions file under the host's session directory layout).
  const catalog = {
    loadCatalog: (workspace: string, sessionId?: string) =>
      loadActionsCatalog(workspace, sessionId === undefined ? {} : { sessionId }),
  };
  // T47: manual catalog-change fan-out shared by configuration writes and
  // session-action registrations (declared before tools registration).
  const manualCatalogListeners = new Map<string, Set<() => void>>();
  const notifyCatalogChanged = (workspace: string): void => {
    for (const listener of Array.from(manualCatalogListeners.get(workspace) ?? [])) listener();
  };
  const sessionFilePath = (sessionId: string, workspace: string): string =>
    sessionActionsPath(resolveDshHome(), workspace, sessionId);
  const actionsService: DshActionsService = {
    configureSession: async (sessionId, workspace, configuration) => {
      await configureSessionActionsFile(sessionFilePath(sessionId, workspace), configuration);
      notifyCatalogChanged(workspace);
    },
    clearSession: async (sessionId, workspace) => {
      await clearSessionActionsFile(sessionFilePath(sessionId, workspace));
      notifyCatalogChanged(workspace);
    },
    setSessionFolders: async (sessionId, workspace, folders) => {
      await writeSessionActionFolders(sessionFilePath(sessionId, workspace), folders);
      notifyCatalogChanged(workspace);
    },
  };
  ctx.provide?.(ACTIONS_SERVICE, actionsService);

  // Agent tools share the same catalog and run lifecycle as the Web entry,
  // while selecting a different execution policy at their trusted Host entry.
  // Agent runs inherit the calling session sandbox; manual Web runs are fixed
  // below to local-user execution and cannot choose that mode in request data.
  const sandboxPolicy = ctx.get('sandboxPolicy');
  const sandboxPolicyResolver = isSandboxPolicyResolverLike(sandboxPolicy) ? sandboxPolicy : undefined;
  // T29: approval-gated actions (approval: agent|always) ask through the
  // session approval channel; without it they fail closed (unavailable).
  const approval = ctx.get('approval');
  const approvalService = isApprovalServiceLike(approval) ? approval : undefined;
  const layerPath = (layer: ConfigurableActionLayer, workspace: string, sessionId: string): string => {
    const paths = resolveActionsLayerPaths(workspace);
    return layer === 'global'
      ? paths.global
      : layer === 'workspace'
        ? paths.workspace
        : sessionActionsPath(resolveDshHome(), workspace, sessionId);
  };
  const actionLayers: ActionLayerStoreLike = {
    inspect: (layer, label, workspace, sessionId) => inspectActionLayer(layerPath(layer, workspace, sessionId), label),
    create: async (layer, entry, expectedStoreRevision, workspace, sessionId) => {
      const path = layerPath(layer, workspace, sessionId);
      await createActionEntry(path, entry, expectedStoreRevision);
      return { path };
    },
    update: async (layer, label, expectedRevision, changes, workspace, sessionId) => {
      const path = layerPath(layer, workspace, sessionId);
      return { path, ...(await updateActionEntry(path, label, expectedRevision, changes)) };
    },
    delete: async (layer, label, expectedRevision, workspace, sessionId) => {
      const path = layerPath(layer, workspace, sessionId);
      return { path, before: await deleteActionEntry(path, label, expectedRevision) };
    },
  };
  if (ctx.on) registerAvailableActionsContext(ctx as Parameters<typeof registerAvailableActionsContext>[0], catalog);
  else console.error('[dsh-actions] Host context cannot register Actions runtime context');

  const tools = ctx.get('tools');
  if (isToolsLike(tools)) {
    ctx.effect(
      () =>
        registerActionTools(tools, {
          catalog,
          runs,
          sandboxPolicy: sandboxPolicyResolver,
          approval: approvalService,
          actionLayers,
          notifyCatalogChanged,
        }),
      'dsh-actions: agent tools',
    );
  } else {
    console.error('[dsh-actions] tools service has an unexpected shape; agent tools not registered');
  }

  // `inject` guarantees the channel is present by the time this runs; the guard
  // only keeps the structural mirror honest. Authentication belongs to the
  // channel, never to this plugin.
  const connection = ctx.get('connection');
  if (!isConnectionLike(connection)) {
    console.error('[dsh-actions] connection service has an unexpected shape; API routes not registered');
    return;
  }
  // Session-bound entries (the right-sidebar tab) address runs by sessionId;
  // the workspace is always the session's own cwd.
  const agents = ctx.get('agents');
  const agentsRegistry = isAgentsLike(agents) ? agents : undefined;
  const resolveSessionWorkspace = (sessionId: string): string | undefined =>
    agentsRegistry?.get(sessionId)?.session?.header?.cwd;

  // T21: polling configuration watcher feeding /catalog/events. Pollers are
  // reference-counted per workspace; streams unsubscribe on disconnect, so
  // no polling runs without an attached client. Configuration writes republish
  // through a manual trigger that shares the same listener channel.
  const configWatcher = createConfigWatcher();

  const routes = createActionsApiRoutes({
    loadCatalog: catalog.loadCatalog,
    runs,
    resolveSessionWorkspace,
    // A foreground user click is the VS Code Tasks-like local execution path.
    // This policy is attached by the Host route, never accepted from the Web
    // request body; actions_run continues to use the session resolver above.
    manualRunSandboxPolicy: (workspace, sessionId) => ({
      mode: 'danger-full-access',
      workspaceRoot: workspace,
      sessionId,
    }),
    watchSession: (workspace, sessionId) => configWatcher.watchSession(workspace, sessionId),
    // T66: a session-selected folder's config joins the same poll set, so a
    // repository edit refreshes the catalog like any layer edit does.
    watchFolder: (workspace, folder) => configWatcher.watchFolder(workspace, folder),
    // Web deletion keeps its existing explicit confirmation path.
    deleteActionEntry: async (layer, label, workspace, sessionId) => {
      // T66: folder definitions belong to their repository. The panel offers no
      // delete entry for them, and this refuses too — falling through to the
      // global file would delete an unrelated same-label action.
      if (layer === 'folder') return false;
      const layers = resolveActionsLayerPaths(workspace);
      const path =
        layer === 'session'
          ? sessionActionsPath(resolveDshHome(), workspace, sessionId)
          : layer === 'workspace'
            ? layers.workspace
            : layers.global;
      return deleteActionEntryFromFile(path, label);
    },
    watchCatalogChanges: (workspace, listener) => {
      const offWatch = configWatcher.watchWorkspace(workspace, listener);
      let set = manualCatalogListeners.get(workspace);
      if (set === undefined) {
        set = new Set();
        manualCatalogListeners.set(workspace, set);
      }
      set.add(listener);
      return () => {
        offWatch();
        set.delete(listener);
        if (set.size === 0) manualCatalogListeners.delete(workspace);
      };
    },
    notifyCatalogChanged,
  });
  for (const route of routes) {
    ctx.effect(() => {
      let dispose: () => void = () => undefined;
      let active = true;
      void connection.fetch.register(route).then(
        (registered) => {
          if (active) dispose = registered;
          else registered();
        },
        // T37: a rejected registration must not become an unhandledRejection
        // (that can take the Host down); log and stay unregistered.
        (error: unknown) => {
          console.error(`[dsh-actions] failed to register api route ${route.path}:`, error);
        },
      );
      return () => {
        active = false;
        dispose();
      };
    }, `dsh-actions: api route ${route.path}`);
  }

  // One-time seed: an entirely absent global layer gets a documented example
  // entry so first-run users have something real to try and to edit. The 'wx'
  // flag makes this fire exactly once per file lifetime; the plugin never
  // edits configuration files afterwards.
  const seed = internals.seedGlobalExample ?? (() => seedGlobalActionsExample(resolveActionsLayerPaths('/').global));
  void seed()
    .then((seeded) => {
      if (seeded) console.log('[dsh-actions] seeded the global actions.json with an example entry');
    })
    .catch((error: unknown) => {
      console.error('[dsh-actions] failed to seed the global actions.json:', error);
    });

  // Packaged authoring skill: served from this package's own skills/ directory
  // so the guide always matches the installed plugin version (AGENTS.md).
  const skills = ctx.get('skills');
  if (isSkillsLike(skills)) {
    ctx.effect(() => {
      let dispose: () => void = () => undefined;
      let active = true;
      void registerAuthoringSkill(skills).then(
        (registered) => {
          if (active) dispose = registered;
          else registered();
        },
        // T37: same unhandledRejection guard as the api routes.
        (error: unknown) => {
          console.error('[dsh-actions] failed to register authoring skill:', error);
        },
      );
      return () => {
        active = false;
        dispose();
      };
    }, 'dsh-actions: authoring skill');
  } else {
    console.error('[dsh-actions] skills service has an unexpected shape; authoring skill not registered');
  }
}

export type * from './contract.js';
export {
  parseActionRunSummary,
  parseActionsCatalog,
  parseActionsFileConfig,
  parseProjectActionSummary,
  parseRunStartResult,
  parseRunStreamFrame,
} from './wire.js';
