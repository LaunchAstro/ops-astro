// SPDX-License-Identifier: AGPL-3.0-only
//
// The mail unit sends an owed invitation as system work under the business's
// worker. The worker is held, active, inside the send's reservation: a
// worker deactivated after the pass chose the invitation, or one that is not
// a worker of this business, writes no token and no `asked`, and the provider
// hears nothing. An active worker sends it once.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sendOwedInvitation } from '../../packages/core-custody/src/index.ts';
import { c, invite, MAIL, noDatabase, useInvitationWorld, w } from './c39-t-world.ts';

useInvitationWorld();

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

describe.skipIf(noDatabase)('an owed invitation sent under the business’s worker', () => {
  it('a worker deactivated after the invitation was chosen sends nothing', async () => {
    const id = await invite(c.admin);
    const worker = await workerOf(w.alpha);
    await w.db.admin.execute(
      'update public.actors set active = false, deactivated_at = now() where id = $1',
      [worker],
    );
    const before = w.provider.received.length;
    const result = await sendOwedInvitation(w.db.app, w.alpha, worker, id, w.broker, MAIL);
    expect(result).toStrictEqual({ ok: false, code: 'WORKER_REQUIRED' });
    expect(await tokensOf(id)).toBe(0);
    expect(w.provider.received.length).toBe(before);
  });

  it('another business’s worker, or no actor at all, sends nothing', async () => {
    const id = await invite(c.admin);
    const elsewhere = await workerOf(w.bravo);
    for (const actor of [elsewhere, randomUUID(), 'not-an-id']) {
      // oxlint-disable-next-line no-await-in-loop -- one refusal after another
      const result = await sendOwedInvitation(w.db.app, w.alpha, actor, id, w.broker, MAIL);
      expect(result, actor).toStrictEqual({ ok: false, code: 'WORKER_REQUIRED' });
    }
    expect(await tokensOf(id)).toBe(0);
  });

  it('an active worker of the business sends it once', async () => {
    const id = await invite(c.admin);
    const worker = await workerOf(w.alpha);
    const before = w.provider.received.length;
    const sent = await sendOwedInvitation(w.db.app, w.alpha, worker, id, w.broker, MAIL);
    expect(sent).toMatchObject({ ok: true, state: 'accepted' });
    const again = await sendOwedInvitation(w.db.app, w.alpha, worker, id, w.broker, MAIL);
    expect(again).toStrictEqual({ ok: false, code: 'NO_SEND_ACT' });
    expect(await tokensOf(id)).toBe(1);
    expect(w.provider.received.length).toBe(before + 1);
  });
});
