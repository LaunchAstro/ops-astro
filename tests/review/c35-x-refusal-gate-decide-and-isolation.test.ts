// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- each refusal beside the key it lacks */
//
// C35-X (#2014, #2076): deciding a review and recording Astra's review of it are
// `gate:decide` at the review's holder, a person's alone. A member with the review keys and
// no gate key is refused, an agent is refused, another client's or another business's review
// is one that is not there, and a revision or a mode that changes while the decision waits
// on its lock is read again after the wait. Each refusal stores nothing.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintDelegation } from '../../packages/core-records/src/authority/delegations.ts';
import { connect } from '../../packages/core-records/src/index.ts';
import { openPageReview } from '../../packages/core-records/src/review/reviews.ts';
import type { TransactionQuery } from '../../packages/core-records/src/tenancy/transaction.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { lockWaiters } from '../site/party-site-races.ts';
import { ABOUT, B_FILE, B_PAGE, PAGE } from './c35-world.ts';
import { c35xWorld, openedOf, type C35XWorld, type Opened } from './c35-x-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('C35-X refusal: DATABASE_URL is unset.');

let w: C35XWorld;

beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35xWorld('c35xdeny');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

const count = async (table: string, business: string): Promise<number> =>
  Number(
    (
      await w.world.db.admin.execute<{ readonly n: string }>(
        `select count(*)::text as n from public.${table} where business_id = $1`,
        [business],
      )
    )[0]?.n,
  );

/** `work` in a transaction of `business` on its own connection, held open until released. */
function held(business: string, work: (tx: TransactionQuery) => Promise<unknown>) {
  const own = connect(w.world.db.appUrl, { source: 'runtime' });
  let ready!: () => void;
  let release!: () => void;
  const isReady = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const done = own
    .withBusiness(business, async (tx) => {
      await work(tx);
      ready();
      await released;
    })
    .finally(async () => {
      await own.close();
    });
  return { ready: isReady, release, done };
}

