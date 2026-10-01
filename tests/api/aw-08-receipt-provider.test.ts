// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-08 (b) through the real worker and API, the provider injected as T3e1's
// cases inject it:
//
// - `AW-08 receipt link`: the link the provider answers with is captured when
//   the effect is observed and kept only when it is https on the operation's
//   declared host; any other is recorded absent (null) and never a link.
// - `AW-08 hostile provider`: an oversized, redirected or malformed answer
//   moves no money (the whole hold stays held as unknown, nothing spent or
//   released) and marks nothing live (no effect, no observation, no link).
// - `AW-08 canary`: a planted credential and planted provider content reach no
//   row, audit payload, log or refusal body.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it as vitestIt, vi } from 'vitest';
import { RECEIPT_LINK_SHAPE, receiptLinkOf } from '../../packages/core-runtime/src/receipt-link.ts';
import { pathOf } from '../../packages/core-wire/src/surface.ts';
import type { Provider } from '../../apps/worker/usage.ts';
import {
  answering,
  appliedWith,
  attempts,
  HOST,
  launched,
  linking,
  noDatabase,
  r,
  retirePickups,
  useReceiptWorld,
  workerOn,
} from './aw-08-receipt-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useReceiptWorld('aw08rcpt');

it('AW-08 receipt link: an https link on the operation’s declared host is kept on the receipt with its decision, version and settlement', async () => {
  const link = `https://${HOST}/effects/${randomUUID()}`;
  const { taskId, receipt } = await appliedWith(linking(link));
  expect(receipt).toMatchObject({
    link,
    decision: { decidedByPersonId: r.fixture.member.personId },
    // The launched version: the successor the plan's work handed back.
    version: { number: 2 },
    settlement: { state: 'settled' },
  });
  expect(await attempts(taskId)).toMatchObject([{ observed: true, link }]);
});

it.each([
  ['plain http', `http://${HOST}/effects/1`],
  ['another host', 'https://receipts.example.com/effects/1'],
  ['a host that ends in the declared one', `https://evil${HOST}/effects/1`],
  ['the declared host as a prefix', `https://${HOST}.evil.example/effects/1`],
  ['a user before the host', `https://${HOST}@evil.example/effects/1`],
  ['a port', `https://${HOST}:8443/effects/1`],
  ['a query', `https://${HOST}/effects/1?token=t`],
  ['a fragment', `https://${HOST}/effects/1#t`],
  ['upper-case scheme', `HTTPS://${HOST}/effects/1`],
  ['a tab inside', `https://${HOST}/eff\tects/1`],
  ['backslashes', `https:\\\\${HOST}\\effects\\1`],
  ['a script', 'javascript:alert(1)'],
  ['no link', undefined],
  ['a number', 42],
  ['an overlong path', `https://${HOST}/${'a'.repeat(600)}`],
] as const)('AW-08 receipt link: %s is recorded absent and never a link', async (_case, link) => {
  const { taskId, receipt } = await appliedWith(linking(link));
  expect(receipt['link']).toBeNull();
  expect(await attempts(taskId)).toMatchObject([{ observed: true, link: null }]);
});

it('AW-08 receipt link: a link the URL parser keeps but the column refuses is recorded absent and the effect still settles', async () => {
  const { taskId, receipt } = await appliedWith(
    answering(200, '{"link":"https://receipts.stand-in.invalid/a|b"}'),
  );
  expect(receipt).toMatchObject({ link: null, settlement: { state: 'settled' } });
  expect(await attempts(taskId)).toMatchObject([{ state: 'settled', observed: true, link: null }]);
});

vitestIt(
  'AW-08 receipt link: receiptLinkOf refuses what the URL parser keeps and the column refuses',
  () => {
    expect(receiptLinkOf(`https://${HOST}/a|b`, 'synthetic_comment')).toBeNull();
    expect(receiptLinkOf(`https://${HOST}/a[b]`, 'synthetic_comment')).toBeNull();
    // Control: the column's own alphabet is still kept.
    const kept = `https://${HOST}/a-b_c~d%20e!$&'()*+,;=:@/f`;
    expect(receiptLinkOf(kept, 'synthetic_comment')).toBe(kept);
    // The pattern is the column's, character for character.
    const column = RECEIPT_LINK_SHAPE.source.replaceAll('\\/', '/').replaceAll("'", "''");
    const migration = new URL('../../migrations/0214_attempt_receipt_link.sql', import.meta.url);
    expect(readFileSync(migration, 'utf8')).toContain(`receipt_link ~ '${column}')`);
  },
);

it('AW-08 hostile provider: a null provider answer is handed back as a drop', async () => {
  const { taskId, credential } = await launched();
  const sent = vi.spyOn(r.api, 'request');
  try {
    const nothing = { call: async () => await Promise.resolve(null) } as unknown as Provider;
    const outcome = await workerOn(credential, nothing).applyOnce(taskId);
    expect(outcome).toStrictEqual({ dropped: { taskId, cause: 'provider_unavailable' } });
    const drops = sent.mock.calls.filter(
      ([path, init]) =>
        String(path).endsWith(pathOf('task.handback')) &&
        String(init?.body).includes('"outcome":"dropped"'),
    );
    expect(drops).toHaveLength(1);
  } finally {
    sent.mockRestore();
  }
});

