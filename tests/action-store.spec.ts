import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyActionChanges, inspectActionLayer, updateActionEntry, deleteActionEntry, createActionEntry } from '../src/host/config/action-store.js';

describe('createActionEntry', () => {
  it('appends against the latest layer contents without a caller revision', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-actions-store-'));
    const path = join(directory, 'actions.json');
    await writeFile(path, JSON.stringify({ version: '1.0.0', actions: [{ label: 'existing', command: 'echo existing' }] }), 'utf8');

    await createActionEntry(path, { label: 'created', command: 'echo created' });

    const saved = JSON.parse(await readFile(path, 'utf8')) as { actions: Array<{ label: string }> };
    expect(saved.actions.map(({ label }) => label)).toEqual(['existing', 'created']);
  });

  it('still rejects a same-label collision instead of upserting', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-actions-store-'));
    const path = join(directory, 'actions.json');
    await writeFile(path, JSON.stringify({ version: '1.0.0', actions: [{ label: 'existing', command: 'echo existing' }] }), 'utf8');

    await expect(createActionEntry(path, { label: 'existing', command: 'echo replacement' }))
      .rejects.toMatchObject({ code: 'already-exists' });
  });
});


describe('independent source writes', () => {
  it('rejects ambiguous duplicate files for inspection and every write', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-actions-duplicate-'));
    const path = join(directory, 'actions.json');
    const original = JSON.stringify({ version: '1.0.0', actions: [{ label: 'same', command: 'one' }, { label: 'same', command: 'two' }] });
    await writeFile(path, original);
    for (const operation of [() => inspectActionLayer(path, 'same'), () => createActionEntry(path, { label: 'other', command: 'echo ok' }), () => updateActionEntry(path, 'same', 'revision', []), () => deleteActionEntry(path, 'same', 'revision')]) {
      await expect(operation()).rejects.toMatchObject({ code: 'invalid-file' });
    }
    expect(await readFile(path, 'utf8')).toBe(original);
  });
  it('serializes concurrent writes against the latest file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-actions-concurrent-'));
    const path = join(directory, 'actions.json');
    await Promise.all(Array.from({ length: 12 }, (_, index) => createActionEntry(path, { label: `task-${index}`, command: 'echo ok', favorite: true })));
    const saved = JSON.parse(await readFile(path, 'utf8')) as { actions: unknown[] };
    expect(saved.actions).toHaveLength(12);
  });
  it('supports boolean agentVisible changes and removal; definitions accept favorite', async () => {
    const entry = { label: 'build', command: 'echo ok', favorite: true };
    const hidden = applyActionChanges(entry, [{ operation: 'set-field', field: 'agentVisible', value: false }]);
    expect(hidden).toMatchObject({ agentVisible: false, favorite: true });
    expect(applyActionChanges(hidden, [{ operation: 'unset-field', field: 'agentVisible' }])).not.toHaveProperty('agentVisible');
    expect(() => applyActionChanges(entry, [{ operation: 'set-field', field: 'agentVisible', value: 'false' } as never])).toThrow();
  });
});
