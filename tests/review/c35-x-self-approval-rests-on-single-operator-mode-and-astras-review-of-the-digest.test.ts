// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- each refusal beside the case it refuses */
//
// C35-X (#2014, R5 as #1689, director register 132): the revision's author, or the person
// whose agent authored it, approves it only while the business is in single-operator mode
// and Astra's latest review of this exact digest approves; the record then carries the
// single-operator mark. Otherwise the command refuses, and so does the table: a row naming
// the author as decider without the mark, or with the mark while the mode is off or Astra's
// review is missing, is refused on a direct insert.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { ASTRA, c35xWorld, openedOf, type C35XWorld, type Opened } from './c35-x-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('C35-X self-approval: DATABASE_URL is unset.');

let w: C35XWorld;

beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35xWorld('c35xself');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

/** Eve's revision of beta's review: she is its author and beta's one operator. */
const eveOpens = async (): Promise<Opened> =>
  openedOf(detailOf(await w.open(w.eve, { taskId: w.betaTask }, w.beta)));

/** A decision row written straight into the table, as the application role writes. */
async function insertDecision(
  business: string,
  at: Opened,
  row: {
    readonly author: string;
    readonly actorId: string;
    readonly personId: string;
    readonly mark: boolean;
  },
): Promise<string> {
  return await w.world.db.app
    .withBusiness(business, async (tx) => {
      await tx.query(
        `insert into public.review_decisions
           (business_id, id, review_id, revision_id, digest, response, author_person_id,
            decided_by_actor_id, decided_by_person_id, single_operator_self_approval)
         values ($1, $2, $3, $4, $5, 'approve', $6, $7, $8, $9)`,
        [
          business,
          randomUUID(),
          at.reviewId,
          at.revisionId,
          at.digest,
          row.author,
          row.actorId,
          row.personId,
          row.mark,
        ],
      );
      return 'stored';
    })
    .catch(String);
}

