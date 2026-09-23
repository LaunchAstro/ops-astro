// SPDX-License-Identifier: AGPL-3.0-only
//
// The two settings a named operation owns.
//
// L2 classified `four_eyes_threshold` and `client_sign_off_required` as
// `operation` and named the commands that would own them; these are those
// commands. The classification is the whole reason they exist: a setting that
// decides whether a second approver is needed is an authority change wearing
// configuration's clothes, so it is not reachable through a generic editor and
// the operation that owns it is the only way in.
//
// **The key is the command, not a field.** `settings.set_four_eyes_threshold`
// writes one row and knows which. A single `settings.set` taking a key would
// have made the `owning_operation` column a decoration: one operation owning
// every setting is the same as no setting being owned.
//
// **The database's check constraint is the backstop and not the mechanism.**
// `business_settings_value_matches_type` refuses a band that arrived as a
// string, and that refusal arrives as a constraint violation rather than as an
// answer about the request. So the type is checked here first and the
// violation is caught behind it, mapped to the same typed refusal the caller
// would have got anyway — because a constraint nobody can reach is a
// constraint nobody has tested, and a path that only the constraint holds is
// one the caller meets as a 500.
//
// **The row is written by `records/business-settings.ts`, against a revision.**
// The update these two commands used to run themselves did not touch
// `revision`, so a setting written through a command kept the number it had and
// two administrators editing one row from two browser tabs both applied — the
// second silently replacing a value chosen before the first existed. The write
// now goes through `writeBusinessSetting`, which locks the row before it
// compares, so the loser waits, re-reads and is refused `VERSION_STALE` instead
// of being told `applied`.
//
// `expectedRevision` is optional and stays optional. The four contracts that
// name these settings predate the column, so a caller that has not learnt to
// send one still writes and is still handed the revision the row is now at.

import type { TenantQuery } from '../tenancy/database.ts';
import { isSettingRevisionStale, writeBusinessSetting } from '../records/business-settings.ts';
import type { CommandContext } from './context.ts';
import { refuseCommand } from './refusal.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';

/** The row each command owns, which is the thing that makes `owning_operation` mean something. */
const KEY_OF: Readonly<Record<string, string>> = {
  'settings.set_four_eyes_threshold': 'four_eyes_threshold',
  'settings.set_client_sign_off': 'client_sign_off_required',
};

const THRESHOLD_FIXES: readonly string[] = [
  'Send value as a number of dollars, or null to turn the second approver off.',
  'A negative band is not "off"; null is.',
];

const SIGN_OFF_FIXES: readonly string[] = ['Send value as true or false.'];

const ABSENT_FIXES: readonly string[] = [
  'This business has no row for that setting yet.',
  'Install the named business settings before writing one.',
];

/** Postgres raises 23514 on a failed check constraint. */
function isCheckViolation(cause: unknown): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    (cause as { readonly code?: unknown }).code === '23514'
  );
}

/**
 * Write one of the two settings a named operation owns.
 *
 * `expectedRevision` is the caller's own, straight off a `settings.read`, and
 * it is handed to the records writer unchanged: absent means "write it anyway",
 * a number the row has moved past is `VERSION_STALE`, and the refusal is
 * returned by that writer rather than thrown so this transaction survives it.
 *
 * `undefined` from the writer is one answer for two facts — this business has
 * no row by that key, and this operation does not own the row it found — and
 * both are the caller's own `NOT_FOUND`. Neither tells the caller which,
 * because "a setting you may not write" and "a setting that is not there" are
 * the same amount of business configuration to somebody who may not write it.
 */
export async function setBusinessSetting(
  tx: TenantQuery,
  context: CommandContext,
  command: 'settings.set_four_eyes_threshold' | 'settings.set_client_sign_off',
  value: unknown,
  expectedRevision?: number,
): Promise<HandlerOutcome> {
  const key = KEY_OF[command];
  if (key === undefined) throw new Error(`setBusinessSetting: ${command} owns no setting`);

  // The narrowing is done into a variable rather than by a guard above, because
  // the value handed to the writer has to be the typed one: this driver
  // serialises by the type it is given, and an `unknown` that is really a
  // string reaches the column as the JSON string "500", which no comparison
  // reads and the check constraint correctly refuses.
  let writable: number | boolean | null;
  if (command === 'settings.set_four_eyes_threshold') {
    if (value === null) writable = null;
    else if (typeof value === 'number' && Number.isFinite(value) && value >= 0) writable = value;
    else return refused(refuseCommand('FIELD_VALUE_INVALID', ['value'], THRESHOLD_FIXES));
  } else if (typeof value === 'boolean') writable = value;
  else return refused(refuseCommand('FIELD_VALUE_INVALID', ['value'], SIGN_OFF_FIXES));

  // `owningOperation` is this command's own name and never the caller's idea of
  // one. The row says which operation owns it, so a setting someone later
  // reclassified stops being writable here without this file changing.
  let written;
  try {
    written = await writeBusinessSetting(tx, {
      key,
      value: writable,
      // Spread rather than set: `exactOptionalPropertyTypes` makes "the
      // property is absent" and "the property is undefined" two different
      // things, and the writer's optional revision means the first one.
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
      owningOperation: command,
      actorId: context.session.actorId,
    });
  } catch (cause) {
    if (!isCheckViolation(cause)) throw cause;
    return refused(
      refuseCommand(
        'FIELD_VALUE_INVALID',
        ['value'],
        command === 'settings.set_four_eyes_threshold' ? THRESHOLD_FIXES : SIGN_OFF_FIXES,
      ),
    );
  }

  if (written === undefined) return refused(refuseCommand('NOT_FOUND', [key], ABSENT_FIXES));
  if (isSettingRevisionStale(written)) {
    // Passed straight through: the writer already named the revision the row is
    // at and the fixes the records spine words, so restating either here would
    // be two wordings of one answer drifting apart.
    return refused(refuseCommand(written.code, written.names, written.fixes));
  }

  // The revision is in the handle *and* in the detail: the handle is what a
  // client writes against next, and the detail is what it shows.
  return applied(written.id, written.revision, {
    key,
    value: written.value,
    revision: written.revision,
  });
}
