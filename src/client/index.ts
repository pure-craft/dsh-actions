import * as React from 'react';
import { Pill, StateDot } from '@deepseek-ai/dsh-client-ui-primitives';
import { ACTIONS_PLUGIN_ID } from '../contract.js';
import { createActionsApi } from './api.js';
import { LOCALE_NS, registerLocale } from './locale.js';
import type { LocaleService } from './locale.js';
import { ActionsPanel } from './panel.js';
import type { InputActionsLike, UseInputLike } from './panel.js';
import { createActionsTriggerSource, makeSectionNamer } from './references.js';
import { isTerminalStatus, PanelStore } from './store.js';
import { ACTIONS_CSS } from './styles.js';
import type { UseSessionsLike } from './sessions.js';
import {
  ActionsCancelView,
  ActionsInspectView,
  ActionsListView,
  ActionsRunView,
  ActionsSetParamsView,
} from './toolview.js';

/** Entry id within the conversation.view tab strip (after chat 0 / trajectory 10). */
const VIEW_ID = ACTIONS_PLUGIN_ID;

/**
 * Guide-card icon on the right sidebar's 开始 page: the circled-play artwork
 * chosen by the user (ring + play triangle in one path), tinted with the
 * business primary so it carries the same accent weight as the folder card.
 */
function GuideIcon(): React.ReactElement {
  return React.createElement(
    'svg',
    {
      viewBox: '0 0 1024 1024',
      width: 24,
      height: 24,
      fill: 'var(--dsw-alias-state-business-primary)',
      'aria-hidden': true,
    },
    React.createElement('path', {
      d: 'M512 1024A512 512 0 1 1 512 0a512 512 0 0 1 0 1024z m3.008-92.992a416 416 0 1 0 0-832 416 416 0 0 0 0 832zM383.232 287.616l384 224.896-384 223.104v-448z',
    }),
  );
}

interface SlotContext {
  readonly slots: {
    inject(name: string, callback: () => (() => void) | void): void;
    register(spec: Record<string, unknown>, component: unknown): () => void;
  };
  readonly locale: LocaleService;
  readonly sidebarRight: {
    openResource(address: string, options?: Record<string, unknown>): void;
    openTab(kind: string, options?: Record<string, unknown>): void;
    registerCloseHandler(kind: string, handler: (sessionId: string, tab: unknown) => void): () => void;
  };
  /** Per-session Conversation assembly (ui-conversation): view activation. */
  readonly uiConversation: {
    binding(sessionId: string): { activate(target: string): void };
  };
  effect(factory: () => (() => void) | void, label?: string): void;
  get(key: string): unknown;
}

/** Mirror of ctx.inputTriggers (dsh-client-ui-input-trigger). */
interface InputTriggersLike {
  registerSource(src: unknown): () => void;
}

/** Mirror of the right-sidebar tab-type registry (ui-sidebar-right). */
interface SidebarRightTabsLike {
  register(definition: Record<string, unknown>): () => void;
}

/**
 * Client-half services this module consumes, by *service* name.
 *
 * The browser boot gates each plugin on its inject list and then reports every
 * entry that never reached `active`. Without this export the fiber carries an
 * empty inject, so `apply` runs at the front of the queue — before the slot
 * registry and the locale runtime exist — and `ctx.slots.inject(...)` throws on
 * an undefined `slots`. The failure is reported as `failed`, not `pending`
 * (a `pending` entry is one still waiting on a service), and the whole Web UI
 * stops at "Failed to load plugins" while the Host half keeps serving.
 *
 * Note this is NOT the same list as `dsh.client.inject` in package.json: that
 * one names *packages* and only orders module loading; cordis gates activation
 * on these service names. Same pairing as the Host half in `src/index.ts`.
 */
export const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs', 'uiConversation', 'inputTriggers'];

