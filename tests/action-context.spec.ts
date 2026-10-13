import { describe, expect, it, vi } from 'vitest';
import type { ProjectActionSummary } from '../src/contract.js';
import {
  registerAvailableActionsContext,
  renderAvailableActionsContext,
  type ActionContextAgentLike,
  type ActionContextHostLike,
} from '../src/host/action-context.js';

function action(overrides: Partial<ProjectActionSummary> = {}): ProjectActionSummary {
  return {
    id: 'workspace:test', label: 'test', sourceLayer: 'workspace', visibility: 'all', approval: 'never',
    command: 'pnpm test', cwd: '/ws', runOptions: { instanceLimit: 1, instancePolicy: 'reuse' }, ...overrides,
  };
}

describe('available Actions runtime context', () => {
  it('injects concise action discovery and maps all four tools', () => {
    const text = renderAvailableActionsContext([action({
      detail: 'Run tests', approval: 'agent',
      inputs: [{ id: 'suite', type: 'string', required: true }, { id: 'mode', type: 'select', default: 'fast', options: ['fast'] }],
    })]);
    expect(text).toContain('- workspace:test: test — Run tests; approval: agent; inputs: suite*, mode=fast');
    for (const tool of ['actions_query', 'actions_run', 'actions_cancel', 'actions_configure']) expect(text).toContain(tool);
    expect(text).toContain('same catalog as its Actions panel');
    expect(text).not.toContain('pnpm test');
  });

  it('excludes ui-only actions and stays quiet when none are callable', () => {
    expect(renderAvailableActionsContext([action({ visibility: 'ui' })])).toBe('');
    expect(renderAvailableActionsContext([])).toBe('');
  });

  it('loads only fresh-session catalogs and binds them to that agent', async () => {
    let listener: ((payload: { agent: ActionContextAgentLike; source: 'startup' | 'resume' | 'clear' | 'compact' }) => Promise<void>) | undefined;
    let text: ((context: { agent?: ActionContextAgentLike }) => string) | undefined;
    const loadCatalog = vi.fn(async () => ({ actions: [action()] }));
    const host = {
      effect(factory: () => (() => void) | void) { factory(); },
      get: () => ({ context: (entry: { text: typeof text }) => { text = entry.text; return () => {}; } }),
      on: (_name: 'agent/created', next: typeof listener) => { listener = next; return () => {}; },
    } as ActionContextHostLike;
    registerAvailableActionsContext(host, { loadCatalog });
    const agent = { id: 'session-1', session: { header: { cwd: '/ws' } } };

    await listener?.({ agent, source: 'resume' });
    expect(loadCatalog).not.toHaveBeenCalled();
    expect(text?.({ agent })).toBe('');

    await listener?.({ agent, source: 'startup' });
    expect(loadCatalog).toHaveBeenCalledWith('/ws', 'session-1');
    expect(text?.({ agent })).toContain('workspace:test');
  });
});
