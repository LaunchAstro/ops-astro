// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-07b, told by email through the broker: the ticket's invariant
// `email_carries_an_address_and_never_a_decision`, the egress case (a send
// outside the broker is refused) and the send's data separation, each against
// a migrated database, custody's real process and the fake provider on
// loopback. No case reaches a real network.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it as vitestIt } from 'vitest';
import {
  catalogue,
  EMAIL_SEND,
  EMAIL_SUBJECT,
  REPLAY_COMPOSE,
} from '../../packages/core-connectors/src/index.ts';
import { sendInboxEmail } from '../../packages/core-custody/src/index.ts';
import { attemptsOf, itemFor, MAIL, noDatabase, useEmailWorld, w } from './email-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;
const ROOT = resolve(import.meta.dirname, '../..');
/** A module that can open a connection: a network import, a global fetch, or a mail or HTTP client. */
const OPENS = String.raw`from 'node:(https?|net|tls|dgram|http2)'|(^|[^.\w])fetch\(|undici|nodemailer|axios`;

useEmailWorld();

const send = async (item: string, business: string = w.alpha, broker = w.broker) =>
  await sendInboxEmail(w.db.app, business, item, broker, MAIL);

/** Every address-like thing in a text: a scheme, `www.` or a bare host with a path. */
const linksIn = (text: string): readonly string[] =>
  [...text.matchAll(/(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+/giu)].map((match) => match[0]);

it('email_carries_an_address_and_never_a_decision', async () => {
  w.provider.mode('accept');
  const item = await itemFor(w.task, 'decision');
  const [fact] = await w.db.admin.execute<{ fact_id: string }>(
    'select fact_id from public.inbox_items where id = $1',
    [item],
  );
  const result = await send(item);
  expect(result).toMatchObject({ ok: true, state: 'accepted' });
  const sent = w.provider.outbox.at(-1);
  expect(sent?.authorization).toBe(`Bearer ${w.key}`);
  const message = JSON.parse(sent?.body ?? '{}') as Record<string, unknown>;
  // The whole message: who, from whom, fixed words and one address. No html,
  // no headers, no tags, no reply or unsubscribe action a scanner could post.
  expect(Object.keys(message).toSorted()).toEqual(['from', 'subject', 'text', 'to']);
  expect(message['to']).toEqual([w.canary]);
  expect(message['subject']).toBe(EMAIL_SUBJECT);
  const text = String(message['text']);
  expect(linksIn(text)).toEqual([`${MAIL.appOrigin}/inbox/${item}`]);
  // Nothing that decides or names what is decided: no decision word, no gate,
  // no task, no token or query on the address.
  expect(`${text} ${EMAIL_SUBJECT}`).not.toMatch(
    /approv|declin|reject|accept|confirm|decid|decision|vote|sign[- ]?off|token|\?/iu,
  );
  expect(text).not.toContain(fact?.fact_id);
  expect(text).not.toContain(w.task);

  // No inbound path writes a decision: an answer that plants one is malformed,
  // the attempt fails and the item, its attention and every gate stay as they were.
  w.provider.mode('malformed');
  const planted = await itemFor(w.task, 'decision');
  expect(await send(planted)).toMatchObject({
    ok: false,
    code: 'EMAIL_FAILED',
    fault: 'malformed',
  });
  const after = await w.db.admin.execute<{ work_state: string; seen: string; decisions: string }>(
    `select i.work_state,
            (select count(*) from public.inbox_attention a where a.item_id = i.id)::text as seen,
            (select count(*) from public.gate_decisions)::text as decisions
       from public.inbox_items i where i.id = any($1::uuid[]) order by i.raised_at`,
    [[item, planted]],
  );
  expect(after).toEqual([
    { work_state: 'open', seen: '0', decisions: '0' },
    { work_state: 'open', seen: '0', decisions: '0' },
  ]);
  const accepted = await attemptsOf(item);
  expect(accepted.map((row) => row.state)).toEqual(['asked', 'accepted']);
  expect(accepted[1]?.evidence).toBe(`provider:${sent?.id ?? ''}`);
  expect(await attemptsOf(planted)).toEqual([
    { state: 'asked', evidence: null },
    { state: 'failed', evidence: 'malformed' },
  ]);
});

it('AW-07b egress: a send outside the broker is refused', async () => {
  w.provider.mode('accept');
  const before = w.provider.received.length;
  const item = await itemFor(w.task, 'mention');
  // A broker whose catalogue does not hold `email.send` sends nothing and writes nothing.
  const uncatalogued = { ...w.broker, operations: catalogue([REPLAY_COMPOSE]) };
  expect(await send(item, w.alpha, uncatalogued)).toEqual({
    ok: false,
    code: 'OPERATION_NOT_CATALOGUED',
  });
  expect(await attemptsOf(item)).toEqual([]);
  // The mail credential reaches its own destination only.
  const request = {
    path: '/emails',
    method: 'POST' as const,
    body: '{}',
    timeoutMs: EMAIL_SEND.timeoutMs,
    maxResponseBytes: EMAIL_SEND.maxResponseBytes,
  };
  for (const destination of ['replay', 'elsewhere']) {
    // oxlint-disable-next-line no-await-in-loop
    const outcome = await w.custody.dispatch('email_key', { destination, ...request });
    expect(outcome).toEqual({
      kind: 'refused',
      started: false,
      code: 'CUSTODY_CREDENTIAL_UNKNOWN',
    });
  }
  expect(w.provider.received.length).toBe(before);

  // The egress proof: no server-side product module opens a connection but
  // custody's egress. The loopback stand-ins only listen; the sign-in key set
  // and the command line's own client reach the product's own services.
  const listed = execFileSync(
    'git',
    [
      'grep',
      '--untracked',
      '-lE',
      OPENS,
      '--',
      'packages',
      'apps/api',
      'apps/worker',
      'apps/cli',
      'apps/forwarder',
    ],
    { cwd: ROOT, encoding: 'utf8' },
  )
    .trim()
    .split('\n')
    .filter((file) => !file.startsWith('packages/') || /^packages\/[^/]+\/src\//u.test(file))
    .toSorted();
  expect(listed).toEqual([
    'apps/api/auth/jwks.ts',
    'apps/cli/client.ts',
    'packages/core-connectors/src/email-fake.ts',
    'packages/core-connectors/src/replay.ts',
    'packages/core-custody/src/egress.ts',
  ]);
  for (const stand of ['email-fake.ts', 'replay.ts']) {
    const source = readFileSync(resolve(ROOT, 'packages/core-connectors/src', stand), 'utf8');
    expect(source).not.toMatch(/\brequest as|\bhttp\.request|\bget as|(^|[^.\w])fetch\(/u);
  }
  for (const client of ['apps/api/auth/jwks.ts', 'apps/cli/client.ts']) {
    expect(readFileSync(resolve(ROOT, client), 'utf8')).not.toMatch(/resend|\/emails|smtp/iu);
  }
});

it('AW-07b isolation (send): another client, another business and another person are never mailed', async () => {
  w.provider.mode('accept');
  const before = w.provider.received.length;
  // The same business, a client the recipient holds no read on: withheld, nothing written.
  const otherClient = await itemFor(w.otherTask, 'decision');
  expect(await send(otherClient)).toEqual({ ok: false, code: 'ITEM_WITHHELD' });
  expect(await attemptsOf(otherClient)).toEqual([]);
  // Another business's item, named from this one: not found, nothing written.
  const bravoItem = await itemFor(w.bravoTask, 'mention', { id: w.bravo, person: w.bravoPerson });
  expect(await send(bravoItem, w.alpha)).toEqual({ ok: false, code: 'ITEM_NOT_OPEN' });
  expect(await attemptsOf(bravoItem)).toEqual([]);
  expect(w.provider.received.length).toBe(before);
  // In its own business it goes to its own recipient's address only.
  expect(await send(bravoItem, w.bravo)).toMatchObject({ ok: true });
  const message = JSON.parse(w.provider.outbox.at(-1)?.body ?? '{}') as { to: string[] };
  expect(message.to).toEqual([`bravo-${w.canary}`]);
});
