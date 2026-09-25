import { describe, expect, it } from 'vitest';
import type { ActionEntryConfig, ActionInputConfig } from '../src/contract.js';
import { loadConfigLayer, parseActionsFileText } from '../src/host/config/load.js';
import { mergeActionEntries, mergeActionEntry } from '../src/host/config/merge.js';
import { normalizeParams } from '../src/host/config/params.js';
import { encodeSegment, projectKey, resolveActionsLayerPaths, sessionActionsPath } from '../src/host/config/paths.js';
import { deleteActionEntryFromFile } from '../src/host/config/session-file.js';
import type { SessionFileIO } from '../src/host/config/session-file.js';
import { createConfigWatcher } from '../src/host/config/watch.js';
import type { IntervalClock, StatFile } from '../src/host/config/watch.js';
import { substituteVariables } from '../src/host/config/variables.js';

// ---------------------------------------------------------------------------
// parseActionsFileText
// ---------------------------------------------------------------------------

describe('parseActionsFileText', () => {
  it('parses JSONC with comments and trailing commas', () => {
    const text = `{
      // project actions
      "version": "1.0.0",
      "actions": [
        { "label": "build", "command": "pnpm build", },
      ],
    }`;
    const result = parseActionsFileText(text);
    expect(result).toEqual({
      ok: true,
      entries: [{ label: 'build', command: 'pnpm build' }],
      errors: [],
    });
  });

  it('accepts a file without actions', () => {
    expect(parseActionsFileText('{"version":"1.0.0"}')).toEqual({ ok: true, entries: [], errors: [] });
  });

  it('rejects syntax errors as parse-error', () => {
    const result = parseActionsFileText('{ "version": ');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('parse-error');
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it('rejects a missing version as parse-error', () => {
    const result = parseActionsFileText('{"actions": []}');
    expect(result).toEqual({
      ok: false,
      reason: 'parse-error',
      errors: ['Invalid actions file: missing version'],
    });
  });

  it('rejects an unknown version as unsupported-version', () => {
    const result = parseActionsFileText('{"version":"2.0.0","actions":[]}');
    expect(result).toEqual({
      ok: false,
      reason: 'unsupported-version',
      errors: ['Unsupported actions file version: 2.0.0'],
    });
  });

  it('rejects a non-array actions field', () => {
    const result = parseActionsFileText('{"version":"1.0.0","actions":{}}');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('parse-error');
  });

  it('skips invalid entries and keeps valid ones', () => {
    const text = JSON.stringify({
      version: '1.0.0',
      actions: [
        { label: 'build', command: 'pnpm build' },
        { command: 'missing label' },
        { label: 'no-command' },
        { label: 'bad-visibility', command: 'x', visibility: 'hidden' },
        { label: 'test', command: 'pnpm test' },
      ],
    });
    const result = parseActionsFileText(text);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries.map((entry) => entry.label)).toEqual(['build', 'test']);
      expect(result.errors).toHaveLength(3);
      expect(result.errors[0]).toContain('actions[1]');
      expect(result.errors[1]).toContain('actions[2]');
      expect(result.errors[2]).toContain('actions[3]');
    }
  });
});

// ---------------------------------------------------------------------------
// loadConfigLayer
// ---------------------------------------------------------------------------

