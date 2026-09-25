/**
 * Append-mode output composition (`presentation.panel: "append"`).
 *
 * Presentation-only: runs keep separate ids and buffers internally; this
 * helper merely concatenates older runs' output above the newest one with a
 * localized boundary line — the VS Code `shared` terminal experience.
 */
import type { RunViewState } from './store.js';

export interface AppendedOutput {
  output: string;
  /** True when any contributing run had earlier output dropped by the ring buffer. */
  truncated: boolean;
}

/**
 * Concatenate the given runs (newest first) oldest-to-newest, inserting
 * `boundary(nextRun.startedAt)` between consecutive runs.
 */
export function appendRunOutputs(
  runs: readonly RunViewState[],
  boundary: (startedAt: number) => string,
): AppendedOutput {
  const ordered = [...runs].reverse(); // oldest first
  let output = '';
  let truncated = false;
  for (let index = 0; index < ordered.length; index++) {
    const view = ordered[index]!;
    truncated ||= view.truncated;
    if (index > 0) output += `\n${boundary(view.run.startedAt)}\n`;
    output += view.output;
  }
  return { output, truncated };
}
