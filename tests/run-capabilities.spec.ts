import { describe, expect, it } from 'vitest';
import { resolveRunCapabilities } from '../src/host/run/host.js';

describe('late Host capabilities', () => {
  it('discovers optional services supplied after bundle initialization', () => {
    const services = new Map<string, unknown>();
    const capabilities = resolveRunCapabilities({ get: (key) => services.get(key) });
    expect(capabilities.shell).toBeUndefined();
    expect(capabilities.jobs).toBeUndefined();
    const shell = { resolve: () => {}, execute: async () => {} };
    const jobs = { start: () => 'job-1', kill: () => 'requested' };
    services.set('shell', shell);
    services.set('jobs', jobs);
    expect(capabilities.shell).toBe(shell);
    expect(capabilities.jobs).toBe(jobs);
    services.clear();
    expect(capabilities.shell).toBeUndefined();
    expect(capabilities.jobs).toBeUndefined();
  });
});
