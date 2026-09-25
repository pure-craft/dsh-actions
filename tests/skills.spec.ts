import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  AUTHORING_SKILL_PATH,
  parseSkillFrontmatter,
  registerAuthoringSkill,
  stripFrontmatter,
} from '../src/host/skills.js';
import type { RuntimeSkillLike } from '../src/host/skills.js';

describe('parseSkillFrontmatter', () => {
  it('extracts name and description from the packaged SKILL.md', async () => {
    const text = await readFile(AUTHORING_SKILL_PATH, 'utf8');
    const { name, description } = parseSkillFrontmatter(text);
    expect(name).toBe('dsh-actions-authoring');
    expect(description.length).toBeGreaterThan(0);
  });

  it('rejects text without frontmatter or required fields', () => {
    expect(() => parseSkillFrontmatter('# no frontmatter')).toThrow('missing YAML frontmatter');
    expect(() => parseSkillFrontmatter('---\nname: x\n---\nbody')).toThrow('name and description');
  });
});

describe('stripFrontmatter', () => {
  it('removes only the leading frontmatter block', () => {
    expect(stripFrontmatter('---\nname: x\ndescription: y\n---\n# Body\n--- kept')).toBe('# Body\n--- kept');
  });
});

describe('registerAuthoringSkill', () => {
  it('registers the packaged skill body as a bundled runtime skill', async () => {
    const registered: RuntimeSkillLike[] = [];
    let disposed = false;
    const dispose = await registerAuthoringSkill({
      register(skill) {
        registered.push(skill);
        return () => {
          disposed = true;
        };
      },
    });

    expect(registered).toHaveLength(1);
    const skill = registered[0]!;
    expect(skill.name).toBe('dsh-actions-authoring');
    expect(skill.description.length).toBeGreaterThan(0);
    expect(skill.source).toBe('bundled');
    expect(skill.content).toContain('# DSH Actions authoring guide');
    expect(skill.content).not.toContain('name: dsh-actions-authoring');
    expect(skill.path?.endsWith('skills/dsh-actions-authoring/SKILL.md')).toBe(true);
    expect(skill.resourceBase?.kind).toBe('directory');
    expect(skill.resourceBase?.path.endsWith('skills/dsh-actions-authoring/')).toBe(true);

    dispose();
    expect(disposed).toBe(true);
  });
});
