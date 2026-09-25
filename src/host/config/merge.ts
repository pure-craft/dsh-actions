import type {
  ActionEntryConfig,
  ActionInputConfig,
  ActionOptionsConfig,
  ActionPresentationConfig,
  ActionRunOptionsConfig,
  ActionSourceLayer,
} from '../../contract.js';

/** An entry after the two-layer merge, tagged with the layer that owns its identity. */
export interface MergedActionEntry {
  entry: ActionEntryConfig;
  layer: ActionSourceLayer;
}

function mergeOptions(
  base: ActionOptionsConfig | undefined,
  override: ActionOptionsConfig | undefined,
): ActionOptionsConfig | undefined {
  if (base === undefined && override === undefined) return undefined;
  const merged: ActionOptionsConfig = {};
  const cwd = override?.cwd ?? base?.cwd;
  if (cwd !== undefined) merged.cwd = cwd;
  // env merges key by key; workspace keys win.
  const env: Record<string, string> = { ...base?.env, ...override?.env };
  if (Object.keys(env).length > 0) merged.env = env;
  return merged;
}

function mergeRunOptions(
  base: ActionRunOptionsConfig | undefined,
  override: ActionRunOptionsConfig | undefined,
): ActionRunOptionsConfig | undefined {
  if (base === undefined && override === undefined) return undefined;
  const merged: ActionRunOptionsConfig = {};
  const instanceLimit = override?.instanceLimit ?? base?.instanceLimit;
  if (instanceLimit !== undefined) merged.instanceLimit = instanceLimit;
  const instancePolicy = override?.instancePolicy ?? base?.instancePolicy;
  if (instancePolicy !== undefined) merged.instancePolicy = instancePolicy;
  return merged;
}

function mergePresentation(
  base: ActionPresentationConfig | undefined,
  override: ActionPresentationConfig | undefined,
): ActionPresentationConfig | undefined {
  if (base === undefined && override === undefined) return undefined;
  const merged: ActionPresentationConfig = {};
  const panel = override?.panel ?? base?.panel;
  if (panel !== undefined) merged.panel = panel;
  return merged;
}

function mergeInput(
  base: ActionInputConfig,
  override: ActionInputConfig,
): ActionInputConfig {
  const merged: ActionInputConfig = {
    id: override.id,
    type: override.type,
  };
  const description = override.description ?? base.description;
  if (description !== undefined) merged.description = description;
  const required = override.required ?? base.required;
  if (required !== undefined) merged.required = required;
  const defaultValue = override.default ?? base.default;
  if (defaultValue !== undefined) merged.default = defaultValue;
  const options = override.options ?? base.options;
  if (options !== undefined) merged.options = options;
  // Post-merge sanitization: field-wise merging can combine fields that were
  // each valid in their own layer into a contract-illegal declaration (e.g.
  // global default 'staging' + workspace options ['dev','qa']). One bad merged
  // input must never poison the whole catalog (normalizeParams would always
  // throw and wire would reject the summary), so degrade the field, not the entry:
  // - a select whose default fell outside the merged options loses its default;
  // - an input whose merged type is 'string' loses any inherited options.
  if (merged.type === 'select') {
    if (merged.default !== undefined && (merged.options === undefined || !merged.options.includes(merged.default))) {
      delete merged.default;
    }
  } else {
    delete merged.options;
  }
  return merged;
}

/**
 * Merge two `inputs` declarations by id: matched inputs merge field-wise
 * (override wins, unwritten fields inherit), override-only inputs append in
 * override order. Within one array, the last declaration of an id wins.
 */
function mergeInputs(
  base: ActionInputConfig[] | undefined,
  override: ActionInputConfig[] | undefined,
): ActionInputConfig[] | undefined {
  if (base === undefined && override === undefined) return undefined;
  const dedupe = (inputs: ActionInputConfig[]): ActionInputConfig[] => {
    const byId = new Map<string, ActionInputConfig>();
    for (const input of inputs) byId.set(input.id, input);
    return [...byId.values()];
  };
  const overrideList = dedupe(override ?? []);
  const overrideById = new Map(overrideList.map((input) => [input.id, input]));
  const merged: ActionInputConfig[] = [];
  for (const baseInput of dedupe(base ?? [])) {
    const overrideInput = overrideById.get(baseInput.id);
    if (overrideInput !== undefined) {
      merged.push(mergeInput(baseInput, overrideInput));
      overrideById.delete(baseInput.id);
    } else {
      merged.push(baseInput);
    }
  }
  for (const input of overrideList) {
    if (overrideById.has(input.id)) merged.push(input);
  }
  return merged.length > 0 ? merged : undefined;
}

