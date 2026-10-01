// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-07b, the delivery worker: what makes mail go out. A pass at once calls
// `emailAtOnce` for every due decision and incident (and any item its person
// chose instant for); the daily tick calls `emailDailyBatch` for every person
// with an item waiting. It runs as system work under the business's worker
// (an active worker actor, AW-01 J), never a person's grant. Each item is sent
// once, each person batched at most once a day, the ceiling and every client's
// week hold, and a second worker under the same worker sends nothing twice:
// the records, not the worker, are what refuse a second send.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { checkItem, recordAsked } from '../../packages/core-custody/src/broker-email.ts';
import { deliverDue, type DeliveryPass } from '../../packages/core-custody/src/index.ts';
import { EMAIL_SEND } from '../../packages/core-connectors/src/index.ts';
import { raiseInboxItem, type InboxReason } from '../../packages/core-records/src/index.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import { attemptsOf, itemFor, noDatabase, useEmailWorld, w } from './email-world.ts';
import {
  aged,
  choices,
  commentBy,
  extra,
  freshInbox,
  timing,
  useTimingWorld,
} from './email-timing-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useEmailWorld();
useTimingWorld();

/** A worker actor of a business, active unless asked otherwise. */
async function workerOf(business: string, active = true): Promise<string> {
  const id = randomUUID();
  await w.db.app.withBusiness(business, async (tx) => {
    await tx.query(
      `insert into public.actors (business_id, id, kind, person_id, active, deactivated_at)
       values ($1, $2, 'worker', null, $3, $4)`,
      [tx.businessId, id, active, active ? null : new Date()],
    );
  });
  return id;
}

let worker = '';
const pass = async (
  kind: 'at_once' | 'daily',
  database: Database = w.db.app,
  actor: string = worker,
  business: string = w.alpha,
): Promise<DeliveryPass> => await deliverDue(database, business, actor, timing(), kind);

/** An item for one of the first business's people, on a task they read. */
async function itemOf(person: string, task: string, reason: InboxReason): Promise<string> {
  return await w.db.app.withBusiness(
    w.alpha,
    async (tx) =>
      await raiseInboxItem(tx, {
        recipientPersonId: person,
        subjectRecordId: task,
        reason,
        fact: { kind: 'record', id: randomUUID() },
      }),
  );
}

/** A client comment an agent wrote, owed to one of the client's people: relationship mail. */
async function agentComment(person: string): Promise<string> {
  const comment = await commentBy(w.task, 'agent');
  return await w.db.app.withBusiness(
    w.alpha,
    async (tx) =>
      await raiseInboxItem(tx, {
        recipientPersonId: person,
        subjectRecordId: w.task,
        reason: 'client_comment',
        fact: { kind: 'record', id: comment },
      }),
  );
}

const states = async (item: string) => (await attemptsOf(item)).map((row) => row.state);

it('AW-07b delivery worker: it sends once per due item, at once for decisions and incidents', async () => {
  await freshInbox();
  worker = await workerOf(w.alpha);
  const due = [
    await itemFor(w.task, 'decision'),
    await itemFor(w.task, 'decision'),
    await itemFor(w.task, 'incident'),
  ];
  const batched = await itemFor(w.task, 'mention');
  const bravo = await itemFor(w.bravoTask, 'decision', { id: w.bravo, person: w.bravoPerson });
  const before = w.provider.outbox.length;
  expect(await pass('at_once')).toEqual({ ok: true, emails: 3 });
  expect(w.provider.outbox.length).toBe(before + 3);
  for (const item of due) {
    // oxlint-disable-next-line no-await-in-loop
    expect(await states(item)).toEqual(['asked', 'accepted']);
  }
  // Anything else waits for the daily tick; another business's item is not this pass's.
  expect(await attemptsOf(batched)).toEqual([]);
  expect(await attemptsOf(bravo)).toEqual([]);
  // The next pass finds nothing due: each item went once.
  expect(await pass('at_once')).toEqual({ ok: true, emails: 0 });
  expect(w.provider.outbox.length).toBe(before + 3);
  // A category its person chose instant for goes at once too.
  choices.set(`${w.person}/mention`, 'instant');
  expect(await pass('at_once')).toEqual({ ok: true, emails: 1 });
  expect(await states(batched)).toEqual(['asked', 'accepted']);
});

