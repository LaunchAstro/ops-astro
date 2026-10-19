// SPDX-License-Identifier: AGPL-3.0-only
//
// C35-X's carry (#2075): a reviewed page landed at both widths showing some text, pins on it,
// the page's next revision landed showing other text, and the worker's carry of the pins onto
// that revision under its lease, each a call of the agent envelope as the site runner makes it.

import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import type { Database } from '../../packages/core-records/src/index.ts';
import {
  pickUpReviewed,
  underReview,
  type C35World,
  type Lease,
  type Reviewed,
} from './c35-world.ts';
import { claimUnder, landUnder, observationOf, pictureBytes, underLease } from './c35-landing.ts';

/** What a revision's page shows at both widths: its text, and its document's digest letter. */
export interface Page {
  readonly text: string;
  /** One hex letter: two pages with the same letter are the same document. */
  readonly document: string;
}

export const observed = (width: number, page: Page): Readonly<Record<string, unknown>> => ({
  ...observationOf(width),
  text: page.text,
  documentDigest: `sha256:${page.document.repeat(64)}`,
});

/** An applied answer's detail, or a throw naming the refusal. */
export function must(result: CommandResult, what: string): Record<string, unknown> {
  const code = codeOf(result);
  if (code !== 'not-a-refusal') throw new Error(`c35-x carry: ${what} refused ${code}`);
  return detailOf(result);
}

/** Claim and land both widths of `revisionId` under `lease`, each showing `page`. */
export async function landPage(
  w: C35World,
  lease: Lease,
  revisionId: string,
  page: Page,
): Promise<void> {
  must(await claimUnder(w, lease, revisionId), 'review.capture_claim');
  for (const width of [1480, 390]) {
    // Each land is its own call under the lease, one after the other.
    // eslint-disable-next-line no-await-in-loop
    const { result } = await landUnder(w, lease, {
      revisionId,
      width,
      picture: pictureBytes(width),
      observation: observed(width, page),
    });
    must(result, 'review.capture_land');
  }
}

/** Which client and page a review is on: party A's about page unless told. */
export interface ReviewAt {
  readonly partyId?: string;
  readonly pageUrl?: string;
  readonly path?: string;
}

/** A review on `title`'s task, its first revision landed showing `page`, and the agent's lease. */
export async function landedReview(
  w: C35World,
  title: string,
  page: Page,
  at: ReviewAt = {},
): Promise<{ readonly reviewed: Reviewed; readonly lease: Lease }> {
  const reviewed = await underReview(w, title, at);
  const lease = await pickUpReviewed(w, reviewed);
  await landPage(w, lease, reviewed.revisionId, page);
  return { reviewed, lease };
}

/** ava's next revision of the review's page, both captures asked; its id. */
export async function nextRevision(
  w: C35World,
  reviewed: Reviewed,
  at: ReviewAt = {},
): Promise<string> {
  const page = at.pageUrl === undefined ? {} : { pageUrl: at.pageUrl, path: at.path };
  const opened = must(await w.open(w.ava, { taskId: reviewed.taskId, ...page }), 'review.open');
  const revisionId = String(opened['revisionId']);
  must(await w.capture(w.ava, revisionId), 'review.capture');
  return revisionId;
}

/** ava's internal pin on the desktop capture unless told; the comment's id. */
export async function pinOn(
  w: C35World,
  revisionId: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Promise<string> {
  return String(must(await w.pin(w.ava, revisionId, overrides), 'review.pin_comment')['commentId']);
}

export const quote = (
  exact: string,
  context: { readonly prefix?: string; readonly suffix?: string } = {},
): Readonly<Record<string, string>> => ({ type: 'TextQuoteSelector', exact, ...context });

/** `review.carry_pins` onto `revisionId` under `lease`, on `database` if given. */
export const carryUnder = async (
  w: C35World,
  lease: Lease,
  revisionId: string,
  database?: Database,
): Promise<{ readonly operationId: string; readonly result: CommandResult }> =>
  await underLease(w, lease, { command: 'review.carry_pins', revisionId }, database);

/** End `lease` now, on the database's clock, as if its time ran out. */
export async function expireNow(w: C35World, lease: Lease): Promise<void> {
  await w.world.db.admin.execute(
    'update public.leases set expires_at = clock_timestamp() where id = $1',
    [lease.leaseId],
  );
}

/** A carry as stored. */
export interface StoredCarry {
  readonly comment_id: string;
  readonly from_revision_id: string;
  readonly state: 'moved' | 'lost';
  readonly anchor: unknown;
  readonly operation_id: string;
}

/** The carries onto `revisionId`, by comment, as plain rows. */
export const carriesOnto = async (
  w: C35World,
  revisionId: string,
): Promise<readonly StoredCarry[]> => [
  ...(await w.world.db.admin.execute<StoredCarry>(
    `select comment_id, from_revision_id, state, anchor, operation_id
       from public.review_pin_carries where to_revision_id = $1 order by comment_id`,
    [revisionId],
  )),
];

/** Every carry in `business`, counted as the administrator sees them. */
export const carryCount = async (w: C35World, business: string): Promise<number> =>
  Number(
    (
      await w.world.db.admin.execute<{ readonly n: string }>(
        'select count(*)::text as n from public.review_pin_carries where business_id = $1',
        [business],
      )
    )[0]?.n,
  );

/** The comment rows of a task as stored, to show a carry leaves them as they were. */
export const commentRows = async (w: C35World, taskId: string): Promise<readonly unknown[]> => [
  ...(await w.world.db.admin.execute(
    `select r.id, r.revision, r.data, r.deleted_at from public.records r
       join public.record_types t on t.business_id = r.business_id and t.id = r.record_type_id
      where t.key = 'task_comment' and r.data ->> 'task' = $1 order by r.id`,
    [taskId.toLowerCase()],
  )),
];
