import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createActionEntry } from '../src/host/config/action-store.js';

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
