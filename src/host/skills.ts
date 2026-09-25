/**
 * Packaged authoring-skill registration.
 *
 * `skills/dsh-actions-authoring/SKILL.md` ships inside this package and is
 * served as a readonly runtime skill on the host `skills` registry — the same
 * authoring guide follows the installed plugin version, never a separately
 * maintained copy. The registry fills in `invocation` and `provider`
 * defaults; duplicate registration in one layer is first-wins with a warning,
 * so this stays idempotent across reloads.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export interface RuntimeSkillLike {
  name: string;
  description: string;
  source: string;
  content: string;
  path?: string;
  /** Directory the skill tool resolves bundled references/ against. */
  resourceBase?: { kind: 'directory'; path: string };
}

/** Minimal mirror of the host `skills` registry surface this bundle consumes. */
export interface SkillsLike {
  register(skill: RuntimeSkillLike): () => void;
}

export function isSkillsLike(value: unknown): value is SkillsLike {
  return typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>).register === 'function';
}

export interface SkillFrontmatter {
  name: string;
  description: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;

/**
 * Parse the flat `key: value` frontmatter this package ships. Deliberately
 * minimal — the file is ours; anything richer should fail loudly here rather
 * than drift from the registry's own parser.
 */
export function parseSkillFrontmatter(text: string): SkillFrontmatter {
  const match = FRONTMATTER.exec(text);
  if (match === null) throw new Error('authoring SKILL.md is missing YAML frontmatter');
  const fields = new Map<string, string>();
  for (const line of match[1]!.split(/\r?\n/)) {
    const entry = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.+?)\s*$/.exec(line);
    if (entry !== null) fields.set(entry[1]!, entry[2]!);
  }
  const name = fields.get('name');
  const description = fields.get('description');
  if (name === undefined || description === undefined) {
    throw new Error('authoring SKILL.md frontmatter requires name and description');
  }
  return { name, description };
}

/** The registry serves the markdown body, not the frontmatter block. */
export function stripFrontmatter(text: string): string {
  return text.replace(FRONTMATTER, '');
}

/**
 * Locate the packaged SKILL.md by walking up from this module: source layout
 * (src/host/skills.ts, two levels below root) and bundled layout (lib/index.js,
 * one level below root) differ, so neither fixed relative path fits both.
 */
function resolveAuthoringSkillPath(): URL {
  const relative = join('skills', 'dsh-actions-authoring', 'SKILL.md');
  let dir = fileURLToPath(new URL('.', import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(dir, relative);
    if (existsSync(candidate)) return pathToFileURL(candidate);
    dir = dirname(dir);
  }
  return pathToFileURL(join(fileURLToPath(new URL('.', import.meta.url)), relative));
}

export const AUTHORING_SKILL_PATH = resolveAuthoringSkillPath();

/**
 * Read the packaged SKILL.md and register it as a readonly runtime skill.
 * Resolves with the registry's own disposer.
 */
export async function registerAuthoringSkill(
  skills: SkillsLike,
  path: URL = AUTHORING_SKILL_PATH,
): Promise<() => void> {
  const text = await readFile(path, 'utf8');
  const { name, description } = parseSkillFrontmatter(text);
  return skills.register({
    name,
    description,
    source: 'bundled',
    content: stripFrontmatter(text),
    path: fileURLToPath(path),
    resourceBase: { kind: 'directory', path: fileURLToPath(new URL('.', path)) },
  });
}
