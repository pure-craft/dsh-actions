/**
 * Empty-state CTA ("Create my first action with DSH") logic.
 *
 * Draft write path (researched, T28): session-scoped slot components receive
 * `inputActions` in their standard props (ui-conversation's
 * SessionStandardProps merge); `inputActions.setDraft(text)` is the official
 * programmatic draft write ("persisted-draft seed and programmatic writes").
 * No clipboard fallback is needed while the panel lives in a session-scoped
 * seat. The composer treats a skill reference as plain text, so the draft is
 * `/dsh-actions-authoring <localized prompt>`.
 */
import type { ActionSourceLayer, ActionSourceStatus } from '../contract.js';
import type { LocaleKey } from './locale.js';

/** The bundled authoring skill, referenced as plain text in the composer. */
export const AUTHORING_SKILL = '/dsh-actions-authoring';

/** Draft text the CTA writes into the session composer. */
export function buildCtaDraft(prompt: string): string {
  return `${AUTHORING_SKILL} ${prompt}`;
}

/**
 * The CTA prompt varies by config layer: the global layer offers the
 * dsh-version action (T44), the session layer the review-and-crystallize
 * prompt (T48), and the workspace layer the workspace-script curation.
 */
export function ctaPromptKey(layer: ActionSourceLayer): LocaleKey {
  if (layer === 'global') return 'ctaPromptGlobal';
  if (layer === 'session') return 'ctaPromptSession';
  return 'ctaPrompt';
}

/**
 * Merge the CTA draft into the composer's current content without clobbering
 * it: append after existing text, write directly when empty, and leave a
 * draft that already references the authoring skill untouched. (`setDraft`
 * replaces the whole draft, so merging is the only append available. The
 * current content comes from the `useInput` standard prop's `draft` field.)
 */
export function mergeCtaDraft(current: string, draft: string): string {
  if (current.includes(AUTHORING_SKILL)) return current;
  const trimmed = current.trimEnd();
  return trimmed === '' ? draft : `${trimmed}\n${draft}`;
}

/** Only a layer whose config file is missing earns the create-first-action CTA. */
export function sourceNeedsCta(source: ActionSourceStatus): boolean {
  return !source.available && source.reason === 'definition-not-found';
}
