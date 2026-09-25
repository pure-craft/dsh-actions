import { homedir } from 'node:os';
import { join } from 'node:path';

/** Absolute paths of the two `actions.json` layers. */
export interface ActionsLayerPaths {
  /** Global layer: `<dshHome>/actions.json`. */
  global: string;
  /** Workspace layer: `<workspace>/.dsh/actions.json`. */
  workspace: string;
}

export interface ResolveLayerPathsOptions {
  /** Overrides `process.env.DSH_HOME`. */
  dshHome?: string;
  /** Overrides `os.homedir()`; only used when no DSH_HOME is available. */
  home?: string;
}

/** Treat empty strings as unset — `DSH_HOME=''` must not yield a cwd-relative path. */
function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value !== '' ? value : undefined;
}

/**
 * Resolve the two configuration layer paths for a workspace.
 * Global home is `process.env.DSH_HOME ?? ~/.dsh`.
 */
export function resolveActionsLayerPaths(
  workspace: string,
  options: ResolveLayerPathsOptions = {},
): ActionsLayerPaths {
  const dshHome = resolveDshHome(options);
  return {
    global: join(dshHome, 'actions.json'),
    workspace: join(workspace, '.dsh', 'actions.json'),
  };
}

/** `process.env.DSH_HOME ?? ~/.dsh` (empty strings count as unset). */
export function resolveDshHome(options: ResolveLayerPathsOptions = {}): string {
  return nonEmpty(options.dshHome) ?? nonEmpty(process.env.DSH_HOME) ?? join(options.home ?? homedir(), '.dsh');
}

// ---------------------------------------------------------------------------
// Session layer paths (T47)
//
// These two encoders MIRROR the host's session persistence layout
// (dsh-session-persistence-jsonl: sessionDir = sessions/<projectKey(cwd)>/
// <encodeSegment(sessionId)>) — session-local artifacts share the session
// directory, which the host reserves for exactly this purpose. Tests pin the
// rules against table-driven cases; if the host changes them, update both.
// ---------------------------------------------------------------------------

/**
 * Mirror of the host's encodeSegment: every unsafe code unit becomes `~XXXX`
 * (uppercase hex, 4-padded); `~` itself is escaped; `.`/`..` are fully
 * escaped against traversal. Operates on code units (lone surrogates kept).
 */
export function encodeSegment(raw: string): string {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment');
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index);
    const ch = String.fromCharCode(code);
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return out;
}

/**
 * Mirror of the host's projectKey: separator runs (/ \ :) collapse to one
 * `-`, unsafe units use the `~XXXX` escape, leading dashes are stripped, the
 * readable core is truncated to 251 chars, wrapped as `--<core>--`
 * (intentionally lossy, human-navigable).
 */
export function projectKey(cwd: string): string {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path');
  let readable = '';
  let separatorRun = false;
  for (let index = 0; index < cwd.length; index += 1) {
    const code = cwd.charCodeAt(index);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

/**
 * The session layer's actions file:
 * `<dshHome>/sessions/<projectKey(cwd)>/<encodeSegment(sessionId)>/actions.json`
 * (`_no-cwd` project dir when cwd is unknown, mirroring the host).
 */
export function sessionActionsPath(dshHome: string, cwd: string | undefined, sessionId: string): string {
  const project = cwd === undefined ? '_no-cwd' : projectKey(cwd);
  return join(dshHome, 'sessions', project, encodeSegment(sessionId), 'actions.json');
}

