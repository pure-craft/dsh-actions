import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type {
  ActionEntryConfig,
  ActionSourceLayer,
  ActionsCatalog,
  ProjectActionSummary,
} from '../contract.js';
import { loadConfigLayer } from './config/load.js';
import type { ReadFileText } from './config/load.js';
import { mergeActionEntries, mergeActionEntry } from './config/merge.js';
import { resolveActionsLayerPaths, resolveDshHome, sessionActionsPath } from './config/paths.js';
import type { LoadedConfigLayer } from './config/load.js';
import { substituteVariables } from './config/variables.js';
import type { VariableContext } from './config/variables.js';

export interface LoadActionsCatalogOptions {
  /** File IO injection for tests; defaults to `fs/promises.readFile` (UTF-8). */
  readFile?: ReadFileText;
  /** Overrides `process.env.DSH_HOME` for the global layer. */
  dshHome?: string;
  /** Overrides `os.homedir()`; used for `${userHome}` and the default global home. */
  home?: string;
  /** Environment lookup for `${env:NAME}`; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Calling session id: adds the session layer (T47) when present. */
  sessionId?: string;
}

const defaultReadFile: ReadFileText = (path) => readFile(path, 'utf8');

function clampInstanceLimit(limit: number): number {
  // T61: NaN guard, aligned with the run service's own clamp.
  if (!Number.isFinite(limit)) return 1;
  return Math.max(1, Math.floor(limit));
}

/**
 * Normalize one merged config entry into a `ProjectActionSummary`:
 * variable substitution, defaults, absolute cwd, and the stable id
 * `<layer>:<label>` (merged entries carry the workspace layer).
 *
 * `${input:id}` placeholders stay verbatim here — inputs are declared on the
 * summary and resolved per run via `normalizeParams` + `substituteVariables`
 * with the run's values. (`context.inputs` is honored when a caller sets it.)
 */
export function normalizeActionEntry(
  entry: ActionEntryConfig,
  layer: ActionSourceLayer,
  context: VariableContext,
): ProjectActionSummary {
  const substitute = (text: string): string => substituteVariables(text, context);
  const rawCwd = entry.options?.cwd;
  const cwd = rawCwd === undefined
    ? context.workspaceFolder
    : resolve(context.workspaceFolder, substitute(rawCwd));
  const summary: ProjectActionSummary = {
    id: `${layer}:${entry.label}`,
    label: entry.label,
    sourceLayer: layer,
    visibility: entry.visibility ?? 'all',
    approval: entry.approval ?? 'never',
    // Orphan extends entries (unresolved reference) keep the ref on the
    // summary and answer unknown-extends at run time; give them a placeholder
    // command instead of crashing the whole catalog assembly.
    command: substitute(entry.command ?? `echo "unknown extends: ${entry.extends ?? ''}"`),
    cwd,
    runOptions: {
      instanceLimit: clampInstanceLimit(entry.runOptions?.instanceLimit ?? 1),
      instancePolicy: entry.runOptions?.instancePolicy ?? 'reuse',
    },
  };
  if (entry.detail !== undefined) summary.detail = substitute(entry.detail);
  // T65: ui-only display metadata, carried verbatim (Iconify code).
  if (entry.icon !== undefined) summary.icon = entry.icon;
  const panel = entry.presentation?.panel;
  if (panel !== undefined) summary.presentation = { panel };
  if (entry.inputs !== undefined && entry.inputs.length > 0) summary.inputs = entry.inputs;
  // T47: an unresolved extends reference rides the summary; running it errors.
  if (entry.extends !== undefined) summary.extends = entry.extends;
  const env = entry.options?.env;
  if (env !== undefined && Object.keys(env).length > 0) {
    summary.env = Object.fromEntries(Object.entries(env).map(([key, value]) => [key, substitute(value)]));
  }
  return summary;
}

/**
 * T47: load the session layer for one caller session. A missing file is an
 * EMPTY layer, not a degradation — the session layer has no "not found"
 * banner semantics, so the status reports available with zero errors.
 */
async function loadSessionLayer(dshHome: string, workspace: string, sessionId: string, read: ReadFileText) {
  const path = sessionActionsPath(dshHome, workspace, sessionId);
  const loaded = await loadConfigLayer('session', path, read);
  if (loaded.status.reason === 'definition-not-found') {
    // Empty-but-healthy, and honestly file-less: available WITHOUT exists, so
    // "open config" affordances (which gate on `exists`, T61) stay hidden.
    const empty: LoadedConfigLayer = {
      status: { layer: 'session', path, available: true, exists: false, errors: [] },
      entries: [],
    };
    return empty;
  }
  return loaded;
}

