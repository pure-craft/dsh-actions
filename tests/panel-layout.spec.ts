import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ACTIONS_CSS } from '../src/client/styles.js';
const panel = readFileSync(new URL('../src/client/panel.ts', import.meta.url), 'utf8');
// Static layout contracts, not browser geometry or visual coverage.
describe('sidebar scrolling layout', () => {
  it('bounds the page to the pane and scrolls the flat list only', () => {
    expect(ACTIONS_CSS).toContain(".dsh-actions-page[data-dsh-surface='sidebar-right'] { position: relative; flex: 1; height: 100%; min-height: 0;");
    expect(ACTIONS_CSS).toContain('overscroll-behavior: contain; scrollbar-gutter: stable;');
    expect(ACTIONS_CSS).toContain(".dsh-actions-dock { position: absolute; bottom: 0;");
  });
  it('reserves measured dock height and updates when the output collapses', () => {
    expect(panel).toContain('new ResizeObserver(measure)');
    expect(panel).toContain("page.style.setProperty('--dsh-actions-dock-height'");
    expect(panel).toContain("'data-collapsed': collapsed");
    expect(ACTIONS_CSS).toContain('padding-bottom: calc(var(--dsh-actions-dock-height, 0px) + 20px)');
    expect(ACTIONS_CSS).toContain(".dsh-actions-runs[data-collapsed='true'] { gap: 0; padding-bottom: 4px; }");
  });
  it('does not shrink sections over their rows when the list fills up', () => {
    expect(ACTIONS_CSS).toContain('.dsh-actions-list > * { flex-shrink: 0; }');
    expect(ACTIONS_CSS).toContain('.dsh-actions-header, .dsh-actions-runs { flex-shrink: 0; }');
  });
  it('retains empty workspace headings and the workspace create entry', () => {
    expect(panel).toContain("title: t('sectionWorkspace')");
    expect(panel).toContain("writeCta !== undefined && layerEmpty('workspace')");
    expect(panel).toContain("ctaLabel: t('ctaCreateWorkspace')");
    expect(panel).not.toContain('workspaceActions.length > 0 ?');
  });
  it('keeps degradation banners independent of the header', () => {
    expect(ACTIONS_CSS).not.toMatch(/\.dsh-actions-header\s*\/\* Source degradation banner/);
  });
});
