// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- one invitation world and the three passes that share it */
//
// The mail unit's invitation pass. A person's `invitation.create` leaves an
// act no email has answered; the pass, run as the business's worker, finds it
// and sends it once, to the invited address, with one link, and a later pass
// finds nothing owed. Two units passing at once over one owed act make one
// provider request, one token, one `asked` and that send's one outcome: the
// second sender waits on the invitation's lock, counts the first's token and
// writes nothing. A resend applied while the first email is in flight is a
// second act: the next pass sends once more, two emails in all, never three.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { deliverOwedInvitations, type EmailTiming } from '../../packages/core-custody/src/index.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import {
  addressFor,
  as,
  c,
  codeOf,
  invite,
  MAIL,
  noDatabase,
  useInvitationWorld,
  w,
} from './c39-t-world.ts';

useInvitationWorld();

const timing = (): EmailTiming => ({
  broker: w.broker,
  mail: MAIL,
  preferences: { mock: true, choice: async () => await Promise.resolve('daily_batch') },
});

async function workerOf(business: string): Promise<string> {
  const id = randomUUID();
  await w.db.app.withBusiness(business, async (tx) => {
    await tx.query(
      `insert into public.actors (business_id, id, kind, person_id, active, deactivated_at)
       values ($1, $2, 'worker', null, true, null)`,
      [tx.businessId, id],
    );
  });
  return id;
}

const tokensOf = async (id: string): Promise<number> =>
  (
    await w.db.admin.execute<{ n: number }>(
      'select count(*)::int as n from public.enrolment_tokens where invitation_id = $1',
      [id],
    )
  )[0]?.n ?? -1;

const attemptsOf = async (id: string): Promise<readonly string[]> =>
  (
    await w.db.admin.execute<{ state: string }>(
      `select state from public.invitation_delivery_attempts
        where invitation_id = $1 order by observed_at`,
      [id],
    )
  ).map((row) => row.state);

/** Every message the provider heard for `address` since `from`. */
const heardFor = (address: string, from: number): readonly string[] =>
  w.provider.received
    .slice(from)
    .map((message) => message.body)
    .filter((body) => body.includes(address));

describe.skipIf(noDatabase)('the invitation pass', () => {
  it('finds an act no email has answered and sends it once, to the invited address; the next pass sends nothing', async () => {
    const address = addressFor('owed-once');
    const id = await invite(c.admin, address);
    const worker = await workerOf(w.alpha);
    const before = w.provider.received.length;
    const first = await deliverOwedInvitations(w.db.app, w.alpha, worker, timing());
    expect(first).toStrictEqual({ ok: true, emails: 1 });
    const heard = heardFor(address, before);
    expect(heard).toHaveLength(1);
    const body = JSON.parse(heard[0] ?? '{}') as { from: string; to: string[]; text: string };
    expect(body.from).toBe(MAIL.from);
    expect(body.to).toEqual([address]);
    expect(body.text.match(/https?:\/\/\S+/gu)).toHaveLength(1);
    expect(await tokensOf(id)).toBe(1);
    const second = await deliverOwedInvitations(w.db.app, w.alpha, worker, timing());
    expect(second).toStrictEqual({ ok: true, emails: 0 });
    expect(heardFor(address, before)).toHaveLength(1);
  });

  it('two units passing at once over one owed act make one request, one token, one ask and its one outcome', async () => {
    const address = addressFor('two-units');
    const id = await invite(c.admin, address);
    const worker = await workerOf(w.alpha);
    const before = w.provider.received.length;
    const unitA = connect(w.db.appUrl);
    const unitB = connect(w.db.appUrl);
    try {
      const passes = await Promise.all([
        deliverOwedInvitations(unitA, w.alpha, worker, timing()),
        deliverOwedInvitations(unitB, w.alpha, worker, timing()),
      ]);
      const emails = passes.map((pass) => (pass.ok ? pass.emails : -1));
      expect(emails.toSorted()).toEqual([0, 1]);
    } finally {
      await Promise.all([unitA.close(), unitB.close()]);
    }
    expect(heardFor(address, before)).toHaveLength(1);
    expect(await tokensOf(id)).toBe(1);
    expect(await attemptsOf(id)).toEqual(['asked', 'accepted']);
  });

  it('a resend applied while the first email is in flight is sent once more by the next pass, two in all', async () => {
    const address = addressFor('resend-in-flight');
    const id = await invite(c.admin, address);
    const worker = await workerOf(w.alpha);
    const before = w.provider.received.length;
    let resent = false;
    let second: Promise<unknown> = Promise.resolve();
    const custody: typeof w.custody = {
      ...w.custody,
      dispatch: async (ref, request) => {
        if (!resent) {
          resent = true;
          const applied = await as(c.admin, 'invitation.resend', { invitationId: id });
          expect(codeOf(applied)).toBe('applied');
          // The next pass runs while this email is still in flight.
          second = deliverOwedInvitations(w.db.app, w.alpha, worker, {
            ...timing(),
            broker: { ...w.broker, custody: w.custody },
          });
          await second;
        }
        return await w.custody.dispatch(ref, request);
      },
    };
    const first = await deliverOwedInvitations(w.db.app, w.alpha, worker, {
      ...timing(),
      broker: { ...w.broker, custody },
    });
    await second;
    expect(first).toStrictEqual({ ok: true, emails: 1 });
    expect(await second).toStrictEqual({ ok: true, emails: 1 });
    expect(heardFor(address, before)).toHaveLength(2);
    expect(await tokensOf(id)).toBe(2);
    const third = await deliverOwedInvitations(w.db.app, w.alpha, worker, timing());
    expect(third).toStrictEqual({ ok: true, emails: 0 });
    expect(heardFor(address, before)).toHaveLength(2);
  });
});
