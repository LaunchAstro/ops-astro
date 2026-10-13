// SPDX-License-Identifier: AGPL-3.0-only
//
// A decided correction cancelled after its dispatch is closed, but a publish
// result the runner records afterwards moves it to unknown, which is open
// (`correction-receipts.ts`, `cancelledAfterDispatch`). That reopening and an
// unbind of its page, each on a connection of its own: the reopening first
// holds the correction, so the unbind waits, seen in pg_stat_activity, and is
// refused once the correction is unknown.
//
// The other order: the unbind comes while the correction is cancelled. A
// correction cancelled after its decision still counts as open, because its
// publish may have gone out and its result can still move it to unknown, so
// the unbind is refused and no open correction is left naming a page its
// client's site no longer holds.

import { beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { c80World, type C80World } from './c80-world.ts';
import { unbindPartySitePage } from '../../packages/core-records/src/site/party-sites.ts';
import type { TransactionQuery } from '../../packages/core-records/src/tenancy/transaction.ts';
import {
  freshClient,
  held,
  inAlpha,
  onOwn,
  UNBIND,
  waitSeen,
  type FreshClient,
} from './party-site-races.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined)
  console.warn('Cancelled reopening: DATABASE_URL is unset, so nothing ran.');

let w: C80World;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await c80World('reopen');
  await w.setApprover(w.ben.personId);
});

/** A correction on the client's first page, approved, then cancelled after its dispatch. */
async function cancelledAfterApproval(client: FreshClient): Promise<string> {
  const [page] = client.pages;
  const asked = detailOf(
    await w.request(w.ava, {
      partyId: client.partyId,
      taskId: client.taskId,
      pageUrl: page.pageUrl,
      path: page.path,
    }),
  );
  const id = String(asked['correctionId']);
  expect(codeOf(await w.approve(w.ben, id, String(asked['versionId'])))).toBe('not-a-refusal');
  await inAlpha(w, async (tx) => await moveTo(tx, id, 'cancelled'));
  return id;
}

/** The correction's state moved as the record layer moves it, by the application role. */
const moveTo = async (tx: TransactionQuery, id: string, state: 'cancelled' | 'unknown') =>
  await tx.query(
    `update public.live_corrections set state = $3, revision = revision + 1
      where business_id = $1 and id = $2`,
    [tx.businessId, id, state],
  );

const unbindOn = (client: FreshClient) => async (tx: TransactionQuery) =>
  await unbindPartySitePage(tx, client.partyId, client.pages[0].pageUrl);

describe.skipIf(serverUrl === undefined)(
  'a cancelled correction reopening against an unbind',
  () => {
    it('makes the unbind wait for the reopening, then refuses it', async () => {
      const client = await freshClient(w);
      const id = await cancelledAfterApproval(client);
      const reopening = held(w, async (tx) => await moveTo(tx, id, 'unknown'));
      await reopening.ready;
      const unbinding = onOwn(w, unbindOn(client));
      await waitSeen(w, UNBIND).finally(() => reopening.release());
      await reopening.done;
      expect(await unbinding).toEqual({ ok: false, code: 'PAGE_UNDER_CORRECTION' });
      expect(await w.stateOf(id)).toBe('unknown');
    });

    // An unbind while the correction is cancelled strands it once it reopens:
    // the hold needs a ruling on a decided cancelled correction.
    it('never leaves an open correction naming a page its site no longer holds', async () => {
      const client = await freshClient(w);
      const id = await cancelledAfterApproval(client);
      const unbound = await onOwn(w, unbindOn(client));
      const reopened = await inAlpha(w, async (tx) => await moveTo(tx, id, 'unknown')).then(
        () => true,
        () => false,
      );
      expect({ unbound, reopened }).not.toEqual({ unbound: { ok: true }, reopened: true });
    });
  },
);
