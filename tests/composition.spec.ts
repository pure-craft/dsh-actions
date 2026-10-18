import { describe, expect, it, vi } from 'vitest';
import { ACTIONS_API_PATHS } from '../src/host/rpc/index.js';
import type { ConnectionFetchRouteLike } from '../src/host/rpc/index.js';
import type { ToolDefinitionLike, ToolsLike } from '../src/host/tools/index.js';
import type { HostContext } from '../src/host/types.js';
import { apply, inject, name } from '../src/index.js';

class RecordingTools implements ToolsLike {
  readonly registered: string[] = [];

  register(definition: ToolDefinitionLike): () => void {
    this.registered.push(definition.name);
    return () => {
      const index = this.registered.indexOf(definition.name);
      if (index >= 0) this.registered.splice(index, 1);
    };
  }
}

class RecordingConnection {
  readonly routes: string[] = [];
  readonly fetch = {
    register: (route: ConnectionFetchRouteLike): (() => Promise<void>) => {
      this.routes.push(route.path);
      return async () => {
        const index = this.routes.indexOf(route.path);
        if (index >= 0) this.routes.splice(index, 1);
      };
    },
  };
}

class RecordingSkills {
  readonly registered: string[] = [];

  register(skill: { name: string }): () => void {
    this.registered.push(skill.name);
    return () => {
      const index = this.registered.indexOf(skill.name);
      if (index >= 0) this.registered.splice(index, 1);
    };
  }
}

interface Fixture {
  readonly ctx: HostContext;
  readonly tools: RecordingTools;
  readonly connection: RecordingConnection;
  readonly skills: RecordingSkills;
  readonly disposers: Array<() => void>;
}

function makeFixture(): Fixture {
  const tools = new RecordingTools();
  const connection = new RecordingConnection();
  const skills = new RecordingSkills();
  const disposers: Array<() => void> = [];
  const services: Record<string, unknown> = { tools, connection, skills, systemPrompt: { context: () => () => {} } };
  const ctx: HostContext = {
    get: (key) => services[key],
    provide: (key, value) => {
      services[key] = value;
      return value;
    },
    effect: (factory) => {
      const dispose = factory();
      if (typeof dispose === 'function') disposers.push(dispose);
    },
    on: () => () => {},
  };
  return { ctx, tools, connection, skills, disposers };
}

describe('bundle composition', () => {
  it('releases legacy async route registrations even after early teardown', async () => {
    const { ctx, disposers } = makeFixture();
    const releases: Array<(dispose: () => void) => void> = [];
    const disposeRoute = vi.fn();
    const get = ctx.get.bind(ctx);
    ctx.get = (key) => key === 'connection' ? { fetch: {
      register: () => new Promise<() => void>((resolve) => releases.push(resolve)),
    } } : get(key);
    apply(ctx, { seedGlobalExample: async () => false });
    for (const dispose of disposers) dispose();
    for (const release of releases) release(disposeRoute);
    await vi.waitFor(() => expect(disposeRoute).toHaveBeenCalledTimes(Object.values(ACTIONS_API_PATHS).length));
  });

  it('contains rejected asynchronous route cleanup', async () => {
    const { ctx, disposers } = makeFixture();
    const error = new Error('cleanup failed');
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    const get = ctx.get.bind(ctx);
    ctx.get = (key) => key === 'connection' ? { fetch: {
      register: () => async () => { throw error; },
    } } : get(key);
    try {
      apply(ctx, { seedGlobalExample: async () => false });
      for (const dispose of disposers) dispose();
      await vi.waitFor(() => expect(report).toHaveBeenCalledWith(expect.stringContaining('[dsh-actions] api route'), error));
    } finally {
      report.mockRestore();
    }
  });
  it('declares the services it consumes, so a cold boot waits for them', () => {
    // Without this export cordis runs `apply` before the tools registry and the
    // web connection channel exist; both `ctx.get` lookups then return
    // undefined and the bundle silently registers nothing. See docs/mvp.md.
    expect(name).toBe('dsh-actions');
    expect(inject).toEqual(['tools', 'connection', 'agents', 'skills', 'approval', 'systemPrompt']);
  });

  it('registers the agent tools, every API route, and the authoring skill', async () => {
    const { ctx, tools, connection, skills, disposers } = makeFixture();
    // Noop the one-time global seed: tests must not touch the real filesystem.
    apply(ctx, { seedGlobalExample: () => Promise.resolve(false) });
    // Current Host routes register synchronously; loading the packaged skill
    // still performs async I/O, so poll for that registration.
    await vi.waitFor(() => {
      expect(connection.routes).toHaveLength(Object.values(ACTIONS_API_PATHS).length);
      expect(skills.registered).toEqual(['dsh-actions-authoring']);
    });

    expect(ctx.get('dshActions')).toMatchObject({
      configureSession: expect.any(Function),
      clearSession: expect.any(Function),
      setSessionFolders: expect.any(Function),
    });
    expect([...tools.registered].sort()).toEqual(['actions_cancel', 'actions_configure', 'actions_query', 'actions_run']);
    expect([...connection.routes].sort()).toEqual(Object.values(ACTIONS_API_PATHS).sort());

    for (const dispose of disposers) dispose();
    expect(tools.registered).toEqual([]);
    expect(connection.routes).toEqual([]);
    expect(skills.registered).toEqual([]);
  });
});
