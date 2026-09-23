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

import type { TenantQuery } from '../tenancy/database.ts';
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

/**
 * How each command's value becomes the document the row holds.
 *
 * `$3` is the caller's own value — a number or a boolean, not its text — and
 * it is converted by the server against the type this command knows the row
 * is. Null is `'null'::jsonb` and not a SQL null: the column is `not null` and
 * "the band is off" is a value rather than an absence.
 *
 * **The value is not stringified on the way in.** It was, and this driver
 * reads `$3::boolean` as a request to serialise the *JavaScript* value as a
 * boolean: the string `'true'` is not `true`, so it went to the server as
 * `false` and the setting was silently written the wrong way round. A driver
 * that serialises by the cast it can see is a good reason never to hand it a
 * value of a different type from the one the SQL claims.
 */
const VALUE_SQL: Readonly<Record<string, string>> = {
  'settings.set_four_eyes_threshold': `case when $3::text is null then 'null'::jsonb else to_jsonb($3::numeric) end`,
  'settings.set_client_sign_off': `to_jsonb($3::boolean)`,
};

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

export async function setBusinessSetting(
  tx: TenantQuery,
  context: CommandContext,
  command: 'settings.set_four_eyes_threshold' | 'settings.set_client_sign_off',
  value: unknown,
): Promise<HandlerOutcome> {
  const key = KEY_OF[command];
  if (key === undefined) throw new Error(`setBusinessSetting: ${command} owns no setting`);

  if (command === 'settings.set_four_eyes_threshold') {
    const acceptable =
      value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
    if (!acceptable) {
      return refused(refuseCommand('FIELD_VALUE_INVALID', ['value'], THRESHOLD_FIXES));
    }
  } else if (typeof value !== 'boolean') {
    return refused(refuseCommand('FIELD_VALUE_INVALID', ['value'], SIGN_OFF_FIXES));
  }

  // `write_mode = 'operation'` and `owning_operation @> {command}` in the
  // predicate rather than in a branch above it: the row itself says which
  // operation owns it, so a row someone later reclassified `generic` stops
  // being writable here without this file changing. Nothing in the update
  // trusts the caller for the key, the actor or the time.
  let rows: readonly { readonly id: string }[];
  try {
    rows = await tx.query<{ readonly id: string }>(
      // The conversion is chosen here, by the command, and there is no `case`
      // over `value_type` in the statement. Two shapes were tried first and
      // both were wrong for the same reason — the server decides the
      // parameter's type before the row is read. A `case` had every arm's cast
      // folded at plan time, so a numeric band was rejected by a boolean arm
      // that was never meant to run; a single `$3::jsonb` had the driver send
      // the text `1200` as the *JSON string* `"1200"`, which
      // `business_settings_value_matches_type` correctly refused. So each
      // command names its own conversion, which it can, because the key is the
      // command and the row's type follows from it.
      `update business_settings
          set value = ${VALUE_SQL[command]},
              updated_at = now(),
              updated_by_actor_id = $4
        where business_id = $1 and key = $2
          and write_mode = 'operation'
          and owning_operation @> array[$5::text]
      returning id`,
      [tx.businessId, key, value ?? null, context.session.actorId, command],
    );
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

  const row = rows[0];
  if (row === undefined) return refused(refuseCommand('NOT_FOUND', [key], ABSENT_FIXES));

  // No revision: `business_settings` carries none, so there is nothing for a
  // caller to write against and nothing to hand back. That is a schema gap
  // rather than a decision, and it is named in the handback.
  return applied(row.id, null, { key, value });
}
