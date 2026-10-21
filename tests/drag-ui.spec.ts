import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ACTIONS_CSS } from '../src/client/styles.js';
const panel = readFileSync(new URL('../src/client/panel.ts', import.meta.url), 'utf8');
// Source contracts: the real panel imports host-only browser modules; these do
// not claim browser rendering/drag dispatch coverage.
describe('whole-row animated drag integration', () => {
  it('allows row/name/description drags, rejects action controls, and uses the whole row image', () => {
    expect(panel).toContain("className: 'dsh-actions-row', draggable: props.presentationEnabled");
    expect(panel).toContain("pointerOrigin.current ??");
    expect(panel).toContain("interactive.matches('.dsh-actions-row-main, .dsh-actions-drag-handle')");
    expect(panel).toContain('event.dataTransfer.setDragImage(row, event.clientX - rect.left, event.clientY - rect.top)');
    expect(panel).toContain('if (suppressClick.current) { event.preventDefault(); event.stopPropagation();');
    expect(ACTIONS_CSS).toContain(".dsh-actions-row[draggable='true'] .dsh-actions-row-main { cursor: grab;");
  });
  it('removes the resident handle column but reveals the keyboard control on focus', () => {
    expect(ACTIONS_CSS).toContain('.dsh-actions-drag-handle { position: absolute; width: 1px; height: 1px;');
    expect(ACTIONS_CSS).toContain('.dsh-actions-drag-handle:focus-visible { position: static;');
    expect(ACTIONS_CSS).toContain('clip-path: inset(50%)');
    expect(panel).toContain("'aria-label': `${action.label}: ${t('reorderHandle')}`");
  });
  it('previews center crossings against untransformed layout and saves the current preview', () => {
    expect(panel).toContain('node.offsetTop + node.offsetHeight / 2');
    expect(panel).toContain('event.clientY < center + 3');
    expect(panel).toContain('event.clientY > center - 3');
    expect(panel).toContain('ids: move(current.ids, current.id, target)');
    expect(panel).toContain('ids: move(current.ids, current.id, current.ids.length - 1)');
    expect(panel).toContain('const labels = current.ids.map(');
    expect(panel).toContain('updateDrag({ ...current, saving: true })');
    expect(panel).not.toContain('save(move(props.actions.map(');
    expect(panel).not.toContain('[actionIds, props.source?.revision, enabled]');
  });
  it('keeps source-qualified chat references and detailed migration warnings', () => {
    expect(panel).toContain('buildActionToken(action.id)');
    expect(panel).toContain("t('migrationWarning'), ' ', warning");
  });
  it('animates keyed rows with bounded FLIP and respects motion/teardown', () => {
    expect(panel).toContain('React.useLayoutEffect(');
    expect(panel).toContain('node.getBoundingClientRect()');
    expect(panel).toContain("window.matchMedia?.('(prefers-reduced-motion: reduce)')");
    expect(panel).toContain("{ duration: 180, easing: 'ease-out' }");
    expect(panel).toContain('animation.cancel()');
    expect(ACTIONS_CSS).not.toMatch(/transition:\s*all/);
  });
});
