// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-07b, when to send: a decision or an incident emails at once, one email
// per item; every other waiting item joins at most one email a day per
// person; the person's choice per channel silences email and never removes
// an item; a refusal is recorded and the item stands. Each case is named
// after its supporting checklist line, against a migrated database, custody's
// real process and the fake provider on loopback.

import { expect, it as vitestIt } from 'vitest';
import { emailAtOnce, emailDailyBatch } from '../../packages/core-custody/src/index.ts';
import { attemptsOf, itemFor, MAIL, masked, noDatabase, useEmailWorld, w } from './email-world.ts';
import {
  aged,
  choices,
  freshInbox,
  seenCount,
  timing,
  useTimingWorld,
} from './email-timing-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useEmailWorld();
useTimingWorld();

const batch = async (person: string = w.person) =>
  await emailDailyBatch(w.db.app, w.alpha, person, timing());
const atOnce = async (item: string) => await emailAtOnce(w.db.app, w.alpha, item, timing());
const lastLink = (): string => {
  const text = String(
    (JSON.parse(w.provider.outbox.at(-1)?.body ?? '{}') as { text?: string }).text,
  );
  return masked(/https?:\/\/\S+/u.exec(text)?.[0] ?? '');
};

it('AW-07b daily batch: several waiting items other than decisions and incidents make one email a day', async () => {
  await freshInbox();
  const items = [
    await itemFor(w.task, 'mention'),
    await itemFor(w.task, 'assignment'),
    await itemFor(w.task, 'waiting_run'),
  ];
  const decision = await itemFor(w.task, 'decision');
  const before = w.provider.outbox.length;
  expect(await batch()).toMatchObject({ ok: true, items: 3 });
  expect(w.provider.outbox.length).toBe(before + 1);
  // Several items: the email names the inbox, never one of them.
  expect(lastLink()).toBe(`${MAIL.appOrigin}/inbox`);
  for (const item of items) {
    // oxlint-disable-next-line no-await-in-loop
    expect((await attemptsOf(item)).map((row) => row.state)).toEqual(['asked', 'accepted']);
  }
  // The decision is not batched: it goes at once, on its own.
  expect(await attemptsOf(decision)).toEqual([]);
  // A new item the same day waits for tomorrow's email.
  const later = await itemFor(w.task, 'mention');
  expect(await batch()).toEqual({ ok: false, code: 'BATCH_ALREADY_SENT' });
  expect(w.provider.outbox.length).toBe(before + 1);
  expect(await attemptsOf(later)).toEqual([]);
  await aged('25 hours');
  expect(await batch()).toMatchObject({ ok: true, items: 1 });
  expect(w.provider.outbox.length).toBe(before + 2);
});

it('AW-07b daily batch: a single comment makes one email', async () => {
  await freshInbox();
  const item = await itemFor(w.task, 'mention');
  const before = w.provider.outbox.length;
  expect(await batch()).toMatchObject({ ok: true, items: 1 });
  expect(w.provider.outbox.length).toBe(before + 1);
  expect(lastLink()).toBe(`[link]/${item}`);
});

it('AW-07b at once: a decision or an incident emails at once, one email per item', async () => {
  await freshInbox();
  const decision = await itemFor(w.task, 'decision');
  const incident = await itemFor(w.task, 'incident');
  const before = w.provider.outbox.length;
  expect(await atOnce(decision)).toMatchObject({ ok: true, state: 'accepted' });
  expect(lastLink()).toBe(`[link]/${decision}`);
  expect(await atOnce(incident)).toMatchObject({ ok: true, state: 'accepted' });
  expect(lastLink()).toBe(`[link]/${incident}`);
  expect(w.provider.outbox.length).toBe(before + 2);
  // Anything else waits for the daily email and is not sent at once.
  const mention = await itemFor(w.task, 'mention');
  expect(await atOnce(mention)).toEqual({ ok: false, code: 'NOT_AT_ONCE' });
  expect(await attemptsOf(mention)).toEqual([]);
  expect(w.provider.outbox.length).toBe(before + 2);
  // Unless the person chose instant for that category.
  choices.set(`${w.person}/mention`, 'instant');
  expect(await atOnce(mention)).toMatchObject({ ok: true });
  expect(await batch()).toEqual({ ok: false, code: 'NOTHING_WAITING' });
});

it('AW-07b channel settings: a preference silences email and never removes the item; only someone not in the app is emailed', async () => {
  await freshInbox();
  choices.set(`${w.person}/mention`, 'off');
  const off = await itemFor(w.task, 'mention');
  expect(await batch()).toEqual({ ok: false, code: 'NOTHING_WAITING' });
  expect(await attemptsOf(off)).toEqual([]);
  // Nobody silences a decision: off is read and does not apply to it.
  choices.set(`${w.person}/decision`, 'off');
  const decision = await itemFor(w.task, 'decision');
  expect(await atOnce(decision)).toMatchObject({ ok: true });
  // Someone who has seen the item in the app is not emailed about it.
  const seen = await itemFor(w.task, 'assignment');
  await w.db.admin.execute(
    'insert into public.inbox_attention (business_id, item_id, person_id) values ($1, $2, $3)',
    [w.alpha, seen, w.person],
  );
  expect(await batch()).toEqual({ ok: false, code: 'NOTHING_WAITING' });
  expect(await attemptsOf(seen)).toEqual([]);
  // Every item still stands, and sending set nobody's seen.
  const open = await w.db.admin.execute<{ work_state: string }>(
    'select work_state from public.inbox_items where id = any($1::uuid[])',
    [[off, decision, seen]],
  );
  expect(open.map((row) => row.work_state)).toEqual(['open', 'open', 'open']);
  expect(await seenCount([off, decision])).toBe(0);
});

it('AW-07b recovery: a provider refusal is recorded and the item stands; accepted is not delivered or seen', async () => {
  await freshInbox();
  const item = await itemFor(w.task, 'mention');
  w.provider.mode('refuse');
  expect(await batch()).toMatchObject({ ok: false, code: 'EMAIL_FAILED' });
  const refused = await attemptsOf(item);
  expect(refused.map((row) => row.state)).toEqual(['asked', 'failed']);
  const [row] = await w.db.admin.execute<{ work_state: string }>(
    'select work_state from public.inbox_items where id = $1',
    [item],
  );
  expect(row?.work_state).toBe('open');
  // A refusal that proves nothing went does not spend the day: the next batch sends.
  w.provider.mode('accept');
  expect(await batch()).toMatchObject({ ok: true, items: 1 });
  const states = (await attemptsOf(item)).map((attempt) => attempt.state);
  expect(states).toEqual(['asked', 'failed', 'asked', 'accepted']);
  expect(states).not.toContain('delivered');
  expect(await seenCount([item])).toBe(0);
});
