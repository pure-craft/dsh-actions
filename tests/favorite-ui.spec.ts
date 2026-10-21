import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ACTIONS_CSS } from '../src/client/styles.js';

// The panel depends on the host browser module loader. These narrow source
// contracts complement store tests without pretending to render the live UI.
const panel = readFileSync(new URL('../src/client/panel.ts', import.meta.url), 'utf8');

describe('favorite panel integration', () => {
  it('uses a resident, accessible toggle wired to the existing store write', () => {
    const favorite = panel.slice(panel.indexOf("className: 'dsh-actions-favorite'"), panel.indexOf('// S6:', panel.indexOf("className: 'dsh-actions-favorite'")));
    expect(favorite).toContain("'aria-pressed': action.favorite === true");
    expect(favorite).toContain('disabled: !props.presentationEnabled');
    expect(favorite).toContain('event.stopPropagation()');
    expect(favorite).toContain('props.store.setFavorite(action.id, action.favorite !== true)');
    expect(favorite).toContain("action.favorite === true ? '★' : '☆'");
    expect(ACTIONS_CSS).toContain(".dsh-actions-favorite[data-active='true'] { color: var(--dsw-alias-state-warn-primary");
    expect(ACTIONS_CSS).not.toMatch(/\.dsh-actions-favorite[^{}]*\{[^}]*opacity:\s*0[;}]/);
  });

  it('resets drag state for source changes rather than freshly filtered array identity', () => {
    expect(panel).toContain('[actionIds, props.source?.revision]');
    expect(panel).not.toContain('}, [props.actions])');
    expect(panel).toContain("if (event.key === 'Escape') { event.preventDefault(); cancelDrag(); return; }");
    expect(panel).toContain('onDragEnd: () => { if (dragRef.current?.saving !== true) cancelDrag(); }');
    expect(panel).toContain('if (dragRef.current === null || dragRef.current.keyboard || !enabled) return;');
    expect(ACTIONS_CSS).toContain(".dsh-actions-row[data-drop-target='true']");
  });
});
