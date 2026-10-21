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
 * Explicit extends only: fields the derived definition writes replace its
 * referenced base; unwritten fields are inherited (except favorite).
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
  const agentVisible = override.agentVisible ?? (override.visibility === undefined ? undefined : override.visibility !== 'ui')
    ?? base.agentVisible ?? (base.visibility === undefined ? undefined : base.visibility !== 'ui');
  if (agentVisible !== undefined) merged.agentVisible = agentVisible;
  // Favorites belong to this definition, never to its base.
  if (override.favorite !== undefined) merged.favorite = override.favorite;
  // Explicit derived approval wins; otherwise inherit the referenced base.
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

/** Exclude every occurrence of a duplicate label, preserving unique entry order. */
export function dedupeByLabel(entries: ActionEntryConfig[]): ActionEntryConfig[] {
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.label, (counts.get(entry.label) ?? 0) + 1);
  return entries.filter((entry) => counts.get(entry.label) === 1);
}

/** Independent sources in global/workspace/session file order; no implicit inheritance. */
export function mergeActionEntries(
  globalEntries: ActionEntryConfig[],
  workspaceEntries: ActionEntryConfig[],
  sessionEntries: ActionEntryConfig[] = [],
): MergedActionEntry[] {
  return [
    ...dedupeByLabel(globalEntries).map((entry) => ({ entry, layer: 'global' as const })),
    ...dedupeByLabel(workspaceEntries).map((entry) => ({ entry, layer: 'workspace' as const })),
    ...dedupeByLabel(sessionEntries).map((entry) => ({ entry, layer: 'session' as const })),
  ];
}
