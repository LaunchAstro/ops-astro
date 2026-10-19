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
import { executeAgentCommand } from '../../packages/core-commands/src/commands/agent-envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { Database } from '../../packages/core-records/src/index.ts';
import type { VerifiedSubject } from '../../packages/core-records/src/identity/login-resolution.ts';

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

// The capture half's helpers (part B): a task of a client's with a review open on its bound
// page and its capture asked, the agent's pickup of it, and the worker's claim and land under
// that lease, each a call of the agent envelope as the site runner makes it.

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

/** A page observation as the fenced capture makes it. */
export const observationOf = (width: number): Readonly<Record<string, unknown>> => ({
  url: PAGE,
  documentDigest: `sha256:${'a'.repeat(64)}`,
  text: `About us, seen ${String(width)} wide.`,
  html: `<main><h1>About</h1><p>${String(width)}</p></main>`,
  status: 200,
  stylesheets: { 'https://agency.example/site.css': `sha256:${'b'.repeat(64)}` },
});

/** A picture's bytes, distinct per `seed`. */
export const pictureBytes = (seed: number, length = 2_048): Buffer =>
  Buffer.alloc(length, seed % 256);

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

/** The agent's login, as `executeAgentCommand` is handed it. */
export const agentLogin = (w: C35World): VerifiedSubject => ({
  provider: 'supabase',
  subject: w.world.agentSubject(),
});

/** One worker call under `lease`, on `database` (the world's own pool unless given). */
export async function underLease(
  w: C35World,
  lease: Lease,
  body: Body,
  database: Database = w.world.db.app,
): Promise<{ readonly operationId: string; readonly result: CommandResult }> {
  const operationId = randomUUID();
  const result = (await executeAgentCommand(
    database,
    w.world.business,
    agentLogin(w),
    lease.credential,
    { operationId, leaseId: lease.leaseId, fence: lease.fence, ...body } as never,
  )) as CommandResult;
  return { operationId, result };
}

export const claimUnder = async (
  w: C35World,
  lease: Lease,
  revisionId: string,
  database?: Database,
): Promise<CommandResult> =>
  (await underLease(w, lease, { command: 'review.capture_claim', revisionId }, database)).result;

/** The land of one width's picture and observation, with the operation it went under. */
export const landUnder = async (
  w: C35World,
  lease: Lease,
  at: { readonly revisionId: string; readonly width: number; readonly picture: Uint8Array },
): Promise<{ readonly operationId: string; readonly result: CommandResult }> =>
  await underLease(w, lease, {
    command: 'review.capture_land',
    revisionId: at.revisionId,
    width: at.width,
    picture: Buffer.from(at.picture).toString('base64'),
    observation: observationOf(at.width),
  });

/** `review.picture`, as `member` reads it in `business`. */
export const readPicture = async (
  w: C35World,
  member: Member,
  pictureId: unknown,
  business: string = w.world.business,
): ReturnType<typeof executeRead> =>
  await executeRead(w.world.db.app, business, member.presented, {
    read: 'review.picture',
    pictureId,
  } as never);

/** Stored objects in `business`, counted as the administrator sees them. */
export const storedObjects = async (w: C35World, business: string): Promise<number> =>
  Number(
    (
      await w.world.db.admin.execute<{ readonly n: string }>(
        'select count(*)::text as n from public.storage_objects where business_id = $1',
        [business],
      )
    )[0]?.n,
  );

/** A revision's captures as stored, widest first. */
export interface StoredCapture {
  readonly width: number;
  readonly state: string;
  readonly lease_id: string | null;
  readonly picture_id: string | null;
  readonly picture_digest: string | null;
}

export const capturesOf = async (
  w: C35World,
  revisionId: string,
): Promise<readonly StoredCapture[]> =>
  await w.world.db.admin.execute<StoredCapture>(
    `select width, state, lease_id, picture_id, picture_digest from public.review_captures
      where revision_id = $1 order by width desc`,
    [revisionId],
  );
