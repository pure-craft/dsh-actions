import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseJsonc } from 'jsonc-parser';
import { updateActionPresentation } from '../src/host/config/presentation-store.js';
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function fixture(text: string) {
  const directory = await mkdtemp(join(tmpdir(), 'actions-presentation-')); directories.push(directory);
  const path = join(directory, 'actions.json'); await writeFile(path, text);
  return { path, expectedRevision: createHash('sha256').update(text).digest('hex') };
}
describe('presentation file writes', () => {
  it('patches favorite without losing comments or other metadata', async () => {
    const text = '{\n  // Header\n  "version": "1.0.0",\n  "custom": 1,\n  "actions": [\n    // Check docs\n    { "label": "a", "command": "echo a", "custom": 2 },\n  ]\n}\n';
    const file = await fixture(text);
    await updateActionPresentation(file.path, { expectedRevision: file.expectedRevision, label: 'a', favorite: true });
    const next = await readFile(file.path, 'utf8');
    expect(next).toContain('// Header'); expect(next).toContain('// Check docs');
    expect(parseJsonc(next)).toMatchObject({ custom: 1, actions: [{ label: 'a', favorite: true, custom: 2 }] });
  });
  it.each([false, true])('reorders raw objects and attached comments (trailing comma %s)', async (trailing) => {
    const text = '{\n "version":"1.0.0",\n "actions":[\n  // A\n  {"label":"a","command":"echo a"}, // after A\n  // B\n  {"label":"b","command":"echo b"},\n  // C\n  {"label":"c","command":"echo c"}' + (trailing ? ',' : '') + '\n ]\n}';
    const file = await fixture(text);
    await updateActionPresentation(file.path, { expectedRevision: file.expectedRevision, labels: ['c', 'a', 'b'] });
    const next = await readFile(file.path, 'utf8');
    expect(parseJsonc(next).actions.map((entry: { label: string }) => entry.label)).toEqual(['c', 'a', 'b']);
    expect(next).toContain('// A'); expect(next).toContain('// B'); expect(next).toContain('// C'); expect(next).toContain('// after A');
    expect(next.indexOf('// C')).toBeLessThan(next.indexOf('"label":"c"'));
  });
  it('preserves one-line arrays and comment text containing commas', async () => {
    const text = '{"version":"1.0.0","actions":[{"label":"a","command":"a"}, {"label":"b","command":"b"}]}';
    const file = await fixture(text);
    await updateActionPresentation(file.path, { expectedRevision: file.expectedRevision, labels: ['b', 'a'] });
    expect(parseJsonc(await readFile(file.path, 'utf8')).actions.map((entry: { label: string }) => entry.label)).toEqual(['b', 'a']);
  });
  it('moves trailing comments intact and never edits commas inside comments', async () => {
    const text = '{"version":"1.0.0","actions":[\n {"label":"a","command":"a"} /* comma, keep */,\n {"label":"b","command":"b"} // final, note\n]}';
    const file = await fixture(text);
    await updateActionPresentation(file.path, { expectedRevision: file.expectedRevision, labels: ['b', 'a'] });
    const next = await readFile(file.path, 'utf8');
    expect(next).toContain('/* comma, keep */');
    expect(next).toMatch(/"label":"b"[^\n]*\/\/ final, note/);
    expect(parseJsonc(next).actions.map((entry: {label:string}) => entry.label)).toEqual(['b', 'a']);
  });
  it('supports separators on a line after an end-of-line comment', async () => {
    const text = '{"version":"1.0.0","actions":[\n {"label":"a","command":"a"} // A\n , {"label":"b","command":"b"}\n]}';
    const file = await fixture(text);
    await updateActionPresentation(file.path, { expectedRevision: file.expectedRevision, labels: ['b', 'a'] });
    const next = await readFile(file.path, 'utf8');
    expect(next).toContain('// A');
    expect(parseJsonc(next).actions.map((entry: {label:string}) => entry.label)).toEqual(['b', 'a']);
  });
  it('rejects stale revisions and incomplete orders without touching the file', async () => {
    const text = '{"version":"1.0.0","actions":[{"label":"a","command":"a"},{"label":"b","command":"b"}]}';
    const file = await fixture(text);
    await expect(updateActionPresentation(file.path, { expectedRevision: 'old', labels: ['a', 'b'] })).rejects.toMatchObject({ code: 'stale-revision' });
    await expect(updateActionPresentation(file.path, { expectedRevision: file.expectedRevision, labels: ['a'] })).rejects.toMatchObject({ code: 'invalid-order' });
    expect(await readFile(file.path, 'utf8')).toBe(text);
  });
  it('serializes concurrent changes so one stale snapshot cannot overwrite another', async () => {
    const text = '{"version":"1.0.0","actions":[{"label":"a","command":"a"},{"label":"b","command":"b"}]}';
    const file = await fixture(text);
    const results = await Promise.allSettled([
      updateActionPresentation(file.path, { expectedRevision: file.expectedRevision, label: 'a', favorite: true }),
      updateActionPresentation(file.path, { expectedRevision: file.expectedRevision, labels: ['b', 'a'] }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(parseJsonc(await readFile(file.path, 'utf8')).actions[0]).toMatchObject({ label: 'a', favorite: true });
  });
});
