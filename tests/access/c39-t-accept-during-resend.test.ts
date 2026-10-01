// SPDX-License-Identifier: AGPL-3.0-only
//
// C39-T review follow-up (SEC3 F1): an accept that waits on the invitation's
// row while a resend holds it. The resend moves the expiry on and spends
// every token the invitation has, then commits; the accept takes the row
// after it. Under read committed a statement that waited on a row lock reads
// that row again, and nothing else: a `for update of i` over the token and
// its invitation saw the new invitation and the old, unspent token, and
// seated the person through the link the resend had spent. The accept now
// takes the row in one statement and decides the link is live in the next,
// which reads what the resend committed. Each case drives the race: the
// accept is seen parked on its own named connection before the row is let go.

import { describe, expect, it } from 'vitest';
import type { TenantQuery } from '../../packages/core-records/src/index.ts';
import { INVITATION_LIFETIME_DAYS } from '../../packages/core-commands/src/commands/invitations.ts';
import {
  bindVia,
  boundTo,
  e,
  enrolVia,
  heldInBravo,
  identityRows,
  invited,
  loginOf,
  mountOver,
  passwordFor,
  spentOf,
  useEnrolWorld,
} from './c39-t-enrol-world.ts';
import { act, holdRow, own, parked, type Own } from './c39-t-race.ts';
import { addressFor, c, noDatabase, w } from './c39-t-world.ts';

useEnrolWorld();

const REFUSED = { status: 404, body: { code: 'ENROLMENT_LINK_INVALID' }, cookie: null };
const RESENT = { state: 'pending', spent: 1, tokens: 1 } as const;

/** A resend's writes, as `invitation.resend` makes them, under the row lock the holder took. */
const resendUnder =
  (id: string) =>
  async (tx: TenantQuery): Promise<void> => {
    await tx.query(
      `update invitations set expires_at = now() + make_interval(days => $3::int),
              revision = revision + 1
        where business_id = $1 and id = $2`,
      [tx.businessId, id, INVITATION_LIFETIME_DAYS],
    );
    await tx.query(
      `update enrolment_tokens set spent_at = now()
        where business_id = $1 and invitation_id = $2 and spent_at is null`,
      [tx.businessId, id],
    );
  };

/** Run `race` over the named connections, and close them whatever it does. */
async function over<T extends readonly Own[]>(
  ones: T,
  race: (ones: T) => Promise<void>,
): Promise<void> {
  try {
    await race(ones);
  } finally {
    await Promise.all(ones.map(async (one) => await one.db.close()));
  }
}

/** The enrolment routes on the accepting connection. */
const routesOn = (accepter: Own): ReturnType<typeof mountOver> =>
  mountOver([w.alpha, w.bravo], accepter.db);

// eslint-disable-next-line max-lines-per-function -- one database world, and the races that share it
describe.skipIf(noDatabase)('C39-T accept during a resend', () => {
  it('C39-T resend spends older links: a token-only accept parked on the row while a resend commits is refused and the invitation stays pending', async () => {
    e.users.mode('accept');
    const { id, token } = await invited(c.admin, addressFor('accept-held-resend'));
    const rows = await identityRows(w.alpha);
    await over([own(), own()] as const, async ([holder, accepter]) => {
      const letGo = await holdRow(holder.db, id, resendUnder(id));
      const accept = enrolVia(token, passwordFor(), routesOn(accepter));
      await parked(1, [accepter.name]);
      await letGo();
      expect(await accept).toStrictEqual(REFUSED);
    });
    expect(await spentOf(id)).toStrictEqual(RESENT);
    expect(await identityRows(w.alpha)).toStrictEqual(rows);
  }, 60_000);

  it('C39-T resend spends older links: a signed-in accept parked on the row while a resend commits is refused and binds nothing', async () => {
    const address = addressFor('bind-held-resend');
    const login = await heldInBravo(address);
    const { id, token } = await invited(c.admin, address);
    const rows = await identityRows(w.alpha);
    await over([own(), own()] as const, async ([holder, accepter]) => {
      const letGo = await holdRow(holder.db, id, resendUnder(id));
      const accept = bindVia(token, loginOf(login), routesOn(accepter));
      await parked(1, [accepter.name]);
      await letGo();
      expect(await accept).toStrictEqual(REFUSED);
    });
    expect(await spentOf(id)).toStrictEqual(RESENT);
    expect(await identityRows(w.alpha)).toStrictEqual(rows);
    expect(await boundTo(w.alpha, login)).toBeUndefined();
  }, 60_000);

  it('C39-T resend spends older links: an accept queued on the row behind a real resend is refused once the resend commits', async () => {
    e.users.mode('accept');
    const { id, token } = await invited(c.admin, addressFor('accept-behind-resend'));
    const rows = await identityRows(w.alpha);
    await over([own(), own(), own()] as const, async ([holder, resender, accepter]) => {
      const letGo = await holdRow(holder.db, id);
      const resend = act(resender.db, c.admin, { command: 'invitation.resend', invitationId: id });
      await parked(1, [resender.name]);
      const accept = enrolVia(token, passwordFor(), routesOn(accepter));
      await parked(2, [resender.name, accepter.name]);
      await letGo();
      expect(await resend).toBe('applied');
      expect(await accept).toStrictEqual(REFUSED);
    });
    expect(await spentOf(id)).toStrictEqual(RESENT);
    expect(await identityRows(w.alpha)).toStrictEqual(rows);
  }, 60_000);
});
