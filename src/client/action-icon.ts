/**
 * Action icon rendering (T65).
 *
 * Configured icons are Iconify codes (`collection:name`, e.g. `lucide:rocket`)
 * loaded asynchronously from api.iconify.design by @iconify/react (bundled
 * into client.js — the spike verified no CSP restriction and open CORS).
 * Both the loading window and every failure mode (offline, unknown icon)
 * fall back to the official checklist glyph, and entries without an `icon`
 * use the same default so rows stay visually aligned.
 */
import * as React from 'react';
import { Icon } from '@iconify/react';
import { IconChecklistOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';

const h = React.createElement;

export function ActionIcon(props: { icon?: string | undefined; size: number }): React.ReactElement {
  const { icon, size } = props;
  if (icon === undefined) return h(IconChecklistOutlineRegular, { size });
  return h(Icon, {
    icon,
    width: size,
    height: size,
    fallback: h(IconChecklistOutlineRegular, { size }),
    'aria-hidden': true,
  });
}
