import { describe, expect, it } from 'vitest';
import type { ActionRunSummary } from '../src/contract.js';
import { appendRunOutputs } from '../src/client/run-display.js';
import type { RunViewState } from '../src/client/store.js';

function run(id: string, startedAt: number, output: string, truncated = false): RunViewState {
  const summary: ActionRunSummary = {
    id,
    actionId: 'workspace:build',
    workspace: '/repo',
    sessionId: 's1',
    status: 'succeeded',
    startedAt,
    finishedAt: startedAt + 1000,
    exitCode: 0,
  };
  return { run: summary, output, offset: output.length, truncated, streaming: false, settled: true };
}

describe('appendRunOutputs', () => {
  it('returns the single run output unchanged', () => {
    const result = appendRunOutputs([run('r1', 1000, 'build ok\n')], (at) => `boundary-${String(at)}`);
    expect(result).toEqual({ output: 'build ok\n', truncated: false });
  });

  it('concatenates oldest-to-newest with a boundary before each re-run', () => {
    const result = appendRunOutputs(
      [run('r3', 3000, 'third\n'), run('r2', 2000, 'second\n'), run('r1', 1000, 'first\n')],
      (at) => `── re-run · ${String(at)} ──`,
    );
    expect(result.output).toBe(
      'first\n\n── re-run · 2000 ──\nsecond\n\n── re-run · 3000 ──\nthird\n',
    );
  });

  it('propagates truncation from any contributing run', () => {
    const result = appendRunOutputs(
      [run('r2', 2000, 'new\n'), run('r1', 1000, 'old\n', true)],
      (at) => `boundary-${String(at)}`,
    );
    expect(result.truncated).toBe(true);
  });
});
