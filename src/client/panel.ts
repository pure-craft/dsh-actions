/**
 * Actions panel components (React.createElement only — the client half is a
 * compiled bundle without JSX).
 */
import * as React from 'react';
import {
  Button,
  Checkbox,
  IconCheckOutlineRegular,
  IconChevronDownOutlineRegular,
  IconChevronUpOutlineRegular,
  IconEditOutlineRegular,
  IconPlayOutlineRegular,
  IconQuestionOutlineRegular,
  IconCloseOutlineRegular,
  IconNewChatOutlineRegular,
  IconRefreshOutlineRegular,
  IconShieldOutlineRegular,
  IconSparkleRegular,
  IconTrashOutlineRegular,
  IconStopFillRegular,
  IconTriangleRightFillRegular,
  IconWarningOutlineRegular,
  Input,
  Menu,
  Modal,
  RiskConfirmation,
  StateDot,
  Tag,
  TerminalBlock,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type {
  StateDotState,
  TagTone,
  TerminalBlockLabels,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type {
  ActionInputConfig,
  ActionRunStatus,
  ActionSourceLayer,
  ActionSourceStatus,
  ProjectActionSummary,
} from '../contract.js';
import type { LocaleKey, LocaleService, Translate } from './locale.js';
import { formatParamsSummary, isTerminalStatus, PanelStore, selectRunTabs } from './store.js';
import type { ConflictNotice, RunTab, RunViewState } from './store.js';
import { appendRunOutputs } from './run-display.js';
import { fallbackUseSessions } from './sessions.js';
import type { UseSessionsLike } from './sessions.js';
import { ActionIcon } from './action-icon.js';
import { buildActionBadges } from './badges.js';
import { buildCtaDraft, ctaPromptKey, mergeCtaDraft, sourceNeedsCta } from './cta.js';
import { buildActionToken } from './references.js';

const h = React.createElement;

/** Minimal face of the session standard prop `inputActions` (ui-conversation). */
export interface InputActionsLike {
  /** Official programmatic draft write into the session composer. */
  setDraft(text: string): void;
}

/** Minimal face of the session standard prop `useInput` (draft read for merge protection). */
export type UseInputLike = <S>(
  select: (state: { draft: string }) => S,
  eq?: (a: S, b: S) => boolean,
) => S;

const EMPTY_INPUT = { draft: '' };

function fallbackUseInput<S>(select: (state: { draft: string }) => S): S {
  return select(EMPTY_INPUT);
}

export interface PanelDeps {
  t: Translate;
  store: PanelStore;
  locale: LocaleService;
  /** Session standard prop from the session-scoped tab seat. */
  sessionId?: string | undefined;
  /** Global standard prop resolving the session's workspace path. */
  useSessions?: UseSessionsLike | undefined;
  /** Session standard prop: composer draft write (always present in a session seat). */
  inputActions?: InputActionsLike | undefined;
  /** Session standard prop: composer draft read (CTA merge protection). */
  useInput?: UseInputLike | undefined;
  /** Activate the chat view after a send-to-chat draft write (T51). */
  activateChat?: (() => void) | undefined;
  /** Which home renders the panel: the wide conversation tab or the narrow right sidebar. */
  surface?: 'conversation-view' | 'sidebar-right' | undefined;
  /** Native DSH resource navigation into the session's right sidebar. */
  openResource: (address: string) => void;
}

const STATUS_KEY: Record<ActionRunStatus, LocaleKey> = {
  queued: 'statusQueued',
  running: 'statusRunning',
  succeeded: 'statusSucceeded',
  failed: 'statusFailed',
  cancelled: 'statusCancelled',
};

function dotState(status: ActionRunStatus | undefined): StateDotState {
  switch (status) {
    case 'queued':
    case 'running': return 'ongoing';
    case 'succeeded': return 'done';
    case 'failed': return 'error';
    case 'cancelled': return 'warning';
    default: return 'idle';
  }
}

function tagTone(status: ActionRunStatus): TagTone {
  switch (status) {
    case 'queued':
    case 'running': return 'info';
    case 'succeeded': return 'success';
    case 'failed': return 'danger';
    case 'cancelled': return 'warning';
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

/** Native-anchor wrapper for the host Tooltip (it injects ref + hover handlers). */
function tooltipWrap(child: React.ReactElement): React.ReactElement {
  return h('span', { style: { display: 'inline-flex' } }, child);
}

/** Stop/cancel affordances are always tinted with the host error token. */
function dangerIcon(icon: React.ReactNode): React.ReactNode {
  return h('span', { className: 'dsh-actions-danger-icon' }, icon);
}

/** Icon-only action button wrapped for the host Tooltip (which needs a native anchor). */
function IconAction(props: {
  label: string;
  icon: React.ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onClick: (event: React.MouseEvent) => void;
}): React.ReactElement {
  return h(Tooltip, {
    label: props.label,
    side: 'top',
    children: tooltipWrap(
      h(Button, {
        variant: 'ghost',
        size: 'sm',
        icon: props.icon,
        'aria-label': props.label,
        disabled: props.disabled ?? false,
        onClick: props.onClick,
      }),
    ),
  });
}

// ---------------------------------------------------------------------------
// Empty-state CTA: write the authoring-skill draft into the session composer
// ---------------------------------------------------------------------------

function CtaButton(props: { t: Translate; onWrite: () => void }): React.ReactElement {
  const { t } = props;
  const [done, setDone] = React.useState(false);
  React.useEffect(() => {
    if (!done) return undefined;
    const timer = setTimeout(() => { setDone(false); }, 2400);
    return () => { clearTimeout(timer); };
  }, [done]);
  return h(Button, {
    // Host inline-CTA convention in cards/banners is outline (ui-user-questions);
    // the solid primary reads as a foreign white block inside the warn banner.
    variant: 'outline',
    size: 'sm',
    icon: done ? h(IconCheckOutlineRegular, { size: 14 }) : h(IconSparkleRegular, { size: 16 }),
    onClick: () => {
      props.onWrite();
      setDone(true);
    },
  }, done ? t('ctaDone') : t('ctaButton'));
}

// ---------------------------------------------------------------------------
// Source degradation banner
// ---------------------------------------------------------------------------

function reasonKey(reason: NonNullable<ActionSourceStatus['reason']>): LocaleKey {
  switch (reason) {
    case 'definition-not-found': return 'sourceNotFound';
    case 'parse-error': return 'sourceParseError';
    case 'unsupported-version': return 'sourceUnsupportedVersion';
  }
}

function SourceBanner(props: {
  source: ActionSourceStatus;
  t: Translate;
  /** The file parses fine but contains no entries — an empty state, not an error. */
  empty?: boolean;
  /** Present when this source earns the create-first-action CTA. */
  onCta: (() => void) | undefined;
  /** Parse-error sources earn a fix-it CTA that drafts the error context to chat. */
  onFix?: (() => void) | undefined;
}): React.ReactElement {
  const { source, t } = props;
  const [expanded, setExpanded] = React.useState(false);
  const layer = t(source.layer === 'workspace' ? 'sectionWorkspace' : 'sectionGlobal');
  const parts: string[] = [];
  if (props.empty === true) parts.push(t('sourceEmpty'));
  else if (!source.available && source.reason !== undefined) parts.push(t(reasonKey(source.reason)));
  else if (!source.available) parts.push(t('sourceParseError'));
  if (source.errors.length > 0) parts.push(t('sourceErrorCount', { count: source.errors.length }));
  return h('div', { className: 'dsh-actions-banner' },
    h('div', { className: 'dsh-actions-banner-row' },
      h('span', { className: 'dsh-actions-banner-icon' }, h(IconWarningOutlineRegular, { size: 16 })),
      h('span', { className: 'dsh-actions-banner-title' }, layer),
      h('span', null, parts.join(' · ')),
      source.errors.length > 0
        ? h('span', { className: 'dsh-actions-banner-toggle' },
            props.onFix !== undefined
              ? h(Button, {
                  variant: 'outline',
                  size: 'sm',
                  icon: h(IconSparkleRegular, { size: 14 }),
                  onClick: () => { props.onFix!(); },
                }, t('sourceFix'))
              : null,
            h(Button, {
              variant: 'ghost',
              size: 'sm',
              icon: h('span', {
                style: { display: 'inline-flex', transform: expanded ? 'rotate(90deg)' : 'none' },
              }, h(IconTriangleRightFillRegular, { size: 14 })),
              onClick: () => { setExpanded((value) => !value); },
            }, t('sourceErrorDetails')),
          )
        : null,
    ),
    h('div', { className: 'dsh-actions-banner-row dsh-actions-banner-meta' }, t('sourcePath', { path: source.path })),
    props.onCta !== undefined
      ? h('div', { className: 'dsh-actions-banner-row' }, h(CtaButton, { t, onWrite: props.onCta }))
      : null,
    expanded
      ? h('ul', { className: 'dsh-actions-banner-errors' },
          ...source.errors.map((message, index) => h('li', { key: index }, message)))
      : null,
  );
}

// ---------------------------------------------------------------------------
// Grouped action list
// ---------------------------------------------------------------------------

interface RowProps {
  action: ProjectActionSummary;
  /** All known runs of this action, newest first. */
  runs: RunViewState[];
  selected: boolean;
  t: Translate;
  store: PanelStore;
  onSelect: () => void;
  onRun: () => void;
  onCancel: (runId: string) => void;
  onSendChat: () => void;
  onDelete: () => void;
}

function ActionRow(props: RowProps): React.ReactElement {
  const { action, runs, selected, t } = props;
  const activeRuns = runs.filter((view) => !isTerminalStatus(view.run.status));
  const activeLatest = activeRuns[0];
  // T54: the dot is an active-only signal — clickable to focus the run tab;
  // terminal runs keep an inert idle dot so rows stay aligned.
  const badges = buildActionBadges(action, t);
  return h('div', { className: 'dsh-actions-row', 'data-selected': selected ? 'true' : 'false' },
    // S6: the active dot is a real sibling button of the row's main button
    // (interactive content must not nest inside a <button>); the idle dot is
    // an inert sibling so rows stay aligned.
    activeLatest !== undefined
      ? h('button', {
          type: 'button',
          className: 'dsh-actions-row-dot',
          title: t('focusRun'),
          'aria-label': t('focusRun'),
          onClick: () => { props.store.focusRunTab(activeLatest.run.id); },
        }, h(StateDot, { state: 'ongoing', size: 10 }))
      : h('span', { className: 'dsh-actions-row-dot dsh-actions-row-dot-idle', 'aria-hidden': true },
          h(StateDot, { state: 'idle', size: 10 })),
    h('button', {
      type: 'button',
      className: 'dsh-actions-row-main',
      onClick: props.onSelect,
      'aria-pressed': selected,
    },
      h(ActionIcon, { icon: action.icon, size: 14 }),
      h('span', { className: 'dsh-actions-row-label' }, action.label),
      ...badges.map((badge) => h('span', {
        key: badge.key,
        className: badge.tone === 'warn' ? 'dsh-actions-badge dsh-actions-badge-warn' : 'dsh-actions-badge',
        title: badge.title,
      },
        badge.icon === 'shield' ? h(IconShieldOutlineRegular, { size: 12 }) : null,
        badge.text,
      )),
      action.detail !== undefined
        ? h('span', { className: 'dsh-actions-row-detail' }, action.detail)
        : null,
    ),
    h('div', { className: 'dsh-actions-row-side' },
      activeRuns.length > 1
        ? h(Tag, { tone: 'info' }, t('runningCount', { count: activeRuns.length }))
        : null,
      activeRuns.length === 1
        ? h(IconAction, {
            label: t('cancel'),
            icon: dangerIcon(h(IconStopFillRegular, { size: 16 })),
            onClick: (event) => { event.stopPropagation(); props.onCancel((activeRuns[0] as RunViewState).run.id); },
          })
        : h(IconAction, {
            label: t('run'),
            icon: h(IconPlayOutlineRegular, { size: 16 }),
            onClick: (event) => { event.stopPropagation(); props.onRun(); },
          }),
      // T51: send-to-chat (@ glyph — the official set has no at-icon, so the
      // affordance is a text glyph), then delete (danger-tinted, strong confirmation).
      h(IconAction, {
        label: t('sendToChat'),
        icon: h('span', { className: 'dsh-actions-at-icon', 'aria-hidden': true }, '@'),
        onClick: (event) => { event.stopPropagation(); props.onSendChat(); },
      }),
      h(IconAction, {
        label: t('deleteAction'),
        icon: dangerIcon(h(IconTrashOutlineRegular, { size: 16 })),
        onClick: (event) => { event.stopPropagation(); props.onDelete(); },
      }),
    ),
  );
}

function ActionSection(props: {
  title: string;
  /** Optional quiet marker glyph before the title (the session section). */
  icon?: React.ReactNode;
  /** Optional caption after the title (e.g. the session visibility note, always visible). */
  tip?: string | undefined;
  actions: ProjectActionSummary[];
  state: PanelStore['state'];
  t: Translate;
  store: PanelStore;
  configPath: string | undefined;
  onOpenConfig: (path: string) => void;
  onSendChat: (action: ProjectActionSummary) => void;
  /** Inline create-first CTA in the section head (sparkle, before the edit button). */
  onCta?: (() => void) | undefined;
  /** The CTA button's text (per-layer meaning, e.g. 让 Agent 帮我创建一个全局 Action). */
  ctaLabel?: string | undefined;
}): React.ReactElement {
  const { state, store, t } = props;
  const configPath = props.configPath;
  return h('section', null,
    h('div', { className: 'dsh-actions-section-head' },
      h('span', { className: 'dsh-actions-section-title' },
        props.icon !== undefined
          ? h('span', { className: 'dsh-actions-section-icon' }, props.icon)
          : null,
        props.title,
        props.tip !== undefined
          ? h('span', { className: 'dsh-actions-section-tip' }, props.tip)
          : null,
      ),
      h('div', { className: 'dsh-actions-section-actions' },
        props.onCta === undefined
          ? null
          : h(Button, {
              variant: 'outline',
              size: 'sm',
              icon: h(IconSparkleRegular, { size: 14 }),
              title: t('ctaButton'),
              onClick: () => { props.onCta!(); },
            }, props.ctaLabel ?? t('ctaCreate')),
        configPath === undefined
          ? null
          : h(IconAction, {
              label: t('openConfig', { layer: props.title }),
              icon: h(IconEditOutlineRegular, { size: 16 }),
              onClick: () => { props.onOpenConfig(configPath); },
            }),
      ),
    ),
    h('div', { className: 'dsh-actions-rows' },
      ...props.actions.map((action) => {
        const runs = (state.runIdsByAction[action.id] ?? [])
          .map((runId) => state.runs[runId])
          .filter((view): view is RunViewState => view !== undefined);
        return h(ActionRow, {
          key: action.id,
          action,
          runs,
          selected: state.selectedActionId === action.id,
          t,
          store,
          onSelect: () => { store.selectAction(action.id); },
          onRun: () => { store.requestRun(action.id); },
          onCancel: (runIdToCancel) => { void store.cancelRun(runIdToCancel); },
          onSendChat: () => { props.onSendChat(action); },
          onDelete: () => { store.requestDeleteAction(action.id); },
        });
      }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Conflict projection
// ---------------------------------------------------------------------------

function ConflictBar(props: { conflict: ConflictNotice; store: PanelStore; t: Translate }): React.ReactElement {
  const { conflict, store, t } = props;
  const running = conflict.kind === 'already-running';
  return h('div', { className: 'dsh-actions-conflict' },
    h('div', { className: 'dsh-actions-conflict-text' },
      h('span', { className: 'dsh-actions-banner-icon' }, h(IconWarningOutlineRegular, { size: 16 })),
      h('span', null, running ? t('conflictRunning') : t('conflictRejected')),
    ),
    h('div', { className: 'dsh-actions-conflict-buttons' },
      running
        ? h(Button, {
            variant: conflict.rerunArmed ? 'outline' : 'primary',
            size: 'sm',
            icon: conflict.rerunArmed ? h(IconCheckOutlineRegular, { size: 14 }) : h(IconPlayOutlineRegular, { size: 16 }),
            onClick: () => {
              if (conflict.rerunArmed) store.disarmRerun();
              else store.armRerun();
            },
          }, conflict.rerunArmed ? t('conflictRunAfterArmed') : t('conflictRunAfter'))
        : null,
      running
        ? h(Button, {
            variant: 'outline',
            size: 'sm',
            icon: dangerIcon(h(IconStopFillRegular, { size: 16 })),
            onClick: () => { void store.stopAndRerun(); },
          }, t('conflictStopRerun'))
        : null,
      h(Button, { variant: 'ghost', size: 'sm', onClick: () => { store.dismissConflict(); } }, t('conflictDismiss')),
    ),
  );
}

// ---------------------------------------------------------------------------
// T29: approval-declined notice (no instance was ever requested)
// ---------------------------------------------------------------------------

const DECLINED_KEY = {
  rejected: 'approvalDeclinedRejected',
  cancelled: 'approvalDeclinedCancelled',
  unavailable: 'approvalDeclinedUnavailable',
} as const;

function DeclinedBar(props: {
  declined: NonNullable<PanelStore['state']['declined']>;
  store: PanelStore;
  t: Translate;
}): React.ReactElement {
  const { declined, store, t } = props;
  return h('div', { className: 'dsh-actions-conflict dsh-actions-declined' },
    h('div', { className: 'dsh-actions-conflict-text' },
      h('span', { className: 'dsh-actions-banner-icon' }, h(IconShieldOutlineRegular, { size: 16 })),
      h('span', null, `${t('approvalDeclinedTitle')} · ${t(DECLINED_KEY[declined.outcome])}`),
    ),
    h('div', { className: 'dsh-actions-conflict-buttons' },
      h(Button, { variant: 'ghost', size: 'sm', onClick: () => { store.dismissDeclined(); } }, t('conflictDismiss')),
    ),
  );
}

// ---------------------------------------------------------------------------
// T29: in-panel confirmation for approval: "always" actions
// ---------------------------------------------------------------------------

function ConfirmationBar(props: {
  action: ProjectActionSummary;
  store: PanelStore;
  t: Translate;
}): React.ReactElement {
  const { action, store, t } = props;
  const [acknowledged, setAcknowledged] = React.useState(false);
  return h(RiskConfirmation, {
    open: true,
    title: t('confirmTitle'),
    description: `${t('confirmDescription')}\n${action.command}`,
    acknowledgeLabel: t('confirmAcknowledge'),
    cancelLabel: t('confirmCancel'),
    closeLabel: t('confirmClose'),
    confirmLabel: t('confirmRun'),
    acknowledged,
    onAcknowledgedChange: setAcknowledged,
    onCancel: () => { store.dismissConfirmation(); },
    onConfirm: () => { void store.confirmAndRun(action.id); },
  });
}

// ---------------------------------------------------------------------------
// T51: strong delete confirmation (acknowledge-gated, danger confirm)
// ---------------------------------------------------------------------------

function DeleteConfirmBar(props: {
  pending: { actionId: string; actionLabel: string };
  store: PanelStore;
  t: Translate;
}): React.ReactElement {
  const { pending, store, t } = props;
  const [acknowledged, setAcknowledged] = React.useState(false);
  return h(RiskConfirmation, {
    open: true,
    title: t('deleteConfirmTitle'),
    description: t('deleteConfirmDetail', { label: pending.actionLabel }),
    acknowledgeLabel: t('deleteAcknowledge'),
    cancelLabel: t('confirmCancel'),
    closeLabel: t('confirmClose'),
    confirmLabel: t('deleteConfirm'),
    acknowledged,
    onAcknowledgedChange: setAcknowledged,
    onCancel: () => { store.dismissDeleteAction(); },
    onConfirm: () => { void store.confirmDeleteAction(); },
  });
}

// ---------------------------------------------------------------------------
// T34: parameter form for actions with declared inputs
// ---------------------------------------------------------------------------

function ParamField(props: {
  input: ActionInputConfig;
  value: string;
  /** Initial focus inside the modal (first required field, else first field). */
  autoFocus?: boolean;
  t: Translate;
  onChange: (value: string) => void;
}): React.ReactElement {
  const { input, value, autoFocus, t, onChange } = props;
  const [open, setOpen] = React.useState(false);
  return h('label', { className: 'dsh-actions-param-field' },
    h('span', { className: 'dsh-actions-param-label' },
      input.id,
      input.required === true ? h('span', { className: 'dsh-actions-param-required' }, ' *') : null,
    ),
    input.description !== undefined
      ? h('span', { className: 'dsh-actions-param-desc' }, input.description)
      : null,
    input.type === 'select'
      ? h(Menu, {
          open,
          portal: true,
          anchor: tooltipWrap(
            h(Button, {
              variant: 'outline',
              size: 'sm',
              autoFocus,
              onClick: () => { setOpen((current) => !current); },
            },
              value === '' ? t('paramSelectPlaceholder') : value,
              h(IconChevronDownOutlineRegular, { size: 14 }),
            ),
          ),
          items: (input.options ?? []).map((option) => ({ id: option, label: option })),
          selectedId: value === '' ? undefined : value,
          onSelect: (id) => {
            setOpen(false);
            onChange(id);
          },
          onClose: () => { setOpen(false); },
        })
      : h(Input, {
          value,
          placeholder: input.default ?? '',
          'aria-label': input.id,
          // The Modal has no autofocus mechanism of its own (verified in the
          // shipped bundle); native autoFocus through the Input passthrough.
          autoFocus,
          onChange: (event: React.ChangeEvent<HTMLInputElement>) => { onChange(event.target.value); },
        }),
  );
}

function ParamForm(props: {
  action: ProjectActionSummary;
  form: { values: Record<string, string>; error: string | null; pin: boolean };
  /** This session's pinned values for the action (undefined when unpinned). */
  pinned: Record<string, string> | undefined;
  store: PanelStore;
  t: Translate;
}): React.ReactElement {
  const { action, form, pinned, store, t } = props;
  const pinnedCount = pinned === undefined ? 0 : Object.keys(pinned).length;
  const inputs = action.inputs ?? [];
  // Initial focus: first required field, else the first field.
  const requiredIndex = inputs.findIndex((input) => input.required === true);
  const focusIndex = requiredIndex >= 0 ? requiredIndex : 0;
  const footer = h('div', { className: 'dsh-actions-params-footer' },
    h('div', { className: 'dsh-actions-param-pin' },
      h(Checkbox, {
        checked: form.pin,
        label: t('paramPin'),
        onChange: (next) => { store.updateParamPin(next); },
      }),
      h(Tooltip, {
        label: t('paramPinTooltip'),
        side: 'top',
        children: tooltipWrap(
          h('span', { className: 'dsh-actions-param-pin-tip', role: 'img', 'aria-label': t('paramPinTooltip') },
            h(IconQuestionOutlineRegular, { size: 14 })),
        ),
      }),
      pinnedCount > 0
        ? h(React.Fragment, null,
            h('span', { className: 'dsh-actions-param-pinned' }, t('paramPinned', { count: pinnedCount })),
            h(Button, {
              variant: 'ghost',
              size: 'sm',
              onClick: () => { void store.unpinParams(action.id); },
            }, t('paramUnpin')),
          )
        : null,
    ),
    h('div', { className: 'dsh-actions-params-actions' },
      h(Button, { variant: 'ghost', size: 'sm', onClick: () => { store.dismissParamForm(); } }, t('confirmCancel')),
      h(Button, {
        variant: 'primary',
        size: 'sm',
        icon: h(IconPlayOutlineRegular, { size: 16 }),
        onClick: () => { void store.submitParamForm(); },
      }, t('run')),
    ),
  );
  return h(Modal, {
    open: true,
    onClose: () => { store.dismissParamForm(); },
    title: t('paramsModalTitle', { label: action.label }),
    closeLabel: t('confirmClose'),
    ...(action.detail !== undefined ? { description: action.detail } : {}),
    footer,
  },
    ...inputs.map((input, index) => h(ParamField, {
      key: input.id,
      input,
      value: form.values[input.id] ?? '',
      autoFocus: index === focusIndex,
      t,
      onChange: (value) => { store.updateParamValue(input.id, value); },
    })),
    form.error !== null ? h('div', { className: 'dsh-actions-param-error' }, form.error) : null,
  );
}

// ---------------------------------------------------------------------------
// Run-tab workspace (T41)
// ---------------------------------------------------------------------------

/** Local time-of-day for a run tab (locale-aware, 24h). */
function runTime(startedAt: number): string {
  return new Date(startedAt).toLocaleTimeString(undefined, { hour12: false });
}

/**
 * One run tab in the strip: status dot + action label + start time + one
 * affordance — a red stop for active runs (terminate-and-close, confirmed)
 * and a × for settled runs (close the tab directly).
 */
function RunTabButton(props: {
  tab: RunTab;
  view: RunViewState;
  label: string;
  /** The action's configured Iconify code (undefined = default glyph). */
  icon: string | undefined;
  selected: boolean;
  store: PanelStore;
  t: Translate;
}): React.ReactElement {
  const { tab, view, label, icon, selected, store, t } = props;
  const active = !isTerminalStatus(view.run.status);
  const paramsSummary = formatParamsSummary(view.run.params);
  return h('div', {
    className: 'dsh-actions-run-tab',
    'data-selected': selected ? 'true' : 'false',
    'data-run-id': tab.runId,
    role: 'tab',
    'aria-selected': selected,
  },
    h('button', {
      type: 'button',
      className: 'dsh-actions-run-tab-main',
      title: paramsSummary === '' ? label : `${label} · ${paramsSummary}`,
      // A user tab click also raises a collapsed workspace (T49).
      onClick: () => { store.focusRunTab(tab.runId); },
    },
      h(StateDot, { state: dotState(view.run.status), size: 8 }),
      h(ActionIcon, { icon, size: 12 }),
      h('span', { className: 'dsh-actions-run-tab-label' }, label),
      h('time', null, runTime(tab.startedAt)),
    ),
    active
      ? h('button', {
          type: 'button',
          className: 'dsh-actions-tab-act dsh-actions-tab-stop',
          title: t('chipCancel'),
          'aria-label': t('chipCancel'),
          onClick: () => { store.requestCloseRun(tab.runId); },
        }, h(IconStopFillRegular, { size: 12 }))
      : h('button', {
          type: 'button',
          className: 'dsh-actions-tab-act',
          title: t('chipForget'),
          'aria-label': t('chipForget'),
          onClick: () => { store.requestCloseRun(tab.runId); },
        }, h(IconCloseOutlineRegular, { size: 12 })),
  );
}

/** The tab strip above the output card. */
/**
 * The tab strip above the output card (T49: host dockkit strip mechanics —
 * hidden scrollbar, edge-fade masks by scroll position, scroll-into-view on
 * selection; the host-aligned underline visuals stay).
 */
function RunTabStrip(props: {
  tabs: RunTab[];
  runs: Record<string, RunViewState>;
  labelOf: (actionId: string) => string;
  iconOf: (actionId: string) => string | undefined;
  selectedRunId: string | null;
  store: PanelStore;
  t: Translate;
  stripRef: React.RefObject<HTMLDivElement | null>;
}): React.ReactElement {
  const { tabs, runs, labelOf, iconOf, selectedRunId, store, t, stripRef } = props;
  const [scrollEdges, setScrollEdges] = React.useState('');

  // Track scroll position to fade the overflowing edge(s), like the host's
  // data-dockkit-strip-scroll attribute.
  const measure = React.useCallback(() => {
    const strip = stripRef.current;
    if (strip === null) return;
    const canLeft = strip.scrollLeft > 1;
    const canRight = strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1;
    const next = canLeft && canRight ? 'start end' : canLeft ? 'start' : canRight ? 'end' : '';
    setScrollEdges((current) => (current === next ? current : next));
  }, [stripRef]);
  React.useLayoutEffect(() => { measure(); }, [measure, tabs.length]);
  React.useEffect(() => {
    const strip = stripRef.current;
    if (strip === null) return undefined;
    strip.addEventListener('scroll', measure, { passive: true });
    return () => { strip.removeEventListener('scroll', measure); };
  }, [stripRef, measure]);

  // Keep the selected tab visible inside the strip.
  React.useEffect(() => {
    if (selectedRunId === null) return;
    stripRef.current
      ?.querySelector(`[data-run-id="${CSS.escape(selectedRunId)}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selectedRunId, tabs.length, stripRef]);

  return h('div', {
    className: 'dsh-actions-tabs',
    role: 'tablist',
    ref: stripRef,
    'data-scroll': scrollEdges === '' ? undefined : scrollEdges,
  },
    ...tabs.flatMap((tab) => {
      const view = runs[tab.runId];
      return view === undefined
        ? []
        : [h(RunTabButton, {
            key: tab.runId,
            tab,
            view,
            label: labelOf(tab.actionId),
            icon: iconOf(tab.actionId),
            selected: selectedRunId === tab.runId,
            store,
            t,
          })];
    }),
  );
}

/** T41: terminate-and-close confirmation for an active tab (same component as the run approval). */
function CloseRunBar(props: {
  pending: { runId: string; actionLabel: string };
  store: PanelStore;
  t: Translate;
}): React.ReactElement {
  const { pending, store, t } = props;
  const [acknowledged, setAcknowledged] = React.useState(false);
  return h(RiskConfirmation, {
    open: true,
    title: t('closeTabTitle'),
    description: t('closeTabDescription', { label: pending.actionLabel }),
    acknowledgeLabel: t('closeTabAcknowledge'),
    cancelLabel: t('confirmCancel'),
    closeLabel: t('confirmClose'),
    confirmLabel: t('closeTabConfirm'),
    acknowledged,
    onAcknowledgedChange: setAcknowledged,
    onCancel: () => { store.dismissCloseRun(); },
    onConfirm: () => { void store.confirmCloseRun(); },
  });
}

/** The selected tab's output card. */
function RunCard(props: {
  action: ProjectActionSummary;
  view: RunViewState;
  /** All known runs of the action, newest first (append mode composes them). */
  runs: RunViewState[];
  store: PanelStore;
  t: Translate;
}): React.ReactElement {
  const { action, view, runs, store, t } = props;
  const status = view.run.status;
  const active = !isTerminalStatus(status);
  const exitCode = isTerminalStatus(status) ? view.run.exitCode ?? null : undefined;

  // presentation.panel: "append" — viewing the newest run shows older runs'
  // output above it (VS Code shared-terminal experience). Older outputs are
  // lazy-loaded through the store.
  const appendMode = action.presentation?.panel === 'append'
    && runs.length > 1
    && runs[0]?.run.id === view.run.id;
  React.useEffect(() => {
    if (!appendMode) return;
    for (const candidate of runs.slice(1)) void store.ensureRunLoaded(candidate.run.id);
  }, [appendMode, runs, store]);
  const display = appendMode
    ? appendRunOutputs(runs, (startedAt) => t('appendBoundary', { time: runTime(startedAt) }))
    : { output: view.output, truncated: view.truncated };

  // Stacked head — command on its own mono line, params (when any) on a
  // tertiary line. The cwd is deliberately not shown (noise + path privacy).
  const paramsSummary = formatParamsSummary(view.run.params);
  return h('section', { className: 'dsh-actions-card' },
    h('div', { className: 'dsh-actions-card-head' },
      h('div', { className: 'dsh-actions-card-head-text' },
        h('span', { className: 'dsh-actions-card-command', title: action.command }, action.command),
        paramsSummary === ''
          ? null
          : h('span', { className: 'dsh-actions-card-cwd', title: paramsSummary }, paramsSummary),
      ),
      h('div', { className: 'dsh-actions-card-actions' },
        h(Tag, { tone: tagTone(status) }, t(STATUS_KEY[status])),
        active
          ? h(IconAction, {
              label: t('cancel'),
              icon: dangerIcon(h(IconStopFillRegular, { size: 16 })),
              onClick: () => { void store.cancelRun(view.run.id); },
            })
          : h(IconAction, {
              label: t('run'),
              icon: h(IconPlayOutlineRegular, { size: 16 }),
              // Rerun prefills the form with this run's own params (T34).
              onClick: () => { store.requestRun(action.id, view.run.params); },
            }),
      ),
    ),
    display.truncated ? h('div', { className: 'dsh-actions-card-note' }, t('truncated')) : null,
    h(TerminalBlock, {
      command: action.command,
      cwd: action.cwd,
      output: display.output,
      running: active,
      exitCode,
      labels: terminalLabels(t),
    }),
  );
}

// ---------------------------------------------------------------------------
// Run workspace: tab strip + selected tab's card + empty states (T41)
// ---------------------------------------------------------------------------

function RunWorkspace(props: {
  state: PanelStore['state'];
  actions: ProjectActionSummary[];
  store: PanelStore;
  t: Translate;
}): React.ReactElement {
  const { state, actions, store, t } = props;
  const tabs = selectRunTabs(state.runs, state.runIdsByAction, (actionId) => store.panelModeOf(actionId));
  const collapsed = state.workspaceCollapsed && tabs.length > 0;
  const stripRef = React.useRef<HTMLDivElement | null>(null);
  const selectedView = state.selectedRunId === null ? undefined : state.runs[state.selectedRunId];
  // With no explicit selection, show the newest tab without stealing store state.
  const effective = selectedView ?? (tabs[0] === undefined ? undefined : state.runs[tabs[0].runId]);
  const cardAction = effective === undefined
    ? undefined
    : actions.find((action) => action.id === effective.run.actionId);
  const labelOf = (actionId: string): string =>
    actions.find((action) => action.id === actionId)?.label ?? actionId;
  const iconOf = (actionId: string): string | undefined =>
    actions.find((action) => action.id === actionId)?.icon;

  // No run history: the workspace renders nothing at all (running is offered
  // by the list rows; a first run raises the workspace automatically).
  if (tabs.length === 0) return h(React.Fragment, null);

  return h('section', { className: 'dsh-actions-runs' },
    state.closeRunConfirm !== null
      ? h(CloseRunBar, { key: state.closeRunConfirm.runId, pending: state.closeRunConfirm, store, t })
      : null,
    tabs.length > 0
      ? h('div', { className: 'dsh-actions-tabs-row' },
          h(RunTabStrip, { tabs, runs: state.runs, labelOf, iconOf, selectedRunId: effective?.run.id ?? null, store, t, stripRef }),
          // T43: collapse/expand toggle, quiet spec like the tab action buttons.
          h(Tooltip, {
            label: collapsed ? t('workspaceExpand') : t('workspaceCollapse'),
            side: 'top',
            children: tooltipWrap(
              h('button', {
                type: 'button',
                className: 'dsh-actions-tab-act dsh-actions-tab-toggle',
                'aria-label': collapsed ? t('workspaceExpand') : t('workspaceCollapse'),
                'aria-expanded': !collapsed,
                onClick: () => { store.toggleWorkspace(); },
              }, collapsed
                ? h(IconChevronUpOutlineRegular, { size: 16 })
                : h(IconChevronDownOutlineRegular, { size: 16 })),
            ),
          }),
        )
      : null,
    collapsed || effective === undefined || cardAction === undefined
      ? null
      : h(RunCard, { action: cardAction, view: effective, runs: store.runsOfAction(cardAction.id), store, t }),
  );
}

// ---------------------------------------------------------------------------
// Panel root
// ---------------------------------------------------------------------------

export function ActionsPanel(deps: PanelDeps): React.ReactElement {
  const { t, store, locale } = deps;
  React.useSyncExternalStore(
    (listener) => locale.subscribe(listener),
    () => locale.getSnapshot(),
  );
  React.useSyncExternalStore(store.subscribe, store.getRevision);

  const sessionId = deps.sessionId ?? '';
  const useSessions = deps.useSessions ?? fallbackUseSessions;
  const sessionCwd = useSessions((snapshot) => sessionId === '' ? undefined : snapshot.byId[sessionId]?.cwd);

  // Bind the panel to this tab's session; the workspace path may resolve late.
  React.useEffect(() => {
    if (sessionId !== '') store.setSession(sessionId, sessionCwd ?? '');
  }, [sessionId, sessionCwd, store]);

  const state = store.state;
  const catalog = state.catalog;
  const actions = catalog?.actions ?? [];
  const workspaceActions = actions.filter((action) => action.sourceLayer === 'workspace');
  const globalActions = actions.filter((action) => action.sourceLayer === 'global');
  const sessionActions = actions.filter((action) => action.sourceLayer === 'session');
  // Banners are for real problems (parse errors). Empty states — missing file
  // OR zero entries — are not banners: they surface as an inline sparkle CTA
  // in the section head, before the edit button.
  const degraded = (catalog?.sources ?? []).filter((source) =>
    (!source.available || source.errors.length > 0) && !sourceNeedsCta(source));
  const layerEmpty = (layer: ActionSourceLayer): boolean => {
    const source = (catalog?.sources ?? []).find((candidate) => candidate.layer === layer);
    const missing = source !== undefined && sourceNeedsCta(source);
    const noEntries = !actions.some((action) => action.sourceLayer === layer);
    return missing || noEntries;
  };
  const sourceByLayer = new Map((catalog?.sources ?? []).map((source) => [source.layer, source]));
  const openConfig = (path: string): void => {
    const normalized = path.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
    const encodedPath = normalized.split('/').map((segment) => encodeURIComponent(segment).replace(/%3A/gi, ':')).join('/');
    deps.openResource(`dsh-resource://file/session/${encodeURIComponent(sessionId)}/${encodedPath}`);
  };

  // The CTA writes the authoring-skill draft through the official composer
  // API (session standard prop inputActions.setDraft — see cta.ts), merged
  // with the current draft so the user's text is never clobbered.
  const useInput = deps.useInput ?? fallbackUseInput;
  const currentDraft = useInput((input) => input.draft);
  const writeCta = deps.inputActions === undefined
    ? undefined
    : (layer: ActionSourceLayer = 'workspace'): void => {
        // T44: the prompt varies by config layer (global = dsh-version action).
        deps.inputActions?.setDraft(mergeCtaDraft(currentDraft, buildCtaDraft(t(ctaPromptKey(layer)))));
      };
  // Parse-error fix CTA: draft the path + error list with the authoring skill,
  // so the agent can repair the file with full schema context.
  const writeFix = deps.inputActions === undefined
    ? undefined
    : (source: ActionSourceStatus): void => {
        const detail = t('fixPrompt', { path: source.path });
        const errors = source.errors.map((message) => `- ${message}`).join('\n');
        deps.inputActions?.setDraft(mergeCtaDraft(currentDraft, buildCtaDraft(`${detail}\n${errors}`)));
        deps.activateChat?.();
      };
  const sessionSource = sourceByLayer.get('session');

  // T53: insert the compact @label reference token into the composer (same
  // no-clobber merge) and bring the user to the chat view to continue.
  const sendToChat = deps.inputActions === undefined
    ? undefined
    : (action: ProjectActionSummary): void => {
        deps.inputActions?.setDraft(mergeCtaDraft(
          currentDraft,
          buildActionToken(action.label),
        ));
        deps.activateChat?.();
      };

  // Three-region layout (T43): fixed header / scrollable list / bottom-pinned
  // run workspace. The page root no longer scrolls as a whole.
  let listBody: React.ReactNode;
  let workspace: React.ReactNode = null;
  if (sessionId === '') {
    listBody = h('div', { className: 'dsh-actions-empty' },
      h('span', null, t('noSession')),
      h('small', null, t('noSessionHint')),
    );
  } else if (state.phase === 'loading') {
    listBody = h('div', { className: 'dsh-actions-empty' }, h('span', null, t('loading')));
  } else if (state.phase === 'error' || catalog === null) {
    listBody = h('div', { className: 'dsh-actions-empty dsh-actions-error' },
      h('span', null, t('error')),
      h(Button, { variant: 'outline', size: 'sm', onClick: () => { void store.refresh(); } }, t('retry')),
    );
  } else {
    listBody = h(React.Fragment, null,
      ...degraded.map((source) => h(SourceBanner, {
        key: source.layer,
        source,
        t,
        onCta: writeCta !== undefined && sourceNeedsCta(source)
          ? () => { writeCta(source.layer); }
          : undefined,
        onFix: writeFix !== undefined && source.errors.length > 0
          ? () => { writeFix(source); }
          : undefined,
      })),
      state.actionError ? h('div', { className: 'dsh-actions-action-error' }, t('actionFailed')) : null,
      state.conflict !== null ? h(ConflictBar, { conflict: state.conflict, store, t }) : null,
      state.declined !== null ? h(DeclinedBar, { declined: state.declined, store, t }) : null,
      state.confirmation !== null
        ? (() => {
            const pending = actions.find((action) => action.id === (state.confirmation as { actionId: string }).actionId);
            // S1: key by actionId — the acknowledged flag must reset per
            // confirmation (otherwise an ack for action A carries into B).
            return pending === undefined
              ? null
              : h(ConfirmationBar, { key: pending.id, action: pending, store, t });
          })()
        : null,
      state.pendingParams !== null
        ? (() => {
            const form = state.pendingParams as { actionId: string; values: Record<string, string>; error: string | null; pin: boolean };
            const target = actions.find((action) => action.id === form.actionId);
            // The form is a body-portaled Modal — no scroll-into-view needed.
            return target === undefined
              ? null
              : h(ParamForm, { action: target, form, pinned: store.sessionParamsOf(form.actionId), store, t });
          })()
        : null,
      state.deleteConfirm !== null
        ? h(DeleteConfirmBar, {
            key: state.deleteConfirm.actionId,
            pending: state.deleteConfirm,
            store,
            t,
          })
        : null,
      h(React.Fragment, null,
        h(ActionSection, {
          title: t('sectionWorkspace'),
          actions: workspaceActions,
          state,
          t,
          store,
          configPath: sourceByLayer.get('workspace')?.available === true
            ? sourceByLayer.get('workspace')?.path
            : undefined,
          onOpenConfig: openConfig,
          onSendChat: sendToChat ?? (() => undefined),
          onCta: writeCta !== undefined && layerEmpty('workspace')
            ? () => { writeCta('workspace'); }
            : undefined,
          ctaLabel: t('ctaCreateWorkspace'),
        }),
        h(ActionSection, {
          title: t('sectionGlobal'),
          actions: globalActions,
          state,
          t,
          store,
          configPath: sourceByLayer.get('global')?.available === true
            ? sourceByLayer.get('global')?.path
            : undefined,
          onOpenConfig: openConfig,
          onSendChat: sendToChat ?? (() => undefined),
          onCta: writeCta !== undefined && layerEmpty('global')
            ? () => { writeCta('global'); }
            : undefined,
          ctaLabel: t('ctaCreateGlobal'),
        }),
        // T48: the session layer last, with its marker glyph; the config
        // edit entry appears only while the session file actually exists.
        h(ActionSection, {
          title: t('sectionSession'),
          icon: h(IconNewChatOutlineRegular, { size: 14 }),
          tip: t('sessionTip'),
          actions: sessionActions,
          state,
          t,
          store,
          configPath: sessionSource?.available === true && sessionSource.exists !== false ? sessionSource.path : undefined,
          onOpenConfig: openConfig,
          onSendChat: sendToChat ?? (() => undefined),
          onCta: writeCta !== undefined && layerEmpty('session')
            ? () => { writeCta('session'); }
            : undefined,
          ctaLabel: t('ctaCreateSession'),
        }),
      ),
    );
    // Run-tab workspace: one tab per run, clicking an action only focuses
    // its newest tab — the strip never gets replaced wholesale.
    workspace = h(RunWorkspace, {
      state,
      actions,
      store,
      t,
    });
  }

  return h('main', { className: 'dsh-actions-page', 'data-dsh-plugin': 'dsh-actions', 'data-dsh-surface': deps.surface ?? 'conversation-view' },
    h('div', { className: 'dsh-actions-content' },
      h('header', { className: 'dsh-actions-header' },
        h('div', { className: 'dsh-actions-header-text' },
          h('h1', null, t('title')),
          h('p', null, t('subtitle')),
        ),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 4 } },
          h(Tooltip, {
            label: t('refreshTooltip'),
            side: 'bottom',
            children: tooltipWrap(
              h(Button, {
                variant: 'toolbar',
                size: 'sm',
                icon: h(IconRefreshOutlineRegular, { size: 16 }),
                disabled: state.refreshing || sessionId === '',
                'aria-label': t('refresh'),
                onClick: () => { void store.refresh(); },
              }),
            ),
          }),
        ),
      ),
      h('div', { className: 'dsh-actions-list' }, listBody),
      workspace,
    ),
  );
}
