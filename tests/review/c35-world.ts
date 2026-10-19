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
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';

export { ABOUT, B_FILE, B_PAGE, PAGE };

type Body = Readonly<Record<string, unknown>>;

export interface C35World extends C80World {
  open(member: Member, overrides?: Body, business?: string): Promise<CommandResult>;
  capture(member: Member, revisionId: unknown, business?: string): Promise<CommandResult>;
  read(member: Member, reviewId: unknown, business?: string): ReturnType<typeof executeRead>;
  /** `review.pin_comment` on `revisionId`, an internal pin on the desktop capture unless told. */
  pin(
    member: Member,
    revisionId: unknown,
    overrides?: Body,
    business?: string,
  ): Promise<CommandResult>;
  /** Rows of a C35 table in `business`, counted as the administrator sees them. */
  count(
    table: 'reviews' | 'review_revisions' | 'review_captures' | 'pins',
    business: string,
  ): Promise<number>;
}

const WHOLE: Scope = { kind: 'business', id: null };

export const MEDIA_FRAGMENTS = 'http://www.w3.org/TR/media-frags/';

/** A media fragment selector on one capture, the spot a pin marks. */
export const spot = (
  value = 'xywh=120,340,300,48',
): { readonly type: 'FragmentSelector'; readonly conformsTo: string; readonly value: string } => ({
  type: 'FragmentSelector',
  conformsTo: MEDIA_FRAGMENTS,
  value,
});

async function reviewKeys(w: C80World, business: string, member: Member, scope: Scope) {
  await w.world.db.app.withBusiness(business, async (tx) => {
    await grantTo(tx, member, 'write', scope, false, 'review');
    await grantTo(tx, member, 'read', scope, false, 'review');
    await grantTo(tx, member, 'comment', scope, false, 'review');
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
    pin: async (member, revisionId, overrides = {}, business = alpha) =>
      await w.asIn(business, member, {
        command: 'review.pin_comment',
        revisionId,
        width: 1480,
        selector: [spot()],
        body: 'Move this heading above the fold',
        audience: 'internal',
        ...overrides,
      }),
    count: async (table, business) =>
      Number(
        (
          await w.world.db.admin.execute<{ readonly n: string }>(
            table === 'pins'
              ? `select count(*)::text as n from public.records
                  where business_id = $1 and data ? 'anchor'`
              : `select count(*)::text as n from public.${table} where business_id = $1`,
            [business],
          )
        )[0]?.n,
      ),
  };
}

// The capture half's helpers (part B): a task of a client's with a review open on its bound
// page and its capture asked, and the agent's pickup of it. The worker's claim and land under
// that lease, each a call of the agent envelope as the site runner makes it, are in
// c35-landing.ts.

/** A task under a client, its review open on a page that client's site binds, capture asked. */
export interface Reviewed {
  readonly taskId: string;
  readonly reviewId: string;
  readonly revisionId: string;
}

/** The lease a pickup handed back, and what it was picked up from. */
export interface Lease {
  readonly taskId: string;
  readonly reservationId: string;
  readonly leaseId: string;
  readonly fence: number;
  readonly credential: string;
}

/** An applied answer's detail, or a throw naming the refusal. */
function needDetail(result: CommandResult, what: string): Record<string, unknown> {
  if (isCommandRefusal(result)) throw new Error(`c35World: ${what} refused ${result.code}`);
  return { ...(result.detail as Record<string, unknown>), recordId: result.recordId };
}

const revisionOfTask = async (w: C35World, taskId: string): Promise<number> =>
  Number(
    (
      await w.world.db.admin.execute<{ readonly revision: string }>(
        'select revision::text as revision from public.records where business_id = $1 and id = $2',
        [w.world.business, taskId],
      )
    )[0]?.revision,
  );

/** On party A's about page unless told otherwise; ava creates, opens and asks. */
export async function underReview(
  w: C35World,
  title: string,
  at: { readonly partyId?: string; readonly pageUrl?: string; readonly path?: string } = {},
): Promise<Reviewed> {
  const created = needDetail(
    await w.as(w.ava, { command: 'task.create', fields: { title } }),
    'task.create',
  );
  const taskId = String(created['recordId']);
  needDetail(
    await w.as(w.admin, {
      command: 'task.set_party',
      recordId: taskId,
      expectedRevision: await revisionOfTask(w, taskId),
      fields: { client: at.partyId ?? w.partyA },
    }),
    'task.set_party',
  );
  const opened = needDetail(
    await w.open(w.ava, { taskId, pageUrl: at.pageUrl ?? PAGE, path: at.path ?? ABOUT }),
    'review.open',
  );
  needDetail(await w.capture(w.ava, opened['revisionId']), 'review.capture');
  return {
    taskId,
    reviewId: String(opened['reviewId']),
    revisionId: String(opened['revisionId']),
  };
}

const leaseOf = (
  taskId: string,
  reservationId: string,
  detail: Record<string, unknown>,
): Lease => ({
  taskId,
  reservationId,
  leaseId: String(detail['leaseId']),
  fence: Number(detail['fence']),
  credential: String(detail['credential']),
});

/** ava approves work on the task and the agent picks it up, for `leaseSeconds` if given. */
export async function pickUpReviewed(
  w: C35World,
  reviewed: Reviewed,
  leaseSeconds?: number,
): Promise<Lease> {
  const proposed = needDetail(
    await w.as(w.ava, {
      command: 'task.propose',
      recordId: reviewed.taskId,
      expectedRevision: await revisionOfTask(w, reviewed.taskId),
      purpose: `review_${randomUUID().slice(0, 8)}`,
      maximumMinor: 3_000,
      currency: 'AUD',
      payload: { instruction: 'capture the page under review' },
      step: { kind: 'compose', payload: {} },
    }),
    'task.propose',
  );
  const decided = needDetail(
    await w.as(w.ava, {
      command: 'task.decide',
      gateId: proposed['gateId'],
      versionId: proposed['versionId'],
      decision: 'approve',
      note: 'approved so the agent can capture the page',
    }),
    'task.decide',
  );
  const reservationId = String(decided['reservationId']);
  const picked = needDetail(
    await w.world.asAgent({
      command: 'task.pickup',
      operationId: randomUUID(),
      reservationId,
      ...(leaseSeconds === undefined ? {} : { leaseSeconds }),
    }),
    'task.pickup',
  );
  return leaseOf(reviewed.taskId, reservationId, picked);
}

/** Wait, on the database's clock, until `lease` and the delegation that expires with it have run out. */
export async function untilExpired(w: C35World, lease: Lease): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    // Polling is sequential by definition.
    // eslint-disable-next-line no-await-in-loop
    const [row] = await w.world.db.admin.execute<{ readonly past: boolean }>(
      `select clock_timestamp() > greatest(l.expires_at, d.expires_at) as past
         from public.leases l join public.delegations d
           on d.business_id = l.business_id and d.id = l.delegation_id
        where l.id = $1`,
      [lease.leaseId],
    );
    if (row?.past === true) return;
    if (attempt > 400) throw new Error('c35World: the lease never ran out');
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
}

/**
 * Wait until `lease` has run out (`untilExpired`), then pick the same reservation up again:
 * a later lease on the same task, at a later fence.
 */
export async function pickUpAgainAfterExpiry(w: C35World, lease: Lease): Promise<Lease> {
  await untilExpired(w, lease);
  const picked = needDetail(
    await w.world.asAgent({
      command: 'task.pickup',
      operationId: randomUUID(),
      reservationId: lease.reservationId,
    }),
    'task.pickup again',
  );
  return leaseOf(lease.taskId, String(picked['reservationId']), picked);
}
