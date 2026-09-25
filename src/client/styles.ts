export const ACTIONS_CSS = `
/* conversation.view body (T43): fixed header, scrollable list, bottom workspace. */
.dsh-actions-page { box-sizing: border-box; height: 100%; overflow: hidden; padding: 28px clamp(24px, 4vw, 48px) 48px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); }
.dsh-actions-content { width: 100%; max-width: 960px; height: 100%; margin: 0 auto; display: flex; flex-direction: column; gap: 20px; }
/* The list region is the only scrolling region of the three. */
.dsh-actions-list { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 20px; }

/* Header: title + subtitle + read-only session workspace path, refresh at right */
.dsh-actions-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.dsh-actions-header-text { min-width: 0; }
.dsh-actions-header h1 { margin: 0; font-size: 20px; font-weight: 500; line-height: 28px; }
.dsh-actions-header p { margin: 4px 0 0; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 20px; }
.dsh-actions-header 
/* Source degradation banner */
.dsh-actions-banner { border: 1px solid var(--dsw-alias-state-warn-tertiary); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; }
.dsh-actions-banner-row { display: flex; align-items: center; gap: 8px; font-size: 13px; line-height: 20px; }
.dsh-actions-banner-icon { color: var(--dsw-alias-state-warn-primary); display: inline-flex; flex: none; }
.dsh-actions-banner-title { font-weight: 500; }
.dsh-actions-banner-meta { color: var(--dsw-alias-label-tertiary); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-actions-banner-toggle { margin-left: auto; }
.dsh-actions-banner-errors { margin: 0; padding: 8px 0 0 24px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 20px; display: flex; flex-direction: column; gap: 2px; overflow-wrap: anywhere; }

/* Grouped action list — mirrors the host list vocabulary:
   36px plain-text section heads (no hover fill), 32px+ rows with
   interactive-bg-hover, 14px/20px primary labels, 12px/20px tertiary detail. */
.dsh-actions-section-head { height: 36px; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 0 8px; color: var(--dsw-alias-label-tertiary); font-size: 12px; font-weight: 500; line-height: 20px; user-select: none; }
.dsh-actions-section-actions { display: flex; align-items: center; gap: 4px; flex: none; }
.dsh-actions-section-title { display: inline-flex; align-items: center; gap: 6px; }
.dsh-actions-section-tip { font-size: 12px; color: var(--dsw-alias-label-caption); font-weight: 400; margin-left: 6px; }
.dsh-actions-section-icon { display: inline-flex; color: var(--dsw-alias-label-tertiary); }
.dsh-actions-rows { display: flex; flex-direction: column; gap: 2px; }
.dsh-actions-row { display: flex; align-items: center; gap: 8px; min-height: 32px; padding: 4px 8px; border-radius: 8px; }
.dsh-actions-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-actions-row[data-selected='true'] { background: var(--dsw-alias-interactive-bg-active); }
.dsh-actions-row-main { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; padding: 0; border: none; background: none; font: inherit; color: inherit; text-align: left; cursor: pointer; }
.dsh-actions-row-label { font-size: 14px; line-height: 20px; color: var(--dsw-alias-label-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dsh-actions-row-detail { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; line-height: 20px; color: var(--dsw-alias-label-tertiary); }
/* T54: command tail in mono tertiary; badges are quiet hairline capsules */
/* S6: the active dot is a real sibling <button> — reset its chrome; the idle dot is an inert aligned span. */
.dsh-actions-row-dot { display: inline-flex; flex: none; cursor: pointer; padding: 2px; border: none; background: none; color: inherit; font: inherit; border-radius: 4px; }
.dsh-actions-row-dot:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-actions-row-dot-idle { cursor: default; }
.dsh-actions-row-dot-idle:hover { background: none; }
.dsh-actions-badge { display: inline-flex; align-items: center; gap: 3px; flex: none; padding: 0 6px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 999px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); white-space: nowrap; }
.dsh-actions-badge-warn { color: var(--dsw-alias-state-warn-label); border-color: var(--dsw-alias-state-warn-tertiary); }
.dsh-actions-row-side { display: flex; align-items: center; gap: 6px; flex: none; }

/* Output card */
.dsh-actions-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
.dsh-actions-card-head { display: flex; align-items: center; gap: 8px; }
.dsh-actions-card-head-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.dsh-actions-card-command { font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 13px; line-height: 20px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* T66: cwd on its own line, tail-ellipsis — the path tail carries the meaning */
.dsh-actions-card-cwd { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; unicode-bidi: plaintext; }
.dsh-actions-card-actions { margin-left: auto; display: flex; align-items: center; gap: 6px; flex: none; }
.dsh-actions-card-note { color: var(--dsw-alias-state-warn-label); font-size: 12px; line-height: 18px; }

/* Run-tab strip (T41): host-style underline tabs, 36px, horizontal scroll */
/* The workspace reads as a pull-up panel: elevated bg + top edge shadow */
.dsh-actions-runs { display: flex; flex-direction: column; gap: 12px; background: var(--dsw-alias-bg-layer-1); border-top: .5px solid var(--dsw-alias-border-l1); border-radius: 12px 12px 0 0; box-shadow: 0 -6px 16px rgba(0, 0, 0, 0.18); padding: 4px 10px 12px; margin: 0 -10px; }
/* Aligned to the host conversation tab strip's measured values (dsh-client-ui-chat):
   33px + font delta height, .5px border-l2 container line, tertiary -> primary text. */
.dsh-actions-tabs { display: flex; align-items: stretch; gap: 2px; height: calc(33px + var(--dsh-content-font-delta, 0px)); overflow-x: auto; overflow-y: hidden; border-bottom: .5px solid var(--dsw-alias-border-l2); scroll-behavior: smooth; scrollbar-width: none; }
/* Host dockkit strip mechanics: hidden scrollbar + 24px edge fades by scroll position */
.dsh-actions-tabs::-webkit-scrollbar { display: none; }
.dsh-actions-tabs[data-scroll='end'] { mask-image: linear-gradient(to right, black calc(100% - 24px), transparent); }
.dsh-actions-tabs[data-scroll='start'] { mask-image: linear-gradient(to right, transparent, black 24px); }
.dsh-actions-tabs[data-scroll='start end'] { mask-image: linear-gradient(to right, transparent, black 24px, black calc(100% - 24px), transparent); }
.dsh-actions-run-tab { display: flex; align-items: center; gap: 2px; border-bottom: 2px solid transparent; flex: none; }
.dsh-actions-run-tab[data-selected='true'] { border-bottom-color: var(--dsw-alias-state-business-primary); }
.dsh-actions-run-tab-main { display: flex; align-items: center; gap: 6px; padding: 0 8px; height: 100%; border: none; background: none; font: inherit; font-size: var(--dsh-content-font-size-secondary, 13px); line-height: 20px; color: var(--dsw-alias-label-tertiary); cursor: pointer; white-space: nowrap; }
.dsh-actions-run-tab-main:hover { color: var(--dsw-alias-label-primary); }
.dsh-actions-run-tab[data-selected='true'] .dsh-actions-run-tab-main { color: var(--dsw-alias-label-primary); }
.dsh-actions-run-tab-label { max-width: 160px; overflow: hidden; text-overflow: ellipsis; }
.dsh-actions-run-tab-main time { color: var(--dsw-alias-label-tertiary); font-size: 12px; font-variant-numeric: tabular-nums; }
/* Tab stop/close: quiet resident glyphs (small, tertiary; accent only on hover) */
.dsh-actions-tab-act { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border: none; border-radius: 50%; background: none; color: var(--dsw-alias-label-tertiary); cursor: pointer; padding: 0; flex: none; transition: background 120ms ease, color 120ms ease; }
.dsh-actions-tab-act:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dsh-actions-tab-stop:hover { color: var(--dsw-alias-state-error-primary); }
/* Strip + collapse toggle share one row: strip scrolls, toggle pinned right */
.dsh-actions-tabs-row { display: flex; align-items: stretch; border-bottom: .5px solid var(--dsw-alias-border-l2); }
.dsh-actions-tabs-row .dsh-actions-tabs { flex: 1; min-width: 0; border-bottom: none; }
/* Collapse toggle is the strip's only control — larger hit area than tab acts */
.dsh-actions-tab-toggle { align-self: center; margin-right: 6px; width: 24px; height: 24px; color: var(--dsw-alias-label-secondary); }
/* Send-to-chat affordance: text @ glyph at icon spec (no official at-icon exists) */
.dsh-actions-at-icon { display: inline-flex; align-items: center; justify-content: center; font-size: 15px; font-weight: 600; line-height: 1; }
/* T66: content-adaptive height — short output shrinks the card (keeps a
   panel-feel floor), long output scrolls inside at the same 45vh ceiling. */
.dsh-actions-card { max-height: 45vh; overflow-y: auto; }

/* Every stop/cancel affordance carries the host error color */
.dsh-actions-danger-icon { display: inline-flex; color: var(--dsw-alias-state-error-primary); }

/* Conflict projection bar */
.dsh-actions-conflict { border: 1px solid var(--dsw-alias-state-warn-tertiary); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
.dsh-actions-conflict-text { display: flex; align-items: flex-start; gap: 8px; font-size: 13px; line-height: 20px; }
.dsh-actions-conflict-buttons { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsh-actions-declined { border-color: var(--dsw-alias-border-l2); }

/* Parameter form (T34, Modal-based): fields stack inside the dialog body; the
   pin row sits left of the footer actions. */
.dsh-actions-param-field { display: flex; flex-direction: column; gap: 4px; }
.dsh-actions-param-field + .dsh-actions-param-field { margin-top: 10px; }
.dsh-actions-param-label { font-size: 12px; font-weight: 500; line-height: 18px; color: var(--dsw-alias-label-primary); }
.dsh-actions-param-required { color: var(--dsw-alias-state-error-primary); }
.dsh-actions-param-desc { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.dsh-actions-param-error { font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary); margin-top: 8px; }
.dsh-actions-params-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; flex-wrap: wrap; }
.dsh-actions-params-actions { display: flex; align-items: center; gap: 8px; flex: none; margin-left: auto; }
.dsh-actions-param-pin { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsh-actions-param-pin-tip { display: inline-flex; color: var(--dsw-alias-label-caption); cursor: help; }

/* Composer dock pill: never wrap (the stats strip squeezes it) */
.dsh-actions-dock-pill { white-space: nowrap; }

/* Tool-call views (conversation cards for actions_* tools) */
.dsh-actions-tv-summary { display: inline-flex; align-items: center; gap: 8px; min-width: 0; overflow: hidden; }
.dsh-actions-tv-summary-text { color: var(--dsw-alias-label-tertiary); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-actions-tv-pre { margin: 8px 0 0; padding: 8px 10px; border-radius: 8px; background: var(--dsw-alias-bg-layer-1); font-size: 12px; line-height: 18px; white-space: pre-wrap; word-break: break-all; color: var(--dsw-alias-label-secondary); }
.dsh-actions-tv-meta { font-size: 12px; color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-actions-tv-list { display: flex; flex-direction: column; gap: 2px; margin-top: 6px; }
.dsh-actions-tv-row { display: flex; align-items: center; gap: 8px; padding: 2px 0; font-size: 13px; line-height: 20px; }
.dsh-actions-tv-row-label { color: var(--dsw-alias-label-primary); }

/* Right-sidebar home: the narrow column compacts the same panel */
.dsh-actions-page[data-dsh-surface='sidebar-right'] { padding: 12px 10px 32px; }
.dsh-actions-page[data-dsh-surface='sidebar-right'] .dsh-actions-content { max-width: none; gap: 12px; }
.dsh-actions-page[data-dsh-surface='sidebar-right'] .dsh-actions-header h1 { font-size: 15px; line-height: 22px; }
.dsh-actions-page[data-dsh-surface='sidebar-right'] .dsh-actions-header p { font-size: 12px; line-height: 18px; }
.dsh-actions-param-pinned { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }

/* Empty / error states */
.dsh-actions-empty { min-height: 120px; display: grid; place-items: center; gap: 4px; color: var(--dsw-alias-label-secondary); border: 1px dashed var(--dsw-alias-border-l1); border-radius: 10px; font-size: 13px; line-height: 20px; padding: 16px; text-align: center; }
.dsh-actions-empty small { display: block; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.dsh-actions-error { color: var(--dsw-alias-state-error-primary); }
.dsh-actions-action-error { border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 18px; padding: 8px 12px; }
`;