/**
 * Field-wise merge (VS Code assign semantics): fields the workspace override
 * writes replace the global base; unwritten fields are inherited.
 */
export function mergeActionEntry(
  base: ActionEntryConfig,
  override: ActionEntryConfig,
): ActionEntryConfig {
  // command inherits from the base when the override omits it (extends entries
  // may legitimately carry none); every other field already follows ?? rules.
  const command = override.command ?? base.command;
  const merged: ActionEntryConfig = { label: override.label };
  if (command !== undefined) merged.command = command;
  const detail = override.detail ?? base.detail;
  if (detail !== undefined) merged.detail = detail;
  const visibility = override.visibility ?? base.visibility;
  if (visibility !== undefined) merged.visibility = visibility;
  // T29: field-wise like visibility — workspace approval wins, unwritten inherits.
  const approval = override.approval ?? base.approval;
  if (approval !== undefined) merged.approval = approval;
  const options = mergeOptions(base.options, override.options);
  if (options !== undefined) merged.options = options;
  const runOptions = mergeRunOptions(base.runOptions, override.runOptions);
  if (runOptions !== undefined) merged.runOptions = runOptions;
  const presentation = mergePresentation(base.presentation, override.presentation);
  if (presentation !== undefined) merged.presentation = presentation;
  const inputs = mergeInputs(base.inputs, override.inputs);
  if (inputs !== undefined) merged.inputs = inputs;
  // T47: extends is field-wise like any other — the override's reference wins.
  const extendsRef = override.extends ?? base.extends;
  if (extendsRef !== undefined) merged.extends = extendsRef;
  // T65: icon is field-wise like detail — the override's icon wins, unset inherits.
  const icon = override.icon ?? base.icon;
  if (icon !== undefined) merged.icon = icon;
  return merged;
}

function dedupeByLabel(entries: ActionEntryConfig[]): ActionEntryConfig[] {
  // Last definition of a label wins within one layer; order follows first occurrence.
  const byLabel = new Map<string, ActionEntryConfig>();
  for (const entry of entries) byLabel.set(entry.label, entry);
  return [...byLabel.values()];
}

/**
 * Merge the layers by label (priority: global < workspace < session, T47).
 * Matched entries merge field-wise and take the higher layer's identity;
 * unmatched entries keep their own layer. Result order: global entries
 * (merged where matched) in global order, then workspace-only entries, then
 * session-only entries.
 */
export function mergeActionEntries(
  globalEntries: ActionEntryConfig[],
  workspaceEntries: ActionEntryConfig[],
  sessionEntries: ActionEntryConfig[] = [],
): MergedActionEntry[] {
  const workspaceList = dedupeByLabel(workspaceEntries);
  const workspaceByLabel = new Map(workspaceList.map((entry) => [entry.label, entry]));
  const sessionByLabel = new Map(dedupeByLabel(sessionEntries).map((entry) => [entry.label, entry]));

  const merged: MergedActionEntry[] = [];
  for (const globalEntry of dedupeByLabel(globalEntries)) {
    // Layer the higher overrides in turn: session wins over workspace wins over global.
    const sessionOverride = sessionByLabel.get(globalEntry.label);
    const workspaceOverride = workspaceByLabel.get(globalEntry.label);
    if (sessionOverride !== undefined) {
      const base = workspaceOverride === undefined ? globalEntry : mergeActionEntry(globalEntry, workspaceOverride);
      merged.push({ entry: mergeActionEntry(base, sessionOverride), layer: 'session' });
      sessionByLabel.delete(globalEntry.label);
      workspaceByLabel.delete(globalEntry.label);
    } else if (workspaceOverride !== undefined) {
      merged.push({ entry: mergeActionEntry(globalEntry, workspaceOverride), layer: 'workspace' });
      workspaceByLabel.delete(globalEntry.label);
    } else {
      merged.push({ entry: globalEntry, layer: 'global' });
    }
  }
  for (const entry of workspaceList) {
    if (!workspaceByLabel.has(entry.label)) continue;
    const sessionOverride = sessionByLabel.get(entry.label);
    if (sessionOverride !== undefined) {
      merged.push({ entry: mergeActionEntry(entry, sessionOverride), layer: 'session' });
      sessionByLabel.delete(entry.label);
    } else {
      merged.push({ entry, layer: 'workspace' });
    }
    workspaceByLabel.delete(entry.label);
  }
  for (const entry of dedupeByLabel(sessionEntries)) {
    if (sessionByLabel.has(entry.label)) merged.push({ entry, layer: 'session' });
  }
  return merged;
}
