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
    register: (route: ConnectionFetchRouteLike): Promise<() => void> => {
      this.routes.push(route.path);
      return Promise.resolve(() => {
        const index = this.routes.indexOf(route.path);
        if (index >= 0) this.routes.splice(index, 1);
      });
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
  const services: Record<string, unknown> = { tools, connection, skills };
  const ctx: HostContext = {
    get: (key) => services[key],
    effect: (factory) => {
      const dispose = factory();
      if (typeof dispose === 'function') disposers.push(dispose);
    },
  };
  return { ctx, tools, connection, skills, disposers };
}

describe('bundle composition', () => {
  it('declares the services it consumes, so a cold boot waits for them', () => {
    // Without this export cordis runs `apply` before the tools registry and the
    // web connection channel exist; both `ctx.get` lookups then return
    // undefined and the bundle silently registers nothing. See docs/mvp.md.
    expect(name).toBe('dsh-actions');
    expect(inject).toEqual(['tools', 'connection', 'agents', 'skills', 'approval']);
  });

  it('registers the agent tools, every API route, and the authoring skill', async () => {
    const { ctx, tools, connection, skills, disposers } = makeFixture();
    // Noop the one-time global seed: tests must not touch the real filesystem.
    apply(ctx, { seedGlobalExample: () => Promise.resolve(false) });
    // Route and skill registration go through real async I/O (fetch.register
    // and readFile of the packaged SKILL.md); poll rather than assuming one
    // macrotask is enough.
    await vi.waitFor(() => {
      expect(connection.routes).toHaveLength(Object.values(ACTIONS_API_PATHS).length);
      expect(skills.registered).toEqual(['dsh-actions-authoring']);
    });

    expect([...tools.registered].sort()).toEqual(['actions_cancel', 'actions_inspect', 'actions_list', 'actions_register', 'actions_run', 'actions_set_params']);
    expect([...connection.routes].sort()).toEqual(Object.values(ACTIONS_API_PATHS).sort());

    for (const dispose of disposers) dispose();
    expect(tools.registered).toEqual([]);
    expect(connection.routes).toEqual([]);
    expect(skills.registered).toEqual([]);
  });
});
