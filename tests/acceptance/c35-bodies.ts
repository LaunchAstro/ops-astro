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

export const C35_NAMES: ReadonlySet<string> = new Set([
  'review.open',
  'review.capture',
  'review.pin_comment',
  'review.read',
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
