import { describe, expect, it } from 'vitest';
import type { ActionsCatalog, ActionRunSummary, ProjectActionSummary } from '../src/contract.js';
import {
  parseActionRunSummary,
  parseActionsCatalog,
  parseActionsFileConfig,
  parseProjectActionSummary,
  parseRunStartResult,
  parseCatalogEventFrame,
  parseRunDiscoveryFrame,
  parseRunStreamFrame,
} from '../src/wire.js';

const ACTION: ProjectActionSummary = {
  id: 'workspace:build',
  label: 'build',
  detail: 'Build artifacts',
  sourceLayer: 'workspace',
  visibility: 'all',
  approval: 'never',
  command: 'pnpm build',
  cwd: '/repo',
  env: { NODE_ENV: 'production' },
  runOptions: { instanceLimit: 1, instancePolicy: 'reuse' },
};

const RUN: ActionRunSummary = {
  id: 'run-1',
  actionId: 'workspace:build',
  workspace: '/repo',
  status: 'running',
  startedAt: 1727000000000,
};

describe('parseActionsFileConfig', () => {
  it('accepts a minimal valid file', () => {
    expect(parseActionsFileConfig({ version: '1.0.0' })).toEqual({ version: '1.0.0' });
  });

  it('accepts a full entry', () => {
    const file = {
      version: '1.0.0',
      actions: [
        {
          label: 'build',
          command: 'pnpm build',
          detail: 'Build artifacts',
          visibility: 'ui',
          options: { cwd: 'packages/web', env: { NODE_ENV: 'production' } },
          runOptions: { instanceLimit: 2, instancePolicy: 'reject' },
          presentation: { panel: 'append' },
        },
      ],
    };
    expect(parseActionsFileConfig(file)).toEqual(file);
  });

  it('accepts an Iconify icon code and rejects a non-string icon (T65)', () => {
    const file = {
      version: '1.0.0',
      actions: [{ label: 'build', command: 'pnpm build', icon: 'lucide:rocket' }],
    };
    expect(parseActionsFileConfig(file)).toEqual(file);
    expect(() =>
      parseActionsFileConfig({ version: '1.0.0', actions: [{ label: 'build', command: 'x', icon: 42 }] }),
    ).toThrow('icon');
  });

  it('rejects a missing or unsupported version', () => {
    expect(() => parseActionsFileConfig({})).toThrow('missing version');
    expect(() => parseActionsFileConfig({ version: '2.0.0' })).toThrow('Unsupported actions file version');
  });

  it('rejects malformed entries', () => {
    expect(() => parseActionsFileConfig({ version: '1.0.0', actions: [{}] })).toThrow('missing label');
    expect(() => parseActionsFileConfig({ version: '1.0.0', actions: [{ label: 'x' }] })).toThrow('missing command');
    expect(() =>
      parseActionsFileConfig({ version: '1.0.0', actions: [{ label: 'x', command: 'y', visibility: 'hidden' }] }),
    ).toThrow('visibility');
    expect(() =>
      parseActionsFileConfig({ version: '1.0.0', actions: [{ label: 'x', command: 'y', options: { env: { A: 1 } } }] }),
    ).toThrow('options.env');
    expect(() =>
      parseActionsFileConfig({
        version: '1.0.0',
        actions: [{ label: 'x', command: 'y', runOptions: { instancePolicy: 'prompt' } }],
      }),
    ).toThrow('instancePolicy');
    expect(() =>
      parseActionsFileConfig({
        version: '1.0.0',
        actions: [{ label: 'x', command: 'y', presentation: { panel: 'shared' } }],
      }),
    ).toThrow('presentation.panel');
  });
});

describe('parseActionsFileConfig extends entries', () => {
  it('allows an extends entry without command but still requires command otherwise', () => {
    const base = { version: '1.0.0', actions: [] };
    expect(() => parseActionsFileConfig({
      ...base,
      actions: [{ label: 'derived', extends: 'workspace:build' }],
    })).not.toThrow();
    expect(() => parseActionsFileConfig({
      ...base,
      actions: [{ label: 'plain' }],
    })).toThrow('missing command');
    expect(() => parseActionsFileConfig({
      ...base,
      actions: [{ label: 'bad', command: 42 }],
    })).toThrow();
  });
});

