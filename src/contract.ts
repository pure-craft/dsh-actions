/**
 * DSH Actions wire contract (V1).
 *
 * This module is types-only. All runtime validation lives in `wire.ts`.
 * Design source: docs/v1-goals.md.
 */

// ---------------------------------------------------------------------------
// Configuration file (`actions.json`, JSONC syntax)
// ---------------------------------------------------------------------------

/** Only accepted `version` value for V1 configuration files. */
export const ACTIONS_FILE_VERSION = '1.0.0';

/**
 * Stable plugin identity (Cordis row id, conversation.view tab id, API
 * route prefix, and the display prefix on tool-call cards). One constant —
 * it is referenced from both halves and from several client surfaces.
 */
export const ACTIONS_PLUGIN_ID = 'dsh-actions';

/**
 * Where an action definition comes from. Priority order: global < workspace
 * < session (T47) — the session layer wins every merge it joins.
 */
export type ActionSourceLayer = 'global' | 'workspace' | 'session';

/** Which entries expose the action. */
export type ActionVisibility = 'all' | 'ui' | 'agent';

/** Host conflict policy for overlapping run requests. */
export type ActionInstancePolicy = 'reuse' | 'reject';

/**
 * Approval requirement (T29): `never` (default, zero behavior change),
 * `agent` (Agent tool calls ask via `ctx.approval`), `always` (Agent asks;
 * the Web entry demands an explicit `confirmed: true`).
 */
export type ActionApprovalRequirement = 'never' | 'agent' | 'always';

export interface ActionRunOptionsConfig {
  /** Maximum concurrent instances per action; clamped to >= 1. Default 1. */
  instanceLimit?: number;
  /** Default 'reuse'. */
  instancePolicy?: ActionInstancePolicy;
}

/**
 * How a new run relates to the run-tab workspace (VS Code `presentation.panel` simplified):
 * - `new` (default): every run opens its own tab; older runs stay as tabs.
 * - `dedicated`: an action owns a single tab — re-running replaces that tab's
 *   content in place (the previous output is discarded; the run record is kept).
 * - `append`: like `dedicated`, but the new output is appended below the
 *   previous runs' output with a boundary line (the VS Code `shared` terminal
 *   experience). Presentation-only: runs keep separate ids and outputs
 *   internally; `actions_inspect` is unaffected.
 */
export type ActionPanelMode = 'new' | 'dedicated' | 'append';

export interface ActionPresentationConfig {
  /** Default 'new'. */
  panel?: ActionPanelMode;
}

export interface ActionOptionsConfig {
  /**
   * Working directory; defaults to the workspace root. Relative values
   * resolve against the workspace root; absolute values are honored as-is
   * (the run's sandbox root stays the workspace — writes outside it may be
   * denied).
   */
  cwd?: string;
  env?: Record<string, string>;
}

/** Declared parameter kinds (VS Code `inputs` simplified to V1's two types). */
export type ActionInputType = 'string' | 'select';

/**
 * A declared action parameter. Referenced in command/cwd/env values/detail as
 * `${input:id}`; provided values are validated against this declaration at run
 * time (see `normalizeParams` in `src/host/config/params.ts`).
 */
export interface ActionInputConfig {
  /** Identifier; referenced as `${input:id}`. Must not contain `}`. */
  id: string;
  type: ActionInputType;
  description?: string;
  /** When true, running without a value (and no default) is an error. */
  required?: boolean;
  /** Fallback when the run provides no value; for `select` it must be one of `options`. */
  default?: string;
  /** Allowed values; required (non-empty) when `type` is `select`. */
  options?: string[];
}

export interface ActionEntryConfig {
  label: string;
  /** Optional only for extends entries (inherited at resolution); required otherwise. */
  command?: string;
  detail?: string;
  visibility?: ActionVisibility;
  approval?: ActionApprovalRequirement;
  options?: ActionOptionsConfig;
  runOptions?: ActionRunOptionsConfig;
  presentation?: ActionPresentationConfig;
  inputs?: ActionInputConfig[];
  /**
   * Iconify icon code (`collection:name`, e.g. `lucide:rocket`) shown in the
   * panel. UI-only display metadata — never enters Agent context.
   */
  icon?: string;
  /**
   * Reference another action id (`<layer>:<label>`) whose definition is this
   * entry's base: the base's cwd/env/inputs/runOptions/etc. are inherited
   * field-wise (this entry's written fields win; command is always written).
   * Resolved at catalog load; an unresolvable reference stays on the
   * normalized summary and errors at run time.
   */
  extends?: string;
}

export interface ActionsFileConfig {
  version: string;
  actions?: ActionEntryConfig[];
}

// ---------------------------------------------------------------------------
// Normalized catalog (Host -> any entry)
// ---------------------------------------------------------------------------

