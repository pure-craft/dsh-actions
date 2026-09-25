/**
 * Composer @ reference source for actions (T53).
 *
 * Contract (extracted from dsh-client-ui-input-trigger types + the
 * ui-skill registration in the shipped bundles, not guessed):
 * - `ctx.inputTriggers.registerSource(src)`; the service name in `inject`
 *   is the string 'inputTriggers' (ui-skill uses ctx.get too).
 * - onPick returns `{ insert: ReferenceInsert }` — a chip carrying
 *   source/ref/label/clipboardText; chips are the only occurrences the
 *   submit pipeline serializes (plain-text `@name` matches only decorate
 *   visually via lexicon and never serialize).
 * - Submit-time expansion goes through `codec.serialize(ref, signal)`
 *   routed by the chip's `source` name; failures BLOCK the send.
 * - lexicon names decorate via TEXT_REF_RE `[/@][\w-]+` — labels with CJK
 *   or spaces never decorate (known host limitation; insertion still works,
 *   the token simply stays plain text).
 *
 * This module is the pure, testable core; `index.ts` wires the registration.
 */
import * as React from 'react';
import type {
  ActionSourceLayer,
  ActionsCatalog,
  AgentActionView,
  ProjectActionSummary,
} from '../contract.js';
import { ActionIcon } from './action-icon.js';
import type { LocaleKey, Translate } from './locale.js';

/** Structural mirror of InputTriggerCandidate (only the fields we set). */
export interface ActionTriggerCandidate {
  readonly name: string;
  readonly label?: string;
  readonly description?: string;
  readonly value?: string;
  readonly section?: string;
  /** Leading row glyph (the same icon as the list row / run tab, T65). */
  readonly icon?: React.ComponentType<{ size?: number }>;
}

/** Structural mirror of ReferenceCodec. */
export interface ReferenceCodecLike {
  clipboardText(ref: string): string;
  serialize(ref: string, signal: AbortSignal): Promise<string>;
}

/** Structural mirror of the source registration object. */
export interface ActionsTriggerSourceLike {
  readonly trigger: '/';
  readonly name: string;
  readonly order: number;
  candidates(session: unknown, req: { query: string; signal: AbortSignal }): Promise<readonly ActionTriggerCandidate[]>;
  onPick(pick: { candidate: ActionTriggerCandidate }): unknown;
  /** Real signature: lexicon(sessionProjection) — the arg carries the session id. */
  lexicon(session: unknown): readonly string[];
  /** Real signature: (sessionProjection, listener) => unsubscribe — the session arg is ignored (our catalog is already session-bound). */
  subscribeLexicon(session: unknown, listener: () => void): () => void;
  /** Real signature: (session, reference: Pick<ReferenceInsert, 'ref' | 'appearance'>) => boolean. */
  openReference(session: unknown, reference: { ref: string }): boolean;
  readonly codec: ReferenceCodecLike;
}

export const ACTIONS_REFERENCE_SOURCE = 'actions';

/** The inline token inserted by the list row's send button: namespaced `@actions:<label>` — identical to the chip the '/' menu inserts (the host renders chips as @ + label). */
export function buildActionToken(label: string): string {
  return `@actions:${label} `;
}

/** Menu candidates for the @ trigger: every visible action, sectioned by layer. */
export function actionCandidates(
  actions: readonly ProjectActionSummary[],
  sectionOf: (layer: ActionSourceLayer) => string,
): ActionTriggerCandidate[] {
  return actions.map((action) => ({
    // `name` is the exact-match / first search key and falls back as display —
    // namespaced so `/actions:` narrows to our entries among every '/' source.
    name: `actions:${action.label}`,
    description: action.detail ?? action.command,
    value: action.id,
    section: sectionOf(action.sourceLayer),
    // T65: the same icon in all three surfaces (row / tab / menu).
    icon: () => React.createElement(ActionIcon, { icon: action.icon, size: 14 }),
  }));
}

/** Hot name roll for plain-text @ decoration: the visible actions' labels. */
export function actionLexicon(actions: readonly ProjectActionSummary[]): string[] {
  return [...new Set(actions.map((action) => action.label))];
}

/**
 * Model serialization of one action reference: the full Agent-facing context
 * (English structural copy, label verbatim), so the user never sees
 * id/command noise in the composer. An unknown ref degrades to a marked
 * stub rather than blocking the send.
 */
export function serializeActionRef(
  actions: readonly AgentActionView[],
  sessionParams: Record<string, Record<string, string>> | undefined,
  ref: string,
): string {
  const action = actions.find((candidate) => candidate.id === ref);
  if (action === undefined) {
    return `Action ${ref}（该任务已不在当前目录中）`;
  }
  // Model form is an operational brief, not a command dump: tell the agent
  // to use the action and hand it everything needed to run WITHOUT errors —
  // the command text itself is available via actions_inspect when needed.
  const required = (action.inputs ?? []).filter((input) => input.required === true);
  const optional = (action.inputs ?? []).filter((input) => input.required !== true);
  const parts: string[] = [];
  if (required.length > 0) {
    parts.push(`必填：${required.map((input) =>
      input.options !== undefined ? `${input.id}（${input.options.join('/')}）` : input.id).join('、')}`);
  }
  if (optional.length > 0) parts.push(`可选：${optional.map((input) => input.id).join('、')}`);
  const pinned = sessionParams?.[action.id];
  if (pinned !== undefined && Object.keys(pinned).length > 0) {
    parts.push(`已记住参数：${Object.entries(pinned).map(([key, value]) => `${key}=${value}`).join('，')}`);
  }
  // A manual-only action cannot be run by the agent at all — say so explicitly
  // instead of letting it attempt actions_run on something it cannot see.
  const note = action.visibility === 'ui'
    ? '。注意：仅人工可见，你无法运行它，请用户在面板上手动运行'
    : '';
  const brief = parts.length === 0 ? '' : `。${parts.join('；')}`;
  return `使用 Action「${action.label}」（id: ${action.id}）${brief}${note}。`;
}

