// SPDX-License-Identifier: AGPL-3.0-only
//
// `preference.save` (MP-2-11a): a key of the caller's own preference row, and
// `preference.dismiss_tip` (MP-2-11): one guided tip merged into it. Both are
// self-scoped (`preference:write`): no grant is asked, and the body names no
// person, so the only row either can write is the caller's. Neither is
// audited (CS-2.8); the surface rows say so.

import { isTipRef, tipKey, TIPS_HELD_MAX } from '../../../core-wire/src/index.ts';
import {
  admitsPreference,
  dismissTip,
  isPreferenceKey,
  savePreference,
  type TenantQuery,
} from '../../../core-records/src/index.ts';
import type { CommandContext } from './context.ts';
import { refuseCommand } from './refusal.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';

const KEY_FIXES: readonly string[] = [
  'Name a preference this store keeps: appearance, rail.width, dock.width, dock.sheetHeight, columns.widths, tips.enabled or tips.dismissed.',
];

const VALUE_FIXES: readonly string[] = [
  'appearance takes light, dark or system.',
  'A width or height is a whole number of pixels above zero; columns.widths maps each column id to one.',
  'tips.enabled takes true or false; tips.dismissed takes only {}, which brings every tip back.',
];

const TIP_FIXES: readonly string[] = [
  "Send the tip's page (a route id such as agency:projects-board), its id (lower-case words and -) and its text version (a whole number from 1).",
];

const HELD_FIXES: readonly string[] = [
  `Bring back your dismissed tips in Settings first: the store keeps ${String(TIPS_HELD_MAX)}.`,
];

export async function saveOwnPreference(
  tx: TenantQuery,
  context: CommandContext,
  preference: string,
  value: unknown,
): Promise<HandlerOutcome> {
  if (!isPreferenceKey(preference)) {
    return refused(refuseCommand('FIELD_VALUE_INVALID', ['preference'], KEY_FIXES));
  }
  if (!admitsPreference(preference, value)) {
    return refused(refuseCommand('FIELD_VALUE_INVALID', ['value'], VALUE_FIXES));
  }
  await savePreference(tx, context.session.personId, preference, value);
  return applied(null, null, { preference });
}

export async function dismissOwnTip(
  tx: TenantQuery,
  context: CommandContext,
  request: { readonly page: unknown; readonly tip: unknown; readonly version: unknown },
): Promise<HandlerOutcome> {
  if (!isTipRef(request)) {
    return refused(refuseCommand('FIELD_VALUE_INVALID', ['page', 'tip', 'version'], TIP_FIXES));
  }
  const entry = tipKey(request.page, request.tip);
  const held = await dismissTip(
    tx,
    context.session.personId,
    entry,
    request.version,
    TIPS_HELD_MAX,
  );
  if (!held) return refused(refuseCommand('FIELD_VALUE_INVALID', ['tip'], HELD_FIXES));
  return applied(null, null, { tip: entry });
}
