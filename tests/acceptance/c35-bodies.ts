// SPDX-License-Identifier: AGPL-3.0-only
//
// C35's positive bodies for the role-case matrix (#2011), answered from `role-case-setup.ts`'s
// `tableBody`: a review is opened by the admin on a task under a client of its own, for that
// client's bound about page, so the capture and the read each name one the admin reaches.

import { randomUUID } from 'node:crypto';
import type { CommandName } from '../../packages/core-wire/src/surface.ts';
import { ABOUT_FILE } from '../site/party-site-fixture.ts';
import { madeClient } from './role-case-access-bodies.ts';
import type { BodyContext, Prepared } from './role-case-bodies.ts';
import type { AdminConnection } from '../../packages/core-records/src/tenancy/database.ts';
import type { Caller } from './cast.ts';
import type { Answer } from './world.ts';
import { PROPOSAL } from './role-case-bodies.ts';

export const C35_NAMES: ReadonlySet<string> = new Set([
  'review.open',
  'review.capture',
  'review.pin_comment',
  'review.read',
  'review.capture_claim',
  'review.capture_land',
  'review.picture',
]);

/** An open's body: a fresh task under a client of the admin's, and that client's bound page. */
async function openBody(context: BodyContext): Promise<Prepared> {
  if (context.bindClientSite === undefined) {
    return { exception: 'this harness binds no client site (C35)' };
  }
  const task = await context.freshTask('a task a page review is opened on');
  const partyId = await madeClient(context);
  const set = await context.asPerson('task.set_party', {
    recordId: task.id,
    expectedRevision: task.revision,
    fields: { client: partyId },
  });
  if (set.code !== 'ok') throw new Error(`matrix: task.set_party refused ${set.code}`);
  const pageUrl = await context.bindClientSite(partyId);
  return {
    body: { taskId: task.id, pageUrl, path: ABOUT_FILE, sourceRevision: `rev-${randomUUID()}` },
  };
}

/** A pin's body (#2012): the revision's captures asked first, then a spot on the desktop one. */
async function pinBody(context: BodyContext, revisionId: unknown): Promise<Prepared> {
  const asked = await context.asPerson('review.capture', { revisionId });
  if (asked.code !== 'ok') throw new Error(`matrix: review.capture refused ${asked.code}`);
  const spot = {
    type: 'FragmentSelector',
    conformsTo: 'http://www.w3.org/TR/media-frags/',
    value: 'xywh=0,0,9,9',
  };
  return {
    body: { revisionId, width: 1480, selector: [spot], body: 'a pin', audience: 'internal' },
  };
}

export async function c35PositiveBody(name: CommandName, context: BodyContext): Promise<Prepared> {
  if (WORKER_NAMES.has(name)) return await workerBody(name, context);
  const open = await openBody(context);
  if (name === 'review.open' || !('body' in open)) return open;
  const opened = await context.asPerson('review.open', open.body);
  if (opened.code !== 'ok') throw new Error(`matrix: review.open refused ${opened.code}`);
  const detail = opened.body['detail'] as Readonly<Record<string, unknown>>;
  if (name === 'review.pin_comment') return await pinBody(context, detail['revisionId']);
  return name === 'review.capture'
    ? { body: { revisionId: detail['revisionId'] } }
    : { body: { reviewId: detail['reviewId'] } };
}

/**
 * A review of another business's with its first revision, written as its open writes it, for
 * the identifier cases. A media review names no page, so no site of that business is needed.
 */
export async function seedForeignReview(
  admin: Pick<AdminConnection, 'execute'>,
  business: string,
  taskId: string,
  by: Pick<Caller, 'actorId' | 'personId'>,
): Promise<{ readonly reviewId: string; readonly revisionId: string }> {
  const [reviewId, revisionId] = [randomUUID(), randomUUID()];
  await admin.execute(
    `insert into public.reviews
       (business_id, id, task_id, kind, opened_by_actor_id, opened_by_person_id)
     values ($1, $2, $3, 'media', $4, $5)`,
    [business, reviewId, taskId, by.actorId, by.personId],
  );
  await admin.execute(
    `insert into public.review_revisions
       (business_id, id, review_id, number, digest, created_by_actor_id, created_by_person_id)
     values ($1, $2, $3, 1, 'sha256:0', $4, $5)`,
    [business, revisionId, reviewId, by.actorId, by.personId],
  );
  return { reviewId, revisionId };
}

/** The worker's claim and land, and the picture read a land leaves behind. */
const WORKER_NAMES: ReadonlySet<string> = new Set([
  'review.capture_claim',
  'review.capture_land',
  'review.picture',
]);

/** What a land carries at one width: the picture's bytes, base64, and the page observation. */
export const LANDING: {
  readonly width: number;
  readonly picture: string;
  readonly observation: Readonly<Record<string, unknown>>;
} = {
  width: 1480,
  picture: Buffer.from('a page capture').toString('base64'),
  observation: {
    url: 'https://agency.example/about/',
    status: 200,
    documentDigest: 'sha256:0',
    text: 'About',
    html: '<h1>About</h1>',
    stylesheets: {},
  },
};

type Fields = Readonly<Record<string, unknown>>;

const detailOf = (answer: Answer, what: string): Fields => {
  if (answer.code !== 'ok') throw new Error(`matrix: ${what} refused ${answer.code}`);
  return answer.body['detail'] as Fields;
};

