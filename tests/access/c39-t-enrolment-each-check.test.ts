// SPDX-License-Identifier: AGPL-3.0-only
//
// C39-T enrolment: each check on the link refuses on its own. A link the
// product kills is usually dead more than one way at once (an accepted
// invitation's tokens are spent too; a revoke spends them), so the cases in
// c39-t-enrolment.test.ts cannot show any one check doing its work. Here the
// rows are planted so that exactly one check stands between the link and an
// accept: a spent token, a token past its own lifetime, an invitation no
// longer pending, everything else live. Each is refused alike, asks the
// login provider nothing and writes nothing; an untouched link enrols.

import { describe, expect, it } from 'vitest';
import { e, enrolVia, invited, rowsIn, spentOf, useEnrolWorld } from './c39-t-enrol-world.ts';
import { addressFor, c, noDatabase, w } from './c39-t-world.ts';

useEnrolWorld();

const REFUSED = { status: 404, body: { code: 'ENROLMENT_LINK_INVALID' }, cookie: null };

/** The identity rows a business holds, to show a refusal wrote none. */
async function identityRows(business: string): Promise<readonly number[]> {
  const tables = ['logins', 'person_logins', 'memberships', 'actors', 'person_identifiers'];
  return await Promise.all(tables.map(async (table) => await rowsIn(table, business)));
}

/** One row change, planted past the product, that kills the link one way only. */
const PLANTS = [
  ['spent', `update public.enrolment_tokens set spent_at = now() where invitation_id = $1`],
  [
    'past its own lifetime',
    `update public.enrolment_tokens set expires_at = now() - interval '1 minute'
      where invitation_id = $1`,
  ],
  [
    'no longer pending',
    `update public.invitations set state = 'revoked', ended_at = now() where id = $1`,
  ],
] as const;

describe.skipIf(noDatabase)('C39-T enrolment, each check alone', () => {
  it('C39-T enrolment: each of the link checks refuses alone, a spent token, one past its lifetime and an invitation no longer pending', async () => {
    e.users.mode('accept');
    const asked = e.users.received.length;
    for (const [name, plant] of PLANTS) {
      // oxlint-disable-next-line no-await-in-loop
      const { id, token } = await invited(c.admin, addressFor(`each-${name}`));
      // oxlint-disable-next-line no-await-in-loop
      await w.db.admin.execute(plant, [id]);
      // oxlint-disable-next-line no-await-in-loop
      const rows = await identityRows(w.alpha);
      // oxlint-disable-next-line no-await-in-loop
      expect(await enrolVia(token), name).toStrictEqual(REFUSED);
      // oxlint-disable-next-line no-await-in-loop
      expect(await identityRows(w.alpha), name).toStrictEqual(rows);
    }
    expect(e.users.received).toHaveLength(asked);

    // The control: the same steps with nothing planted enrol.
    const control = await invited(c.admin, addressFor('each-control'));
    expect((await enrolVia(control.token)).body).toStrictEqual({ state: 'enrolled' });
    expect((await spentOf(control.id)).state).toBe('accepted');
  });
});