describe('parseProjectActionSummary', () => {
  it('accepts a valid summary', () => {
    expect(parseProjectActionSummary(ACTION)).toEqual(ACTION);
  });

  it('rejects invalid layers, visibility, and run options', () => {
    expect(() => parseProjectActionSummary({ ...ACTION, sourceLayer: 'repo' })).toThrow('Invalid project action summary');
    expect(() => parseProjectActionSummary({ ...ACTION, visibility: 'hidden' })).toThrow('Invalid project action summary');
    expect(() =>
      parseProjectActionSummary({ ...ACTION, runOptions: { instanceLimit: 1, instancePolicy: 'terminate' } }),
    ).toThrow('Invalid project action summary');
  });

  it('accepts presentation panel modes and rejects unknown ones', () => {
    expect(parseProjectActionSummary({ ...ACTION, presentation: { panel: 'append' } }))
      .toEqual({ ...ACTION, presentation: { panel: 'append' } });
    expect(parseProjectActionSummary({ ...ACTION, presentation: { panel: 'dedicated' } }))
      .toEqual({ ...ACTION, presentation: { panel: 'dedicated' } });
    expect(() => parseProjectActionSummary({ ...ACTION, presentation: { panel: 'shared' } }))
      .toThrow('Invalid project action summary');
  });

  it('accepts an icon on the summary and rejects a non-string one (T65)', () => {
    expect(parseProjectActionSummary({ ...ACTION, icon: 'lucide:rocket' }))
      .toEqual({ ...ACTION, icon: 'lucide:rocket' });
    expect(() => parseProjectActionSummary({ ...ACTION, icon: null }))
      .toThrow('Invalid project action summary');
  });
});

describe('parseActionsCatalog', () => {
  it('accepts an empty catalog', () => {
    const catalog: ActionsCatalog = { apiVersion: 1, workspace: '/repo', sources: [], actions: [], runs: [] };
    expect(parseActionsCatalog(catalog)).toEqual(catalog);
  });

  it('accepts a populated catalog', () => {
    const catalog: ActionsCatalog = {
      apiVersion: 1,
      workspace: '/repo',
      sources: [{ layer: 'workspace', path: '/repo/.dsh/actions.json', available: true, errors: [] }],
      actions: [ACTION],
      runs: [RUN],
    };
    expect(parseActionsCatalog(catalog)).toEqual(catalog);
  });

  it('accepts a source status with an exists signal and rejects a non-boolean one (T61)', () => {
    const catalog: ActionsCatalog = {
      apiVersion: 1,
      workspace: '/repo',
      sources: [{ layer: 'session', path: '/p', available: true, exists: false, errors: [] }],
      actions: [],
      runs: [],
    };
    expect(parseActionsCatalog(catalog)).toEqual(catalog);
    expect(() =>
      parseActionsCatalog({
        apiVersion: 1,
        workspace: '/repo',
        sources: [{ layer: 'session', path: '/p', available: true, exists: 'yes', errors: [] }],
        actions: [],
        runs: [],
      }),
    ).toThrow('Invalid action source status');
  });

  it('rejects malformed envelopes and collections', () => {
    expect(() => parseActionsCatalog({ apiVersion: 2 })).toThrow('Invalid DSH Actions catalog envelope');
    expect(() => parseActionsCatalog({ apiVersion: 1, workspace: '/repo', sources: null, actions: [], runs: [] })).toThrow(
      'Invalid DSH Actions catalog collections',
    );
    expect(() =>
      parseActionsCatalog({ apiVersion: 1, workspace: '/repo', sources: [{ layer: 'repo' }], actions: [], runs: [] }),
    ).toThrow('Invalid action source status');
    expect(() =>
      parseActionsCatalog({
        apiVersion: 1,
        workspace: '/repo',
        sources: [{ layer: 'global', path: '/p', available: false, reason: 'weird', errors: [] }],
        actions: [],
        runs: [],
      }),
    ).toThrow('Invalid action source status');
  });
});

