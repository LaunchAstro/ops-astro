// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-07b hostile provider and AW-07b canary: the email send against each
// hostile answer the fake provider gives (standing gate 9's adapter rules),
// and a planted recipient address and item link that must reach the provider
// and nowhere else. Custody's real process, the fake on loopback, no network.

import { expect, it as vitestIt, vi } from 'vitest';
import type { FakeEmailMode } from '../../packages/core-connectors/src/index.ts';
import { emailAdapter } from '../../packages/core-connectors/src/index.ts';
import { sendInboxEmail } from '../../packages/core-custody/src/index.ts';
import { attemptsOf, itemFor, MAIL, noDatabase, useEmailWorld, w } from './email-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useEmailWorld();

const send = async (item: string, broker = w.broker) =>
  await sendInboxEmail(w.db.app, w.alpha, item, broker, MAIL);

const HOSTILE: readonly (readonly [FakeEmailMode, string])[] = [
  ['oversized', 'too_large'],
  ['redirect', 'redirect'],
  ['malformed', 'malformed'],
  ['slow', 'timeout'],
];

it('AW-07b hostile provider: oversized, redirected, malformed and slow answers are a failed attempt, nothing kept', async () => {
  for (const [mode, fault] of HOSTILE) {
    w.provider.mode(mode);
    // oxlint-disable-next-line no-await-in-loop
    const item = await itemFor(w.task, 'mention');
    const started = Date.now();
    // oxlint-disable-next-line no-await-in-loop
    const result = await send(item);
    expect(Date.now() - started, mode).toBeLessThan(5_000);
    expect(result, mode).toMatchObject({ ok: false, code: 'EMAIL_FAILED', fault });
    // The kind of fault is all that is kept: no answer body, id or planted field.
    // oxlint-disable-next-line no-await-in-loop
    expect(await attemptsOf(item), mode).toEqual([
      { state: 'asked', evidence: null },
      { state: 'failed', evidence: fault },
    ]);
    // oxlint-disable-next-line no-await-in-loop
    const [row] = await w.db.admin.execute<{ work_state: string }>(
      'select work_state from public.inbox_items where id = $1',
      [item],
    );
    expect(row?.work_state, mode).toBe('open');
  }
  expect(w.provider.outbox).toEqual([]);

  // A slow answer may have sent: no second send without positive proof.
  const slow = await itemFor(w.task, 'incident');
  w.provider.mode('slow');
  await send(slow);
  const received = w.provider.received.length;
  w.provider.mode('accept');
  expect(await send(slow)).toEqual({ ok: false, code: 'EMAIL_MAY_HAVE_GONE' });
  expect(w.provider.received.length).toBe(received);
  // A redirect proves the provider took nothing: the next send may go.
  const redirected = await itemFor(w.task, 'incident');
  w.provider.mode('redirect');
  await send(redirected);
  w.provider.mode('accept');
  expect(await send(redirected)).toMatchObject({ ok: true, state: 'accepted' });
});

// eslint-disable-next-line max-lines-per-function -- one capture around every path the canary could leak by
it('AW-07b canary: a planted recipient address and item link never reach logs, errors or traces', async () => {
  const written: string[] = [];
  const capture = (chunk: unknown): boolean => {
    written.push(String(chunk));
    return true;
  };
  const spies = [
    vi.spyOn(process.stdout, 'write').mockImplementation(capture),
    vi.spyOn(process.stderr, 'write').mockImplementation(capture),
    ...(['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        written.push(args.map(String).join(' '));
      }),
    ),
  ];
  const results: unknown[] = [];
  const items: string[] = [];
  try {
    for (const mode of [
      'accept',
      'oversized',
      'redirect',
      'malformed',
      'slow',
      'refuse',
    ] as const) {
      w.provider.mode(mode);
      // oxlint-disable-next-line no-await-in-loop
      const item = await itemFor(w.task, 'decision');
      items.push(item);
      // oxlint-disable-next-line no-await-in-loop
      results.push(await send(item));
    }
    // A send custody refuses, and a resend refused after an unknown outcome.
    const unrouted = { ...w.broker, routes: [{ ...w.broker.routes[0]!, credentialRef: 'none' }] };
    const refused = await itemFor(w.task, 'decision');
    items.push(refused);
    results.push(await send(refused, unrouted), await send(items[4] ?? ''));
    // The adapter's own error names no value.
    try {
      emailAdapter({ to: w.canary, address: `${MAIL.appOrigin}/inbox/${refused}` });
    } catch (error) {
      results.push(String(error), (error as Error).stack);
    }
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  // The positive control: the address was planted and reached the provider.
  expect(w.provider.received.some((message) => message.body.includes(w.canary))).toBe(true);
  const stored = await w.db.admin.execute(
    `select (select coalesce(json_agg(d), '[]') from public.inbox_delivery_attempts d)::text as a,
            (select coalesce(json_agg(e), '[]') from public.audit_events e)::text as e`,
  );
  const haystack = [
    ...written,
    w.custody.stderr(),
    JSON.stringify(results),
    JSON.stringify(stored),
  ].join('\n');
  const links = items.map((item) => `${MAIL.appOrigin}/inbox/${item}`);
  // Booleans, so a failure here does not print the canary itself.
  expect(haystack.includes(w.canary), 'the planted address leaked').toBe(false);
  expect(haystack.includes(w.canary.split('@')[0] ?? w.canary), 'its local part leaked').toBe(
    false,
  );
  expect(
    links.some((link) => haystack.includes(link)),
    'an item link leaked',
  ).toBe(false);
  expect(haystack.includes(w.key), 'the mail key leaked').toBe(false);
});
