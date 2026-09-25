import { ACTIONS_FILE_VERSION } from './contract.js';
import { actionEntrySchema } from './host/config/schema.js';
import type {
  ActionInputConfig,
  ActionInputType,
  ActionApprovalRequirement,
  ActionInstancePolicy,
  ActionPanelMode,
  ActionRunStatus,
  ActionSourceLayer,
  ActionVisibility,
  ActionsCatalog,
  ActionsFileConfig,
  ProjectActionSummary,
  ActionRunSummary,
  ActionSourceStatus,
  CatalogEventFrame,
  RunDiscoveryFrame,
  RunStartResult,
  RunStreamFrame,
} from './contract.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

function isLayer(value: unknown): value is ActionSourceLayer {
  return value === 'global' || value === 'workspace' || value === 'session';
}

function isVisibility(value: unknown): value is ActionVisibility {
  return value === 'all' || value === 'ui' || value === 'agent';
}

function isInstancePolicy(value: unknown): value is ActionInstancePolicy {
  return value === 'reuse' || value === 'reject';
}

function isApprovalRequirement(value: unknown): value is ActionApprovalRequirement {
  return value === 'never' || value === 'agent' || value === 'always';
}

function isApprovalDeclineOutcome(value: unknown): value is 'rejected' | 'cancelled' | 'unavailable' {
  return value === 'rejected' || value === 'cancelled' || value === 'unavailable';
}

function isPanelMode(value: unknown): value is ActionPanelMode {
  return value === 'new' || value === 'dedicated' || value === 'append';
}

function isPresentation(value: unknown): boolean {
  return isRecord(value) && (value.panel === undefined || isPanelMode(value.panel));
}

function isInputType(value: unknown): value is ActionInputType {
  return value === 'string' || value === 'select';
}

function optionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === 'boolean';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/**
 * Validate one input declaration. `context` prefixes error messages
 * (e.g. `Invalid action entry "build"`).
 */
function parseActionInputConfig(value: unknown, context: string): void {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id.length === 0 || value.id.includes('}')) {
    throw new TypeError(`${context}: inputs entry missing id`);
  }
  const prefix = `${context}: input "${value.id}"`;
  if (!isInputType(value.type)) throw new TypeError(`${prefix}: type`);
  if (!optionalString(value.description)) throw new TypeError(`${prefix}: description`);
  if (!optionalBoolean(value.required)) throw new TypeError(`${prefix}: required`);
  if (!optionalString(value.default)) throw new TypeError(`${prefix}: default`);
  if (value.type === 'select') {
    if (!isStringArray(value.options) || value.options.length === 0) {
      throw new TypeError(`${prefix}: select requires a non-empty options array`);
    }
    if (typeof value.default === 'string' && !value.options.includes(value.default)) {
      throw new TypeError(`${prefix}: default must be one of options`);
    }
  } else if (value.options !== undefined && !isStringArray(value.options)) {
    throw new TypeError(`${prefix}: options`);
  }
}

/** Validate an `inputs` array (shared by entry config and summary parsing). */
function isInputs(value: unknown, context: string): value is ActionInputConfig[] {
  if (!Array.isArray(value)) return false;
  const seen = new Set<string>();
  for (const entry of value) {
    parseActionInputConfig(entry, context);
    const id = (entry as ActionInputConfig).id;
    if (seen.has(id)) throw new TypeError(`${context}: duplicate input id "${id}"`);
    seen.add(id);
  }
  return true;
}

function isRunStatus(value: unknown): value is ActionRunStatus {
  return value === 'queued' || value === 'running' || value === 'succeeded' || value === 'failed' || value === 'cancelled';
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function optionalNumber(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value));
}

// ---------------------------------------------------------------------------
// Configuration file
// ---------------------------------------------------------------------------