export function apply(ctx: SlotContext): void {
  const h = React.createElement;
  ctx.effect(() => registerLocale(ctx.locale), 'dsh-actions: dictionaries');
  const t = ctx.locale.bind(LOCALE_NS);

  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.plugin = 'dsh-actions';
    style.textContent = ACTIONS_CSS;
    document.head.appendChild(style);
    return () => { style.remove(); };
  }, 'dsh-actions: stylesheet');

  const api = createActionsApi();
  const store = new PanelStore(api);
  ctx.effect(() => () => { store.dispose(); }, 'dsh-actions: store');

  // T53: the '/' reference source — chips from the menu or a row's send button
  // (token form `@actions:<label>`) that serialize at send time (see references.ts).
  const inputTriggers = ctx.get('inputTriggers') as InputTriggersLike | undefined;
  if (inputTriggers !== undefined) {
    ctx.effect(
      () => inputTriggers.registerSource(createActionsTriggerSource({
        catalog: () => store.state.catalog,
        storeSessionId: () => store.state.sessionId,
        listCatalog: (sessionId) => api.listCatalog(sessionId),
        sectionOf: makeSectionNamer(t),
        onOpen: (actionId) => {
          store.selectAction(actionId);
          ctx.sidebarRight.openTab(VIEW_ID);
        },
        subscribe: store.subscribe,
      })),
      'dsh-actions: / reference source',
    );
  }

  function Panel(props: {
    sessionId?: string;
    useSessions?: UseSessionsLike;
    inputActions?: InputActionsLike;
    useInput?: UseInputLike;
    surface?: 'conversation-view' | 'sidebar-right';
  }): React.ReactElement {
    return h(ActionsPanel, {
      t,
      store,
      locale: ctx.locale,
      sessionId: props.sessionId,
      useSessions: props.useSessions,
      inputActions: props.inputActions,
      useInput: props.useInput,
      surface: props.surface,
      // T51: after a send-to-chat draft, land the user on the chat view.
      activateChat: props.sessionId === undefined
        ? undefined
        : () => { ctx.uiConversation.binding(props.sessionId as string).activate('chat'); },
      openResource: (address) => { ctx.sidebarRight.openResource(address); },
    });
  }

  // The panel's only home is the right sidebar: a page type with a guide
  // entry (the 开始 page's "工作区文件 / 新建终端" row pattern) plus the
  // body keyed to it. The conversation.view tab was removed in favor of
  // this single home + the composer-dock quick entry below.
  const sidebarRightTabs = ctx.get('sidebarRightTabs') as SidebarRightTabsLike | undefined;
  if (sidebarRightTabs !== undefined) {
    ctx.effect(
      () => sidebarRightTabs.register({
        id: VIEW_ID,
        kind: 'dsh-actions',
        title: () => t('nav'),
        guide: [{
          id: 'open',
          order: 30,
          title: () => t('nav'),
          description: () => t('sidebarGuideDescription'),
          icon: GuideIcon,
        }],
      }),
      'dsh-actions: sidebar tab type',
    );
    ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab', key: VIEW_ID, locale: LOCALE_NS,
      inject: (sessionId: string) => ({ sessionId }),
    }, SidebarPanel));

    // Close guard: the framework's cleanup hook is synchronous, so a running
    // tab asks through a synchronous confirm — declining preserves the tab,
    // confirming stops the active runs and lets the tab close.
    ctx.effect(
      () => ctx.sidebarRight.registerCloseHandler('dsh-actions', (sessionId) => {
        if (store.state.sessionId !== sessionId) return; // not bound here; nothing to protect
        const active = Object.values(store.state.runs)
          .map((view) => view.run)
          .filter((run) => !isTerminalStatus(run.status));
        if (active.length === 0) return;
        const message = t('closeConfirm', { count: active.length });
        if (!window.confirm(message)) throw new Error('dsh-actions: close declined by user');
        for (const run of active) void store.cancelRun(run.id);
      }),
      'dsh-actions: close guard',
    );
  }

  function SidebarPanel(props: { sessionId?: string }): React.ReactElement {
    return h(Panel, { ...props, surface: 'sidebar-right' });
  }

  // Composer-dock quick entry (the stats strip above the composer): a live
  // status pill driven by the same PanelStore — no polling. Clicking it
  // opens the right-sidebar tab. The store is single-session-bound, so the
  // pill only shows state when the store is bound to its own session.
  function DockEntry(props: { sessionId?: string }): React.ReactElement {
    React.useSyncExternalStore(store.subscribe, store.getRevision);
    const state = store.state;
    const bound = props.sessionId !== undefined && state.sessionId === props.sessionId;
    const active = bound
      ? Object.values(state.runs).map((view) => view.run).filter((run) => !isTerminalStatus(run.status))
      : [];
    const labelOf = (actionId: string): string =>
      state.catalog?.actions.find((action) => action.id === actionId)?.label ?? actionId;
    const label = active.length === 0
      ? t('dockIdle')
      : active.length === 1
        ? t('dockRunning', { label: labelOf(active[0]!.actionId) })
        : t('dockRunningCount', { count: active.length });
    return h('div', { style: { display: 'flex', justifyContent: 'center', paddingBottom: '2px' } },
      h(Pill, {
        active: active.length > 0,
        className: 'dsh-actions-dock-pill',
        onClick: () => { ctx.sidebarRight.openTab(VIEW_ID); },
        title: t('dockTooltip'),
      },
        h(StateDot, { state: active.length > 0 ? 'ongoing' : 'idle', size: 8 }),
        h('span', { style: { whiteSpace: 'nowrap' } }, label),
      ),
    );
  }

  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock', id: VIEW_ID, order: 100, locale: LOCALE_NS,
    inject: (sessionId: string) => ({ sessionId }),
  }, DockEntry));

  // tool.call.toolview is keyed by tool name: a keyed hit replaces the host's
  // generic "工具调用" row with our structured rendering (see toolview.ts).
  const toolviews: Array<readonly [string, unknown]> = [
    ['actions_run', ActionsRunView],
    ['actions_inspect', ActionsInspectView],
    ['actions_list', ActionsListView],
    ['actions_cancel', ActionsCancelView],
    ['actions_set_params', ActionsSetParamsView],
  ];
  for (const [key, component] of toolviews) {
    ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
      name: 'tool.call.toolview', key, locale: LOCALE_NS,
    }, component));
  }
}
