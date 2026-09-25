/**
 * Real host wiring for the run service.
 *
 * `ctx.shell` and `ctx.jobs` are optional host services; resolve them through
 * `ctx.get()` with an undefined check (per the DSH service contracts). A
 * missing shell makes `run()` fail with a structured `shell-unavailable`
 * error; a missing jobs registry only drops job registration.
 */

import type { JobsLike, ShellLike } from './service.js';

/** Minimal context surface needed to resolve the run capabilities. */
export interface HostServiceResolver {
  get(key: string): unknown;
}

export interface RunCapabilities {
  shell?: ShellLike | undefined;
  jobs?: JobsLike | undefined;
}

function isShellLike(value: unknown): value is ShellLike {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  // DSH 0.1.7 renamed ShellLike.start to ShellLike.execute.
  return typeof candidate.resolve === 'function' && typeof candidate.execute === 'function';
}

function isJobsLike(value: unknown): value is JobsLike {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.start === 'function' && typeof candidate.kill === 'function';
}

export function resolveRunCapabilities(ctx: HostServiceResolver): RunCapabilities {
  const shell = ctx.get('shell');
  const jobs = ctx.get('jobs');
  return {
    shell: isShellLike(shell) ? shell : undefined,
    jobs: isJobsLike(jobs) ? jobs : undefined,
  };
}
