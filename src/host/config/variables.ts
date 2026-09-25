import { basename } from 'node:path';

/**
 * V1 variable set: `${workspaceFolder}`, `${workspaceFolderBasename}`,
 * `${userHome}`, `${env:NAME}`, and `${input:id}` for declared parameters.
 * Unresolvable references (unknown names, missing env vars, inputs without a
 * resolved value) are left verbatim.
 */
export interface VariableContext {
  /** Absolute workspace root. */
  workspaceFolder: string;
  /** Absolute user home directory. */
  userHome: string;
  /** Environment lookup; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /**
   * Resolved input values (from `normalizeParams`). An input id absent from
   * this map keeps its `${input:id}` placeholder verbatim — the catalog keeps
   * placeholders unresolved; run evaluation passes a complete map.
   */
  inputs?: Record<string, string>;
}

const VARIABLE_PATTERN = /\$\{(workspaceFolder|workspaceFolderBasename|userHome|env:[^}]+|input:[^}]+)\}/g;

/**
 * Substitute the V1 variable set inside `text`. Replacement is verbatim —
 * values are inserted without quoting or escaping (VS Code `${input:*}`
 * semantics); injection hardening belongs to the approval flow and the
 * authoring guidance, not to this function.
 */
export function substituteVariables(text: string, context: VariableContext): string {
  return text.replace(VARIABLE_PATTERN, (match, name: string) => {
    if (name === 'workspaceFolder') return context.workspaceFolder;
    if (name === 'workspaceFolderBasename') return basename(context.workspaceFolder);
    if (name === 'userHome') return context.userHome;
    if (name.startsWith('env:')) {
      const value = (context.env ?? process.env)[name.slice('env:'.length)];
      return value === undefined ? match : value;
    }
    const value = context.inputs?.[name.slice('input:'.length)];
    return value === undefined ? match : value;
  });
}
