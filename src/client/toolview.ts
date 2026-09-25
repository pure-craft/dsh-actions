/**
 * Custom conversation renderings for the actions_* tools.
 *
 * The `tool.call.toolview` slot is keyed by tool name; a keyed hit replaces
 * the host's generic "工具调用" row. Every view is ONE DisclosureRow in the
 * shape ui-deliverables established (icon + title + tertiary summary, body on
 * expand) so the cards read as native UI. All parsing is defensive: unknown
 * or legacy payload shapes fall back to a styled raw-text body.
 */
import * as React from 'react';
import {
  DisclosureRow,
  IconInspectOutlineRegular,
  IconListPenOutlineRegular,
  IconPinOutlineRegular,
  IconPlayOutlineRegular,
  IconShieldOutlineRegular,
  IconStopFillRegular,
  IconWarningOutlineRegular,
  StateDot,
  TerminalBlock,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type { StateDotState, TerminalBlockLabels } from '@deepseek-ai/dsh-client-ui-primitives';
import { ACTIONS_PLUGIN_ID } from '../contract.js';
import type { ActionRunStatus } from '../contract.js';
import type { Translate } from './locale.js';

const h = React.createElement;

// ---------------------------------------------------------------------------
// Block parsing (mirrors the host's tool-call block shape)
// ---------------------------------------------------------------------------

interface ToolCallBlock {
  kind?: string;
  argsRaw?: string;
  call?: { argsRaw?: string };
  content?: Array<{ type: string; text?: string }>;
  error?: { name?: string; code?: string };
  isError?: boolean;
}

export interface ToolViewProps {
  block: ToolCallBlock;
  t: Translate;
}

function argsOf(block: ToolCallBlock): Record<string, unknown> {
  const raw = block.call?.argsRaw ?? block.argsRaw ?? '';
  if (typeof raw !== 'string' || raw === '') return {};
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function textOf(block: ToolCallBlock): string {
  const content = block.content ?? [];
  const joined = content.map((item) => (item.type === 'text' ? (item.text ?? '') : JSON.stringify(item))).join('\n');
  if (joined !== '') return joined;
  if (block.error !== undefined) return `${block.error.name ?? 'Error'}: ${block.error.code ?? ''}`;
  return '';
}

function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function shortLabel(actionId: string): string {
  const at = actionId.indexOf(':');
  return at === -1 ? actionId : actionId.slice(at + 1);
}

function dotState(status: string | undefined): StateDotState {
  switch (status) {
    case 'queued':
    case 'running': return 'ongoing';
    case 'succeeded': return 'done';
    case 'failed': return 'error';
    case 'cancelled': return 'warning';
    default: return 'idle';
  }
}

function statusKey(status: string): 'statusQueued' | 'statusRunning' | 'statusSucceeded' | 'statusFailed' | 'statusCancelled' {
  switch (status as ActionRunStatus) {
    case 'queued': return 'statusQueued';
    case 'running': return 'statusRunning';
    case 'succeeded': return 'statusSucceeded';
    case 'failed': return 'statusFailed';
    default: return 'statusCancelled';
  }
}

function terminalLabels(t: Translate): TerminalBlockLabels {
  return {
    signal: (signal) => t('termSignal', { signal }),
    exitCode: (code) => t('termExitCode', { code }),
    noExitCode: t('termNoExitCode'),
    running: t('termRunning'),
    failed: t('termFailed'),
    done: t('termDone'),
    copy: t('termCopy'),
    copied: t('termCopied'),
    noOutput: t('termNoOutput'),
    collapseAria: t('termCollapseAria'),
    collapse: t('termCollapse'),
    expandAria: (hidden) => t('termExpandAria', { hidden }),
    expand: (hidden) => t('termExpand', { hidden }),
  };
}

/**
 * The one native card shape every view uses: DisclosureRow with an icon and a
 * semantic title; the collapsed side carries a tertiary summary (state dot +
 * summary text, truncated); the body (detail text or a component) appears on
 * expand. Mirrors ui-deliverables' PresentRow.
 */
function ToolCard(props: {
  title: string;
  icon: React.ReactNode;
  state: StateDotState;
  summary: string;
  children?: React.ReactNode;
}): React.ReactElement {
  const [expanded, setExpanded] = React.useState(false);
  const expandable = props.children !== undefined && props.children !== null;
  return h(DisclosureRow, {
    title: `${ACTIONS_PLUGIN_ID} · ${props.title}`,
    icon: props.icon,
    open: expanded && expandable,
    expandable,
    expandOnRowClick: true,
    keepContentWhenOpen: true,
    onToggle: () => { setExpanded((value) => !value); },
    collapsedContent: props.summary === '' ? null : h('span', { className: 'dsh-actions-tv-summary' },
      h(StateDot, { state: props.state, size: 10 }),
      h('span', { className: 'dsh-actions-tv-summary-text' }, props.summary),
    ),
  }, expandable ? props.children : null);
}

function TextBody(props: { text: string }): React.ReactElement {
  return h('pre', { className: 'dsh-actions-tv-pre' }, props.text);
}

// ---------------------------------------------------------------------------
// actions_run
// ---------------------------------------------------------------------------

type RunOutcome = 'started' | 'already-running' | 'rejected' | 'approval-declined' | 'unknown';

function outcomeOf(text: string): RunOutcome {
  if (text.startsWith('Started')) return 'started';
  if (text.startsWith('Already running')) return 'already-running';
  if (text.startsWith('Approval')) return 'approval-declined';
  if (text.startsWith('Rejected')) return 'rejected';
  return 'unknown';
}

export function ActionsRunView({ block, t }: ToolViewProps): React.ReactElement {
  const args = argsOf(block);
  const actionId = typeof args.actionId === 'string' ? args.actionId : '';
  const text = textOf(block);
  const outcome = outcomeOf(text);
  const state: StateDotState = outcome === 'started' ? 'done'
    : outcome === 'already-running' ? 'ongoing'
    : outcome === 'unknown' ? 'idle'
    : 'warning';
  const icon = outcome === 'approval-declined'
    ? h(IconShieldOutlineRegular, { size: 14 })
    : outcome === 'rejected'
      ? h(IconWarningOutlineRegular, { size: 14 })
      : h(IconPlayOutlineRegular, { size: 14 });
  const titleKey = outcome === 'started' ? 'tvRunStarted'
    : outcome === 'already-running' ? 'tvRunAlready'
    : outcome === 'rejected' ? 'tvRunRejected'
    : outcome === 'approval-declined' ? 'tvRunDeclined'
    : 'tvRun';
  const params = Object.keys(args.params ?? {}).length > 0 ? `params: ${JSON.stringify(args.params)}` : '';
  const detail = [actionId !== '' ? `actionId: ${actionId}` : '', params, text].filter((line) => line !== '').join('\n');
  return h(ToolCard, {
    title: `${t(titleKey)}${actionId === '' ? '' : ` · ${shortLabel(actionId)}`}`,
    icon,
    state,
    summary: text.split('\n')[0] ?? '',
    children: h(TextBody, { text: detail }),
  });
}

// ---------------------------------------------------------------------------
// actions_inspect
// ---------------------------------------------------------------------------

interface InspectionPayload {
  run?: { id?: string; actionId?: string; status?: string; exitCode?: number | null; startedAt?: number };
  action?: { command?: string; cwd?: string; label?: string };
  output?: { text?: string };
}

export function ActionsInspectView({ block, t }: ToolViewProps): React.ReactElement {
  const text = textOf(block);
  const payload = jsonOf(text) as InspectionPayload | undefined;
  if (payload?.run !== undefined && payload.action !== undefined) {
    const status = payload.run.status ?? '';
    const active = status === 'queued' || status === 'running';
    const label = payload.action.label ?? (payload.run.actionId === undefined ? '' : shortLabel(payload.run.actionId));
    return h(ToolCard, {
      title: `${t('tvInspect')} · ${label}`,
      icon: h(IconInspectOutlineRegular, { size: 14 }),
      state: dotState(status),
      summary: `${payload.run.id ?? ''} · ${t(statusKey(status))}`,
      children: h(TerminalBlock, {
        command: payload.action.command ?? '',
        cwd: payload.action.cwd ?? '',
        output: payload.output?.text ?? '',
        running: active,
        exitCode: !active && payload.run.exitCode !== undefined ? payload.run.exitCode : undefined,
        labels: terminalLabels(t),
      }),
    });
  }
  return h(ToolCard, {
    title: t('tvInspect'),
    icon: h(IconInspectOutlineRegular, { size: 14 }),
    state: 'idle',
    summary: text.split('\n')[0] ?? '',
    children: h(TextBody, { text }),
  });
}

// ---------------------------------------------------------------------------
// actions_list
// ---------------------------------------------------------------------------

const LIST_ROW = /^- (.+?) \((.+?)\) — (.+)$/;

export function ActionsListView({ block, t }: ToolViewProps): React.ReactElement {
  const text = textOf(block);
  const lines = text.split('\n');
  const header = lines[0] ?? '';
  const rows = lines.slice(1)
    .map((line) => LIST_ROW.exec(line))
    .filter((match): match is RegExpExecArray => match !== null);
  const summary = rows.length === 0 ? header : t('tvListSummary', { count: rows.length });
  return h(ToolCard, {
    title: t('tvList'),
    icon: h(IconListPenOutlineRegular, { size: 14 }),
    state: 'idle',
    summary,
    children: rows.length === 0
      ? h(TextBody, { text })
      : h('div', { className: 'dsh-actions-tv-list' },
          ...rows.map((match) => h('div', { key: match[2], className: 'dsh-actions-tv-row' },
            h(StateDot, { state: dotState(match[3]), size: 8 }),
            h('span', { className: 'dsh-actions-tv-row-label' }, match[1]),
            h('span', { className: 'dsh-actions-tv-meta' }, match[3]),
          )),
        ),
  });
}

// ---------------------------------------------------------------------------
// actions_cancel
// ---------------------------------------------------------------------------

export function ActionsCancelView({ block, t }: ToolViewProps): React.ReactElement {
  const text = textOf(block);
  return h(ToolCard, {
    title: t('tvCancel'),
    icon: h('span', { style: { color: 'var(--dsw-alias-state-error-primary)', display: 'inline-flex' } },
      h(IconStopFillRegular, { size: 14 })),
    state: 'warning',
    summary: text.split('\n')[0] ?? '',
    children: h(TextBody, { text }),
  });
}

// ---------------------------------------------------------------------------
// actions_set_params
// ---------------------------------------------------------------------------

export function ActionsSetParamsView({ block, t }: ToolViewProps): React.ReactElement {
  const payload = jsonOf(textOf(block)) as
    | { actionId?: string; sessionParams?: Record<string, unknown>; sessionId?: string }
    | undefined;
  const sessionParams = payload?.sessionParams ?? {};
  // S4: a no-actionId list call returns the NESTED board
  // (Record<actionId, Record<input, value>>) — group per action instead of
  // stringifying it into [object Object].
  const nested = Object.values(sessionParams).some((value) => typeof value === 'object' && value !== null);
  if (nested) {
    const groups = Object.entries(sessionParams as Record<string, Record<string, string>>);
    const count = groups.reduce((total, [, values]) => total + Object.keys(values).length, 0);
    const text = groups
      .map(([actionId, values]) =>
        `${shortLabel(actionId)}:\n${Object.entries(values)
          .map(([key, value]) => `  ${key} = ${value}`)
          .join('\n')}`,
      )
      .join('\n');
    return h(ToolCard, {
      title: t('tvPin'),
      icon: h(IconPinOutlineRegular, { size: 14 }),
      state: count === 0 ? 'idle' : 'done',
      summary: count === 0 ? '' : t('tvListSummary', { count }),
      children: count === 0 ? undefined : h(TextBody, { text }),
    });
  }
  const actionId = typeof payload?.actionId === 'string' ? payload.actionId : '';
  const entries = Object.entries(sessionParams as Record<string, string>);
  const title = entries.length === 0 ? t('tvPinCleared') : `${t('tvPin')} · ${shortLabel(actionId)}`;
  const summary = entries.map(([key, value]) => `${key}=${value}`).join('  ');
  return h(ToolCard, {
    title,
    icon: h(IconPinOutlineRegular, { size: 14 }),
    state: entries.length === 0 ? 'idle' : 'done',
    summary,
    children: entries.length === 0
      ? undefined
      : h(TextBody, { text: entries.map(([key, value]) => `${key} = ${value}`).join('\n') }),
  });
}
