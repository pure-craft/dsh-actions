/**
 * Semantic behavior badges for action list rows (T54).
 *
 * A row answers "what is this, what happens when it runs": badges translate
 * raw config into localized meaning; default states render nothing (quiet by
 * default). Tooltips carry the raw config value.
 */
import type { ProjectActionSummary } from '../contract.js';
import type { Translate } from './locale.js';

export type ActionBadgeTone = 'quiet' | 'warn';

export interface ActionBadge {
  /** Locale-independent identity (tests key on this). */
  key: 'approval-agent' | 'approval-always' | 'panel-dedicated' | 'panel-append' | 'visibility-ui' | 'extends';
  text: string;
  tone: ActionBadgeTone;
  icon?: 'shield';
  /** Tooltip with the raw config value. */
  title?: string;
}

/** The label part of an extends reference id (`<layer>:<label>`). */
export function extendsLabel(ref: string): string {
  const index = ref.lastIndexOf(':');
  return index === -1 ? ref : ref.slice(index + 1);
}

export function buildActionBadges(action: ProjectActionSummary, t: Translate): ActionBadge[] {
  const badges: ActionBadge[] = [];

  if (action.approval === 'agent') {
    badges.push({
      key: 'approval-agent',
      text: t('badgeApprovalAgent'),
      tone: 'quiet',
      title: t('badgeTipApproval', { value: 'agent' }),
    });
  } else if (action.approval === 'always') {
    badges.push({
      key: 'approval-always',
      text: t('badgeApprovalAlways'),
      tone: 'quiet',
      icon: 'shield',
      title: t('badgeTipApproval', { value: 'always' }),
    });
  }

  const panel = action.presentation?.panel;
  if (panel === 'dedicated') {
    badges.push({
      key: 'panel-dedicated',
      text: t('badgePanelDedicated'),
      tone: 'quiet',
      title: t('badgeTipPanel', { value: 'dedicated' }),
    });
  } else if (panel === 'append') {
    badges.push({
      key: 'panel-append',
      text: t('badgePanelAppend'),
      tone: 'quiet',
      title: t('badgeTipPanel', { value: 'append' }),
    });
  }

  if (action.visibility === 'ui') {
    badges.push({
      key: 'visibility-ui',
      text: t('badgeVisibilityUi'),
      tone: 'quiet',
      title: t('badgeTipVisibility', { value: 'ui' }),
    });
  }

  // Summary `extends` is present only for an unresolved reference (T47).
  if (action.extends !== undefined) {
    badges.push({
      key: 'extends',
      text: t('badgeExtends', { label: extendsLabel(action.extends) }),
      tone: 'quiet',
      title: t('badgeTipExtends', { id: action.extends }),
    });
  }

  return badges;
}
