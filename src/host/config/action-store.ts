import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parse as parseJsonc, printParseErrorCode } from 'jsonc-parser';
import type { ParseError } from 'jsonc-parser';
import { ACTIONS_FILE_VERSION } from '../../contract.js';
import type { ActionEntryConfig } from '../../contract.js';
import { validateActionEntryConfig } from '../../wire.js';

export type ConfigurableActionLayer = 'global' | 'workspace' | 'session';

export interface ActionLayerSnapshot {
  path: string;
  revision: string;
  entryRevision?: string;
  entry?: ActionEntryConfig;
}

export type ActionChange =
  | { operation: 'set-field'; field: 'command' | 'detail' | 'icon' | 'visibility' | 'approval' | 'extends'; value: string }
  | { operation: 'unset-field'; field: 'command' | 'detail' | 'icon' | 'visibility' | 'approval' | 'extends' }
  | { operation: 'set-options'; value: ActionEntryConfig['options'] }
  | { operation: 'unset-options' }
  | { operation: 'set-run-options'; value: ActionEntryConfig['runOptions'] }
  | { operation: 'unset-run-options' }
  | { operation: 'set-presentation'; value: ActionEntryConfig['presentation'] }
  | { operation: 'unset-presentation' }
  | { operation: 'put-input'; input: NonNullable<ActionEntryConfig['inputs']>[number] }
  | { operation: 'remove-input'; inputId: string }
  | { operation: 'move-input'; inputId: string; beforeInputId?: string };

export class ActionStoreError extends Error {
  override readonly name = 'ActionStoreError';
  constructor(readonly code: 'invalid-file' | 'already-exists' | 'not-found' | 'stale-revision' | 'invalid-entry', message: string, readonly issues?: unknown) {
    super(message);
  }
}

const locks = new Map<string, Promise<void>>();

function revision(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableEntryRevision(entry: ActionEntryConfig): string {
  return revision(JSON.stringify(entry));
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT';
}

async function readRaw(path: string): Promise<{ text: string; config: Record<string, unknown> }> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return { text: '', config: { version: ACTIONS_FILE_VERSION, actions: [] } };
    throw error;
  }
  const errors: ParseError[] = [];
  const parsed: unknown = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) throw new ActionStoreError('invalid-file', `Cannot modify ${path}: ${printParseErrorCode(errors[0]!.error)}`);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new ActionStoreError('invalid-file', `Cannot modify non-object actions file ${path}`);
  const config = parsed as Record<string, unknown>;
  if (config.version !== ACTIONS_FILE_VERSION) throw new ActionStoreError('invalid-file', `Unsupported actions file version in ${path}: ${String(config.version)}`);
  return { text, config };
}

function entriesOf(config: Record<string, unknown>): ActionEntryConfig[] {
  return Array.isArray(config.actions) ? config.actions as ActionEntryConfig[] : [];
}

export async function inspectActionLayer(path: string, label: string): Promise<ActionLayerSnapshot> {
  const { text, config } = await readRaw(path);
  const entry = entriesOf(config).find((candidate) => candidate?.label === label);
  return {
    path,
    revision: revision(text),
    ...(entry === undefined ? {} : { entry, entryRevision: stableEntryRevision(entry) }),
  };
}

async function atomicWrite(path: string, config: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await rename(tmp, path);
}

async function serialized<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(path) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  locks.set(path, previous.then(() => current));
  await previous;
  try { return await operation(); }
  finally {
    release();
    if (locks.get(path) === current) locks.delete(path);
  }
}

function validate(entry: ActionEntryConfig): void {
  const issues = validateActionEntryConfig(entry);
  if (issues.length > 0) throw new ActionStoreError('invalid-entry', `Invalid action definition for ${entry.label}`, issues);
}

export async function createActionEntry(path: string, entry: ActionEntryConfig): Promise<void> {
  await serialized(path, async () => {
    const loaded = await readRaw(path);
    const actions = [...entriesOf(loaded.config)];
    if (actions.some((candidate) => candidate.label === entry.label)) throw new ActionStoreError('already-exists', `Action "${entry.label}" already exists in the target layer.`);
    validate(entry);
    actions.push(entry);
    loaded.config.actions = actions;
    await atomicWrite(path, loaded.config);
  });
}