describe('loadConfigLayer', () => {
  it('degrades a missing file to definition-not-found', async () => {
    const result = await loadConfigLayer('global', '/home/u/.dsh/actions.json', () => {
      return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    });
    expect(result.entries).toEqual([]);
    expect(result.status).toEqual({
      layer: 'global',
      path: '/home/u/.dsh/actions.json',
      available: false,
      reason: 'definition-not-found',
      exists: false,
      errors: [],
    });
  });

  it('degrades unexpected read failures to parse-error without throwing', async () => {
    const result = await loadConfigLayer('workspace', '/repo/.dsh/actions.json', () => {
      return Promise.reject(new Error('permission denied'));
    });
    expect(result.status.available).toBe(false);
    expect(result.status.reason).toBe('parse-error');
    expect(result.status.exists).toBe(true); // the file exists; reading it failed
    expect(result.status.errors[0]).toContain('permission denied');
  });

  it('reports per-entry errors on an available source', async () => {
    const text = JSON.stringify({
      version: '1.0.0',
      actions: [{ label: 'ok', command: 'true' }, { label: 'broken' }],
    });
    const result = await loadConfigLayer('workspace', '/repo/.dsh/actions.json', () => Promise.resolve(text));
    expect(result.status.available).toBe(true);
    expect(result.status.errors).toHaveLength(1);
    expect(result.entries).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// resolveActionsLayerPaths
// ---------------------------------------------------------------------------

describe('resolveActionsLayerPaths', () => {
  it('prefers an explicit dshHome', () => {
    expect(resolveActionsLayerPaths('/repo', { dshHome: '/custom/.dsh' })).toEqual({
      global: '/custom/.dsh/actions.json',
      workspace: '/repo/.dsh/actions.json',
    });
  });

  it('falls back to home when dshHome and DSH_HOME are unset', () => {
    const saved = process.env.DSH_HOME;
    delete process.env.DSH_HOME;
    try {
      expect(resolveActionsLayerPaths('/repo', { home: '/home/u' })).toEqual({
        global: '/home/u/.dsh/actions.json',
        workspace: '/repo/.dsh/actions.json',
      });
    } finally {
      if (saved !== undefined) process.env.DSH_HOME = saved;
    }
  });

  it('treats an empty DSH_HOME / dshHome as unset (never a cwd-relative path)', () => {
    const saved = process.env.DSH_HOME;
    delete process.env.DSH_HOME;
    try {
      process.env.DSH_HOME = '';
      expect(resolveActionsLayerPaths('/repo', { home: '/home/u' }).global).toBe('/home/u/.dsh/actions.json');
      delete process.env.DSH_HOME;
      expect(resolveActionsLayerPaths('/repo', { dshHome: '', home: '/home/u' }).global).toBe(
        '/home/u/.dsh/actions.json',
      );
    } finally {
      if (saved === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = saved;
    }
  });
});

// ---------------------------------------------------------------------------
// substituteVariables
// ---------------------------------------------------------------------------

describe('substituteVariables', () => {
  const context = {
    workspaceFolder: '/repo/app',
    userHome: '/home/u',
    env: { NODE_ENV: 'test' } as Record<string, string | undefined>,
  };

  it('substitutes the full V1 variable set', () => {
    expect(
      substituteVariables('cd ${workspaceFolder} && echo ${workspaceFolderBasename} ${userHome} $NODE', context),
    ).toBe('cd /repo/app && echo app /home/u $NODE');
  });

  it('substitutes env:NAME from the injected environment', () => {
    expect(substituteVariables('mode=${env:NODE_ENV}', context)).toBe('mode=test');
  });

  it('leaves unknown variables and missing env names verbatim', () => {
    expect(substituteVariables('${input:x} ${env:MISSING_VAR}', context)).toBe('${input:x} ${env:MISSING_VAR}');
  });

  it('substitutes input:id from resolved values, verbatim without quoting', () => {
    const withInputs = { ...context, inputs: { env: 'prod', tag: 'v1; rm -rf ~' } };
    expect(substituteVariables('deploy --env ${input:env} --tag ${input:tag}', withInputs)).toBe(
      'deploy --env prod --tag v1; rm -rf ~',
    );
  });

  it('keeps unresolved input placeholders verbatim', () => {
    const withInputs = { ...context, inputs: { env: 'prod' } };
    expect(substituteVariables('${input:env} ${input:missing}', withInputs)).toBe('prod ${input:missing}');
  });
});

// ---------------------------------------------------------------------------
// normalizeParams (2.4 parameter signature)
// ---------------------------------------------------------------------------

describe('normalizeParams', () => {
  const declared: ActionInputConfig[] = [
    { id: 'env', type: 'select', options: ['staging', 'prod'], default: 'staging' },
    { id: 'tag', type: 'string', required: true },
    { id: 'note', type: 'string' },
  ];

  it('resolves provided values, defaults, and empty optionals', () => {
    expect(normalizeParams(declared, { tag: 'v1' })).toEqual({
      values: { env: 'staging', tag: 'v1', note: '' },
      signature: 'env=staging&note=&tag=v1',
    });
  });

  it('sorts the signature by id and percent-encodes values', () => {
    const result = normalizeParams(declared, { tag: 'a b&c=d', env: 'prod', note: 'x' });
    expect(result.signature).toBe('env=prod&note=x&tag=a%20b%26c%3Dd');
  });

  it('produces an empty signature when no inputs are declared', () => {
    expect(normalizeParams(undefined, undefined)).toEqual({ values: {}, signature: '' });
    expect(normalizeParams([], {})).toEqual({ values: {}, signature: '' });
  });

  it('rejects unknown provided ids', () => {
    expect(() => normalizeParams(declared, { tag: 'v1', bogus: '1' })).toThrow(
      'Unknown input parameter(s): bogus',
    );
    expect(() => normalizeParams(undefined, { a: '1' })).toThrow('Unknown input parameter(s): a');
  });

  it('lists every missing required input', () => {
    const two = [
      { id: 'a', type: 'string', required: true },
      { id: 'b', type: 'string', required: true },
    ] as ActionInputConfig[];
    expect(() => normalizeParams(two, {})).toThrow('Missing required input parameter(s): a, b');
    // A required input with a default does not need a provided value.
    expect(normalizeParams([{ id: 'a', type: 'string', required: true, default: 'x' }], {}).values).toEqual({
      a: 'x',
    });
  });

  it('rejects select values outside the declared options', () => {
    expect(() => normalizeParams(declared, { tag: 'v1', env: 'qa' })).toThrow(
      'Invalid value for select input "env": "qa"',
    );
  });
});

// ---------------------------------------------------------------------------
// mergeActionEntry / mergeActionEntries
// ---------------------------------------------------------------------------

describe('mergeActionEntry', () => {
  const base: ActionEntryConfig = {
    label: 'build',
    command: 'make all',
    detail: 'global build',
    visibility: 'ui',
    options: { cwd: 'packages/web', env: { A: '1', B: '2' } },
    runOptions: { instanceLimit: 2, instancePolicy: 'reject' },
  };

  it('lets the override win field-wise and merges env by key', () => {
    const merged = mergeActionEntry(base, {
      label: 'build',
      command: 'pnpm build',
      options: { env: { B: '20', C: '3' } },
      runOptions: { instancePolicy: 'reuse' },
    });
    expect(merged).toEqual({
      label: 'build',
      command: 'pnpm build',
      detail: 'global build',
      visibility: 'ui',
      options: { cwd: 'packages/web', env: { A: '1', B: '20', C: '3' } },
      runOptions: { instanceLimit: 2, instancePolicy: 'reuse' },
    });
  });

  it('inherits the base when the override writes nothing optional', () => {
    expect(mergeActionEntry(base, { label: 'build', command: 'pnpm build' })).toEqual({
      ...base,
      command: 'pnpm build',
    });
  });

  it('overrides cwd and detail when written', () => {
    const merged = mergeActionEntry(base, {
      label: 'build',
      command: 'pnpm build',
      detail: 'workspace build',
      options: { cwd: 'apps/web' },
    });
    expect(merged.detail).toBe('workspace build');
    expect(merged.options?.cwd).toBe('apps/web');
    expect(merged.options?.env).toEqual({ A: '1', B: '2' });
  });

  it('merges presentation field-wise: override wins, unset inherits', () => {
    const withBase = mergeActionEntry(
      { ...base, presentation: { panel: 'append' } },
      { label: 'build', command: 'pnpm build' },
    );
    expect(withBase.presentation).toEqual({ panel: 'append' });
    const overridden = mergeActionEntry(
      { ...base, presentation: { panel: 'append' } },
      { label: 'build', command: 'pnpm build', presentation: { panel: 'new' } },
    );
    expect(overridden.presentation).toEqual({ panel: 'new' });
    expect(mergeActionEntry(base, { label: 'build', command: 'x' }).presentation).toBeUndefined();
  });

  it('merges inputs by id: field-wise on matches, override-only appended', () => {
    const merged = mergeActionEntry(
      {
        ...base,
        inputs: [
          { id: 'env', type: 'select', options: ['staging', 'prod'], default: 'staging', description: 'global' },
          { id: 'tag', type: 'string', required: true },
        ],
      },
      {
        label: 'build',
        command: 'pnpm build',
        inputs: [
          { id: 'env', type: 'select', options: ['staging', 'prod', 'qa'], default: 'qa' },
          { id: 'note', type: 'string' },
        ],
      },
    );
    expect(merged.inputs).toEqual([
      // Matched id: override fields win, unwritten (description) inherited.
      { id: 'env', type: 'select', options: ['staging', 'prod', 'qa'], default: 'qa', description: 'global' },
      // Base-only input inherited as-is.
      { id: 'tag', type: 'string', required: true },
      // Override-only input appended.
      { id: 'note', type: 'string' },
    ]);
    // Inputs are inherited when the override declares none, omitted when neither does.
    expect(mergeActionEntry({ ...base, inputs: [{ id: 'a', type: 'string' }] }, { label: 'build', command: 'x' })
      .inputs).toEqual([{ id: 'a', type: 'string' }]);
    expect(mergeActionEntry(base, { label: 'build', command: 'x' }).inputs).toBeUndefined();
  });

  it('drops a select default that fell outside the merged options (cross-layer narrowing)', () => {
    const merged = mergeActionEntry(
      {
        ...base,
        inputs: [{ id: 'env', type: 'select', options: ['staging', 'prod'], default: 'staging' }],
      },
      {
        label: 'build',
        command: 'pnpm build',
        inputs: [{ id: 'env', type: 'select', options: ['dev', 'qa'] }],
      },
    );
    // The inherited default 'staging' is not in the narrowed options — dropped,
    // so the merged declaration stays contract-legal.
    expect(merged.inputs).toEqual([{ id: 'env', type: 'select', options: ['dev', 'qa'] }]);
  });

  it('drops inherited options when the merged type flips select → string', () => {
    const merged = mergeActionEntry(
      {
        ...base,
        inputs: [{ id: 'env', type: 'select', options: ['staging', 'prod'], default: 'prod' }],
      },
      {
        label: 'build',
        command: 'pnpm build',
        inputs: [{ id: 'env', type: 'string' }],
      },
    );
    expect(merged.inputs).toEqual([{ id: 'env', type: 'string', default: 'prod' }]);
  });
});

describe('mergeActionEntries', () => {
  it('matches by label, tags merged entries with the workspace layer', () => {
    const merged = mergeActionEntries(
      [
        { label: 'build', command: 'make all', detail: 'global' },
        { label: 'lint', command: 'make lint' },
      ],
      [
        { label: 'build', command: 'pnpm build' },
        { label: 'test', command: 'pnpm test' },
      ],
    );
    expect(merged).toEqual([
      {
        layer: 'workspace',
        entry: { label: 'build', command: 'pnpm build', detail: 'global' },
      },
      { layer: 'global', entry: { label: 'lint', command: 'make lint' } },
      { layer: 'workspace', entry: { label: 'test', command: 'pnpm test' } },
    ]);
  });

  it('keeps the last definition when a layer repeats a label', () => {
    const merged = mergeActionEntries(
      [
        { label: 'build', command: 'old' },
        { label: 'build', command: 'new' },
      ],
      [],
    );
    expect(merged).toEqual([{ layer: 'global', entry: { label: 'build', command: 'new' } }]);
  });
});

// ---------------------------------------------------------------------------
// createConfigWatcher (T21)
// ---------------------------------------------------------------------------

describe('createConfigWatcher', () => {
  function makeFixture() {
    const files = new Map<string, { mtimeMs: number; size: number }>();
    const stat: StatFile = (path) => {
      const file = files.get(path);
      if (file === undefined) return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      return Promise.resolve(file);
    };
    const callbacks: Array<() => void> = [];
    const clock: IntervalClock = (callback) => {
      callbacks.push(callback);
      return () => {
        const index = callbacks.indexOf(callback);
        if (index >= 0) callbacks.splice(index, 1);
      };
    };
    const watcher = createConfigWatcher({
      stat,
      clock,
      pollIntervalMs: 1,
      resolvePaths: (workspace) => ({ global: '/home/.dsh/actions.json', workspace: `${workspace}/.dsh/actions.json` }),
    });
    /** Run one polling round and flush its microtasks. */
    const tick = async (): Promise<void> => {
      for (const callback of Array.from(callbacks)) callback();
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    return { files, watcher, tick, callbacks };
  }

  const WORKSPACE_FILE = '/ws/.dsh/actions.json';

  it('fires on mtime/size changes and dedupes unchanged polls', async () => {
    const { files, watcher, tick } = makeFixture();
    files.set(WORKSPACE_FILE, { mtimeMs: 1, size: 10 });
    let fired = 0;
    watcher.watchWorkspace('/ws', () => {
      fired += 1;
    });

    await tick(); // baseline
    expect(fired).toBe(0);
    await tick(); // unchanged
    expect(fired).toBe(0);

    files.set(WORKSPACE_FILE, { mtimeMs: 2, size: 10 });
    await tick();
    expect(fired).toBe(1);
    await tick(); // unchanged again
    expect(fired).toBe(1);

    files.set(WORKSPACE_FILE, { mtimeMs: 2, size: 11 });
    await tick();
    expect(fired).toBe(2);
  });

  it('treats absent → created → deleted as changes', async () => {
    const { files, watcher, tick } = makeFixture();
    let fired = 0;
    watcher.watchWorkspace('/ws', () => {
      fired += 1;
    });
    await tick(); // baseline: absent
    expect(fired).toBe(0);

    files.set(WORKSPACE_FILE, { mtimeMs: 1, size: 5 });
    await tick();
    expect(fired).toBe(1);

    files.delete(WORKSPACE_FILE);
    await tick();
    expect(fired).toBe(2);
  });

  it('shares one poller per workspace and stops it after the last unsubscribe', async () => {
    const { files, watcher, tick, callbacks } = makeFixture();
    files.set(WORKSPACE_FILE, { mtimeMs: 1, size: 10 });
    let first = 0;
    let second = 0;
    const offA = watcher.watchWorkspace('/ws', () => {
      first += 1;
    });
    const offB = watcher.watchWorkspace('/ws', () => {
      second += 1;
    });
    expect(watcher.activeWatchCount).toBe(1);
    expect(callbacks).toHaveLength(1);

    await tick();
    files.set(WORKSPACE_FILE, { mtimeMs: 2, size: 10 });
    await tick();
    expect(first).toBe(1);
    expect(second).toBe(1);

    offA();
    expect(watcher.activeWatchCount).toBe(1); // still shared by the second subscriber
    offB();
    expect(watcher.activeWatchCount).toBe(0);
    expect(callbacks).toHaveLength(0); // interval cancelled
  });

  it('contains listener errors', async () => {
    const { files, watcher, tick } = makeFixture();
    files.set(WORKSPACE_FILE, { mtimeMs: 1, size: 10 });
    let good = 0;
    watcher.watchWorkspace('/ws', () => {
      throw new Error('bad listener');
    });
    watcher.watchWorkspace('/ws', () => {
      good += 1;
    });
    await tick();
    files.set(WORKSPACE_FILE, { mtimeMs: 2, size: 10 });
    await tick();
    expect(good).toBe(1);
  });

  it('treats two subscriptions of the same function as independent (unsubscribe order)', async () => {
    const { files, watcher, tick, callbacks } = makeFixture();
    files.set(WORKSPACE_FILE, { mtimeMs: 1, size: 10 });
    let fired = 0;
    const listener = (): void => {
      fired += 1;
    };
    const offFirst = watcher.watchWorkspace('/ws', listener);
    const offSecond = watcher.watchWorkspace('/ws', listener);
    expect(watcher.activeWatchCount).toBe(1);
    await tick(); // baseline

    // Unsubscribing the first subscription must not stop the poller nor
    // silence the second subscription of the same function.
    offFirst();
    expect(watcher.activeWatchCount).toBe(1);
    files.set(WORKSPACE_FILE, { mtimeMs: 2, size: 10 });
    await tick();
    expect(fired).toBe(1); // exactly one live subscription fires once

    offSecond();
    expect(watcher.activeWatchCount).toBe(0);
    expect(callbacks).toHaveLength(0);
  });

  it('a stale unsubscribe after a poller restart does not tear down the new poller', async () => {
    const { files, watcher, tick, callbacks } = makeFixture();
    files.set(WORKSPACE_FILE, { mtimeMs: 1, size: 10 });
    let fired = 0;
    const offOld = watcher.watchWorkspace('/ws', () => {
      fired += 1;
    });
    offOld(); // stops and removes the first poller
    expect(watcher.activeWatchCount).toBe(0);

    watcher.watchWorkspace('/ws', () => {
      fired += 10;
    });
    expect(watcher.activeWatchCount).toBe(1);
    expect(callbacks).toHaveLength(1);
    await tick(); // baseline for the restarted poller

    offOld(); // stale: the workspace now has a different poller — no-op
    expect(watcher.activeWatchCount).toBe(1);
    expect(callbacks).toHaveLength(1);

    files.set(WORKSPACE_FILE, { mtimeMs: 2, size: 10 });
    await tick();
    expect(fired).toBe(10); // only the new subscription fired
  });
});

// ---------------------------------------------------------------------------
// T29: approval merge semantics
// ---------------------------------------------------------------------------

describe('mergeActionEntry approval (T29)', () => {
  it('workspace approval overrides; unwritten inherits the global value', () => {
    const base: ActionEntryConfig = { label: 'deploy', command: 'deploy', approval: 'always' };
    expect(mergeActionEntry(base, { label: 'deploy', command: 'deploy --fast' }).approval).toBe('always');
    expect(mergeActionEntry(base, { label: 'deploy', command: 'deploy --fast', approval: 'never' }).approval).toBe('never');
    expect(mergeActionEntry({ label: 'deploy', command: 'deploy' }, { label: 'deploy', command: 'x' }).approval).toBeUndefined();
  });
});


// ---------------------------------------------------------------------------
// T47: session layer paths (mirror dsh-session-persistence-jsonl)
// ---------------------------------------------------------------------------

describe('session layer paths (T47, mirror of the host session layout)', () => {
  // Pinned against dsh-session-persistence-jsonl encodeSegment/projectKey.
  it.each([
    ['abc-123_X.y', 'abc-123_X.y'],
    ['.', '~002E'],
    ['..', '~002E~002E'],
    ['a/b', 'a~002Fb'],
    ['a\\b', 'a~005Cb'],
    ['a~b', 'a~007Eb'],
    ['a b', 'a~0020b'],
    ['会话', '~4F1A~8BDD'],
  ])('encodeSegment(%j) === %j', (raw, expected) => {
    expect(encodeSegment(raw)).toBe(expected);
  });

  it('encodeSegment throws on empty input', () => {
    expect(() => encodeSegment('')).toThrow('empty path segment');
  });

  it.each([
    ['/Users/u/repo', '--Users-u-repo--'],
    ['/', '--root--'],
    ['C:\\Users\\u', '--C-Users-u--'],
    ['/a//b///c', '--a-b-c--'],
    ['/a b/~c', '--a~0020b-~007Ec--'],
  ])('projectKey(%j) === %j', (cwd, expected) => {
    expect(projectKey(cwd)).toBe(expected);
  });

  it('projectKey truncates the readable core to 251 chars', () => {
    const key = projectKey(`/${'a'.repeat(300)}`);
    expect(key).toBe(`--${'a'.repeat(251)}--`);
  });

  it('sessionActionsPath mirrors sessionDir + actions.json', () => {
    expect(sessionActionsPath('/dsh', '/Users/u/repo', 'sess-1')).toBe(
      '/dsh/sessions/--Users-u-repo--/sess-1/actions.json',
    );
    expect(sessionActionsPath('/dsh', '/Users/u/re po', 's/1')).toBe(
      '/dsh/sessions/--Users-u-re~0020po--/s~002F1/actions.json',
    );
    expect(sessionActionsPath('/dsh', undefined, 'sess-1')).toBe('/dsh/sessions/_no-cwd/sess-1/actions.json');
  });
});

describe('watcher session files (T47)', () => {
  function makeSessionWatcherFixture() {
    const files = new Map<string, { mtimeMs: number; size: number }>();
    const stat: StatFile = (path) => {
      const file = files.get(path);
      if (file === undefined) return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      return Promise.resolve(file);
    };
    const callbacks: Array<() => void> = [];
    const clock: IntervalClock = (callback) => {
      callbacks.push(callback);
      return () => {
        const index = callbacks.indexOf(callback);
        if (index >= 0) callbacks.splice(index, 1);
      };
    };
    const watcher = createConfigWatcher({
      stat,
      clock,
      pollIntervalMs: 1,
      resolvePaths: (workspace) => ({ global: '/g/actions.json', workspace: `${workspace}/.dsh/actions.json` }),
      sessionPath: (workspace, sessionId) => `${workspace}/.sessions/${sessionId}/actions.json`,
    });
    const tick = async (): Promise<void> => {
      for (const callback of Array.from(callbacks)) callback();
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    return { files, watcher, tick };
  }

  it('an enrolled session file fires the workspace listeners on change', async () => {
    const { files, watcher, tick } = makeSessionWatcherFixture();
    let fired = 0;
    watcher.watchSession('/ws', 'session-1');
    watcher.watchWorkspace('/ws', () => {
      fired += 1;
    });
    await tick(); // baselines (session file included, silently)
    expect(fired).toBe(0);

    files.set('/ws/.sessions/session-1/actions.json', { mtimeMs: 1, size: 10 });
    await tick();
    expect(fired).toBe(1);
    await tick(); // dedupe
    expect(fired).toBe(1);
  });

  it('mid-stream enrollment establishes a silent baseline', async () => {
    const { files, watcher, tick } = makeSessionWatcherFixture();
    files.set('/ws/.sessions/session-1/actions.json', { mtimeMs: 1, size: 10 });
    let fired = 0;
    watcher.watchWorkspace('/ws', () => {
      fired += 1;
    });
    await tick();
    watcher.watchSession('/ws', 'session-1');
    await tick(); // new file observes baseline — no fire
    expect(fired).toBe(0);
    files.set('/ws/.sessions/session-1/actions.json', { mtimeMs: 2, size: 10 });
    await tick();
    expect(fired).toBe(1);
  });
});


// ---------------------------------------------------------------------------
// T50: deleteActionEntryFromFile (config file editing, atomic)
// ---------------------------------------------------------------------------

describe('deleteActionEntryFromFile (T50)', () => {
  function makeIo(initial?: string) {
    const files = new Map<string, string>();
    if (initial !== undefined) files.set('/ws/.dsh/actions.json', initial);
    const writes: string[] = [];
    const renames: Array<[string, string]> = [];
    const io: SessionFileIO = {
      readFile: (path) => {
        const file = files.get(path);
        if (file === undefined) return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
        return Promise.resolve(file);
      },
      writeFile: (path, content) => {
        files.set(path, content);
        writes.push(path);
        return Promise.resolve();
      },
      mkdir: () => Promise.resolve(),
      rename: (from, to) => {
        renames.push([from, to]);
        const content = files.get(from);
        if (content !== undefined) files.set(to, content);
        files.delete(from);
        return Promise.resolve();
      },
    };
    return { files, writes, renames, io };
  }

  const TWO = JSON.stringify({
    version: '1.0.0',
    actions: [
      { label: 'build', command: 'pnpm build' },
      { label: 'test', command: 'pnpm test' },
    ],
  });

  it('removes the entry and writes back atomically (tmp + rename)', async () => {
    const { files, writes, renames, io } = makeIo(TWO);
    const removed = await deleteActionEntryFromFile('/ws/.dsh/actions.json', 'build', io);
    expect(removed).toBe(true);
    expect(renames).toHaveLength(1);
    expect(renames[0]?.[1]).toBe('/ws/.dsh/actions.json');
    expect(renames[0]?.[0]).toContain('.tmp-');
    expect(writes).toEqual([renames[0]?.[0]]); // only the temp path was written
    const parsed = JSON.parse(files.get('/ws/.dsh/actions.json') ?? '') as { actions: Array<{ label: string }> };
    expect(parsed.actions.map((entry) => entry.label)).toEqual(['test']);
  });

  it('returns false for a missing file or a missing label, writing nothing', async () => {
    const missing = makeIo();
    expect(await deleteActionEntryFromFile('/ws/.dsh/actions.json', 'build', missing.io)).toBe(false);
    expect(missing.writes).toHaveLength(0);

    const present = makeIo(TWO);
    expect(await deleteActionEntryFromFile('/ws/.dsh/actions.json', 'nope', present.io)).toBe(false);
    expect(present.writes).toHaveLength(0);
    expect(present.files.get('/ws/.dsh/actions.json')).toBe(TWO); // untouched
  });

  it('refuses to clobber a syntactically broken file', async () => {
    const { io } = makeIo('{ not json');
    await expect(deleteActionEntryFromFile('/ws/.dsh/actions.json', 'build', io)).rejects.toThrow('unparseable');
  });
});
