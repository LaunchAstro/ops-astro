// SPDX-License-Identifier: AGPL-3.0-only
//
// What `s0-5-gate-commands.test.ts` runs: the two gate commands sent through
// the real API as each caller, every refusal checked to write nothing to
// either gate table, and the application role's direct writes to them.

import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { gateRecordBody } from '../acceptance/role-case-gate-bodies.ts';
import { createHarness, type Harness } from '../acceptance/role-case-harness.ts';
import { bearer, call, personPath, type Answer } from '../acceptance/world.ts';
import { grantTo, WHOLE_BUSINESS, type Member } from '../commands/fixture.ts';

export const RECORD = '/operations/record_gate_item';
export const CHANGE = '/operations/change_installation_mode';

export type Expected = { readonly status: number; readonly code: string };
export type Attempt = readonly [label: string, send: () => Promise<Answer>];

export interface GateWorld {
  readonly harness: Harness;
  /** The agent's delegation credential from a live pickup in alpha. */
  readonly credential: string;
}

/** Alpha operates the installation; noah reads operations there, bea manages them in bravo. */
export async function openGateWorld(): Promise<GateWorld> {
  const harness = await createHarness('s05_gate_cmds');
  const { world } = harness;
  await world.db.app.withBusiness(world.alpha, async (tx) => {
    await grantTo(tx, world.noah as unknown as Member, 'read', WHOLE_BUSINESS, false, 'operations');
  });
  await world.db.app.withBusiness(world.bravo, async (tx) => {
    await grantTo(
      tx,
      world.bea as unknown as Member,
      'manage',
      WHOLE_BUSINESS,
      false,
      'operations',
    );
  });
  const { decided } = await harness.approvedReservation();
  const reservationId = (decided.body['detail'] as Record<string, unknown>)['reservationId'];
  const picked = await harness.asAgent('task.pickup', { reservationId });
  if (picked.code !== 'ok') throw new Error(`the pickup answered ${String(picked.code)}`);
  const detail = picked.body['detail'] as Record<string, unknown>;
  return { harness, credential: String(detail['credential']) };
}

export const admin = async <T>(w: GateWorld, sql: string, params: unknown[] = []): Promise<T[]> =>
  (await w.harness.world.db.admin.execute<T & Record<string, unknown>>(sql, params)) as T[];

/** Both gate tables, as one digest. */
export async function fingerprint(w: GateWorld): Promise<string> {
  const [row] = await admin<{ digest: string }>(
    w,
    `select md5(
       (select coalesce(string_agg(t::text, '|' order by t::text), '') from ops.installation t) ||
       (select coalesce(string_agg(t::text, '|' order by t::text), '') from ops.gate_items t)
     ) as digest`,
  );
  return row!.digest;
}

export async function readiness(w: GateWorld): Promise<{ mode: string; open_items: string[] }> {
  const [row] = await admin<{ mode: string; open_items: string[] }>(
    w,
    'select mode, open_items from public.first_client_readiness()',
  );
  return row!;
}

export const send = async (
  w: GateWorld,
  path: string,
  body: object,
  token: string = w.harness.world.ada.token,
  key = 'alpha',
): Promise<Answer> =>
  await call(
    w.harness.world.api,
    personPath(key, path),
    { operationId: randomUUID(), ...body },
    bearer(token),
  );

export const outcome = (answer: Answer): Expected => ({ status: answer.status, code: answer.code });
export const names = (answer: Answer): unknown => answer.body['names'];
export const evidence = (item: string): string =>
  `https://evidence.example/${item}/${randomUUID()}`;

/** Each attempt refused as `expected`, and nothing written to either gate table. */
export async function refusedAlike(
  w: GateWorld,
  attempts: readonly Attempt[],
  expected: Expected,
): Promise<string[]> {
  const wrong: string[] = [];
  for (const [label, attempt] of attempts) {
    // oxlint-disable-next-line no-await-in-loop
    const before = await fingerprint(w);
    // oxlint-disable-next-line no-await-in-loop
    const got = outcome(await attempt());
    // oxlint-disable-next-line no-await-in-loop
    const after = await fingerprint(w);
    if (got.status !== expected.status || got.code !== expected.code) {
      wrong.push(`${label}: ${String(got.status)} ${String(got.code)}`);
    }
    if (before !== after) wrong.push(`${label}: wrote`);
  }
  return wrong;
}

const BAD_ITEMS: readonly (readonly [string, object])[] = [
  ['unknown item', { item: 'coffee' }],
  ['no item', {}],
  ['item not a string', { item: 7 }],
];

const BAD_LINKS: readonly (readonly [string, object])[] = [
  ['http link', { evidence: 'http://evidence.example/a' }],
  ['no link', {}],
  ['a space', { evidence: 'https://evidence.example/a b' }],
  ['a newline', { evidence: 'https://evidence.example/a\n' }],
  ['too long', { evidence: `https://e.example/${'a'.repeat(2000)}` }],
  ['upper-case scheme', { evidence: 'HTTPS://evidence.example/a' }],
  ['bare scheme', { evidence: 'https://' }],
  ["an owner's line on one of the eight", { evidence: 'https://e.example/a', statement: 'a line' }],
];

