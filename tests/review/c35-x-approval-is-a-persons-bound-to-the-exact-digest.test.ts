// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- one revision's life read top to bottom */
//
// C35-X (#2014, #2076): a person holding `gate:decide` at the review's holder approves the
// review's latest revision on its exact digest. The record carries that digest, the
// revision's author person and the decider; a decision naming an earlier digest is refused,
// a new revision is undecided until a person approves it, and an approval writes nothing
// but its own record and its audit row: no publish, no send, no outside call.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { c35xWorld, openedOf, type C35XWorld } from './c35-x-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('C35-X approval: DATABASE_URL is unset.');

let w: C35XWorld;

beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35xWorld('c35xapprove');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

/**
 * Rows in every business-scoped public table of alpha but the decision's own and the call's
 * own bookkeeping: its audit row, its sign-in and its operation register.
 */
async function otherRows(): Promise<Readonly<Record<string, number>>> {
  const tables = await w.world.db.admin.execute<{ readonly name: string }>(
    `select c.table_name as name from information_schema.columns c
       join information_schema.tables t
         on t.table_schema = c.table_schema and t.table_name = c.table_name
      where c.table_schema = 'public' and c.column_name = 'business_id'
        and t.table_type = 'BASE TABLE'
        and c.table_name not in (
          'review_decisions', 'audit_events', 'authentication_attempts', 'operations')
      order by 1`,
  );
  const counts: Record<string, number> = {};
  for (const { name } of tables) {
    // oxlint-disable-next-line no-await-in-loop -- one count per table
    const [row] = await w.world.db.admin.execute<{ readonly n: string }>(
      `select count(*)::text as n from public.${name} where business_id = $1`,
      [w.world.business],
    );
    counts[name] = Number(row?.n);
  }
  return counts;
}

/** The decision `review.read` shows on a revision: its `after` (the latest) or its `before`. */
const decisionOn = async (reviewId: string, which: 'after' | 'before'): Promise<unknown> => {
  const read = await w.read(w.ava, reviewId);
  if (!('review' in read)) throw new Error(`review.read refused ${JSON.stringify(read)}`);
  const revision = read.review[which];
  return revision === null ? undefined : (revision as { readonly decision?: unknown }).decision;
};
const latestDecision = async (reviewId: string): Promise<unknown> =>
  await decisionOn(reviewId, 'after');

describe.skipIf(serverUrl === undefined)('C35-X the review decision', () => {
  it('C35-X approval is a person’s, bound to the exact digest', async () => {
    // fay opens the revision; ben (gate:decide business-wide) approves it.
    const first = openedOf(detailOf(await w.open(w.fay)));
    const second = openedOf(detailOf(await w.open(w.fay)));
    expect(second.reviewId).toBe(first.reviewId);

    // The earlier digest names a revision that is no longer the one under review.
    expect(codeOf(await w.decide(w.ben, first))).toBe('VERSION_STALE');
    // A digest the review never had.
    expect(codeOf(await w.decide(w.ben, { ...second, digest: 'sha256:0' }))).toBe('VERSION_STALE');
    expect(await w.decisions(w.world.business)).toStrictEqual([]);

    const approved = await w.decide(w.ben, second);
    expect(codeOf(approved)).toBe('not-a-refusal');
    expect(detailOf(approved)).toMatchObject({
      reviewId: second.reviewId,
      revisionId: second.revisionId,
      digest: second.digest,
      response: 'approve',
      singleOperatorSelfApproval: false,
    });
    expect(await w.decisions(w.world.business)).toMatchObject([
      {
        review_id: second.reviewId,
        revision_id: second.revisionId,
        digest: second.digest,
        response: 'approve',
        author_person_id: w.fay.personId,
        decided_by_actor_id: w.ben.actorId,
        decided_by_person_id: w.ben.personId,
        single_operator_self_approval: false,
      },
    ]);
    expect(await latestDecision(second.reviewId)).toMatchObject({
      response: 'approve',
      digest: second.digest,
      decidedByPersonId: w.ben.personId,
      singleOperatorSelfApproval: false,
    });

    // Approved once: a second approval of the same revision is refused.
    expect(codeOf(await w.decide(w.cal, second))).toBe('REVIEW_ALREADY_DECIDED');
  });

  it('C35-X a new revision after approval needs a new approval', async () => {
    const approvedOne = openedOf(detailOf(await w.open(w.fay)));
    expect(codeOf(await w.decide(w.ben, approvedOne))).toBe('not-a-refusal');
    const next = openedOf(detailOf(await w.open(w.fay)));
    expect(next.reviewId).toBe(approvedOne.reviewId);

    // The review is undecided again; the earlier approval is kept on its own revision.
    expect(await latestDecision(next.reviewId)).toBeNull();
    expect(await decisionOn(next.reviewId, 'before')).toMatchObject({ digest: approvedOne.digest });
    // The old approval does not reach the new revision, and the old digest is stale now.
    expect(codeOf(await w.decide(w.ben, approvedOne))).toBe('VERSION_STALE');
    expect(codeOf(await w.decide(w.ben, next))).toBe('not-a-refusal');
    expect(await latestDecision(next.reviewId)).toMatchObject({ digest: next.digest });
  });

  it('C35-X an approval fires nothing', async () => {
    const opened = openedOf(detailOf(await w.open(w.fay)));
    const before = await otherRows();
    expect(codeOf(await w.decide(w.ben, opened))).toBe('not-a-refusal');
    // No correction, publish, receipt, message, outbox row or task: nothing but the decision.
    expect(await otherRows()).toStrictEqual(before);
  });

  it('C35-X audit readback (revision approved (exact version))', async () => {
    const opened = openedOf(detailOf(await w.open(w.fay)));
    const [mark] = await w.world.db.admin.execute<{ readonly at: string }>(
      `select coalesce(max(occurred_at), 'epoch')::text as at from public.audit_events
        where business_id = $1`,
      [w.world.business],
    );
    expect(codeOf(await w.decide(w.ben, { ...opened, digest: 'sha256:0' }))).toBe('VERSION_STALE');
    expect(codeOf(await w.decide(w.ben, opened))).toBe('not-a-refusal');
    const rows = await w.world.db.admin.execute<{
      readonly command: string;
      readonly refusal_code: string | null;
    }>(
      `select command, refusal_code from public.audit_events
        where business_id = $1 and command = 'review.decide' and occurred_at > $2
        order by occurred_at, id`,
      [w.world.business, mark?.at],
    );
    expect(rows.map((row) => [row.command, row.refusal_code])).toStrictEqual([
      ['review.decide', 'VERSION_STALE'],
      ['review.decide', null],
    ]);
  });
});
