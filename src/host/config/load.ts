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

export type ParseActionsFileResult =
  | { ok: true; entries: ActionEntryConfig[]; errors: string[] }
  | { ok: false; reason: 'parse-error' | 'unsupported-version'; errors: string[] };

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
  if (value.actions === undefined) {
    return { ok: true, entries: [], errors: [] };
  }
  if (!Array.isArray(value.actions)) {
    return { ok: false, reason: 'parse-error', errors: ['Invalid actions file: actions must be an array'] };
  }
  const entries: ActionEntryConfig[] = [];
  const errors: string[] = [];
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
  return { ok: true, entries, errors };
}

// ---------------------------------------------------------------------------
// Per-layer loading
// ---------------------------------------------------------------------------

export interface LoadedConfigLayer {
  status: ActionSourceStatus;
  /** Valid entries only; invalid ones are reported in `status.errors`. */
  entries: ActionEntryConfig[];
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

/**
 * Load one configuration layer. A missing file degrades to
 * `definition-not-found`; the load never throws.
 */
export async function loadConfigLayer(
  layer: ActionSourceLayer,
  path: string,
  readFile: ReadFileText,
): Promise<LoadedConfigLayer> {
  let text: string;
  try {
    text = await readFile(path);
  } catch (error) {
    if (isNotFound(error)) {
      return {
        status: { layer, path, available: false, reason: 'definition-not-found', exists: false, errors: [] },
        entries: [],
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: { layer, path, available: false, reason: 'parse-error', exists: true, errors: [`Failed to read: ${message}`] },
      entries: [],
    };
  }
  const parsed = parseActionsFileText(text);
  if (!parsed.ok) {
    return {
      status: { layer, path, available: false, reason: parsed.reason, exists: true, errors: parsed.errors },
      entries: [],
    };
  }
  return {
    status: { layer, path, available: true, exists: true, errors: parsed.errors },
    entries: parsed.entries,
  };
}
