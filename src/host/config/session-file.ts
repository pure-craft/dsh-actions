/**
 * Session-layer actions file writer (T47).
 *
 * Writes one entry into `<sessionDir>/actions.json`: the directory is created
 * when missing, an existing file is parsed (JSONC) and the entry with the
 * same label is replaced in place, otherwise the entry appends. The write is
 * atomic (temp file + rename). The file is plugin-generated, so writes are
 * plain pretty-printed JSON (valid JSONC); hand-written comments in a
 * pre-existing file are preserved only while it stays parseable, not across
 * a rewrite.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parse as parseJsonc, printParseErrorCode } from 'jsonc-parser';
import type { ParseError } from 'jsonc-parser';
import { ACTIONS_FILE_VERSION } from '../../contract.js';
import type { ActionEntryConfig } from '../../contract.js';

export interface SessionFileIO {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

const defaultIo: SessionFileIO = {
  readFile: (path) => readFile(path, 'utf8'),
  writeFile: (path, content) => writeFile(path, content, 'utf8'),
  mkdir: (path) => mkdir(path, { recursive: true }).then(() => undefined),
  rename: (from, to) => rename(from, to),
};

export class SessionFileError extends Error {
  override readonly name = 'SessionFileError';

  constructor(message: string) {
    super(message);
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT';
}

/** Read + parse an existing actions file; undefined when absent. Never clobbers a broken file. */
async function readActionsFile(path: string, io: SessionFileIO): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await io.readFile(path);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  const errors: ParseError[] = [];
  const parsed: unknown = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    throw new SessionFileError(
      `Refusing to rewrite unparseable actions file ${path}: ${printParseErrorCode(errors[0]!.error)}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SessionFileError(`Refusing to rewrite non-object actions file ${path}`);
  }
  const config = parsed as Record<string, unknown>;
  if (config.version !== ACTIONS_FILE_VERSION) {
    throw new SessionFileError(`Actions file ${path} has unsupported version: ${String(config.version)}`);
  }
  return config;
}

/** Atomic write: temp sibling + rename. */
async function writeActionsFile(path: string, config: Record<string, unknown>, io: SessionFileIO): Promise<void> {
  await io.mkdir(dirname(path));
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await io.writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`);
  await io.rename(tmp, path);
}

function entryLabel(value: unknown): unknown {
  return typeof value === 'object' && value !== null ? (value as { label?: unknown }).label : undefined;
}

/**
 * Insert or replace `entry` (matched by label) in the session actions file at
 * `path`. A syntactically broken existing file is never clobbered — it throws
 * instead.
 */
export async function writeSessionActionEntry(
  path: string,
  entry: ActionEntryConfig,
  io: SessionFileIO = defaultIo,
): Promise<void> {
  const config = (await readActionsFile(path, io)) ?? { version: ACTIONS_FILE_VERSION, actions: [] };
  const actions = Array.isArray(config.actions) ? [...(config.actions as unknown[])] : [];
  const index = actions.findIndex((existing) => entryLabel(existing) === entry.label);
  if (index >= 0) actions[index] = entry;
  else actions.push(entry);
  config.actions = actions;
  await writeActionsFile(path, config, io);
}

/**
 * Remove the entry with `label` from the actions file at `path` (T50).
 * Returns false when the file or the entry does not exist. A broken file is
 * never clobbered — it throws.
 */
export async function deleteActionEntryFromFile(
  path: string,
  label: string,
  io: SessionFileIO = defaultIo,
): Promise<boolean> {
  const config = await readActionsFile(path, io);
  if (config === undefined) return false;
  const actions = Array.isArray(config.actions) ? [...(config.actions as unknown[])] : [];
  const index = actions.findIndex((existing) => entryLabel(existing) === label);
  if (index < 0) return false;
  actions.splice(index, 1);
  config.actions = actions;
  await writeActionsFile(path, config, io);
  return true;
}