it.each([
  [
    'oversized',
    answering(200, JSON.stringify({ link: `https://${HOST}/x`, pad: 'x'.repeat(5_000) })),
  ],
  ['redirected', answering(302, JSON.stringify({ link: `https://${HOST}/x` }))],
  ['malformed', answering(200, '{"link": "https://receipts.stand-in.invalid/x"')],
  ['not an object', answering(200, JSON.stringify([`https://${HOST}/x`]))],
  ['status-less', answering(Number.NaN, JSON.stringify({ link: `https://${HOST}/x` }))],
] as const)(
  'AW-08 hostile provider: a %s answer moves no money and marks nothing live',
  async (_case, provider) => {
    const { taskId, credential } = await launched();
    const outcome = await workerOn(credential, provider).applyOnce(taskId);
    expect(outcome).toStrictEqual({ dropped: { taskId, cause: 'provider_unavailable' } });
    expect(await attempts(taskId)).toMatchObject([
      {
        state: 'liability_unknown',
        observed: false,
        link: null,
        held: 'held',
        held_minor: '2500',
        actual_minor: null,
      },
    ]);
    const effects = await r.fixture.db.admin.execute(
      `select 1 from public.operations where business_id = $1 and record_id = $2
      and command = 'task.comment' and outcome = 'applied'`,
      [r.fixture.business, taskId],
    );
    expect(effects).toHaveLength(0);
  },
);

/** An attempt's receipt link written straight through the app's role: `applied` or the SQLSTATE. */
async function setLink(id: unknown, to: string, observed = ''): Promise<string> {
  try {
    await r.fixture.db.app.withBusiness(r.fixture.business, async (tx) => {
      await tx.query(
        `update public.attempts set receipt_link = $3${observed} where business_id = $1 and id = $2`,
        [r.fixture.business, id, to],
      );
    });
    return 'applied';
  } catch (cause) {
    return String((cause as { code?: unknown }).code);
  }
}

it('AW-08 receipt link: at the database, an observed attempt’s link is fixed and no other shape is stored', async () => {
  const link = `https://${HOST}/effects/${randomUUID()}`;
  const kept = (await attempts((await appliedWith(linking(link))).taskId))[0];
  await retirePickups();
  const none = (await attempts((await appliedWith(linking(null))).taskId))[0];
  await retirePickups();
  const { taskId, credential } = await launched();
  await workerOn(credential, answering(302, '{}')).applyOnce(taskId);
  const dropped = (await attempts(taskId))[0];
  expect([kept?.['link'], none?.['observed'], dropped?.['observed']]).toStrictEqual([
    link,
    true,
    false,
  ]);
  expect(await setLink(kept?.['id'], `https://${HOST}/effects/other`)).toBe('23001');
  expect(await setLink(none?.['id'], `https://${HOST}/effects/later`)).toBe('23001');
  expect(await setLink(dropped?.['id'], `https://${HOST}/effects/1`)).toBe('23514');
  for (const shape of [`https://${HOST}/x?t=1`, `http://${HOST}/x`, `https://${HOST}:1/x`]) {
    // eslint-disable-next-line no-await-in-loop
    expect(await setLink(dropped?.['id'], shape, ', observed = true'), shape).toBe('23514');
  }
  expect(await attempts(taskId)).toMatchObject([{ observed: false, link: null }]);
}, 60_000);

it('AW-08 canary: a planted credential and planted provider content reach no row, audit payload, log or refusal body', async () => {
  const planted = `aw08-planted-${randomUUID()}`;
  const output: string[] = [];
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      output.push(args.map(String).join(' '));
    }),
  );
  try {
    const kept = await appliedWith(
      answering(
        200,
        JSON.stringify({
          link: `https://evil.example/${planted}/${r.agentToken}`,
          note: planted,
        }),
      ),
    );
    expect(kept.receipt['link']).toBeNull();
    await retirePickups();
    const { taskId, credential } = await launched();
    const hostile = await workerOn(
      credential,
      answering(302, JSON.stringify({ link: `https://${HOST}/${planted}`, secret: credential })),
    ).applyOnce(taskId);
    const [dump] = await r.fixture.db.admin.execute<{ dump: string }>(
      `select coalesce(string_agg(t, ' '), '') as dump from (
       select row_to_json(a)::text as t from public.attempts a where a.business_id = $1
       union all select row_to_json(o)::text from public.operations o where o.business_id = $1
       union all select row_to_json(e)::text from public.audit_events e where e.business_id = $1
       union all select row_to_json(r)::text from public.records r where r.business_id = $1) rows`,
      [r.fixture.business],
    );
    // Booleans, so a failure message never prints the secret it found.
    const seen = [dump?.dump ?? '', JSON.stringify(hostile), JSON.stringify(kept), ...output];
    for (const [n, secret] of [planted, r.agentToken, credential].entries()) {
      expect(
        seen.map((text) => text.includes(secret)),
        `secret ${String(n)}`,
      ).not.toContain(true);
    }
    // Not vacuous: the dump holds this business's attempts and their tasks.
    expect(dump?.dump ?? '').toContain(taskId);
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});
