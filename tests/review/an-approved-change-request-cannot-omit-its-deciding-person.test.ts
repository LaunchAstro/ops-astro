// SPDX-License-Identifier: AGPL-3.0-only
//
// C57 (#2016): the table itself refuses a decision with no deciding person, through the
// application role's granted UPDATE, whatever a handler sends. Sol's proof (#2122 round 1),
// its assertion unchanged.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { c57World, type C57World } from './c57-world.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('C57 deciding person: DATABASE_URL is unset.');

let w: C57World;
beforeAll(async () => {
  if (serverUrl !== undefined) w = await c57World('c57person');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w?.world.drop();
});

describe.skipIf(serverUrl === undefined)('C57 the deciding person', () => {
  it('an approved request cannot omit its deciding person', async () => {
    const { clientPin } = await w.pins();
    const filed = await w.propose(w.ava, clientPin);
    expect(codeOf(filed)).toBe('not-a-refusal');
    const id = String(detailOf(filed)['changeRequestId']);
    // Exercise the granted application UPDATE, not the administrator role.
    // The named decided_by_a_person CHECK must reject this un-attributed decision.
    await expect(
      w.world.db.app.withBusiness(w.world.business, async (tx) => {
        await tx.query(
          `update public.review_change_requests set state='approved', decided_at=clock_timestamp()
           where business_id=$1 and id=$2`,
          [w.world.business, id],
        );
      }),
    ).rejects.toMatchObject({
      code: '23514',
      constraint_name: 'review_change_requests_decided_by_a_person',
    });
  });
});
