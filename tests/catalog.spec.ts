import { describe, expect, it } from 'vitest';
import { loadActionsCatalog, normalizeActionEntry } from '../src/host/catalog.js';
import { sessionActionsPath } from '../src/host/config/paths.js';

/** Build an injected readFile from a path -> text map; missing paths throw ENOENT. */
function fakeReadFile(files: Record<string, string>): (path: string) => Promise<string> {
  return (path) => {
    const text = files[path];
    if (text === undefined) {
      return Promise.reject(Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' }));
    }
    return Promise.resolve(text);
  };
}

const GLOBAL_FILE = JSON.stringify({
  version: '1.0.0',
  actions: [
    {
      label: 'build',
      command: 'make all',
      detail: 'global build',
      visibility: 'ui',
      options: { cwd: 'packages/web', env: { A: '1', B: '2' } },
      runOptions: { instanceLimit: 3, instancePolicy: 'reject' },
    },
    { label: 'lint', command: 'make lint' },
    { label: 'broken-global' },
  ],
});

const WORKSPACE_FILE = JSON.stringify({
  version: '1.0.0',
  actions: [
    {
      label: 'build',
      command: 'pnpm build --filter ${workspaceFolderBasename}',
      options: { env: { B: '20' } },
      // T63a: entry schema requires a positive integer (floats fault per-entry).
      runOptions: { instanceLimit: 2 },
    },
    {
      label: 'deploy',
      command: 'deploy --home ${userHome} --mode ${env:MODE}',
      visibility: 'agent',
      options: { cwd: '${workspaceFolder}/infra' },
    },
  ],
});

describe('loadActionsCatalog', () => {
  it('loads both layers independently and normalizes each definition', async () => {
    const catalog = await loadActionsCatalog('/repo/app', {
      dshHome: '/dsh', home: '/home/u', env: { MODE: 'staging' },
      readFile: fakeReadFile({ '/dsh/actions.json': GLOBAL_FILE, '/repo/app/.dsh/actions.json': WORKSPACE_FILE }),
    });
    expect(catalog.apiVersion).toBe(1);
    expect(catalog.workspace).toBe('/repo/app');
    expect(catalog.runs).toEqual([]);
    expect(catalog.sources[0]).toMatchObject({ available: true });
    expect(catalog.sources[0]?.errors).toHaveLength(1);
    expect(catalog.actions.map((action) => action.id)).toEqual(['global:build', 'global:lint', 'workspace:build', 'workspace:deploy']);
    expect(catalog.actions[0]).toMatchObject({ command: 'make all', agentVisible: false, favorite: false, cwd: '/repo/app/packages/web', env: { A: '1', B: '2' } });
    expect(catalog.actions[2]).toMatchObject({ command: 'pnpm build --filter app', agentVisible: true, favorite: false, cwd: '/repo/app', env: { B: '20' }, runOptions: { instanceLimit: 2, instancePolicy: 'reuse' } });
    expect(catalog.actions[2]?.detail).toBeUndefined();
    expect(catalog.actions[3]).toMatchObject({ command: 'deploy --home /home/u --mode staging', cwd: '/repo/app/infra', agentVisible: true });
    expect(catalog.actions.every((action) => !('visibility' in action))).toBe(true);
  });

  it('degrades missing files without blocking the other layer', async () => {
    const catalog = await loadActionsCatalog('/repo/app', {
      dshHome: '/dsh',
      readFile: fakeReadFile({ '/repo/app/.dsh/actions.json': WORKSPACE_FILE }),
    });
    expect(catalog.sources[0]).toMatchObject({
      layer: 'global',
      available: false,
      reason: 'definition-not-found',
    });
    expect(catalog.sources[1]).toMatchObject({ layer: 'workspace', available: true });
    expect(catalog.actions.map((action) => action.id)).toEqual(['workspace:build', 'workspace:deploy']);
  });

  it('surfaces unsupported versions on the source status', async () => {
    const catalog = await loadActionsCatalog('/repo/app', {
      dshHome: '/dsh',
      readFile: fakeReadFile({
        '/dsh/actions.json': '{"version":"9.9.9"}',
        '/repo/app/.dsh/actions.json': '{"version":"1.0.0"}',
      }),
    });
    expect(catalog.sources[0]).toMatchObject({
      layer: 'global',
      available: false,
      reason: 'unsupported-version',
    });
    expect(catalog.actions).toEqual([]);
  });
});

describe('normalizeActionEntry', () => {
  const context = { workspaceFolder: '/repo/app', userHome: '/home/u', env: {} };

  it('keeps absolute configured cwd and substitutes variables in env values', () => {
    const summary = normalizeActionEntry(
      {
        label: 'release',
        command: 'release',
        options: { cwd: '/opt/tools', env: { OUT: '${workspaceFolder}/dist' } },
      },
      'global',
      context,
    );
    expect(summary.cwd).toBe('/opt/tools');
    expect(summary.env).toEqual({ OUT: '/repo/app/dist' });
  });

  it('omits empty env and clamps instanceLimit', () => {
    const summary = normalizeActionEntry(
      { label: 'x', command: 'x', options: { env: {} }, runOptions: { instanceLimit: 0 } },
      'workspace',
      context,
    );
    expect(summary.env).toBeUndefined();
    expect(summary.runOptions.instanceLimit).toBe(1);
  });

  it('carries a configured presentation panel and omits it otherwise', () => {
    const withPanel = normalizeActionEntry(
      { label: 'x', command: 'x', presentation: { panel: 'append' } },
      'workspace',
      context,
    );
    expect(withPanel.presentation).toEqual({ panel: 'append' });
    const without = normalizeActionEntry({ label: 'x', command: 'x' }, 'workspace', context);
    expect(without.presentation).toBeUndefined();
  });

  it('carries declared inputs and keeps ${input:id} placeholders verbatim (2.4)', () => {
    const summary = normalizeActionEntry(
      {
        label: 'deploy',
        command: 'deploy --env ${input:env} --tag ${input:tag}',
        detail: '部署 ${input:env}',
        options: { env: { TARGET: '${input:env}' } },
        inputs: [
          { id: 'env', type: 'select', options: ['staging', 'prod'], default: 'staging' },
          { id: 'tag', type: 'string', required: true },
        ],
      },
      'workspace',
      context,
    );
    expect(summary.inputs).toEqual([
      { id: 'env', type: 'select', options: ['staging', 'prod'], default: 'staging' },
      { id: 'tag', type: 'string', required: true },
    ]);
    // No run values at catalog time: placeholders survive in every field.
    expect(summary.command).toBe('deploy --env ${input:env} --tag ${input:tag}');
    expect(summary.detail).toBe('部署 ${input:env}');
    expect(summary.env).toEqual({ TARGET: '${input:env}' });
    // Inputs are omitted when undeclared.
    expect(normalizeActionEntry({ label: 'x', command: 'x' }, 'workspace', context).inputs).toBeUndefined();
  });

  it('honors resolved input values when the context provides them', () => {
    const summary = normalizeActionEntry(
      { label: 'deploy', command: 'deploy ${input:env}', inputs: [{ id: 'env', type: 'string' }] },
      'workspace',
      { ...context, inputs: { env: 'prod' } },
    );
    expect(summary.command).toBe('deploy prod');
  });
});

describe('loadActionsCatalog inputs (2.4)', () => {
  it('merges inputs only with an explicit extends reference', async () => {
    const catalog = await loadActionsCatalog('/repo/app', {
      dshHome: '/dsh',
      readFile: fakeReadFile({
        '/dsh/actions.json': JSON.stringify({
          version: '1.0.0',
          actions: [
            {
              label: 'deploy',
              command: 'deploy ${input:env}',
              inputs: [
                { id: 'env', type: 'select', options: ['staging', 'prod'], default: 'staging' },
                { id: 'tag', type: 'string', required: true },
              ],
            },
          ],
        }),
        '/repo/app/.dsh/actions.json': JSON.stringify({
          version: '1.0.0',
          actions: [
            {
              label: 'deploy',
              command: 'deploy ${input:env} --fast',
              extends: 'global:deploy',
              inputs: [{ id: 'env', type: 'select', options: ['staging', 'prod'], default: 'prod' }],
            },
          ],
        }),
      }),
    });
    expect(catalog.sources.every((source) => source.available)).toBe(true);
    expect(catalog.actions).toHaveLength(2);
    const deploy = catalog.actions[1];
    expect(deploy).toMatchObject({
      id: 'workspace:deploy',
      command: 'deploy ${input:env} --fast',
      inputs: [
        { id: 'env', type: 'select', options: ['staging', 'prod'], default: 'prod' },
        { id: 'tag', type: 'string', required: true },
      ],
    });
  });
});


// ---------------------------------------------------------------------------
// T47: session layer
// ---------------------------------------------------------------------------

describe('session layer (T47)', () => {
  const GLOBAL_FILE = JSON.stringify({
    version: '1.0.0',
    actions: [{ label: 'build', command: 'global build', detail: 'global detail' }],
  });
  const WORKSPACE_FILE_LOCAL = JSON.stringify({
    version: '1.0.0',
    actions: [{ label: 'build', command: 'ws build' }, { label: 'test', command: 'ws test' }],
  });
  const SESSION_FILE = JSON.stringify({
    version: '1.0.0',
    actions: [{ label: 'build', command: 'session build' }, { label: 'scratch', command: 'scratch pad' }],
  });

  it('session layer coexists with workspace and global in file order', async () => {
    const sessionPath = sessionActionsPath('/dsh', '/repo/app', 'sess-1');
    const catalog = await loadActionsCatalog('/repo/app', {
      dshHome: '/dsh',
      sessionId: 'sess-1',
      readFile: fakeReadFile({
        '/dsh/actions.json': GLOBAL_FILE,
        '/repo/app/.dsh/actions.json': WORKSPACE_FILE_LOCAL,
        [sessionPath]: SESSION_FILE,
      }),
    });
    const build = catalog.actions.find((action) => action.id === 'session:build');
    expect(build?.command).toBe('session build');
    expect(build?.sourceLayer).toBe('session');
    expect(build?.id).toBe('session:build');
    expect(build?.detail).toBeUndefined();
    expect(catalog.actions.map((action) => action.id)).toEqual(['global:build', 'workspace:build', 'workspace:test', 'session:build', 'session:scratch']);
    expect(catalog.actions.find((action) => action.label === 'test')?.sourceLayer).toBe('workspace');
    expect(catalog.actions.find((action) => action.label === 'scratch')?.sourceLayer).toBe('session');
    expect(catalog.sources.map((source) => source.layer)).toEqual(['global', 'workspace', 'session']);
  });

  it('a missing session file is an empty layer, not a degradation', async () => {
    const catalog = await loadActionsCatalog('/repo/app', {
      dshHome: '/dsh',
      sessionId: 'sess-1',
      readFile: fakeReadFile({ '/repo/app/.dsh/actions.json': WORKSPACE_FILE_LOCAL }),
    });
    const sessionSource = catalog.sources.find((source) => source.layer === 'session');
    expect(sessionSource).toMatchObject({ available: true, errors: [] });
    expect(sessionSource?.path).toContain('sess-1');
    expect(catalog.actions.map((action) => action.label)).toEqual(['build', 'test']);
  });

  it('without a sessionId the session layer is not consulted at all', async () => {
    const catalog = await loadActionsCatalog('/repo/app', {
      dshHome: '/dsh',
      readFile: fakeReadFile({ '/repo/app/.dsh/actions.json': WORKSPACE_FILE_LOCAL }),
    });
    expect(catalog.sources.map((source) => source.layer)).toEqual(['global', 'workspace']);
  });

  it('resolves extends at load: base fields inherit, child command wins', async () => {
    const sessionPath = sessionActionsPath('/dsh', '/repo/app', 'sess-1');
    const catalog = await loadActionsCatalog('/repo/app', {
      dshHome: '/dsh',
      sessionId: 'sess-1',
      readFile: fakeReadFile({
        '/repo/app/.dsh/actions.json': JSON.stringify({
          version: '1.0.0',
          actions: [
            {
              label: 'base',
              command: 'echo base',
              options: { cwd: 'sub', env: { MODE: 'base' } },
              inputs: [{ id: 'target', type: 'string', required: true }],
            },
          ],
        }),
        [sessionPath]: JSON.stringify({
          version: '1.0.0',
          actions: [{ label: 'child', command: 'echo child', extends: 'workspace:base' }],
        }),
      }),
    });
    const child = catalog.actions.find((action) => action.label === 'child');
    expect(child?.extends).toBeUndefined();
    expect(child?.command).toBe('echo child');
    expect(child?.cwd).toBe('/repo/app/sub');
    expect(child?.env).toEqual({ MODE: 'base' });
    expect(child?.inputs).toEqual([{ id: 'target', type: 'string', required: true }]);
  });

  it('an unresolvable extends stays on the summary for the run-time error', async () => {
    const sessionPath = sessionActionsPath('/dsh', '/repo/app', 'sess-1');
    const catalog = await loadActionsCatalog('/repo/app', {
      dshHome: '/dsh',
      sessionId: 'sess-1',
      readFile: fakeReadFile({
        [sessionPath]: JSON.stringify({
          version: '1.0.0',
          actions: [{ label: 'orphan', command: 'echo x', extends: 'workspace:missing' }],
        }),
      }),
    });
    const orphan = catalog.actions.find((action) => action.label === 'orphan');
    expect(orphan?.extends).toBe('workspace:missing');
  });

  it('resolves extends chains in any declaration order (T61 fixpoint)', async () => {
    const file = JSON.stringify({
      version: '1.0.0',
      actions: [
        // Dependent declared BEFORE its base — the T55b-1 ghost-action order.
        { label: 'c', extends: 'workspace:b' },
        { label: 'b', extends: 'workspace:a', options: { env: { FROM_B: '1' } } },
        { label: 'a', command: 'echo A', options: { env: { FROM_A: '1' } } },
      ],
    });
    const catalog = await loadActionsCatalog('/repo/app', {
      dshHome: '/dsh',
      readFile: fakeReadFile({ '/repo/app/.dsh/actions.json': file }),
    });
    const c = catalog.actions.find((action) => action.label === 'c');
    expect(c?.extends).toBeUndefined();
    expect(c?.command).toBe('echo A');
    expect(c?.env).toEqual({ FROM_A: '1', FROM_B: '1' });
    const b = catalog.actions.find((action) => action.label === 'b');
    expect(b?.extends).toBeUndefined();
    expect(b?.command).toBe('echo A');
  });

  it('keeps cyclic extends references on the summary for the run-time error', async () => {
    const file = JSON.stringify({
      version: '1.0.0',
      actions: [
        { label: 'x', command: 'echo x', extends: 'workspace:y' },
        { label: 'y', command: 'echo y', extends: 'workspace:x' },
      ],
    });
    const catalog = await loadActionsCatalog('/repo/app', {
      dshHome: '/dsh',
      readFile: fakeReadFile({ '/repo/app/.dsh/actions.json': file }),
    });
    expect(catalog.actions.find((action) => action.label === 'x')?.extends).toBe('workspace:y');
    expect(catalog.actions.find((action) => action.label === 'y')?.extends).toBe('workspace:x');
  });

  it('resolves extends against the RAW layer entry even when a higher layer shadows it (T61)', async () => {
    const catalog = await loadActionsCatalog('/repo/app', {
      dshHome: '/dsh',
      readFile: fakeReadFile({
        '/dsh/actions.json': JSON.stringify({
          version: '1.0.0',
          actions: [
            { label: 'build', command: 'echo global-build' },
            { label: 'derived', command: 'echo derived', extends: 'global:build' },
          ],
        }),
        '/repo/app/.dsh/actions.json': JSON.stringify({
          version: '1.0.0',
          // The workspace shadows "build" — the extends must still mean the GLOBAL one.
          actions: [{ label: 'build', command: 'echo workspace-build' }],
        }),
      }),
    });
    const derived = catalog.actions.find((action) => action.label === 'derived');
    expect(derived?.extends).toBeUndefined();
    expect(derived?.command).toBe('echo derived');
    // Inherited nothing from the workspace shadow; the raw global base supplied the command.
    const base = catalog.actions.find((action) => action.id === 'workspace:build');
    expect(base?.command).toBe('echo workspace-build'); // the shadow still wins the merged view
  });

  it('reports exists per source: session file absent vs present layers (T61)', async () => {
    const catalog = await loadActionsCatalog('/repo/app', {
      dshHome: '/dsh',
      sessionId: 'sess-1',
      readFile: fakeReadFile({ '/repo/app/.dsh/actions.json': WORKSPACE_FILE_LOCAL }),
    });
    const byLayer = new Map(catalog.sources.map((source) => [source.layer, source]));
    expect(byLayer.get('workspace')?.exists).toBe(true);
    expect(byLayer.get('global')?.exists).toBe(false);
    expect(byLayer.get('session')).toMatchObject({ available: true, exists: false });
  });
});


describe('catalog conflicts and local UI metadata', () => {
  it('cannot extend a conflicting entry, even if a different layer has the same label', async () => {
    const catalog = await loadActionsCatalog('/repo/app', {
      dshHome: '/dsh', readFile: fakeReadFile({
        '/dsh/actions.json': JSON.stringify({ version: '1.0.0', actions: [{ label: 'base', command: 'global' }] }),
        '/repo/app/.dsh/actions.json': JSON.stringify({ version: '1.0.0', actions: [
          { label: 'base', command: 'one' }, { label: 'safe', command: 'ok' },
          { label: 'base', command: 'two' }, { label: 'child', extends: 'workspace:base' },
        ] }),
      }),
    });
    expect(catalog.actions.map((action) => action.id)).toEqual(['global:base', 'workspace:safe', 'workspace:child']);
    expect(catalog.sources[1]?.errors).toHaveLength(2);
    expect(catalog.actions[2]?.extends).toBe('workspace:base');
    expect(catalog.actions[2]?.command).not.toBe('global');
  });

  it('excludes duplicate folder entries and prevents extends from selecting a conflict', async () => {
    const catalog = await loadActionsCatalog('/repo/app', {
      dshHome: '/dsh', sessionId: 's', readFile: fakeReadFile({
        [sessionActionsPath('/dsh', '/repo/app', 's')]: JSON.stringify({ version: '1.0.0', folders: ['child'], actions: [{ label: 'derived', extends: 'folder:child:dup' }] }),
        '/repo/app/child/.dsh/actions.json': JSON.stringify({ version: '1.0.0', actions: [
          { label: 'dup', command: 'one' }, { label: 'ok', command: 'yes' }, { label: 'dup', command: 'two' },
        ] }),
      }),
    });
    expect(catalog.actions.map((action) => action.id)).toEqual(['session:derived', 'folder:child:ok']);
    expect(catalog.actions[0]?.extends).toBe('folder:child:dup');
    expect(catalog.sources.find((source) => source.layer === 'folder')?.errors).toHaveLength(2);
  });

  it('resolves chained inheritance without inheriting favorites and honors explicit false', async () => {
    const catalog = await loadActionsCatalog('/repo/app', {
      dshHome: '/dsh', readFile: fakeReadFile({
        '/repo/app/.dsh/actions.json': JSON.stringify({ version: '1.0.0', actions: [
          { label: 'grandchild', extends: 'workspace:child' },
          { label: 'child', extends: 'workspace:base', favorite: true },
          { label: 'base', command: 'x', favorite: true, agentVisible: false },
          { label: 'public', extends: 'workspace:base', favorite: false, agentVisible: true },
        ] }),
      }),
    });
    expect(catalog.actions.map((action) => action.favorite)).toEqual([false, true, true, false]);
    expect(catalog.actions.map((action) => action.agentVisible)).toEqual([false, false, false, true]);
    expect(catalog.actions.map((action) => action.command)).toEqual(['x', 'x', 'x', 'x']);
  });
});
