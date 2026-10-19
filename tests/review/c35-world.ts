// SPDX-License-Identifier: AGPL-3.0-only
//
// C35's command-layer world (#2011), on C80's: one business with two client
// parties whose sites bind their pages, a second business with a client and
// task of its own, and the agent fixture's runtime delegation and lease. The
// review keys are granted here: ava business-wide, dee on party B only, eve
// business-wide in beta; cal holds the correction keys and no review key.

import { randomUUID } from 'node:crypto';
import { c80World, type C80World } from '../site/c80-world.ts';
import { ABOUT, B_FILE, B_PAGE, PAGE } from '../site/c80-sites.ts';
import { grantTo, type Member } from '../commands/fixture.ts';
import type { Scope } from '../../packages/core-records/src/authority/grants.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';

export { ABOUT, B_FILE, B_PAGE, PAGE };

type Body = Readonly<Record<string, unknown>>;

export interface C35World extends C80World {
  open(member: Member, overrides?: Body, business?: string): Promise<CommandResult>;
  capture(member: Member, revisionId: unknown, business?: string): Promise<CommandResult>;
  read(member: Member, reviewId: unknown, business?: string): ReturnType<typeof executeRead>;
  /** Rows of a C35 table in `business`, counted as the administrator sees them. */
  count(
    table: 'reviews' | 'review_revisions' | 'review_captures',
    business: string,
  ): Promise<number>;
}

const WHOLE: Scope = { kind: 'business', id: null };

async function reviewKeys(w: C80World, business: string, member: Member, scope: Scope) {
  await w.world.db.app.withBusiness(business, async (tx) => {
    await grantTo(tx, member, 'write', scope, false, 'review');
    await grantTo(tx, member, 'read', scope, false, 'review');
  });
}

export async function c35World(part: string): Promise<C35World> {
  const w = await c80World(part);
  await reviewKeys(w, w.world.business, w.ava, WHOLE);
  await reviewKeys(w, w.world.business, w.dee, { kind: 'party', id: w.partyB });
  await reviewKeys(w, w.beta, w.eve, WHOLE);
  const alpha = w.world.business;
  return {
    ...w,
    open: async (member, overrides = {}, business = alpha) =>
      await w.asIn(business, member, {
        command: 'review.open',
        taskId: w.taskA,
        pageUrl: PAGE,
        path: ABOUT,
        sourceRevision: `rev-${randomUUID().slice(0, 8)}`,
        ...overrides,
      }),
    capture: async (member, revisionId, business = alpha) =>
      await w.asIn(business, member, { command: 'review.capture', revisionId }),
    read: async (member, reviewId, business = alpha) =>
      await executeRead(w.world.db.app, business, member.presented, {
        read: 'review.read',
        reviewId,
      } as never),
    count: async (table, business) =>
      Number(
        (
          await w.world.db.admin.execute<{ readonly n: string }>(
            `select count(*)::text as n from public.${table} where business_id = $1`,
            [business],
          )
        )[0]?.n,
      ),
  };
}
