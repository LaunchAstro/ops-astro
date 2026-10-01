// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-07b hook signature and AW-07b no decision, on the inbound side: the
// provider's delivery and bounce events through the real hook route, over a
// migrated database, custody's real process and the fake provider. The
// signature is made here from the scheme, under a made-up secret.

import { beforeAll, expect, it as vitestIt } from 'vitest';
import { sendInboxEmail } from '../../packages/core-custody/src/index.ts';
import { attemptsOf, itemFor, MAIL, noDatabase, useEmailWorld, w } from './email-world.ts';
import { eventBody, hook, mountHook, post, sentItem, sign } from './email-hook-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useEmailWorld();
beforeAll(() => {
  mountHook();
});

const states = async (item: string): Promise<readonly string[]> =>
  (await attemptsOf(item)).map((row) => row.state);

it('AW-07b hook signature: a signed delivered event moves an accepted attempt; sent alone never shows delivered, an open never sets seen', async () => {
  const { item, messageId } = await sentItem();
  expect(await post(eventBody('email.sent', messageId))).toMatchObject({
    status: 200,
    code: 'UNCHANGED',
  });
  expect(await states(item)).toEqual(['asked', 'accepted']);
  expect(await post(eventBody('email.opened', messageId))).toMatchObject({ code: 'IGNORED' });
  expect(await post(eventBody('email.delivered', messageId))).toMatchObject({
    status: 200,
    code: 'DELIVERED',
  });
  expect(await states(item)).toEqual(['asked', 'accepted', 'delivered']);
  expect(await post(eventBody('email.clicked', messageId))).toMatchObject({ code: 'IGNORED' });
  const [seen] = await w.db.admin.execute<{ n: string }>(
    'select count(*)::text as n from public.inbox_attention where item_id = $1',
    [item],
  );
  expect(seen?.n).toBe('0');
});

it('AW-07b hook signature: a bounce is recorded as failed and the item is never mailed again', async () => {
  const { item, messageId } = await sentItem();
  expect(await post(eventBody('email.bounced', messageId))).toMatchObject({ code: 'BOUNCED' });
  const rows = await attemptsOf(item);
  expect(rows.map((row) => row.state)).toEqual(['asked', 'accepted', 'failed']);
  expect(rows[2]?.evidence).toMatch(/^bounced:msg_/u);
  // A delivered after the bounce moves nothing.
  expect(await post(eventBody('email.delivered', messageId))).toMatchObject({ code: 'UNCHANGED' });
  const received = w.provider.received.length;
  expect(await sendInboxEmail(w.db.app, w.alpha, item, w.broker, MAIL)).toEqual({
    ok: false,
    code: 'EMAIL_MAY_HAVE_GONE',
  });
  expect(w.provider.received.length).toBe(received);
});

it('AW-07b hook signature: a stale or future timestamp and a replayed event id are refused, two at once included', async () => {
  const { item, messageId } = await sentItem();
  const body = eventBody('email.delivered', messageId);
  for (const at of [hook.clock - 301, hook.clock + 301, 0]) {
    // oxlint-disable-next-line no-await-in-loop
    expect(await post(body, sign(body, at)), String(at)).toMatchObject({
      status: 401,
      code: 'HOOK_STALE',
    });
  }
  expect(await states(item)).toEqual(['asked', 'accepted']);
  // Inside the window, the same event twice at once: one lands, one is a replay.
  const signed = sign(body, hook.clock - 299);
  const both = await Promise.all([post(body, signed), post(body, signed)]);
  expect(both.map((answer) => answer.code).toSorted()).toEqual(['DELIVERED', 'REPLAYED']);
  expect(both.find((answer) => answer.code === 'REPLAYED')?.status).toBe(409);
  // And again later, still inside the window, and on a fresh route as another
  // process would serve it: the landed event's id is held in the database.
  expect(await post(body, signed)).toMatchObject({ status: 409, code: 'REPLAYED' });
  mountHook();
  expect(await post(body, signed)).toMatchObject({ status: 409, code: 'REPLAYED' });
  expect(await states(item)).toEqual(['asked', 'accepted', 'delivered']);
});

