// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- each proof sets its revision up and races it in one place */
//
// C35-X (#2075): the carry is the worker's, under its live lease on the review's task. Before
// the new revision has landed at both widths it is refused CARRY_NOT_READY; under an expired
// lease, or one that ran out while the carry waited on the captures, it is refused
// LEASE_EXPIRED; under a lease on another task it finds no revision. Each writes nothing. A
// second carry, a replayed one and two at once on separate connections leave one carry per
// pin.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf } from '../commands/agent-fixture.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { executeAgentCommand } from '../../packages/core-commands/src/commands/agent-envelope.ts';
import { c35World, pickUpReviewed, spot, underReview, type C35World } from './c35-world.ts';
import { agentLogin } from './c35-landing.ts';
import {
  carriesOnto,
  carryCount,
  carryUnder,
  expireNow,
  landPage,
  landedReview,
  must,
  nextRevision,
  pinOn,
  quote,
} from './c35-x-carry.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('C35-X carry lease: DATABASE_URL is unset.');

let w: C35World;

beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35World('c35xlease');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

const PAGE_ONE = { text: 'Book a visit today. Our team.', document: 'a' };
const PAGE_TWO = { text: 'Book a visit today. Meet the team.', document: 'd' };

/** Wait until a statement on the app role waits on a lock, as the carry does on the captures. */
async function untilParked(): Promise<boolean> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    // Polling is sequential by definition.
    // eslint-disable-next-line no-await-in-loop
    const [row] = await w.world.db.admin.execute<{ readonly n: string }>(
      `select count(*)::text as n from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
          and query like '%from public.review_captures k%'`,
    );
    if (Number(row?.n) > 0) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  return false;
}

/** Hold the revision's capture rows locked on another connection until `release` is called. */
function holdCaptures(revisionId: string) {
  const holder = connect(w.world.db.appUrl);
  let release!: () => void;
  let locked!: () => void;
  const ready = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held = holder.withBusiness(w.world.business, async (tx) => {
    await tx.query(
      'select 1 from public.review_captures where business_id = $1 and revision_id = $2 for update',
      [w.world.business, revisionId],
    );
    locked();
    await gate;
  });
  return {
    ready,
    release: async () => {
      release();
      await held;
      await holder.close();
    },
  };
}

describe.skipIf(serverUrl === undefined)('C35-X the carry and its lease', () => {
  it('C35-X the carry needs a live worker lease on the review’s task and a revision landed at both widths', async () => {
    const { reviewed, lease } = await landedReview(w, 'carry lease', PAGE_ONE);
    await pinOn(w, reviewed.revisionId, { selector: [spot(), quote('Our team')] });
    const second = await nextRevision(w, reviewed);
    const before = await carryCount(w, w.world.business);

    expect(codeOf((await carryUnder(w, lease, second)).result)).toBe('CARRY_NOT_READY');

    // A lease on another task finds no revision of this review.
    const other = await underReview(w, 'another task');
    const foreign = await pickUpReviewed(w, other);
    await landPage(w, lease, second, PAGE_TWO);
    expect(codeOf((await carryUnder(w, foreign, second)).result)).toBe('NOT_FOUND');

    await expireNow(w, lease);
    expect(codeOf((await carryUnder(w, lease, second)).result)).toBe('LEASE_EXPIRED');
    expect(await carryCount(w, w.world.business)).toBe(before);
  }, 90_000);

  it('C35-X a carry that waited on the captures past its lease’s expiry writes nothing', async () => {
    const { reviewed, lease } = await landedReview(w, 'carry waits', PAGE_ONE);
    await pinOn(w, reviewed.revisionId);
    const second = await nextRevision(w, reviewed);
    await landPage(w, lease, second, PAGE_TWO);
    const before = await carryCount(w, w.world.business);
    const held = holdCaptures(second);
    await held.ready;
    const carrying = carryUnder(w, lease, second);
    try {
      expect(await untilParked(), 'the carry must reach the capture lock').toBe(true);
      await expireNow(w, lease);
    } finally {
      await held.release();
    }
    expect(codeOf((await carrying).result)).toBe('LEASE_EXPIRED');
    expect(await carryCount(w, w.world.business)).toBe(before);
  }, 90_000);

  it('C35-X a second, a replayed and two competing carries leave one carry per pin', async () => {
    const { reviewed, lease } = await landedReview(w, 'carry once', PAGE_ONE);
    const pins = [
      await pinOn(w, reviewed.revisionId),
      await pinOn(w, reviewed.revisionId, { selector: [spot(), quote('Book a visit today')] }),
    ];
    const second = await nextRevision(w, reviewed);
    await landPage(w, lease, second, PAGE_TWO);

    // Two at once, each on its own connection, both parked behind a held lock first.
    const other = connect(w.world.db.appUrl);
    const held = holdCaptures(second);
    await held.ready;
    const racing = [carryUnder(w, lease, second), carryUnder(w, lease, second, other)];
    try {
      expect(await untilParked()).toBe(true);
    } finally {
      await held.release();
    }
    const answers = await Promise.all(racing);
    await other.close();
    const details = answers.map(({ result }) => must(result, 'review.carry_pins'));
    expect(
      details.map((detail) => Number(detail['moved']) + Number(detail['lost'])).toSorted(),
    ).toStrictEqual([0, 2]);
    const stored = await carriesOnto(w, second);
    expect(stored.map((row) => row.comment_id).toSorted()).toStrictEqual(pins.toSorted());

    // Another carry finds nothing left; the same operation replayed answers as it did.
    expect(must((await carryUnder(w, lease, second)).result, 'again')).toStrictEqual({
      revisionId: second,
      moved: 0,
      lost: 0,
    });
    const [first] = answers;
    const replayed = await executeAgentCommand(
      w.world.db.app,
      w.world.business,
      agentLogin(w),
      lease.credential,
      {
        operationId: first?.operationId,
        command: 'review.carry_pins',
        leaseId: lease.leaseId,
        fence: lease.fence,
        revisionId: second,
      } as never,
    );
    expect(codeOf(replayed as never)).toBe('not-a-refusal');
    expect(await carriesOnto(w, second)).toStrictEqual(stored);
  }, 90_000);
});
