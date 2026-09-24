// SPDX-License-Identifier: AGPL-3.0-only
//
// The two reads `/settings` opens on, as names, and the helpers over their rows.
//
// The wire shapes they return are `operations/shapes.ts`'s, with the rest of
// what crossed a network; the names are `ReadName`'s, with the rest of the
// surface's reads. What stays here is what is particular to this screen: which
// two keys it draws, which grant its commands take, and how a row is read.

import type { ReadState } from '../../data/authorised-read.ts';
import type { ReadName } from '../../operations/client.ts';
import type { Grant, SettingRow, SettingsReadResult } from '../../operations/shapes.ts';

/** `POST /api/b/:businessKey/settings/read`, body `{}`, grant `settings:read`. */
export const SETTINGS_READ: ReadName = 'settings.read';

/**
 * `POST /api/b/:businessKey/session/capabilities`, body `{}`. A member holding
 * no grant is refused `SCOPE_NOT_GRANTED`, never answered an empty list.
 */
export const SESSION_CAPABILITIES: ReadName = 'session.capabilities';

/** The collection and action the two settings commands take. */
export const SETTINGS_MANAGE = { collection: 'settings', action: 'manage' } as const;

export const FOUR_EYES = 'four_eyes_threshold';
export const SIGN_OFF = 'client_sign_off_required';

/**
 * The rows in hand: the answer, or while a reread is in flight the previous
 * answer, which `loading` keeps as its `value`. A denial or an outage has none.
 */
export function rowsInHand(state: ReadState<SettingsReadResult>): SettingsReadResult | null {
  switch (state.outcome) {
    case 'ready':
    case 'empty':
      return state.value;
    case 'loading':
      return state.value;
    default:
      return null;
  }
}

/** The row for a key, or nothing when the read has not answered or does not carry it. */
export function settingOf(result: SettingsReadResult | null, key: string): SettingRow | null {
  return result?.settings.find((row) => row.key === key) ?? null;
}

/** Whether these grants cover the two settings commands. */
export function holdsManage(grants: readonly Grant[]): boolean {
  return grants.some(
    (grant) =>
      grant.collection === SETTINGS_MANAGE.collection && grant.action === SETTINGS_MANAGE.action,
  );
}

/** A setting's value in words. Null is a real value — the band is off. */
export function inWords(row: SettingRow): string {
  if (row.value === null) return 'off';
  if (typeof row.value === 'boolean') return row.value ? 'on' : 'off';
  return String(row.value);
}
