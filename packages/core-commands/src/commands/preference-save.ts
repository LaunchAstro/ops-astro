// SPDX-License-Identifier: AGPL-3.0-only
//
// `preference.save` (MP-2-11a): a key of the caller's own preference row. The
// key is self-scoped (`preference:write`): no grant is asked, and the body
// names no person, so the only row it can write is the caller's. A saved
// preference is not audited (CS-2.8); the surface row says so.

import {
  admitsPreference,
  isPreferenceKey,
  savePreference,
  type TenantQuery,
} from '../../../core-records/src/index.ts';
import type { CommandContext } from './context.ts';
import { refuseCommand } from './refusal.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';

const KEY_FIXES: readonly string[] = [
  'Name a preference this store keeps: appearance, rail.width, dock.width, dock.sheetHeight or columns.widths.',
];

const VALUE_FIXES: readonly string[] = [
  'appearance takes light, dark or system.',
  'A width or height is a whole number of pixels above zero; columns.widths maps each column id to one.',
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