export function applyActionChanges(entry: ActionEntryConfig, changes: readonly ActionChange[]): ActionEntryConfig {
  const next: ActionEntryConfig = structuredClone(entry);
  for (const change of changes) {
    if (change.operation === 'set-field') Object.assign(next, { [change.field]: change.value });
    else if (change.operation === 'unset-field') delete (next as unknown as Record<string, unknown>)[change.field];
    else if (change.operation === 'set-options') { if (change.value === undefined) delete next.options; else next.options = change.value; }
    else if (change.operation === 'unset-options') delete next.options;
    else if (change.operation === 'set-run-options') { if (change.value === undefined) delete next.runOptions; else next.runOptions = change.value; }
    else if (change.operation === 'unset-run-options') delete next.runOptions;
    else if (change.operation === 'set-presentation') { if (change.value === undefined) delete next.presentation; else next.presentation = change.value; }
    else if (change.operation === 'unset-presentation') delete next.presentation;
    else if (change.operation === 'put-input') {
      const inputs = [...(next.inputs ?? [])];
      const index = inputs.findIndex((input) => input.id === change.input.id);
      if (index < 0) inputs.push(change.input); else inputs[index] = change.input;
      next.inputs = inputs;
    } else if (change.operation === 'remove-input') {
      next.inputs = (next.inputs ?? []).filter((input) => input.id !== change.inputId);
      if (next.inputs.length === 0) delete next.inputs;
    } else {
      const inputs = [...(next.inputs ?? [])];
      const index = inputs.findIndex((input) => input.id === change.inputId);
      if (index < 0) throw new ActionStoreError('invalid-entry', `Unknown input "${change.inputId}".`);
      const [input] = inputs.splice(index, 1);
      const before = change.beforeInputId === undefined ? inputs.length : inputs.findIndex((candidate) => candidate.id === change.beforeInputId);
      if (before < 0) throw new ActionStoreError('invalid-entry', `Unknown beforeInputId "${change.beforeInputId}".`);
      inputs.splice(before, 0, input!);
      next.inputs = inputs;
    }
  }
  validate(next);
  return next;
}

export async function updateActionEntry(path: string, label: string, expectedRevision: string, changes: readonly ActionChange[]): Promise<{ before: ActionEntryConfig; after: ActionEntryConfig }> {
  return serialized(path, async () => {
    const loaded = await readRaw(path);
    const actions = [...entriesOf(loaded.config)];
    const index = actions.findIndex((candidate) => candidate.label === label);
    if (index < 0) throw new ActionStoreError('not-found', `Action "${label}" does not exist in the target layer.`);
    const before = actions[index]!;
    if (stableEntryRevision(before) !== expectedRevision) throw new ActionStoreError('stale-revision', 'Action definition changed since it was queried.');
    const after = applyActionChanges(before, changes);
    if (after.label !== before.label) throw new ActionStoreError('invalid-entry', 'Action labels cannot be renamed.');
    actions[index] = after;
    loaded.config.actions = actions;
    await atomicWrite(path, loaded.config);
    return { before, after };
  });
}

export async function deleteActionEntry(path: string, label: string, expectedRevision: string): Promise<ActionEntryConfig> {
  return serialized(path, async () => {
    const loaded = await readRaw(path);
    const actions = [...entriesOf(loaded.config)];
    const index = actions.findIndex((candidate) => candidate.label === label);
    if (index < 0) throw new ActionStoreError('not-found', `Action "${label}" does not exist in the target layer.`);
    const before = actions[index]!;
    if (stableEntryRevision(before) !== expectedRevision) throw new ActionStoreError('stale-revision', 'Action definition changed since it was queried.');
    actions.splice(index, 1);
    loaded.config.actions = actions;
    await atomicWrite(path, loaded.config);
    return before;
  });
}
