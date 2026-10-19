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

export const C35_NAMES: ReadonlySet<string> = new Set([
  'review.open',
  'review.capture',
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

export async function c35PositiveBody(name: CommandName, context: BodyContext): Promise<Prepared> {
  const open = await openBody(context);
  if (name === 'review.open' || !('body' in open)) return open;
  const opened = await context.asPerson('review.open', open.body);
  if (opened.code !== 'ok') throw new Error(`matrix: review.open refused ${opened.code}`);
  const detail = opened.body['detail'] as Readonly<Record<string, unknown>>;
  return name === 'review.capture'
    ? { body: { revisionId: detail['revisionId'] } }
    : { body: { reviewId: detail['reviewId'] } };
}