/** The statements waiting on a lock once one does, within five seconds; empty if none does. */
async function waiters(): Promise<readonly string[]> {
  for (let tries = 0; tries < 200; tries += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polling for the waiter
    const waiting = await lockWaiters(w);
    if (waiting.length > 0) return waiting;
    // oxlint-disable-next-line no-await-in-loop -- polling for the waiter
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  return [];
}

/** What `decide` waited on while `holding` held its lock, and its answer once released. */
async function decidedBehind(
  holding: ReturnType<typeof held>,
  decide: () => Promise<unknown>,
): Promise<{ readonly waited: readonly string[]; readonly answer: unknown }> {
  await holding.ready;
  const deciding = decide();
  let waited: readonly string[] = [];
  try {
    waited = await waiters();
  } finally {
    holding.release();
    await holding.done;
  }
  return { waited, answer: await deciding };
}

describe.skipIf(serverUrl === undefined)('C35-X gate:decide', () => {
  it('C35-X refusal gate:decide', async () => {
    const opened = openedOf(detailOf(await w.open(w.fay)));
    // fay holds the review keys and no gate key: neither the decision nor Astra's review.
    expect(codeOf(await w.decide(w.fay, opened))).toBe('SCOPE_NOT_GRANTED');
    expect(codeOf(await w.astra(w.fay, opened))).toBe('SCOPE_NOT_GRANTED');

    // An agent on a pickup, and one delegated the gate key itself for the review's task.
    const picked = await w.pickUpUnder(w.ava, 'Approve the about page', w.partyA);
    const asAgent = async (body: Readonly<Record<string, unknown>>, credential: string) =>
      codeOf(await w.world.asAgent({ operationId: randomUUID(), ...body }, credential));
    const decideBody = { command: 'review.decide', ...opened, response: 'approve' };
    const astraBody = {
      command: 'review.record_astra_review',
      ...opened,
      verdict: 'approve',
      review: 'Astra: fine',
    };
    expect(await asAgent(decideBody, picked.credential)).not.toBe('not-a-refusal');
    expect(await asAgent(astraBody, picked.credential)).not.toBe('not-a-refusal');
    const gateDelegation = await w.world.db.app
      .withBusiness(w.world.business, async (tx) => {
        const minted = await mintDelegation(tx, {
          agentActorId: w.world.agentActorId,
          delegatePersonId: w.ben.personId,
          mintedByActorId: w.ben.actorId,
          purpose: `decide_${opened.revisionId.slice(0, 8)}`,
          collections: ['gate'],
          actions: ['decide'],
          purposeScope: { kind: 'record', id: w.taskA },
          expiresAt: new Date(Date.now() + 3_600_000),
        });
        return minted.ok ? minted.value.credential : null;
      })
      .catch(() => null);
    if (gateDelegation !== null) {
      expect(await asAgent(decideBody, gateDelegation)).not.toBe('not-a-refusal');
    }
    expect(await count('review_decisions', w.world.business)).toBe(0);
    expect(await count('review_astra_reviews', w.world.business)).toBe(0);
  });

  it('C35-X isolation', async () => {
    const onA = openedOf(detailOf(await w.open(w.ava)));
    const onB = openedOf(
      detailOf(await w.open(w.ava, { taskId: w.taskB, pageUrl: B_PAGE, path: B_FILE })),
    );
    const inBeta = openedOf(detailOf(await w.open(w.eve, { taskId: w.betaTask }, w.beta)));
    const betaDecisions = await count('review_decisions', w.beta);

    // dee's gate key reaches party B only: the door asks it at party A and refuses her, as it
    // refuses her `review.capture` there.
    expect(codeOf(await w.decide(w.dee, onA))).toBe('SCOPE_NOT_GRANTED');
    expect(codeOf(await w.astra(w.dee, onA))).toBe('SCOPE_NOT_GRANTED');
    // eve's business-wide key in beta reaches nothing of alpha's, and ben's nothing of beta's.
    expect(codeOf(await w.decide(w.eve, onA, w.beta))).toBe('NOT_FOUND');
    expect(codeOf(await w.astra(w.eve, onA, 'approve', w.beta))).toBe('NOT_FOUND');
    expect(codeOf(await w.decide(w.ben, inBeta))).toBe('NOT_FOUND');
    expect(await count('review_decisions', w.world.business)).toBe(0);
    expect(await count('review_decisions', w.beta)).toBe(betaDecisions);

    // Inside her client, dee decides; the decision reads back to her and not to beta.
    expect(codeOf(await w.decide(w.dee, onB))).toBe('not-a-refusal');
    const read = await w.read(w.eve, onB.reviewId, w.beta);
    expect(read).toMatchObject({ code: 'NOT_FOUND' });
    expect(JSON.stringify(read)).not.toContain(onB.digest);
  });

  it('C35-X a revision added while the approval waits leaves the approval stale', async () => {
    const opened = openedOf(detailOf(await w.open(w.fay)));
    const adding = held(w.world.business, async (tx) => {
      await openPageReview(tx, {
        taskId: w.taskA,
        pageUrl: PAGE,
        path: ABOUT,
        sourceRevision: `rev-race-${randomUUID().slice(0, 8)}`,
        writer: { actorId: w.fay.actorId, personId: w.fay.personId, delegationId: null },
      });
    });
    const { waited, answer } = await decidedBehind(
      adding,
      async () => await w.decide(w.ben, opened),
    );
    // The review's covered lock (`lockCoveredReview`): its grant CTE first, the text the
    // activity view keeps of a statement longer than 1 KB.
    expect(
      waited.some((query) => /^\s*with recursive effective as/u.test(query)),
      waited.join(' | '),
    ).toBe(true);
    expect(codeOf(answer as never)).toBe('VERSION_STALE');
    const decided = await w.decisions(w.world.business);
    expect(decided.filter((row) => row['review_id'] === opened.reviewId)).toStrictEqual([]);
  });

  it('C35-X single-operator mode ended while the self-approval waits refuses it', async () => {
    expect(codeOf(await w.setMode(w.beta, w.eve, true))).toBe('not-a-refusal');
    const opened: Opened = openedOf(detailOf(await w.open(w.eve, { taskId: w.betaTask }, w.beta)));
    expect(codeOf(await w.astra(w.eve, opened, 'approve', w.beta))).toBe('not-a-refusal');
    const before = await count('review_decisions', w.beta);
    // A second operator's membership, as its trigger writes it: the mode's row, then off.
    const ending = held(w.beta, async (tx) => {
      await tx.query(
        `select value from public.business_settings
          where business_id = $1 and key = 'single_operator_mode' for update`,
        [w.beta],
      );
      await tx.query(
        `update public.business_settings set value = 'false'::jsonb, revision = revision + 1,
                updated_at = now()
          where business_id = $1 and key = 'single_operator_mode'`,
        [w.beta],
      );
    });
    const { waited, answer } = await decidedBehind(
      ending,
      async () => await w.decide(w.eve, opened, w.beta),
    );
    expect(
      waited.some((query) => /from public\.business_settings[\s\S]*for share/u.test(query)),
      waited.join(' | '),
    ).toBe(true);
    expect(codeOf(answer as never)).toBe('SELF_APPROVAL_REFUSED');
    expect(await count('review_decisions', w.beta)).toBe(before);
  });
});
