import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionsCatalog, ProjectActionSummary } from '../src/contract.js';
import { ActionsApiError, createHttpApi } from '../src/client/api.js';
import type { ActionsApi, PresentationUpdate } from '../src/client/api.js';
import { PanelStore } from '../src/client/store.js';

const action = (label: string): ProjectActionSummary => ({
  id: `workspace:${label}`, label, sourceLayer: 'workspace', agentVisible: true,
  visibility: 'all', approval: 'never', command: 'echo ok', cwd: '/repo',
  runOptions: { instanceLimit: 1, instancePolicy: 'reuse' },
});
const catalog = (revision = 'r1'): ActionsCatalog => ({
  apiVersion: 1, workspace: '/repo', runs: [], actions: [action('a'), action('b')],
  sources: [{ layer: 'workspace', path: '/repo/.dsh/actions.json', available: true, errors: [], revision }],
});
function fixture(write: ActionsApi['updatePresentation']) {
  const api = { updatePresentation: write } as ActionsApi;
  const store = new PanelStore(api);
  // No transport loops in these focused presentation-state tests.
  Object.assign(store.state, { sessionId: 's1', phase: 'ready', catalog: catalog() });
  return store;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('presentation HTTP contract', () => {
  it('uses the existing authenticated prefix and unwraps the catalog response', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ catalog: catalog() })));
    vi.stubGlobal('fetch', fetch);
    const request: PresentationUpdate = { sessionId: 's1', actionId: 'workspace:a', sourceLayer: 'workspace', expectedRevision: 'r1', favorite: true };
    const result = await createHttpApi().updatePresentation(request);
    expect(result.actions.map((item) => item.label)).toEqual(['a', 'b']);
    expect(fetch).toHaveBeenCalledWith('/api/dsh-actions/actions/presentation', expect.objectContaining({
      method: 'POST', credentials: 'same-origin', body: JSON.stringify(request),
    }));
  });
});

describe('presentation store isolation', () => {
  it('serializes concurrent writes and resolves the next revision after writeback', async () => {
    let finish!: (value: ActionsCatalog) => void;
    const write = vi.fn<ActionsApi['updatePresentation']>()
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce(catalog('r3'));
    const store = fixture(write);
    const first = store.setFavorite('workspace:a', true);
    const second = store.reorderActions('workspace', undefined, ['b', 'a']);
    await Promise.resolve();
    expect(write).toHaveBeenCalledTimes(1);
    finish(catalog('r2'));
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(write.mock.calls[1]?.[0]).toMatchObject({ expectedRevision: 'r2', labels: ['b', 'a'] });
    store.dispose();
  });

  it('retains every failure independently until explicitly dismissed', async () => {
    const write = vi.fn<ActionsApi['updatePresentation']>()
      .mockRejectedValueOnce(new ActionsApiError(409, 'revision-conflict', 'changed'))
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValueOnce(catalog('r2'));
    const store = fixture(write);
    await store.setFavorite('workspace:a', true);
    await store.setFavorite('workspace:b', true);
    await store.setFavorite('workspace:a', false);
    expect(store.state.presentationErrors.map((error) => error.conflict)).toEqual([true, false]);
    store.dismissPresentationError(store.state.presentationErrors[0]!.id);
    expect(store.state.presentationErrors[0]?.message).toBe('disk full');
    store.dispose();
  });

  it('does not touch run views, indexes, selected tabs or collapsed state', async () => {
    const store = fixture(vi.fn().mockResolvedValue(catalog('r2')));
    const runs = store.state.runs;
    const indexes = store.state.runIdsByAction;
    Object.assign(store.state, { selectedRunId: 'retained-run', workspaceCollapsed: true });
    await store.setFavorite('workspace:a', true);
    expect(store.state.runs).toBe(runs);
    expect(store.state.runIdsByAction).toBe(indexes);
    expect(store.state.selectedRunId).toBe('retained-run');
    expect(store.state.workspaceCollapsed).toBe(true);
    store.dispose();
  });

  it('rejects incomplete, duplicated and cross-group label orders before writing', async () => {
    const write = vi.fn<ActionsApi['updatePresentation']>();
    const store = fixture(write);
    expect(await store.reorderActions('workspace', undefined, ['a'])).toBe(false);
    expect(await store.reorderActions('workspace', undefined, ['a', 'a'])).toBe(false);
    expect(await store.reorderActions('workspace', undefined, ['a', 'folder:b'])).toBe(false);
    expect(write).not.toHaveBeenCalled();
    store.dispose();
  });

  it('never overwrites a newer catalog event with an older presentation response', async () => {
    let finish!: (value: ActionsCatalog) => void;
    const newer = catalog('event-r3');
    newer.actions[0]!.detail = 'newer external edit';
    const store = fixture(() => new Promise((resolve) => { finish = resolve; }));
    const internal = store as unknown as { api: ActionsApi; applyCatalogEvent(sessionId: string, frame: { type: 'catalog'; catalog: ActionsCatalog }): void };
    internal.api.listCatalog = vi.fn().mockResolvedValue(newer);
    const pending = store.setFavorite('workspace:a', true);
    await Promise.resolve();
    internal.applyCatalogEvent('s1', { type: 'catalog', catalog: newer });
    finish(catalog('response-r2'));
    expect(await pending).toBe(true);
    expect(store.state.catalog?.actions[0]?.detail).toBe('newer external edit');
    expect(store.state.catalog?.sources[0]?.revision).toBe('event-r3');
    store.dispose();
  });

  it('ignores a response after disposal/session abort', async () => {
    let finish!: (value: ActionsCatalog) => void;
    const store = fixture(() => new Promise((resolve) => { finish = resolve; }));
    const pending = store.setFavorite('workspace:a', true);
    await Promise.resolve();
    const original = store.state.catalog;
    store.dispose();
    finish(catalog('stale'));
    expect(await pending).toBe(false);
    expect(store.state.catalog).toBe(original);
  });

  it('writes folder favorites and order with the folder source revision', async () => {
    const write = vi.fn<ActionsApi['updatePresentation']>().mockResolvedValue(catalog('r2'));
    const store = fixture(write);
    const current = store.state.catalog!;
    current.sources = [{ layer: 'folder', folder: '/other', path: '/other/.dsh/actions.json', available: true, errors: [], revision: 'folder-r1' }];
    current.actions = current.actions.map((item) => ({ ...item, sourceLayer: 'folder', folder: '/other' }));
    await store.reorderActions('folder', '/other', ['b', 'a']);
    expect(write.mock.calls[0]?.[0]).toMatchObject({ sourceLayer: 'folder', folder: '/other', expectedRevision: 'folder-r1', labels: ['b', 'a'] });
    store.dispose();
  });
});