/**
 * The admin's own lease on a task under a client of its own, with a page review open on it and
 * both widths' captures asked: what a person working their own pickup claims and lands under.
 * The proposal locks the client, so the client is set and its page bound first (P26 low 4).
 */
async function leasedCapture(
  context: BodyContext,
): Promise<{ readonly leaseId: string; readonly fence: number; readonly revisionId: string }> {
  const open = await openBody(context);
  if (!('body' in open)) throw new Error(`matrix: ${open.exception}`);
  const taskId = String(open.body['taskId']);
  const read = await context.asPerson('task.read', { recordId: taskId });
  const proposed = detailOf(
    await context.asPerson('task.propose', {
      recordId: taskId,
      expectedRevision: (read.body['task'] as { revision: number }).revision,
      ...PROPOSAL,
    }),
    'task.propose',
  );
  const decided = detailOf(
    await context.asPerson('task.decide', {
      gateId: proposed['gateId'],
      versionId: proposed['versionId'],
      decision: 'approve',
      note: 'approved so its page capture is worked',
    }),
    'task.decide',
  );
  const picked = detailOf(
    await context.asPerson('task.pickup', { reservationId: decided['reservationId'] }),
    'task.pickup',
  );
  const opened = detailOf(await context.asPerson('review.open', open.body), 'review.open');
  const revisionId = String(opened['revisionId']);
  detailOf(await context.asPerson('review.capture', { revisionId }), 'review.capture');
  return { leaseId: String(picked['leaseId']), fence: Number(picked['fence']), revisionId };
}

/** The claim under the admin's own lease, a land of what it claimed, and the landed picture. */
async function workerBody(name: CommandName, context: BodyContext): Promise<Prepared> {
  if (context.bindClientSite === undefined) {
    return { exception: 'this harness binds no client site (C35)' };
  }
  const lease = await leasedCapture(context);
  if (name === 'review.capture_claim') return { body: { ...lease } };
  detailOf(await context.asPerson('review.capture_claim', lease), 'review.capture_claim');
  if (name === 'review.capture_land') return { body: { ...lease, ...LANDING } };
  const landed = detailOf(
    await context.asPerson('review.capture_land', { ...lease, ...LANDING }),
    'review.capture_land',
  );
  return { body: { pictureId: landed['pictureId'] } };
}

/** A media review on `taskId` with both widths asked, as the ask writes them; its revision. */
export async function seedAskedRevision(
  admin: Pick<AdminConnection, 'execute'>,
  business: string,
  taskId: string,
  by: Pick<Caller, 'actorId' | 'personId'>,
): Promise<string> {
  const { revisionId } = await seedForeignReview(admin, business, taskId, by);
  await admin.execute(
    `insert into public.review_captures
       (business_id, id, revision_id, width, asked_by_actor_id, asked_by_person_id)
     select $1, gen_random_uuid(), $2, w.width, $3, $4 from unnest($5::int[]) as w (width)`,
    [business, revisionId, by.actorId, by.personId, [1480, 390]],
  );
  return revisionId;
}

/**
 * A picture of another business's, landed on a capture of `revisionId` under `lease`, as a land
 * writes it, for the identifier cases: the stored object and the capture row that names it.
 */
export async function seedForeignPicture(
  admin: Pick<AdminConnection, 'execute'>,
  business: string,
  revisionId: string,
  lease: { readonly leaseId: string; readonly fence: number },
  by: Pick<Caller, 'actorId' | 'personId'>,
): Promise<string> {
  const pictureId = randomUUID();
  await admin.execute(
    `insert into public.storage_objects (business_id, id, digest, byte_count, body)
     values ($1, $2, 'sha256:0', 4, 'seed'::bytea)`,
    [business, pictureId],
  );
  await admin.execute(
    `insert into public.review_captures
       (business_id, id, revision_id, width, state, asked_by_actor_id, asked_by_person_id,
        lease_id, fence, observation, picture_id, picture_digest, landed_at)
     values ($1, gen_random_uuid(), $2, 1480, 'landed', $3, $4, $5, $6, '{}'::jsonb, $7,
             'sha256:0', now())`,
    [business, revisionId, by.actorId, by.personId, lease.leaseId, lease.fence, pictureId],
  );
  return pictureId;
}

/** What D06's agent cells ask of their harness: the owner's connection and the agent prefix. */
interface AgentWorker {
  readonly world: {
    readonly db: { readonly admin: Pick<AdminConnection, 'execute'> };
    readonly alpha: string;
    readonly ada: Pick<Caller, 'actorId' | 'personId'>;
  };
  asAgent(name: CommandName, body: Fields, credential?: string): Promise<Answer>;
}

/**
 * D06's positive agent body for the claim and the land: a revision asked on the held lease's task,
 * owner-seeded, claimed first by the agent for a land. Undefined for every other operation.
 */
export async function c35AgentBody(
  harness: AgentWorker,
  name: CommandName,
  held: { readonly taskId: string; readonly leaseId: string; readonly fence: number },
  credential: string,
): Promise<Fields | undefined> {
  if (name !== 'review.capture_claim' && name !== 'review.capture_land') return undefined;
  const { world } = harness;
  const revisionId = await seedAskedRevision(world.db.admin, world.alpha, held.taskId, world.ada);
  const lease = { leaseId: held.leaseId, fence: held.fence, revisionId };
  if (name === 'review.capture_claim') return lease;
  detailOf(await harness.asAgent('review.capture_claim', lease, credential), 'agent claim');
  return { ...lease, ...LANDING };
}
