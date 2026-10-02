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
import type {
  Capability,
  SettingsReadResult,
  SettingView,
} from '../../../../../packages/core-wire/src/index.ts';

/** `POST /api/b/:businessKey/settings/read`, body `{}`, grant `settings:read`. */
export const SETTINGS_READ: ReadName = 'settings.read';

/**
 * `POST /api/b/:businessKey/session/capabilities`, body `{}`. A member holding
 * no grant is refused `SCOPE_NOT_GRANTED`, never answered an empty list.
 */
export const SESSION_CAPABILITIES: ReadName = 'session.capabilities';

/** A grant a settings command takes, as `collection:action`. */
export interface Grant {
  readonly collection: string;
  readonly action: string;
}

/** What sign-off and the two windows take. */
export const SETTINGS_MANAGE: Grant = { collection: 'settings', action: 'manage' };
/** What the four-eyes threshold takes: it moves money, so the server gates it as spend. */
export const SPEND_DECIDE: Grant = { collection: 'spend', action: 'decide' };

export const FOUR_EYES = 'four_eyes_threshold';
export const SIGN_OFF = 'client_sign_off_required';
export const CONVERSATION_WINDOW = 'conversation_window_days';
export const RETENTION_WINDOW = 'retention_window_days';

/** Each row of the screen and the setting key it draws. */
export const KEY = {
  'four-eyes': FOUR_EYES,
  'sign-off': SIGN_OFF,
  conversation: CONVERSATION_WINDOW,
  retention: RETENTION_WINDOW,
} as const;

/** Each row and the grant its own command takes; the server gates them apart. */
export const GRANT: Record<keyof typeof KEY, Grant> = {
  'four-eyes': SPEND_DECIDE,
  'sign-off': SETTINGS_MANAGE,
  conversation: SETTINGS_MANAGE,
  retention: SETTINGS_MANAGE,
};

/** A grant in words, as the server names its scopes. */
export const scopeName = (grant: Grant): string => `${grant.collection}:${grant.action}`;

/**
 * The rows in hand: the answer, or while a reread is in flight the previous
 * answer, which `loading` keeps as its `previous`. A denial or an outage has none.
 */
export function rowsInHand(state: ReadState<SettingsReadResult>): SettingsReadResult | null {
  switch (state.outcome) {
    case 'ready':
    case 'empty':
      return state.value;
    case 'loading':
      return state.previous;
    default:
      return null;
  }
}

/** The row for a key, or nothing when the read has not answered or does not carry it. */
export function settingOf(result: SettingsReadResult | null, key: string): SettingView | null {
  return result?.settings.find((row) => row.key === key) ?? null;
}

/** Whether these grants include the one asked for. */
export function holds(grants: readonly Capability[], need: Grant): boolean {
  return grants.some(
    (grant) => grant.collection === need.collection && grant.action === need.action,
  );
}

/** A setting's value in words. Null is a real value — the band is off. */
export function inWords(row: SettingView): string {
  if (row.value === null) return 'off';
  if (typeof row.value === 'boolean') return row.value ? 'on' : 'off';
  return String(row.value);
}