/** A malformed item or evidence link: FIELD_VALUE_INVALID, nothing written. */
export async function malformedRecords(w: GateWorld): Promise<string[]> {
  return await refusedAlike(
    w,
    [
      ...BAD_ITEMS.map(([label, body]): Attempt => [
        label,
        async () => await send(w, RECORD, { evidence: evidence('x'), ...body }),
      ]),
      ...BAD_LINKS.map(([label, body]): Attempt => [
        label,
        async () => await send(w, RECORD, { item: 'phone-alerts', ...body }),
      ]),
    ],
    { status: 422, code: 'FIELD_VALUE_INVALID' },
  );
}

/** The operator records one item: stored with its link, audited once, refused the second time. */
export async function recordedOnce(w: GateWorld, item: string): Promise<void> {
  const link = evidence(item);
  expect(outcome(await send(w, RECORD, { item, evidence: link }))).toStrictEqual({
    status: 200,
    code: 'ok',
  });
  expect(await admin(w, `select item, evidence from ops.gate_items`)).toStrictEqual([
    { item, evidence: link },
  ]);
  expect((await readiness(w)).open_items).not.toContain(item);
  const [audit] = await admin<{ n: number }>(
    w,
    `select count(*)::int as n from public.operations
      where business_id = $1 and command = 'operations.record_gate_item' and outcome = 'applied'`,
    [w.harness.world.alpha],
  );
  expect(audit?.n).toBe(1);
  const again: Attempt = [
    'again',
    async () => await send(w, RECORD, { item, evidence: evidence('again') }),
  ];
  expect(
    await refusedAlike(w, [again], { status: 409, code: 'GATE_ITEM_ALREADY_RECORDED' }),
  ).toStrictEqual([]);
}

/** While items are open: not ready, naming them; an unknown or missing mode, or made-up, refused. */
export async function modeRefusedWhileOpen(w: GateWorld): Promise<string[]> {
  const toReal = async () => await send(w, CHANGE, { mode: 'real' });
  const notReady = await toReal();
  expect(outcome(notReady)).toStrictEqual({ status: 409, code: 'INSTALLATION_NOT_READY' });
  expect(names(notReady)).toStrictEqual((await readiness(w)).open_items);
  return [
    ...(await refusedAlike(w, [['open items', toReal]], {
      status: 409,
      code: 'INSTALLATION_NOT_READY',
    })),
    ...(await refusedAlike(
      w,
      [
        ['an unknown mode', async () => await send(w, CHANGE, { mode: 'staging' })],
        ['no mode', async () => await send(w, CHANGE, {})],
      ],
      { status: 422, code: 'FIELD_VALUE_INVALID' },
    )),
    // The only change there is goes to real; made-up is refused while made-up, too.
    ...(await refusedAlike(
      w,
      [['made-up', async () => await send(w, CHANGE, { mode: 'made-up' })]],
      {
        status: 409,
        code: 'INSTALLATION_MODE_ONE_WAY',
      },
    )),
  ];
}

/** Every open item recorded, the mode moves to real with its time stamped, and never back. */
export async function modeToReal(w: GateWorld): Promise<string[]> {
  for (const item of (await readiness(w)).open_items) {
    // oxlint-disable-next-line no-await-in-loop
    const answer = await send(w, RECORD, gateRecordBody(item));
    expect(outcome(answer), item).toStrictEqual({ status: 200, code: 'ok' });
  }
  const changedAt = async () =>
    (await admin<{ changed_at: Date }>(w, 'select changed_at from ops.installation'))[0]!
      .changed_at;
  const before = await changedAt();
  expect(outcome(await send(w, CHANGE, { mode: 'real' }))).toStrictEqual({
    status: 200,
    code: 'ok',
  });
  expect(await readiness(w)).toStrictEqual({ mode: 'real', open_items: [] });
  expect((await changedAt()).getTime()).toBeGreaterThan(before.getTime());
  return await refusedAlike(w, [['back', async () => await send(w, CHANGE, { mode: 'made-up' })]], {
    status: 409,
    code: 'INSTALLATION_MODE_ONE_WAY',
  });
}

/** Only through the command: every other direct write by the app's role, and how it was answered. */
export async function directWrites(w: GateWorld): Promise<(readonly [string, string])[]> {
  const direct = [
    `update ops.installation set singleton = true`,
    `update ops.installation set changed_at = now()`,
    `update ops.installation set operator_business_id = null`,
    `update ops.gate_items set evidence = 'https://evidence.example/other'`,
    `delete from ops.gate_items`,
    `delete from ops.installation`,
    `insert into ops.installation (mode) values ('made-up')`,
  ];
  const { world } = w.harness;
  return await Promise.all(
    direct.map(
      async (sql) =>
        [
          sql,
          await world.db.app
            .withBusiness(world.alpha, async (tx) => await tx.query(sql))
            .then(
              () => 'allowed',
              (error: unknown) =>
                /permission denied/u.test(String(error)) ? 'denied' : String(error),
            ),
        ] as const,
    ),
  );
}