describe('parseActionRunSummary', () => {
  it('accepts running and terminal states', () => {
    expect(parseActionRunSummary(RUN)).toEqual(RUN);
    expect(parseActionRunSummary({ ...RUN, status: 'succeeded', finishedAt: 1, exitCode: 0 })).toMatchObject({
      status: 'succeeded',
    });
  });

  it('rejects unknown statuses', () => {
    expect(() => parseActionRunSummary({ ...RUN, status: 'stopping' })).toThrow('Invalid action run summary');
  });

  it('rejects a non-numeric exitCode', () => {
    expect(() => parseActionRunSummary({ ...RUN, exitCode: 'abc' })).toThrow('Invalid action run summary');
    expect(parseActionRunSummary({ ...RUN, exitCode: null })).toEqual({ ...RUN, exitCode: null });
    expect(parseActionRunSummary({ ...RUN, exitCode: 1 })).toEqual({ ...RUN, exitCode: 1 });
  });

  it('T14: accepts an optional sessionId and rejects non-string values', () => {
    // Wire compatibility: summaries without sessionId stay valid.
    expect(parseActionRunSummary(RUN)).toEqual(RUN);
    expect(parseActionRunSummary({ ...RUN, sessionId: 'session-1' })).toEqual({ ...RUN, sessionId: 'session-1' });
    expect(() => parseActionRunSummary({ ...RUN, sessionId: 7 })).toThrow('Invalid action run summary');
  });
});

describe('parseRunStartResult', () => {
  it('accepts every conflict-protocol outcome', () => {
    expect(parseRunStartResult({ kind: 'started', run: RUN })).toEqual({ kind: 'started', run: RUN });
    expect(parseRunStartResult({ kind: 'already-running', run: RUN })).toEqual({ kind: 'already-running', run: RUN });
    expect(parseRunStartResult({ kind: 'rejected', reason: 'exclusive', run: RUN })).toEqual({
      kind: 'rejected',
      reason: 'exclusive',
      run: RUN,
    });
  });

  it('rejects unknown kinds and reasons', () => {
    expect(() => parseRunStartResult({ kind: 'terminated', run: RUN })).toThrow('Invalid run start result');
    expect(() => parseRunStartResult({ kind: 'rejected', reason: 'busy', run: RUN })).toThrow('Invalid run start result');
    expect(() => parseRunStartResult({ kind: 'started' })).toThrow('Invalid run start result');
  });
});

describe('parseRunStreamFrame', () => {
  it('accepts output and status frames', () => {
    expect(parseRunStreamFrame({ type: 'output', runId: 'run-1', offset: 0, text: 'hello' })).toEqual({
      type: 'output',
      runId: 'run-1',
      offset: 0,
      text: 'hello',
    });
    expect(parseRunStreamFrame({ type: 'status', run: RUN })).toEqual({ type: 'status', run: RUN });
  });

  it('rejects malformed frames', () => {
    expect(() => parseRunStreamFrame({ type: 'output', runId: 'run-1' })).toThrow('Invalid run stream output frame');
    expect(() =>
      parseRunStreamFrame({ type: 'output', runId: 'run-1', offset: 0, text: 'x', truncated: 'yes' }),
    ).toThrow('Invalid run stream output frame');
    expect(() => parseRunStreamFrame({ type: 'heartbeat' })).toThrow('Invalid run stream frame');
  });
});

describe('parseRunDiscoveryFrame', () => {
  it('accepts snapshot and status frames (T16H)', () => {
    expect(parseRunDiscoveryFrame({ type: 'snapshot', runs: [RUN] })).toEqual({ type: 'snapshot', runs: [RUN] });
    expect(parseRunDiscoveryFrame({ type: 'snapshot', runs: [] })).toEqual({ type: 'snapshot', runs: [] });
    expect(parseRunDiscoveryFrame({ type: 'status', run: RUN })).toEqual({ type: 'status', run: RUN });
  });

  it('rejects malformed frames', () => {
    expect(() => parseRunDiscoveryFrame({ type: 'snapshot', runs: 'nope' })).toThrow(
      'Invalid run discovery snapshot frame',
    );
    expect(() => parseRunDiscoveryFrame({ type: 'snapshot', runs: [{ id: 1 }] })).toThrow(
      'Invalid action run summary',
    );
    expect(() => parseRunDiscoveryFrame({ type: 'status', run: { id: 1 } })).toThrow('Invalid action run summary');
    expect(() => parseRunDiscoveryFrame({ type: 'output' })).toThrow('Invalid run discovery frame');
    expect(() => parseRunDiscoveryFrame(null)).toThrow('Invalid run discovery frame');
  });
});