// eslint-disable-next-line max-lines-per-function -- every way a body or its signature can be bent, one list
it('AW-07b hook signature: a body altered after signing, a wrong secret and odd encodings are refused before parsing', async () => {
  const { item, messageId } = await sentItem();
  const body = eventBody('email.delivered', messageId);
  const bytes = Buffer.from(body, 'utf8');
  const signed = sign(body);
  const flipped = Buffer.from(bytes);
  flipped[10] = (flipped[10] ?? 0) ^ 0x01;
  const otherSecret = `whsec_${Buffer.alloc(24, 7).toString('base64')}`;
  const mac = signed.signature.slice(3);
  const cases: readonly (readonly [string, Uint8Array | string, ReturnType<typeof sign>])[] = [
    ['one bit flipped', flipped, signed],
    ['a byte added', `${body} `, signed],
    ['re-encoded as UTF-16', Buffer.from(body, 'utf16le'), signed],
    ['with a byte-order mark', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]), signed],
    ['signed under another secret', body, sign(body, hook.clock, signed.id, otherSecret)],
    ['signed for another id', body, { ...signed, id: `${signed.id}x` }],
    [
      'base64url signature, unpadded',
      body,
      {
        ...signed,
        signature: `v1,${mac.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')}`,
      },
    ],
    ['percent-encoded signature', body, { ...signed, signature: `v1,${encodeURIComponent(mac)}` }],
    ['v1a scheme', body, { ...signed, signature: `v1a,${mac}` }],
    ['uppercase scheme', body, { ...signed, signature: `V1,${mac}` }],
    // Not JSON at all, under a wrong signature: the signature answers, never the parser.
    ['garbage, badly signed', '\u0000{not json', signed],
  ];
  for (const [name, raw, headers] of cases) {
    // oxlint-disable-next-line no-await-in-loop
    const answer = await post(raw, headers);
    expect(answer.status, name).toBe(401);
    expect(['HOOK_SIGNATURE', 'HOOK_HEADERS'], name).toContain(answer.code);
  }
  // Correctly signed but not a strict UTF-8 JSON event: malformed, after the signature held.
  for (const raw of [
    Buffer.from([0x7b, 0xc0, 0xae, 0x7d]),
    'not json',
    '[]',
    JSON.stringify({ type: 'email.delivered', data: { email_id: '../x' } }),
    JSON.stringify({ type: 'email.delivered' }),
  ]) {
    // oxlint-disable-next-line no-await-in-loop
    expect(await post(raw, sign(raw))).toMatchObject({ status: 400, code: 'HOOK_MALFORMED' });
  }
  expect(await states(item)).toEqual(['asked', 'accepted']);
});

it('AW-07b hook signature: missing, duplicate and malformed headers are refused', async () => {
  const { item, messageId } = await sentItem();
  const body = eventBody('email.delivered', messageId);
  const signed = sign(body);
  const names = ['svix-id', 'svix-timestamp', 'svix-signature'] as const;
  const values = [signed.id, signed.timestamp, signed.signature] as const;
  for (const name of names) {
    const missing = new Headers();
    const twice = new Headers();
    for (const [other, value] of names.map((n, i) => [n, values[i] ?? ''] as const)) {
      if (other !== name) missing.set(other, value);
      twice.append(other, value);
      if (other === name) twice.append(other, value);
    }
    // oxlint-disable-next-line no-await-in-loop
    expect(await post(body, null, missing), `${name} missing`).toMatchObject({
      status: 401,
      code: 'HOOK_HEADERS',
    });
    // oxlint-disable-next-line no-await-in-loop
    expect(await post(body, null, twice), `${name} twice`).toMatchObject({ status: 401 });
  }
  for (const bent of [
    { ...signed, timestamp: `${signed.timestamp}.0` },
    // HTTP trims a value's ends, so the bends are inside it.
    { ...signed, timestamp: `+${signed.timestamp}` },
    { ...signed, id: `${signed.id}\tx` },
    { ...signed, signature: `${signed.signature},` },
    { ...signed, signature: '' },
  ]) {
    // oxlint-disable-next-line no-await-in-loop
    expect(await post(body, bent)).toMatchObject({ status: 401 });
  }
  expect(await states(item)).toEqual(['asked', 'accepted']);
});

it('AW-07b no decision: no inbound hook path writes a decision or moves the item', async () => {
  const decision = await itemFor(w.task, 'decision');
  expect(await sendInboxEmail(w.db.app, w.alpha, decision, w.broker, MAIL)).toMatchObject({
    ok: true,
  });
  const messageId = w.provider.outbox.at(-1)?.id ?? '';
  const planted = { decision: 'approve', gate: decision, action: 'approve', seen: true };
  for (const type of ['gate.decided', 'email.delivered', 'email.opened', 'email.clicked']) {
    // oxlint-disable-next-line no-await-in-loop
    await post(eventBody(type, messageId, planted));
  }
  const [after] = await w.db.admin.execute<{ work: string; seen: string; decisions: string }>(
    `select i.work_state as work,
            (select count(*) from public.inbox_attention a where a.item_id = i.id)::text as seen,
            (select count(*) from public.gate_decisions)::text as decisions
       from public.inbox_items i where i.id = $1`,
    [decision],
  );
  expect(after).toEqual({ work: 'open', seen: '0', decisions: '0' });
  expect(await states(decision)).toEqual(['asked', 'accepted', 'delivered']);
});

it('AW-07b isolation (hook): an event moves only the attempt of the business that sent it', async () => {
  const alpha = await sentItem();
  const bravo = await sentItem({ id: w.bravo, person: w.bravoPerson, task: w.bravoTask });
  expect(await post(eventBody('email.delivered', bravo.messageId))).toMatchObject({
    code: 'DELIVERED',
  });
  expect(await states(bravo.item)).toEqual(['asked', 'accepted', 'delivered']);
  expect(await states(alpha.item)).toEqual(['asked', 'accepted']);
  // A message id no business in the deployment sent: not found, nothing written.
  const before = await w.db.admin.execute('select id from public.inbox_delivery_attempts');
  expect(await post(eventBody('email.delivered', 'no-such-message'))).toMatchObject({
    status: 404,
    code: 'UNKNOWN_MESSAGE',
  });
  expect(await w.db.admin.execute('select id from public.inbox_delivery_attempts')).toHaveLength(
    before.length,
  );
});
