import { parse as parseJsonc, printParseErrorCode } from 'jsonc-parser';
import type { ParseError } from 'jsonc-parser';
import { ACTIONS_FILE_VERSION } from '../../contract.js';
import type { ActionEntryConfig, ActionSourceLayer, ActionSourceStatus } from '../../contract.js';
import { parseActionEntryConfig } from '../../wire.js';

/** File IO abstraction: read a UTF-8 text file; throw (e.g. ENOENT) when absent. */
export type ReadFileText = (path: string) => Promise<string>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// JSONC parsing with per-entry fault tolerance
// ---------------------------------------------------------------------------

/** Successfully parsed file: the entries plus the top-level session-only `folders` (T66). */
export interface ParsedActionsFile {
  ok: true;
  entries: ActionEntryConfig[];
  folders?: string[];
  errors: string[];
}

export type ParseActionsFileResult =
  | ParsedActionsFile
  | { ok: false; reason: 'parse-error' | 'unsupported-version'; errors: string[] };

/**
 * Read the top-level session-only `folders` list (T66). A malformed value is
 * a *field-level* fault, not a whole-file one: the entries still load and the
 * problem is reported in `errors` — the same tolerance individual invalid
 * entries get. Silently ignoring it is exactly the failure mode this field
 * must not have.
 */
function readFolders(value: unknown, errors: string[]): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string' && entry.length > 0)) {
    errors.push('Invalid actions file: folders must be an array of non-empty strings');
    return undefined;
  }
  return value as string[];
}

/**
 * Parse `actions.json` JSONC text. Syntax errors and an unsupported/missing
 * `version` fail the whole file; individual invalid entries are skipped and
 * collected as messages so the rest of the file still loads.
 */
export function parseActionsFileText(text: string): ParseActionsFileResult {
  const syntaxErrors: ParseError[] = [];
  const value: unknown = parseJsonc(text, syntaxErrors, { allowTrailingComma: true });
  if (syntaxErrors.length > 0) {
    return {
      ok: false,
      reason: 'parse-error',
      errors: syntaxErrors.map(
        (error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`,
      ),
    };
  }
  if (!isRecord(value) || typeof value.version !== 'string') {
    return { ok: false, reason: 'parse-error', errors: ['Invalid actions file: missing version'] };
  }
  if (value.version !== ACTIONS_FILE_VERSION) {
    return {
      ok: false,
      reason: 'unsupported-version',
      errors: [`Unsupported actions file version: ${value.version}`],
    };
  }
  const errors: string[] = [];
  const folders = readFolders(value.folders, errors);
  const result: ParsedActionsFile = { ok: true, entries: [], errors };
  if (folders !== undefined) result.folders = folders;
  if (value.actions === undefined) return result;
  if (!Array.isArray(value.actions)) {
    return { ok: false, reason: 'parse-error', errors: ['Invalid actions file: actions must be an array'] };
  }
  const entries: ActionEntryConfig[] = [];
  value.actions.forEach((entry, index) => {
    try {
      // Wire validator (zod schema, T63a) with the entry's real index — the
      // thrown message already carries the full `actions[i].<path>` location.
      parseActionEntryConfig(entry, index);
      entries.push(entry as ActionEntryConfig);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  });
  result.entries = entries;
  return result;
}

// ---------------------------------------------------------------------------
// Per-layer loading
// ---------------------------------------------------------------------------

export interface LoadedConfigLayer {
  status: ActionSourceStatus;
  /** Valid entries only; invalid ones are reported in `status.errors`. */
  entries: ActionEntryConfig[];
  /**
   * T66: the layer's declared `folders`, present only for the session layer —
   * the field is meaningless anywhere else and is reported as an error there.
   */
  folders?: string[];
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

/**
 * Load one configuration layer. A missing file degrades to
 * `definition-not-found`; the load never throws.
 *
 * `folder` tags the loaded source when it is one of the session's selected
 * action directories (T66): several such sources share `layer: 'folder'`, so
 * only this field tells them apart downstream.
 */
export async function loadConfigLayer(
  layer: ActionSourceLayer,
  path: string,
  readFile: ReadFileText,
  folder?: string,
): Promise<LoadedConfigLayer> {
  const tagged = folder === undefined
    ? { layer, path }
    : { layer, path, folder };
  let text: string;
  try {
    text = await readFile(path);
  } catch (error) {
    if (isNotFound(error)) {
      return {
        status: { ...tagged, available: false, reason: 'definition-not-found', exists: false, errors: [] },
        entries: [],
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: { ...tagged, available: false, reason: 'parse-error', exists: true, errors: [`Failed to read: ${message}`] },
      entries: [],
    };
  }
  const parsed = parseActionsFileText(text);
  if (!parsed.ok) {
    return {
      status: { ...tagged, available: false, reason: parsed.reason, exists: true, errors: parsed.errors },
      entries: [],
    };
  }
  const loaded: LoadedConfigLayer = {
    status: { ...tagged, available: true, exists: true, errors: parsed.errors },
    entries: parsed.entries,
  };
  if (parsed.folders === undefined) return loaded;
  if (layer !== 'session') {
    // T66: only the session layer may select folders. Report it loudly — an
    // ignored field would look like it worked.
    loaded.status.errors.push(
      `"folders" is only allowed in the session-layer actions.json; ignored in this ${layer} file`,
    );
    return loaded;
  }
  loaded.folders = parsed.folders;
  return loaded;
}
