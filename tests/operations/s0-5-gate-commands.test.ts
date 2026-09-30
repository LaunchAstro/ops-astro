// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5: the gate's own commands, through the real API on a throwaway database.
// `operations.record_gate_item` ticks one item with its https evidence link
// (`gate item recorded`); `operations.change_installation_mode` moves the
// installation from made-up to real data while the readiness check is true
// (`installation mode changed`). Both are a person's, under `operations:manage`
// in the business that operates the installation; never an agent's, never
// under a delegation, and every refusal writes nothing.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GATE_ITEMS } from '../../packages/core-commands/src/index.ts';
import { DELEGATION_HEADER } from '../../packages/core-wire/src/surface.ts';
import { createHarness, type Harness } from '../acceptance/role-case-harness.ts';
import {
  agentPath,
  bearer,
  call,
  personPath,
  serverUrl,
  type Answer,
} from '../acceptance/world.ts';
import { grantTo, WHOLE_BUSINESS, type Member } from '../commands/fixture.ts';

if (serverUrl === undefined) {
  console.warn('operations/s0-5-gate-commands: DATABASE_URL is unset, so nothing below ran.');
}

const RECORD = '/operations/record_gate_item';
const CHANGE = '/operations/change_installation_mode';

let harness: Harness;
let credential = '';

const admin = async <T>(sql: string, params: unknown[] = []): Promise<T[]> =>
  (await harness.world.db.admin.execute<T & Record<string, unknown>>(sql, params)) as T[];

/** Both gate tables, as one digest. */
async function fingerprint(): Promise<string> {
  const [row] = await admin<{ digest: string }>(
    `select md5(
       (select coalesce(string_agg(t::text, '|' order by t::text), '') from ops.installation t) ||
       (select coalesce(string_agg(t::text, '|' order by t::text), '') from ops.gate_items t)
     ) as digest`,
  );
  return row!.digest;
}

async function readiness(): Promise<{ mode: string; open_items: string[] }> {
  const [row] = await admin<{ mode: string; open_items: string[] }>(
    'select mode, open_items from public.first_client_readiness()',
  );
  return row!;
}

const send = async (
  path: string,
  body: object,
  token: string = harness.world.ada.token,
  key = 'alpha',
): Promise<Answer> =>
  await call(
    harness.world.api,
    personPath(key, path),
    { operationId: randomUUID(), ...body },
    bearer(token),
  );

const outcome = (answer: Answer) => ({ status: answer.status, code: answer.code });
const names = (answer: Answer): unknown => answer.body['names'];
const evidence = (item: string) => `https://evidence.example/${item}/${randomUUID()}`;

/** Each call refused as `expected`, and nothing written to either gate table. */
async function refusedAlike(
  calls: readonly (readonly [string, () => Promise<Answer>])[],
  expected: { readonly status: number; readonly code: string },
): Promise<string[]> {
  const wrong: string[] = [];
  for (const [label, attempt] of calls) {
    // oxlint-disable-next-line no-await-in-loop
    const before = await fingerprint();
    // oxlint-disable-next-line no-await-in-loop
    const answer = await attempt();
    // oxlint-disable-next-line no-await-in-loop
    const after = await fingerprint();
    const got = outcome(answer);
    if (got.status !== expected.status || got.code !== expected.code) {
      wrong.push(`${label}: ${String(got.status)} ${String(got.code)}`);
    }
    if (before !== after) wrong.push(`${label}: wrote`);
  }
  return wrong;
}