describe.skipIf(serverUrl === undefined)('C35-X self-approval', () => {
  it('C35-X self-approval admitted in single-operator mode with Astra’s review recorded for the exact digest', async () => {
    expect(codeOf(await w.setMode(w.beta, w.eve, true))).toBe('not-a-refusal');
    const opened = await eveOpens();
    expect(codeOf(await w.astra(w.eve, opened, 'approve', w.beta))).toBe('not-a-refusal');

    const approved = await w.decide(w.eve, opened, w.beta);
    expect(codeOf(approved)).toBe('not-a-refusal');
    expect(detailOf(approved)).toMatchObject({ singleOperatorSelfApproval: true });
    expect((await w.decisions(w.beta)).at(-1)).toMatchObject({
      revision_id: opened.revisionId,
      digest: opened.digest,
      author_person_id: w.eve.personId,
      decided_by_person_id: w.eve.personId,
      single_operator_self_approval: true,
    });
    // The Astra review is kept with its digest and the person who recorded it, never changed.
    const [astra] = await w.world.db.admin.execute<Record<string, unknown>>(
      `select digest, verdict, review, recorded_by_person_id from public.review_astra_reviews
        where business_id = $1 and revision_id = $2`,
      [w.beta, opened.revisionId],
    );
    expect(astra).toStrictEqual({
      digest: opened.digest,
      verdict: 'approve',
      review: ASTRA,
      recorded_by_person_id: w.eve.personId,
    });
    // The audit keeps the command, its outcome and digests: never Astra's words.
    const audit = await w.world.db.admin.execute<{ readonly row: string }>(
      `select to_jsonb(e)::text as row from public.audit_events e
        where business_id = $1 and command like 'review.%'`,
      [w.beta],
    );
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.filter((one) => one.row.includes(ASTRA))).toStrictEqual([]);
  });

  it('C35-X self-approval refused without single-operator mode', async () => {
    expect(codeOf(await w.setMode(w.beta, w.eve, false))).toBe('not-a-refusal');
    const opened = await eveOpens();
    expect(codeOf(await w.astra(w.eve, opened, 'approve', w.beta))).toBe('not-a-refusal');
    expect(codeOf(await w.decide(w.eve, opened, w.beta))).toBe('SELF_APPROVAL_REFUSED');

    // The person whose agent authored the revision is its author: ava, in alpha, where
    // several operators work and the mode is off.
    const byAgent = await w.openAsAgentFor(w.ava);
    expect(codeOf(await w.decide(w.ava, byAgent))).toBe('SELF_APPROVAL_REFUSED');
    const decided = await w.decisions(w.world.business);
    expect(decided.filter((row) => row['revision_id'] === byAgent.revisionId)).toStrictEqual([]);

    // The table refuses the author as decider without the mark, and the mark with the mode off.
    const asEve = { author: w.eve.personId, actorId: w.eve.actorId, personId: w.eve.personId };
    expect(await insertDecision(w.beta, opened, { ...asEve, mark: false })).toMatch(
      /review_decisions_no_self_approval/u,
    );
    expect(await insertDecision(w.beta, opened, { ...asEve, mark: true })).toMatch(
      /single_operator_mode is off/u,
    );
    // An author the revision does not carry is refused by its key, and an agent never decides.
    const asBen = { actorId: w.ben.actorId, personId: w.ben.personId, mark: false };
    expect(
      await insertDecision(w.world.business, byAgent, { ...asBen, author: w.cal.personId }),
    ).toMatch(/review_decisions_author_fkey/u);
    expect(
      await insertDecision(w.world.business, byAgent, {
        author: w.ava.personId,
        actorId: w.world.agentActorId,
        personId: w.ben.personId,
        mark: false,
      }),
    ).toMatch(/a person decides as themselves/u);
    expect(await w.decisions(w.beta)).toHaveLength(1);
  });

  it('C35-X self-approval refused without a recorded Astra review, or with one bound to an earlier digest', async () => {
    expect(codeOf(await w.setMode(w.beta, w.eve, true))).toBe('not-a-refusal');
    const first = await eveOpens();
    // No review at all.
    expect(codeOf(await w.decide(w.eve, first, w.beta))).toBe('ASTRA_REVIEW_MISSING');
    expect(codeOf(await w.astra(w.eve, first, 'approve', w.beta))).toBe('not-a-refusal');

    // A new revision: the review of the earlier digest does not carry to it, and Astra's
    // review naming that earlier digest is refused rather than stored against the new one.
    const second = await eveOpens();
    expect(codeOf(await w.decide(w.eve, second, w.beta))).toBe('ASTRA_REVIEW_MISSING');
    expect(codeOf(await w.astra(w.eve, first, 'approve', w.beta))).toBe('VERSION_STALE');

    // Astra's latest word on this digest is what counts: changes requested withdraws an approval.
    expect(codeOf(await w.astra(w.eve, second, 'approve', w.beta))).toBe('not-a-refusal');
    expect(codeOf(await w.astra(w.eve, second, 'changes_requested', w.beta))).toBe('not-a-refusal');
    expect(codeOf(await w.decide(w.eve, second, w.beta))).toBe('ASTRA_REVIEW_MISSING');
    const asEve = { author: w.eve.personId, actorId: w.eve.actorId, personId: w.eve.personId };
    expect(await insertDecision(w.beta, second, { ...asEve, mark: true })).toMatch(
      /no approving Astra review of this digest/u,
    );
    expect(codeOf(await w.astra(w.eve, second, 'approve', w.beta))).toBe('not-a-refusal');
    expect(codeOf(await w.decide(w.eve, second, w.beta))).toBe('not-a-refusal');
    // A business's earlier self-approval waives nothing: the next revision needs its own review.
    const third = await eveOpens();
    expect(codeOf(await w.decide(w.eve, third, w.beta))).toBe('ASTRA_REVIEW_MISSING');
  });
});