export function parseActionsFileConfig(value: unknown): ActionsFileConfig {
  if (!isRecord(value) || typeof value.version !== 'string') {
    throw new TypeError('Invalid actions file: missing version');
  }
  if (value.version !== ACTIONS_FILE_VERSION) {
    throw new TypeError(`Unsupported actions file version: ${value.version}`);
  }
  if (value.actions !== undefined) {
    if (!Array.isArray(value.actions)) throw new TypeError('Invalid actions file: actions must be an array');
    value.actions.forEach((entry, index) => parseActionEntryConfig(entry, index));
  }
  return value as unknown as ActionsFileConfig;
}

/** Join a zod issue path: `inputs[0].options`-style. */
function formatIssuePath(path: PropertyKey[]): string {
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${segment}]`;
    else out += out === '' ? String(segment) : `.${String(segment)}`;
  }
  return out;
}

/** One field-level validation issue (T63b): entry-relative path + message. */
export interface EntryIssue {
  /** Entry-relative location, e.g. `inputs[0].options`; '' for the entry root. */
  path: string;
  message: string;
}

/**
 * Non-throwing entry validation (T63b): every zod issue mapped to
 * `{path, message}` (entry-relative paths). Consumers that need ALL issues at
 * once (e.g. actions_register's self-correcting invalid-entry result) use
 * this; the throwing parser below stays the file-loading gate.
 */
export function validateActionEntryConfig(value: unknown): EntryIssue[] {
  const result = actionEntrySchema.safeParse(value);
  if (result.success) return [];
  return result.error.issues.map((issue) => ({ path: formatIssuePath(issue.path), message: issue.message }));
}

/**
 * Validate one action entry through the zod schema (T63a). Throws a TypeError
 * whose message is the precise `actions[<index>].<path>: <message>` form —
 * the config banner's error-details channel carries these strings verbatim,
 * so field-level location reaches the UI unchanged.
 */
export function parseActionEntryConfig(value: unknown, index?: number): void {
  const issues = validateActionEntryConfig(value);
  const first = issues[0];
  if (first === undefined) return;
  const prefix = index === undefined ? 'actions' : `actions[${index}]`;
  throw new TypeError(first.path === '' ? `${prefix}: ${first.message}` : `${prefix}.${first.path}: ${first.message}`);
}

// ---------------------------------------------------------------------------
// Catalog payloads
// ---------------------------------------------------------------------------

export function parseProjectActionSummary(value: unknown): ProjectActionSummary {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.label !== 'string' ||
    !isLayer(value.sourceLayer) ||
    !isVisibility(value.visibility) ||
    !isApprovalRequirement(value.approval) ||
    typeof value.command !== 'string' ||
    typeof value.cwd !== 'string' ||
    !optionalString(value.extends) ||
    !optionalString(value.detail) ||
    !optionalString(value.icon) ||
    (value.env !== undefined && !isStringRecord(value.env)) ||
    !isRecord(value.runOptions) ||
    !Number.isFinite(value.runOptions.instanceLimit) ||
    !isInstancePolicy(value.runOptions.instancePolicy) ||
    (value.presentation !== undefined && !isPresentation(value.presentation))
  ) {
    throw new TypeError('Invalid project action summary');
  }
  if (value.inputs !== undefined && !isInputs(value.inputs, 'Invalid project action summary')) {
    throw new TypeError('Invalid project action summary');
  }
  return value as unknown as ProjectActionSummary;
}

export function parseActionSourceStatus(value: unknown): ActionSourceStatus {
  if (
    !isRecord(value) ||
    !isLayer(value.layer) ||
    typeof value.path !== 'string' ||
    typeof value.available !== 'boolean' ||
    (value.reason !== undefined &&
      value.reason !== 'definition-not-found' &&
      value.reason !== 'parse-error' &&
      value.reason !== 'unsupported-version') ||
    (value.exists !== undefined && typeof value.exists !== 'boolean') ||
    !Array.isArray(value.errors) ||
    !value.errors.every((entry) => typeof entry === 'string')
  ) {
    throw new TypeError('Invalid action source status');
  }
  return value as unknown as ActionSourceStatus;
}

export function parseActionRunSummary(value: unknown): ActionRunSummary {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.actionId !== 'string' ||
    typeof value.workspace !== 'string' ||
    !optionalString(value.sessionId) ||
    (value.params !== undefined && !isStringRecord(value.params)) ||
    !isRunStatus(value.status) ||
    !Number.isFinite(value.startedAt) ||
    !optionalNumber(value.finishedAt) ||
    !(value.exitCode === undefined || value.exitCode === null || optionalNumber(value.exitCode))
  ) {
    throw new TypeError('Invalid action run summary');
  }
  return value as unknown as ActionRunSummary;
}

export function parseActionsCatalog(value: unknown): ActionsCatalog {
  if (!isRecord(value) || value.apiVersion !== 1 || typeof value.workspace !== 'string') {
    throw new TypeError('Invalid DSH Actions catalog envelope');
  }
  if (!Array.isArray(value.sources) || !Array.isArray(value.actions) || !Array.isArray(value.runs)) {
    throw new TypeError('Invalid DSH Actions catalog collections');
  }
  if (
    value.sessionParams !== undefined &&
    (!isRecord(value.sessionParams) || !Object.values(value.sessionParams).every((entry) => isStringRecord(entry)))
  ) {
    throw new TypeError('Invalid DSH Actions catalog sessionParams');
  }
  for (const source of value.sources) parseActionSourceStatus(source);
  for (const action of value.actions) parseProjectActionSummary(action);
  for (const run of value.runs) parseActionRunSummary(run);
  return value as unknown as ActionsCatalog;
}

// ---------------------------------------------------------------------------
// Conflict protocol and streaming
// ---------------------------------------------------------------------------

export function parseRunStartResult(value: unknown): RunStartResult {
  if (!isRecord(value)) throw new TypeError('Invalid run start result');
  // T29: approval declines carry no run — no instance was ever requested.
  if (value.kind === 'approval-declined') {
    if (typeof value.actionId !== 'string' || !isApprovalDeclineOutcome(value.outcome)) {
      throw new TypeError('Invalid run start result');
    }
    return value as unknown as RunStartResult;
  }
  if (!('run' in value)) throw new TypeError('Invalid run start result');
  if (value.kind === 'started' || value.kind === 'already-running') {
    parseActionRunSummary(value.run);
    return value as unknown as RunStartResult;
  }
  if (value.kind === 'rejected' && value.reason === 'exclusive') {
    parseActionRunSummary(value.run);
    return value as unknown as RunStartResult;
  }
  throw new TypeError('Invalid run start result');
}

export function parseRunStreamFrame(value: unknown): RunStreamFrame {
  if (!isRecord(value)) throw new TypeError('Invalid run stream frame');
  if (value.type === 'output') {
    if (
      typeof value.runId !== 'string' ||
      !Number.isFinite(value.offset) ||
      typeof value.text !== 'string' ||
      (value.truncated !== undefined && typeof value.truncated !== 'boolean')
    ) {
      throw new TypeError('Invalid run stream output frame');
    }
    return value as unknown as RunStreamFrame;
  }
  if (value.type === 'status') {
    parseActionRunSummary(value.run);
    return value as unknown as RunStreamFrame;
  }
  throw new TypeError('Invalid run stream frame');
}

export function parseRunDiscoveryFrame(value: unknown): RunDiscoveryFrame {
  if (!isRecord(value)) throw new TypeError('Invalid run discovery frame');
  if (value.type === 'snapshot') {
    if (!Array.isArray(value.runs)) throw new TypeError('Invalid run discovery snapshot frame');
    for (const run of value.runs) parseActionRunSummary(run);
    return value as unknown as RunDiscoveryFrame;
  }
  if (value.type === 'status') {
    parseActionRunSummary(value.run);
    return value as unknown as RunDiscoveryFrame;
  }
  throw new TypeError('Invalid run discovery frame');
}

export function parseCatalogEventFrame(value: unknown): CatalogEventFrame {
  if (!isRecord(value) || value.type !== 'catalog') throw new TypeError('Invalid catalog event frame');
  parseActionsCatalog(value.catalog);
  return value as unknown as CatalogEventFrame;
}