/**
 * Fully-resolved form of every resolvable raw entry, by `${layer}:${label}`.
 * Fixpoint: an entry whose target is already resolved merges that target in
 * and drops its reference; the loop repeats until a pass changes nothing, so
 * chains resolve in ANY declaration order. Entries in a cycle (or pointing at
 * nothing) never resolve.
 */
function computeResolvedEntries(rawById: ReadonlyMap<string, ActionEntryConfig>): ReadonlyMap<string, ActionEntryConfig> {
  const resolved = new Map<string, ActionEntryConfig>();
  for (const [id, entry] of rawById) {
    if (entry.extends === undefined) resolved.set(id, entry);
  }
  for (;;) {
    let progressed = false;
    for (const [id, entry] of rawById) {
      if (entry.extends === undefined || resolved.has(id)) continue;
      const target = resolved.get(entry.extends);
      if (target === undefined) continue;
      const { extends: _consumed, ...combined } = mergeActionEntry(target, entry);
      resolved.set(id, combined);
      progressed = true;
    }
    if (!progressed) return resolved;
  }
}

/**
 * T47/T61: resolve `extends` references against the RAW per-layer entries
 * (pre-merge), so a shadowed entry stays referenceable by its own layer id —
 * `extends: "global:build"` means the global file's own "build" even when a
 * higher layer overrides it (semantics decided in T61). The fixpoint makes
 * chains order-independent (T55b-1: single-pass resolution silently dropped a
 * dependent's reference when it was declared before its base, producing a
 * command-less "ghost" action). Unknown/cyclic references stay on the entry
 * (and the summary) so RUNNING them errors with a structured unknown-extends;
 * the definition itself still loads.
 */
function resolveEntryExtends(
  merged: { entry: ActionEntryConfig; layer: ActionSourceLayer }[],
  rawById: ReadonlyMap<string, ActionEntryConfig>,
): void {
  const resolved = computeResolvedEntries(rawById);
  for (const item of merged) {
    if (item.entry.extends === undefined) continue;
    const target = resolved.get(item.entry.extends);
    if (target === undefined) continue; // unknown or cyclic: stays on summary
    const { extends: _consumed, ...combined } = mergeActionEntry(target, item.entry);
    item.entry = combined;
  }
}

/**
 * Load the configuration layers for `workspace` (global + workspace, plus the
 * caller session's layer when `sessionId` is given — T47), merge them by
 * label (session wins), and normalize into the catalog. `runs` is left
 * empty; the run service owns it. Never throws: every failure degrades into
 * `sources[]` statuses.
 */
export async function loadActionsCatalog(
  workspace: string,
  options: LoadActionsCatalogOptions = {},
): Promise<ActionsCatalog> {
  const read = options.readFile ?? defaultReadFile;
  const pathOptions: { dshHome?: string; home?: string } = {};
  if (options.dshHome !== undefined) pathOptions.dshHome = options.dshHome;
  if (options.home !== undefined) pathOptions.home = options.home;
  const paths = resolveActionsLayerPaths(workspace, pathOptions);
  const sessionId = options.sessionId;
  const [globalLayer, workspaceLayer, sessionLayer] = await Promise.all([
    loadConfigLayer('global', paths.global, read),
    loadConfigLayer('workspace', paths.workspace, read),
    sessionId === undefined
      ? Promise.resolve(undefined)
      : loadSessionLayer(resolveDshHome(pathOptions), workspace, sessionId, read),
  ]);
  const context: VariableContext = {
    workspaceFolder: workspace,
    userHome: options.home ?? homedir(),
  };
  if (options.env !== undefined) context.env = options.env;
  const mergedEntries = mergeActionEntries(
    globalLayer.entries,
    workspaceLayer.entries,
    sessionLayer?.entries ?? [],
  );
  // T61: extends indexes the RAW per-layer entries, not the merged winners —
  // a shadowed entry stays referenceable by its own layer id.
  const rawById = new Map<string, ActionEntryConfig>();
  const rawLayers: Array<readonly [ActionSourceLayer, ActionEntryConfig[]]> = [
    ['global', globalLayer.entries],
    ['workspace', workspaceLayer.entries],
    ['session', sessionLayer?.entries ?? []],
  ];
  for (const [layer, entries] of rawLayers) {
    for (const entry of entries) rawById.set(`${layer}:${entry.label}`, entry);
  }
  resolveEntryExtends(mergedEntries, rawById);
  const actions = mergedEntries.map((merged) => normalizeActionEntry(merged.entry, merged.layer, context));
  const sources = [globalLayer.status, workspaceLayer.status];
  if (sessionLayer !== undefined) sources.push(sessionLayer.status);
  return {
    apiVersion: 1,
    workspace,
    sources,
    actions,
    runs: [],
  };
}
