// SPDX-License-Identifier: AGPL-3.0-only
//
// The made-up guard's sign-in list (made-up-only.ts says what it is for): the
// sign-ins at its addresses still waiting for `auth:seed` or the seed to vouch
// for them.
// Each reads or writes digests only, never a sign-in's row.
import { UNVOUCHED } from './made-up-install.ts';
import type { OwnerQuery } from './made-up-only.ts';

async function exists(admin: OwnerQuery, table: string): Promise<boolean> {
  const [row] = await admin.execute<{ present: boolean }>(
    'select to_regclass($1) is not null as present',
    [table],
  );
  return row?.present === true;
}

/** Whether a sign-in at a listed address is still waiting for `auth:seed`'s word. */
export async function anyUnvouched(admin: OwnerQuery): Promise<boolean> {
  if (!(await exists(admin, UNVOUCHED))) return false;
  return (await admin.execute(`select from ${UNVOUCHED} limit 1`)).length > 0;
}

/**
 * `auth:seed`'s word for the sign-ins it created, by id: each stops waiting.
 * One it found already there is not its own, so it is never passed here.
 */
export async function vouchSignIns(admin: OwnerQuery, ids: readonly string[]): Promise<void> {
  if (ids.length === 0 || !(await exists(admin, UNVOUCHED))) return;
  await admin.execute(
    `delete from ${UNVOUCHED} where sign_in = any (select encode(sha256(convert_to(id, 'UTF8')), 'hex')
      from unnest($1::text[]) as given (id))`,
    [ids],
  );
}