/**
 * Build the '/' trigger source bound to a live catalog reader.
 *
 * The panel store only binds once the panel has mounted, so the composer
 * menu must not depend on it: when the store is unbound (or bound to
 * another session), candidates/serialize fetch the catalog directly by
 * sessionId (the Host resolves the session cwd) and cache it per session.
 *
 * @param deps.catalog - current catalog (read fresh at every call).
 * @param deps.storeSessionId - the session the store is currently bound to.
 * @param deps.listCatalog - direct catalog fetch by session (menu path before
 *   any panel mount).
 * @param deps.sectionOf - localized layer name for menu grouping.
 * @param deps.onOpen - chip click: open the Actions panel on that action.
 * @param deps.subscribe - store subscription driving lexicon invalidation.
 */
export function createActionsTriggerSource(deps: {
  catalog: () => ActionsCatalog | null;
  storeSessionId: () => string;
  listCatalog: (sessionId: string) => Promise<ActionsCatalog>;
  sectionOf: (layer: ActionSourceLayer) => string;
  onOpen: (actionId: string) => void;
  subscribe: (listener: () => void) => () => void;
}): ActionsTriggerSourceLike {
  const cache = new Map<string, ActionsCatalog>();
  const catalogFor = async (sessionId: string): Promise<ActionsCatalog | null> => {
    const bound = deps.catalog();
    if (bound !== null && deps.storeSessionId() === sessionId) return bound;
    const cached = cache.get(sessionId);
    if (cached !== undefined) return cached;
    const fresh = await deps.listCatalog(sessionId);
    cache.set(sessionId, fresh);
    return fresh;
  };
  // Best-effort sync view for lexicon/openReference (a chip can only exist
  // after candidates ran, so the cache is warm by then).
  const actionsOf = (sessionId?: string): readonly ProjectActionSummary[] => {
    const bound = deps.catalog();
    if (bound !== null) return bound.actions;
    if (sessionId !== undefined) return cache.get(sessionId)?.actions ?? [];
    return [];
  };

  return {
    trigger: '/',
    name: ACTIONS_REFERENCE_SOURCE,
    order: 20,
    candidates: async (session, req) => {
      const sessionId = (session as { sessionId?: string } | undefined)?.sessionId ?? deps.storeSessionId();
      const catalog = await catalogFor(sessionId);
      const query = req.query.trim().toLowerCase();
      const all = actionCandidates(catalog?.actions ?? [], deps.sectionOf);
      return query === ''
        ? all
        : all.filter((candidate) =>
            candidate.name.toLowerCase().includes(query)
            || (candidate.description?.toLowerCase().includes(query) ?? false));
    },
    onPick: ({ candidate }) => ({
      insert: {
        source: ACTIONS_REFERENCE_SOURCE,
        ref: candidate.value ?? candidate.name,
        // candidate.name is already namespaced (actions:<label>). The host
        // renders appearance-less chips as @ + label — the @ reads as an
        // @-trigger hint, so we take the 'session' appearance (chat-lines
        // glyph, no @, no wrong file/folder metaphor) instead.
        label: candidate.name,
        appearance: 'session',
        clipboardText: `@${candidate.name}`,
      },
    }),
    lexicon: (session) => actionLexicon(actionsOf((session as { sessionId?: string } | undefined)?.sessionId)),
    // The host calls subscribeLexicon(sessionProjection, listener) — bind the
    // listener to the SECOND arg, never the first (a projection object added
    // to the store's listener set crashes every update()).
    subscribeLexicon: (_session, listener) => deps.subscribe(listener),
    openReference: (session, reference) => {
      const sessionId = (session as { sessionId?: string } | undefined)?.sessionId;
      if (!actionsOf(sessionId).some((action) => action.id === reference.ref)) return false;
      deps.onOpen(reference.ref);
      return true;
    },
    codec: {
      clipboardText: (ref) => {
        const action = actionsOf().find((candidate) => candidate.id === ref);
        return `@actions:${action?.label ?? ref}`;
      },
      serialize: async (ref, _signal) => {
        // Fail-soft: a catalog fetch failure (e.g. the Host cannot resolve a
        // brand-new session's cwd yet) must never block the message send —
        // degrade to the store/cache view, or a bare pointer as last resort.
        let catalog: ActionsCatalog | null = null;
        try {
          catalog = await catalogFor(deps.storeSessionId());
        } catch {
          catalog = null;
        }
        if (catalog === null) {
          const cached = actionsOf();
          if (!cached.some((action) => action.id === ref)) return `使用 Action（id: ${ref}）。`;
          return serializeActionRef(cached, undefined, ref);
        }
        return serializeActionRef(catalog.actions, catalog.sessionParams, ref);
      },
    },
  };
}

/** Locale key for a layer's menu section label. */
export function sectionKeyOf(layer: ActionSourceLayer): LocaleKey {
  if (layer === 'global') return 'sectionGlobal';
  if (layer === 'session') return 'sectionSession';
  return 'sectionWorkspace';
}

/** Bound t() variant for the trigger source deps (kept for type clarity). */
export type SectionNamer = (layer: ActionSourceLayer) => string;

/** Helper used by index.ts to localize section names once. */
export function makeSectionNamer(t: Translate): SectionNamer {
  return (layer) => t(sectionKeyOf(layer));
}