describe.skipIf(serverUrl === undefined)('S0-5 gate commands', () => {
  beforeAll(async () => {
    harness = await createHarness('s05_gate_cmds');
    const { world } = harness;
    await world.db.app.withBusiness(world.alpha, async (tx) => {
      await grantTo(
        tx,
        world.noah as unknown as Member,
        'read',
        WHOLE_BUSINESS,
        false,
        'operations',
      );
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
    expect(picked.code, 'the pickup').toBe('ok');
    credential = String((picked.body['detail'] as Record<string, unknown>)['credential']);
  }, 300_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('S0-5 gate item recorded: the operator ticks an item with its https evidence link, once, audited; a malformed item or link is refused and writes nothing', async () => {
    const wrong = [
      ...(await refusedAlike(
        [
          [
            'unknown item',
            async () => await send(RECORD, { item: 'coffee', evidence: evidence('x') }),
          ],
          ['no item', async () => await send(RECORD, { evidence: evidence('x') })],
          [
            'item not a string',
            async () => await send(RECORD, { item: 7, evidence: evidence('x') }),
          ],
        ],
        { status: 400, code: 'FIELD_VALUE_INVALID' },
      )),
      ...(await refusedAlike(
        [
          [
            'http link',
            async () =>
              await send(RECORD, { item: 'phone-alerts', evidence: 'http://evidence.example/a' }),
          ],
          ['no link', async () => await send(RECORD, { item: 'phone-alerts' })],
          [
            'a space',
            async () =>
              await send(RECORD, {
                item: 'phone-alerts',
                evidence: 'https://evidence.example/a b',
              }),
          ],
          [
            'a newline',
            async () =>
              await send(RECORD, {
                item: 'phone-alerts',
                evidence: 'https://evidence.example/a\n',
              }),
          ],
          [
            'too long',
            async () =>
              await send(RECORD, {
                item: 'phone-alerts',
                evidence: `https://e.example/${'a'.repeat(2000)}`,
              }),
          ],
          [
            'upper-case scheme',
            async () =>
              await send(RECORD, { item: 'phone-alerts', evidence: 'HTTPS://evidence.example/a' }),
          ],
          [
            'bare scheme',
            async () => await send(RECORD, { item: 'phone-alerts', evidence: 'https://' }),
          ],
        ],
        { status: 400, code: 'FIELD_VALUE_INVALID' },
      )),
    ];
    expect(wrong).toStrictEqual([]);
    const refusal = await send(RECORD, { item: 'coffee', evidence: evidence('x') });
    expect(names(refusal)).toStrictEqual(['item']);
    expect(JSON.stringify(refusal.body)).not.toContain('coffee');

    const link = evidence('phone-alerts');
    const recorded = await send(RECORD, { item: 'phone-alerts', evidence: link });
    expect(outcome(recorded)).toStrictEqual({ status: 200, code: 'ok' });
    expect(await admin(`select item, evidence from ops.gate_items`)).toStrictEqual([
      { item: 'phone-alerts', evidence: link },
    ]);
    expect((await readiness()).open_items).not.toContain('phone-alerts');
    const [audit] = await admin<{ n: number }>(
      `select count(*)::int as n from public.operations
        where business_id = $1 and command = 'operations.record_gate_item' and outcome = 'applied'`,
      [harness.world.alpha],
    );
    expect(audit?.n).toBe(1);

    expect(
      await refusedAlike(
        [
          [
            'again',
            async () => await send(RECORD, { item: 'phone-alerts', evidence: evidence('again') }),
          ],
        ],
        { status: 409, code: 'GATE_ITEM_ALREADY_RECORDED' },
      ),
    ).toStrictEqual([]);
  });

  it('S0-5 installation mode changed: made-up to real by the operator only while every item is done; never back; the app role writes nothing else directly', async () => {
    const toReal = async () => await send(CHANGE, { mode: 'real' });
    const notReady = await toReal();
    expect(outcome(notReady)).toStrictEqual({ status: 409, code: 'INSTALLATION_NOT_READY' });
    expect(names(notReady)).toStrictEqual((await readiness()).open_items);
    expect(
      await refusedAlike([['open items', toReal]], { status: 409, code: 'INSTALLATION_NOT_READY' }),
    ).toStrictEqual([]);
    expect(
      await refusedAlike(
        [
          ['an unknown mode', async () => await send(CHANGE, { mode: 'staging' })],
          ['no mode', async () => await send(CHANGE, {})],
        ],
        { status: 400, code: 'FIELD_VALUE_INVALID' },
      ),
    ).toStrictEqual([]);
    // The only change there is goes to real; made-up is refused while made-up, too.
    expect(
      await refusedAlike([['made-up', async () => await send(CHANGE, { mode: 'made-up' })]], {
        status: 409,
        code: 'INSTALLATION_MODE_ONE_WAY',
      }),
    ).toStrictEqual([]);

    for (const item of GATE_ITEMS.filter((one) => one !== 'phone-alerts')) {
      // oxlint-disable-next-line no-await-in-loop
      expect(outcome(await send(RECORD, { item, evidence: evidence(item) })), item).toStrictEqual({
        status: 200,
        code: 'ok',
      });
    }
    const [{ changed_at: before } = { changed_at: new Date(0) }] = await admin<{
      changed_at: Date;
    }>('select changed_at from ops.installation');
    expect(outcome(await toReal())).toStrictEqual({ status: 200, code: 'ok' });
    expect(await readiness()).toStrictEqual({ mode: 'real', open_items: [] });
    const [{ changed_at: after } = { changed_at: new Date(0) }] = await admin<{ changed_at: Date }>(
      'select changed_at from ops.installation',
    );
    expect(after.getTime()).toBeGreaterThan(before.getTime());

    expect(
      await refusedAlike([['back', async () => await send(CHANGE, { mode: 'made-up' })]], {
        status: 409,
        code: 'INSTALLATION_MODE_ONE_WAY',
      }),
    ).toStrictEqual([]);

    // Only through the command: every other direct write by the app's role is refused.
    const direct = [
      `update ops.installation set singleton = true`,
      `update ops.installation set changed_at = now()`,
      `update ops.installation set operator_business_id = null`,
      `update ops.gate_items set evidence = 'https://evidence.example/other'`,
      `delete from ops.gate_items`,
      `delete from ops.installation`,
      `insert into ops.installation (mode) values ('made-up')`,
    ];
    const answered = await Promise.all(
      direct.map(async (sql) => [
        sql,
        await harness.world.db.app
          .withBusiness(harness.world.alpha, async (tx) => await tx.query(sql))
          .then(
            () => 'allowed',
            (error: unknown) =>
              /permission denied/u.test(String(error)) ? 'denied' : String(error),
          ),
      ]),
    );
    expect(answered).toStrictEqual(direct.map((sql) => [sql, 'denied']));
  });

  it('S0-5 operator only: another business, a person without operations:manage, a delegated agent, and any caller while no business operates the installation, are refused and write nothing', async () => {
    const { world } = harness;
    const agent = async (path: string, body: object) =>
      await call(
        world.api,
        agentPath('alpha', path),
        { operationId: randomUUID(), ...body },
        {
          ...bearer(world.agent.token),
          [DELEGATION_HEADER]: credential,
        },
      );
    const bodies = [
      [RECORD, { item: 'phone-alerts', evidence: evidence('phone-alerts') }],
      [CHANGE, { mode: 'real' }],
    ] as const;
    const wrong = [
      // Bea holds operations:manage in bravo, which does not operate this installation.
      ...(await refusedAlike(
        bodies.map(
          ([path, body]) =>
            [
              `bea in bravo ${path}`,
              async () => await send(path, body, world.bea.token, 'bravo'),
            ] as const,
        ),
        { status: 403, code: 'SCOPE_NOT_GRANTED' },
      )),
      ...(await refusedAlike(
        bodies.flatMap(([path, body]) => [
          [`mia ${path}`, async () => await send(path, body, world.mia.token)] as const,
          [
            `noah (operations:read) ${path}`,
            async () => await send(path, body, world.noah.token),
          ] as const,
        ]),
        { status: 403, code: 'SCOPE_NOT_GRANTED' },
      )),
      ...(await refusedAlike(
        bodies.map(
          ([path, body]) =>
            [`delegated agent ${path}`, async () => await agent(path, body)] as const,
        ),
        { status: 403, code: 'DELEGATION_EXCLUDES_OPERATION' },
      )),
    ];
    expect(wrong).toStrictEqual([]);

    await admin('update ops.installation set operator_business_id = null');
    try {
      expect(
        await refusedAlike(
          bodies.map(
            ([path, body]) =>
              [`ada, no operator ${path}`, async () => await send(path, body)] as const,
          ),
          { status: 403, code: 'SCOPE_NOT_GRANTED' },
        ),
      ).toStrictEqual([]);
    } finally {
      await admin('update ops.installation set operator_business_id = $1', [world.alpha]);
    }
  });
});