export interface ProjectActionSummary {
  /** Stable id: derived from source layer + label; merged entries use the workspace layer. */
  id: string;
  label: string;
  detail?: string;
  sourceLayer: ActionSourceLayer;
  visibility: ActionVisibility;
  /** Normalized approval requirement; `never` when the entry omitted it. */
  approval: ActionApprovalRequirement;
  /** Command text after variable substitution. */
  command: string;
  /** Absolute working directory the run binds to. */
  cwd: string;
  env?: Record<string, string>;
  runOptions: {
    instanceLimit: number;
    instancePolicy: ActionInstancePolicy;
  };
  /** Present only when the config sets `presentation.panel`; absence means 'new'. */
  presentation?: ActionPresentationConfig;
  /**
   * Declared parameters (after the two-layer merge). The summary keeps
   * `${input:id}` placeholders verbatim in command/cwd/env/detail; values are
   * resolved per run via `normalizeParams` + variable substitution.
   */
  inputs?: ActionInputConfig[];
  /**
   * Unresolved `extends` reference (T47): present only when the referenced
   * action id did not exist at catalog load. Running such an action fails
   * with a structured `unknown-extends` error.
   */
  extends?: string;
  /**
   * Iconify icon code shown in the panel (T65).
   * @ui-only — never surfaces in Agent context (tool outputs/approvals keep
   * their own whitelisted field sets; do not add this there).
   */
  icon?: string;
}

/**
 * Agent-facing projection of an action (T64). Every Agent-bound surface
 * (actions_list/run/inspect outputs, composer reference serialization)
 * consumes ONLY this type: human-only fields (e.g. `icon`) stay out of the
 * Pick, so they structurally cannot leak. Widening the Pick is an
 * intentional, review-visible decision.
 */
export type AgentActionView = Pick<
  ProjectActionSummary,
  | 'id'
  | 'label'
  | 'sourceLayer'
  | 'visibility'
  | 'approval'
  | 'command'
  | 'cwd'
  | 'detail'
  | 'inputs'
  | 'runOptions'
  | 'presentation'
  | 'extends'
>;

/** Per-layer load status; per-entry faults degrade here, never block the catalog. */
export interface ActionSourceStatus {
  layer: ActionSourceLayer;
  path: string;
  available: boolean;
  reason?: 'definition-not-found' | 'parse-error' | 'unsupported-version';
  /**
   * Whether the layer's file exists on disk (T61). A session layer's file may
   * be absent while the layer itself is healthy (empty, not degraded) — UI
   * "open config" affordances gate on this, not on `available`.
   */
  exists?: boolean;
  /** Per-entry validation messages collected during loading. */
  errors: string[];
}

export interface ActionsCatalog {
  apiVersion: 1;
  /** Absolute workspace root this catalog was resolved for. */
  workspace: string;
  sources: ActionSourceStatus[];
  actions: ProjectActionSummary[];
  runs: ActionRunSummary[];
  /**
   * Session-pinned input values of the requesting session (T38):
   * actionId -> values. Present only when the request identifies a
   * resolvable session; other sessions' pins are never exposed.
   */
  sessionParams?: Record<string, Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Runs and the unified conflict protocol
// ---------------------------------------------------------------------------

export type ActionRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface ActionRunSummary {
  id: string;
  actionId: string;
  /** Absolute workspace root the run is bound to. */
  workspace: string;
  /**
   * Runtime session scope the run belongs to (T14): run state — conflict
   * keys, listing, retention — is isolated per session. Optional on the wire
   * for compatibility; the Host always sets it.
   */
  sessionId?: string;
  /**
   * Resolved input values this run started with (T33); part of the conflict
   * signature. Optional on the wire for compatibility.
   */
  params?: Record<string, string>;
  status: ActionRunStatus;
  startedAt: number;
  finishedAt?: number;
  exitCode?: number | null;
}

/**
 * Result of a run request. The Host only produces structured outcomes;
 * every entry (human UI / Agent / automation) projects them on its own.
 *
 * `approval-declined` (T29) is distinct from the conflict protocol's
 * `rejected`: no instance exists or was requested — the asking user declined,
 * cancelled, or no approval channel was available.
 */
export type RunStartResult =
  | { kind: 'started'; run: ActionRunSummary }
  | { kind: 'already-running'; run: ActionRunSummary }
  | { kind: 'rejected'; reason: 'exclusive'; run: ActionRunSummary }
  | { kind: 'approval-declined'; actionId: string; outcome: 'rejected' | 'cancelled' | 'unavailable' };

// ---------------------------------------------------------------------------
// Streaming (NDJSON frames over the authenticated fetch channel)
// ---------------------------------------------------------------------------

export type RunStreamFrame =
  | {
      type: 'output';
      runId: string;
      /** Byte offset of this chunk in the run's full output, for resume-after-reconnect. */
      offset: number;
      text: string;
      /**
       * Two distinct loss signals sharing one flag: on LIVE frames it means
       * the shell reported a lossy read (see the spill path on inspect); on
       * REPLAY frames (stream resume) it means the run's ring buffer already
       * dropped bytes older than `offset`.
       */
      truncated?: boolean;
    }
  | { type: 'status'; run: ActionRunSummary };

/**
 * Session-scoped run discovery feed (T16H): creation/status updates only —
 * output content stays on the per-run stream endpoint.
 */
export type RunDiscoveryFrame =
  /** Exactly once, as the first frame: every run this session currently has. */
  | { type: 'snapshot'; runs: ActionRunSummary[] }
  /** A run of this session was created or changed status. */
  | { type: 'status'; run: ActionRunSummary };

/**
 * Catalog change feed (T21): the first frame arrives immediately with the
 * full assembled catalog; later frames follow configuration changes detected
 * by the polling watcher.
 */
export interface CatalogEventFrame {
  type: 'catalog';
  catalog: ActionsCatalog;
}
