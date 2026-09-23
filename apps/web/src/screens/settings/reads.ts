// SPDX-License-Identifier: AGPL-3.0-only
//
// The two reads `/settings` opens on, as wire shapes and as names.
//
// They live here rather than in `operations/shapes.ts` for the reason that file
// gives for its own contents: these describe JSON that crossed a network, and
// this lane does not own the operations module. When `settings.read` and
// `session.capabilities` join `ReadName` and `shapes.ts` — the exact text is in
// this lane's handback — these two interfaces move there and this file keeps
// only the helpers.
//
// **Why the names are cast.** `OperationsClient.read` takes `ReadName`, a union
// of the three reads that existed when it was written. The route is not in that
// union: it is derived by `pathOf`, which is `/${name.replace('.', '/')}` over
// the name string, so `settings.read` reaches `/api/b/:businessKey/settings/read`
// today, with or without a declaration. The cast is the one place this lane
// admits the union is behind the surface, and it is one line rather than five
// screens each composing a path of their own.

import type { ReadName } from '../../operations/client.ts';

/** `POST /api/b/:businessKey/settings/read`, body `{}`, grant `settings:read`. */
export const SETTINGS_READ = 'settings.read' as ReadName;

/** `POST /api/b/:businessKey/session/capabilities`, body `{}`, membership only. */
export const SESSION_CAPABILITIES = 'session.capabilities' as ReadName;

/** The collection and action the two settings commands take. */
export const SETTINGS_MANAGE = { collection: 'settings', action: 'manage' } as const;

export const FOUR_EYES = 'four_eyes_threshold';
export const SIGN_OFF = 'client_sign_off_required';

/**
 * One row of `settings.read`.
 *
 * `revision` is optional and its absence is a fact about the server, not about
 * the row: `business_settings` carried no revision column until lane
 * SETTINGS-REVISION gave it one, and this screen has to write correctly against
 * both. A row with a revision is written with `expectedRevision`; a row without
 * one is written as the two commands have always taken it.
 */
export interface SettingRow {
  readonly key: string;
  readonly value: unknown;
  readonly valueType?: string;
  readonly updatedAt?: string;
  /** Null is a real answer: the row was written with no actor recorded. */
  readonly updatedByActorId?: string | null;
  readonly revision?: number;
}

export interface SettingsReadResult {
  readonly ok: true;
  readonly settings: readonly SettingRow[];
}

export interface Grant {
  readonly collection: string;
  readonly action: string;
}

export interface CapabilitiesResult {
  readonly ok: true;
  readonly personId: string;
  readonly businessKey: string;
  readonly grants: readonly Grant[];
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
