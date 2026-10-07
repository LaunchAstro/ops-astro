// SPDX-License-Identifier: AGPL-3.0-only
//
// The drawer's allowance line (`conversation.allowance`) reads the planning
// cap, what is left of it across the business and the caller's own
// conversation's spent and held as one view of the database. Each case holds
// the read open on its own connection, after the statement that reads the cap
// or the conversation's spend, while another connection commits a planning
// hold or a settlement; the answer is then the view from before that commit or
// the view from after it, never the cap from one and the spend from the other.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { executeRead } from '../../packages/core-commands/src/index.ts';
import {
  callModelForPlanning,
  type Broker,
  type ModelCallResult,
} from '../../packages/core-custody/src/index.ts';
import type { Database } from '../../packages/core-records/src/index.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { grantTo } from '../commands/fixture.ts';
import { asPerson, seedSchedules, type Schedules } from '../runtime/schedules-harness.ts';
import { noDatabase, s, useBrokerWorld, world } from './broker-world.ts';
import { ask, local, ownerOf, setCap } from './aw-04-planning-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('allowsnap');

const noop = (): void => undefined;

/** A fresh business whose owner holds the drawer's `conversation:write`. */
async function team(part: string): Promise<Schedules> {
  const on = await seedSchedules(s.db, part, 1_000_000);
  await on.db.app.withBusiness(on.business, async (tx) => {
    await grantTo(tx, on.decider, 'write', undefined, false, 'conversation');
  });
  return on;
}

/** A conversation `on`'s owner starts in the drawer: its id. */
async function started(on: Schedules): Promise<string> {
  const answer = await asPerson(on, {
    command: 'conversation.start',
    operationId: randomUUID(),
    body: 'plan the supplier follow-up',
  });
  const id = 'detail' in answer ? answer.detail?.['conversationId'] : undefined;
  if (typeof id !== 'string') throw new Error(`no conversation: ${JSON.stringify(answer)}`);
  return id;
}

/**
 * A connection of the read's own (the app pool is one connection), its
 * transaction held open once a statement matching `at` has answered; `paused`
 * settles when it is held, `resume` lets it go on.
 */
function pausedAfter(
  on: Schedules,
  at: RegExp,
): {
  readonly database: Database;
  readonly paused: Promise<void>;
  readonly resume: () => void;
} {
  const reader = connect(on.db.appUrl, { source: 'runtime', log: on.db.log });
  let held = noop;
  let resume = noop;
  const paused = new Promise<void>((resolve) => {
    held = resolve;
  });
  const resumed = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let passed = false;
  const database: Database = {
    ...reader,
    withBusiness: async (businessId, run) =>
      await reader.withBusiness(
        businessId,
        async (tx) =>
          await run({
            ...tx,
            async query<Row>(text: string, parameters?: readonly unknown[]) {
              const rows = await tx.query<Row>(text, parameters);
              if (!passed && at.test(text)) {
                passed = true;
                held();
                await resumed;
              }
              return rows;
            },
          }),
      ),
  };
  return { database, paused, resume: () => resume() };
}

/** A planning reply whose hold has committed, waiting in custody until `open`. */
async function heldInCustody(
  on: Schedules,
  conversationId: string,
): Promise<{ readonly reply: Promise<ModelCallResult>; readonly open: () => void }> {
  let entered = noop;
  let open = noop;
  const dispatching = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const base = local(on);
  const gated: Broker = {
    ...base,
    custody: {
      ...base.custody,
      dispatch: async (credentialRef, request) => {
        entered();
        await gate;
        return await base.custody.dispatch(credentialRef, request);
      },
    },
  };
  const reply = callModelForPlanning(
    on.db.app,
    on.business,
    ownerOf(on),
    ask(on, conversationId),
    gated,
  );
  // Custody is only reached once the hold's own transaction has committed.
  await Promise.race([dispatching, reply]);
  return { reply, open: () => open() };
}

const allowanceOf = async (
  on: Schedules,
  database: Database,
  conversationId: string,
): Promise<unknown> =>
  await executeRead(database, on.business, on.decider.presented, {
    read: 'conversation.allowance',
    conversationId,
  });

it('the allowance read held after its cap lookup while the first planning hold commits answers before the hold or after it, never the whole default beside the hold', async () => {
  const on = await team('allowsnap-first');
  const mine = await started(on);
  const other = await started(on);
  world.provider.mode('answer');
  const read = pausedAfter(on, /budget_caps/u);
  const reading = allowanceOf(on, read.database, mine);
  const replies: { reply: Promise<ModelCallResult>; open: () => void }[] = [];
  try {
    await read.paused;
    // The business's first hold, then a second from its other conversation.
    replies.push(await heldInCustody(on, mine), await heldInCustody(on, other));
    read.resume();
    const answer = await reading;
    const before = {
      set: false,
      currency: 'AUD',
      limitMinor: 5_000,
      leftMinor: 5_000,
      conversation: { spentMinor: 0, heldMinor: 0 },
    };
    const after = {
      set: true,
      currency: 'AUD',
      limitMinor: 5_000,
      leftMinor: 5_000 - 500 - 500,
      conversation: { spentMinor: 0, heldMinor: 500 },
    };
    expect(
      [
        { ok: true, allowance: before },
        { ok: true, allowance: after },
      ],
      `one view of the allowance, before the hold or after it: ${JSON.stringify(answer)}`,
    ).toContainEqual(answer);
  } finally {
    read.resume();
    for (const held of replies) held.open();
    await Promise.allSettled([reading, ...replies.map((held) => held.reply)]);
    await read.database.close();
  }
}, 120_000);

it('the allowance read held after its conversation spend while that conversation settles answers before the settlement or after it, never the held amount beside the settled total', async () => {
  const on = await team('allowsnap-settle');
  await setCap(on, 2_000);
  const mine = await started(on);
  const other = await started(on);
  world.provider.mode('answer');
  const replies = [await heldInCustody(on, mine), await heldInCustody(on, other)];
  const [own, elsewhere] = replies;
  if (own === undefined || elsewhere === undefined) throw new Error('no planning holds');
  const read = pausedAfter(on, /planning_envelopes/u);
  const reading = allowanceOf(on, read.database, mine);
  try {
    await read.paused;
    own.open();
    const settled = await own.reply;
    if (!settled.ok) throw new Error(`the reply did not settle: ${JSON.stringify(settled)}`);
    const actual = settled.actualMinor;
    // Settled below its hold, so the two views differ in what is left.
    expect(actual).toBeLessThan(500);
    read.resume();
    const answer = await reading;
    const before = {
      set: true,
      currency: 'AUD',
      limitMinor: 2_000,
      leftMinor: 2_000 - 500 - 500,
      conversation: { spentMinor: 0, heldMinor: 500 },
    };
    const after = {
      set: true,
      currency: 'AUD',
      limitMinor: 2_000,
      leftMinor: 2_000 - actual - 500,
      conversation: { spentMinor: actual, heldMinor: 0 },
    };
    expect(
      [
        { ok: true, allowance: before },
        { ok: true, allowance: after },
      ],
      `one view of the allowance, before the settlement or after it: ${JSON.stringify(answer)}`,
    ).toContainEqual(answer);
  } finally {
    read.resume();
    for (const held of replies) held.open();
    await Promise.allSettled([reading, ...replies.map((held) => held.reply)]);
    await read.database.close();
  }
}, 120_000);
