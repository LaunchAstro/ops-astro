// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it as vitestIt } from 'vitest';
import { mintChildDelegation } from '../../packages/core-records/src/authority/delegations.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { hold, waitingOn } from '../support/lock-waits.ts';
import { childRequest, noDatabase, parentWork, useChildWorld, w } from './aw-11-child-world.ts';

useChildWorld('parentlockwait');
const it = noDatabase ? vitestIt.skip : vitestIt;

it('a parent expiring during its own row lock wait cannot mint a child', async () => {
  const { parent } = await parentWork(w.s);
  await w.s.db.admin.execute(
    "update public.delegations set expires_at = clock_timestamp() + interval '2 seconds' where id = $1",
    [parent.id],
  );
  const held = await hold(
    w.s.db.appUrl,
    w.s.business,
    async (tx) =>
      await tx.query(
        'select id from public.delegations where business_id = $1 and id = $2 for update',
        [w.s.business, parent.id],
      ),
  );
  const writer = connect(w.s.db.appUrl);
  const minting = writer.withBusiness(
    w.s.business,
    async (tx) => await mintChildDelegation(tx, parent, childRequest(w.helper)),
  );
  try {
    await waitingOn(w.s.db.admin, 'transactionid', 'delegations');
    for (let attempt = 0; attempt < 500; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop -- polled until the deadline passes
      const [clock] = await w.s.db.admin.execute<{ expired: boolean }>(
        'select expires_at <= clock_timestamp() as expired from public.delegations where id = $1',
        [parent.id],
      );
      if (clock?.expired === true) break;
      if (attempt === 499) throw new Error('parent did not expire');
      // eslint-disable-next-line no-await-in-loop -- one poll at a time
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
    }
  } finally {
    await held.letGo();
  }
  try {
    const result = await minting;
    expect(result.ok ? 'minted' : result.refusal.code).toBe('DELEGATION_EXPIRED');
    const [kept] = await w.s.db.admin.execute<{ n: number }>(
      'select count(*)::int as n from public.delegations where parent_delegation_id = $1',
      [parent.id],
    );
    expect(kept?.n).toBe(0);
  } finally {
    await writer.close();
  }
});