it('AW-07b delivery worker: one batch per person a day on the daily tick', async () => {
  await freshInbox();
  worker = await workerOf(w.alpha);
  const mine = [await itemFor(w.task, 'mention'), await itemFor(w.task, 'assignment')];
  const theirs = await itemOf(extra.clientA2, w.task, 'mention');
  const decision = await itemFor(w.task, 'decision');
  const before = w.provider.outbox.length;
  expect(await pass('daily')).toEqual({ ok: true, emails: 2 });
  expect(w.provider.outbox.length).toBe(before + 2);
  for (const item of [...mine, theirs]) {
    // oxlint-disable-next-line no-await-in-loop
    expect(await states(item)).toEqual(['asked', 'accepted']);
  }
  // The daily tick never batches a decision: that is the pass at once.
  expect(await attemptsOf(decision)).toEqual([]);
  // The same day, a new item waits, however often the tick runs.
  const later = await itemFor(w.task, 'mention');
  expect(await pass('daily')).toEqual({ ok: true, emails: 0 });
  expect(await attemptsOf(later)).toEqual([]);
  await aged('25 hours');
  expect(await pass('daily')).toEqual({ ok: true, emails: 1 });
  expect(await states(later)).toEqual(['asked', 'accepted']);
  expect(w.provider.outbox.length).toBe(before + 3);
});

it("AW-07b delivery worker: it respects the ceiling and every client's week", async () => {
  await freshInbox();
  worker = await workerOf(w.alpha);
  // Live sends fill email.send's ceiling: the pass leaves the decision for a later one.
  for (let n = 0; n < EMAIL_SEND.concurrency; n += 1) {
    // oxlint-disable-next-line no-await-in-loop
    const live = await itemFor(w.task, 'incident');
    // oxlint-disable-next-line no-await-in-loop
    await w.db.app.withBusiness(w.alpha, async (tx) => {
      const item = await checkItem(tx, live);
      if (typeof item === 'string') throw new Error(`refused: ${item}`);
      await recordAsked(tx, [item], false);
    });
  }
  const decision = await itemFor(w.task, 'decision');
  expect(await pass('at_once')).toEqual({ ok: true, emails: 0 });
  expect(await attemptsOf(decision)).toEqual([]);
  // Once those calls are long over, the next pass sends it.
  await aged('2 minutes');
  expect(await pass('at_once')).toEqual({ ok: true, emails: 1 });
  expect(await states(decision)).toEqual(['asked', 'accepted']);
  // Two of one client's people, each owed an agent's comment: one relationship email a week.
  const first = await agentComment(w.person);
  const second = await agentComment(extra.clientA2);
  expect(await pass('daily')).toEqual({ ok: true, emails: 1 });
  const told = [await attemptsOf(first), await attemptsOf(second)];
  expect(told.filter((rows) => rows.length > 0)).toHaveLength(1);
  // The held one stands, untouched, and waits out the client's week.
  await aged('25 hours');
  expect(await pass('daily')).toEqual({ ok: true, emails: 0 });
  await aged('7 days');
  expect(await pass('daily')).toEqual({ ok: true, emails: 1 });
  expect((await attemptsOf(first)).length > 0 && (await attemptsOf(second)).length > 0).toBe(true);
});

it('AW-07b delivery worker: a second worker under the same worker sends nothing twice', async () => {
  await freshInbox();
  worker = await workerOf(w.alpha);
  const due = [
    await itemFor(w.task, 'decision'),
    await itemFor(w.task, 'incident'),
    await itemFor(w.task, 'decision'),
  ];
  const batched = [
    await itemFor(w.task, 'mention'),
    await itemOf(extra.clientA2, w.task, 'mention'),
  ];
  const before = w.provider.outbox.length;
  // Two processes' connections, the same worker, at the same time.
  const second = connect(w.db.appUrl, { source: 'runtime' });
  try {
    const atOnce = await Promise.all([pass('at_once'), pass('at_once', second)]);
    const daily = await Promise.all([pass('daily'), pass('daily', second)]);
    const emails = [...atOnce, ...daily].reduce(
      (sum, one) => sum + (one.ok ? one.emails : Number.NaN),
      0,
    );
    expect(emails).toBe(5);
  } finally {
    await second.close();
  }
  expect(w.provider.outbox.length).toBe(before + 5);
  for (const item of [...due, ...batched]) {
    // oxlint-disable-next-line no-await-in-loop
    expect(await states(item)).toEqual(['asked', 'accepted']);
  }
});

it('AW-07b delivery worker: only an active worker of the business sends, never a person', async () => {
  await freshInbox();
  const decision = await itemFor(w.task, 'decision');
  const [personActor] = await w.db.admin.execute<{ id: string }>(
    `select id from public.actors where person_id = $1 and kind = 'person'`,
    [w.person],
  );
  const before = w.provider.outbox.length;
  for (const actor of [
    personActor?.id ?? '',
    await workerOf(w.alpha, false),
    await workerOf(w.bravo),
    randomUUID(),
    'not-an-id',
  ]) {
    // oxlint-disable-next-line no-await-in-loop
    expect(await pass('at_once', w.db.app, actor)).toEqual({ ok: false, code: 'WORKER_REQUIRED' });
    // oxlint-disable-next-line no-await-in-loop
    expect(await pass('daily', w.db.app, actor)).toEqual({ ok: false, code: 'WORKER_REQUIRED' });
  }
  expect(w.provider.outbox.length).toBe(before);
  expect(await attemptsOf(decision)).toEqual([]);
});