describe('parseCatalogEventFrame', () => {
  const CATALOG: ActionsCatalog = { apiVersion: 1, workspace: '/repo', sources: [], actions: [], runs: [] };

  it('accepts a catalog frame (T21)', () => {
    const frame = { type: 'catalog', catalog: { ...CATALOG, actions: [ACTION], runs: [RUN] } };
    expect(parseCatalogEventFrame(frame)).toEqual(frame);
  });

  it('rejects malformed frames', () => {
    expect(() => parseCatalogEventFrame({ type: 'catalog' })).toThrow('Invalid DSH Actions catalog envelope');
    expect(() => parseCatalogEventFrame({ type: 'snapshot', catalog: CATALOG })).toThrow('Invalid catalog event frame');
    expect(() => parseCatalogEventFrame(null)).toThrow('Invalid catalog event frame');
  });
});

// ---------------------------------------------------------------------------
// inputs declarations (2.4)
// ---------------------------------------------------------------------------

describe('inputs validation', () => {
  const entry = (inputs: unknown): unknown => ({
    version: '1.0.0',
    actions: [{ label: 'x', command: 'y', inputs }],
  });

  it('accepts string and select inputs', () => {
    const file = {
      version: '1.0.0',
      actions: [
        {
          label: 'deploy',
          command: 'deploy ${input:env}',
          inputs: [
            { id: 'env', type: 'select', options: ['staging', 'prod'], default: 'staging', description: '目标环境' },
            { id: 'tag', type: 'string', required: true },
            { id: 'note', type: 'string', default: '' },
          ],
        },
      ],
    };
    expect(parseActionsFileConfig(file)).toEqual(file);
  });

  it('rejects malformed input declarations with field-level paths (T63a)', () => {
    expect(() => parseActionsFileConfig(entry('nope'))).toThrow('actions[0].inputs');
    expect(() => parseActionsFileConfig(entry([{ type: 'string' }]))).toThrow('actions[0].inputs[0].id');
    expect(() => parseActionsFileConfig(entry([{ id: 'a}b', type: 'string' }]))).toThrow('must not contain }');
    expect(() => parseActionsFileConfig(entry([{ id: 'a', type: 'number' }]))).toThrow('actions[0].inputs[0].type');
    expect(() => parseActionsFileConfig(entry([{ id: 'a', type: 'string', required: 'yes' }]))).toThrow(
      'actions[0].inputs[0].required',
    );
    expect(() => parseActionsFileConfig(entry([{ id: 'a', type: 'string', default: 1 }]))).toThrow(
      'actions[0].inputs[0].default',
    );
    expect(() => parseActionsFileConfig(entry([{ id: 'a', type: 'string', options: 'x' }]))).toThrow(
      'actions[0].inputs[0].options',
    );
  });

  it('requires non-empty options for select and a default within them', () => {
    expect(() => parseActionsFileConfig(entry([{ id: 's', type: 'select' }]))).toThrow(
      'actions[0].inputs[0].options: must declare at least one option',
    );
    expect(() => parseActionsFileConfig(entry([{ id: 's', type: 'select', options: [] }]))).toThrow(
      'actions[0].inputs[0].options: must declare at least one option',
    );
    expect(() =>
      parseActionsFileConfig(entry([{ id: 's', type: 'select', options: ['a'], default: 'b' }])),
    ).toThrow('actions[0].inputs[0].default: default must be one of options');
  });

  it('rejects duplicate input ids', () => {
    expect(() =>
      parseActionsFileConfig(
        entry([
          { id: 'a', type: 'string' },
          { id: 'a', type: 'select', options: ['x'] },
        ]),
      ),
    ).toThrow('duplicate input id "a"');
  });

  it('validates inputs on project action summaries', () => {
    const inputs = [{ id: 'env', type: 'select', options: ['staging', 'prod'] }];
    expect(parseProjectActionSummary({ ...ACTION, inputs })).toEqual({ ...ACTION, inputs });
    expect(() => parseProjectActionSummary({ ...ACTION, inputs: [{ id: 'x', type: 'bool' }] })).toThrow(
      'Invalid project action summary',
    );
    expect(() => parseProjectActionSummary({ ...ACTION, inputs: 'nope' })).toThrow(
      'Invalid project action summary',
    );
  });
});

describe('T29 approval contract', () => {
  it('validates the approval enum on entries and summaries', () => {
    const file = { version: '1.0.0', actions: [{ label: 'deploy', command: 'x', approval: 'always' }] };
    expect(parseActionsFileConfig(file)).toEqual(file);
    expect(() => parseActionsFileConfig({ version: '1.0.0', actions: [{ label: 'x', command: 'y', approval: 'sometimes' }] })).toThrow(
      'approval',
    );
    expect(parseProjectActionSummary({ ...ACTION, approval: 'agent' })).toMatchObject({ approval: 'agent' });
    expect(() => parseProjectActionSummary({ ...ACTION, approval: 'sometimes' })).toThrow(
      'Invalid project action summary',
    );
  });

  it('accepts approval-declined and keeps it distinct from conflict rejection', () => {
    const declined = { kind: 'approval-declined', actionId: 'workspace:deploy', outcome: 'rejected' };
    expect(parseRunStartResult(declined)).toEqual(declined);
    expect(() => parseRunStartResult({ kind: 'approval-declined', actionId: 'x', outcome: 'busy' })).toThrow(
      'Invalid run start result',
    );
    // Extra fields pass through untouched; the variant needs no run.
    expect(parseRunStartResult({ kind: 'approval-declined', actionId: 'x', outcome: 'rejected' })).toEqual({
      kind: 'approval-declined',
      actionId: 'x',
      outcome: 'rejected',
    });
    // Conflict rejection still requires its own shape.
    expect(parseRunStartResult({ kind: 'rejected', reason: 'exclusive', run: RUN })).toEqual({
      kind: 'rejected',
      reason: 'exclusive',
      run: RUN,
    });
  });
});

describe('T33 run params on the wire', () => {
  it('accepts optional string-record params and rejects others', () => {
    expect(parseActionRunSummary({ ...RUN, params: { target: 'web' } })).toEqual({ ...RUN, params: { target: 'web' } });
    expect(parseActionRunSummary(RUN)).toEqual(RUN);
    expect(() => parseActionRunSummary({ ...RUN, params: { target: 5 } })).toThrow('Invalid action run summary');
  });
});

describe('numeric fields reject NaN/Infinity (T36)', () => {
  it('run options instanceLimit must be finite', () => {
    expect(() =>
      parseProjectActionSummary({ ...ACTION, runOptions: { instanceLimit: Number.NaN, instancePolicy: 'reuse' } }),
    ).toThrow('Invalid project action summary');
    expect(() =>
      parseProjectActionSummary({ ...ACTION, runOptions: { instanceLimit: Infinity, instancePolicy: 'reuse' } }),
    ).toThrow('Invalid project action summary');
  });

  it('run startedAt must be finite', () => {
    expect(() => parseActionRunSummary({ ...RUN, startedAt: Number.NaN })).toThrow('Invalid action run summary');
    expect(() => parseActionRunSummary({ ...RUN, startedAt: Infinity })).toThrow('Invalid action run summary');
  });

  it('stream output offset must be finite', () => {
    expect(() =>
      parseRunStreamFrame({ type: 'output', runId: 'run-1', offset: Number.NaN, text: 'x' }),
    ).toThrow('Invalid run stream output frame');
    expect(() =>
      parseRunStreamFrame({ type: 'output', runId: 'run-1', offset: Infinity, text: 'x' }),
    ).toThrow('Invalid run stream output frame');
  });
});


describe('T47 session layer and extends on the wire', () => {
  it('accepts the session source layer and extends references', () => {
    const summary = { ...ACTION, sourceLayer: 'session', extends: 'workspace:build' };
    expect(parseProjectActionSummary(summary)).toEqual(summary);
    expect(() => parseProjectActionSummary({ ...ACTION, sourceLayer: 'package' })).toThrow(
      'Invalid project action summary',
    );
    expect(() => parseProjectActionSummary({ ...ACTION, extends: 5 })).toThrow('Invalid project action summary');
    expect(
      parseActionsFileConfig({ version: '1.0.0', actions: [{ label: 'x', command: 'y', extends: 'workspace:build' }] }),
    ).toBeDefined();
    expect(() =>
      parseActionsFileConfig({ version: '1.0.0', actions: [{ label: 'x', command: 'y', extends: 3 }] }),
    ).toThrow('extends');
  });
});
