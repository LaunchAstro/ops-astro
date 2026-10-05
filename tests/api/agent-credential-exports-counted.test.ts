// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import type { SecuritySignal } from '../../apps/api/alerts/detect.ts';
import { bearer, call, personPath } from '../acceptance/world.ts';
import { harness, openWorld } from './api-2-agent-credential-world.ts';
import { apiWith, issued, latch } from './api-2-agent-credential-use-world.ts';
import { limited, readWith } from './api-2-agent-credential-quota-world.ts';

openWorld();

it('concurrent credential reads cannot export more records than the minute limit', async () => {
  const pool = connect(harness.world.db.appUrl, { max: 5 });
  const release = latch();
  const twoEntered = latch();
  const fiveEntered = latch();
  let entered = 0;
  const held: Database = {
    ...pool,
    withBusiness: async (businessId, run) =>
      await pool.withBusiness(businessId, async (tx) => {
        let resolved = false;
        let stopped = false;
        return await run({
          ...tx,
          query: async <Row>(text: string, parameters?: readonly unknown[]) => {
            if (resolved && !stopped) {
              stopped = true;
              entered += 1;
              if (entered === 2) twoEntered.open();
              if (entered === 5) fiveEntered.open();
              await release.promise;
            }
            const rows = await tx.query<Row>(text, parameters);
            if (text.includes('for share of c')) resolved = true;
            return rows;
          },
        });
      }),
  };
  const { api } = limited({ exports: { credential: 2, person: 2, business: 2 } }, held);
  const credential = await issued();
  const first = [readWith(api, credential.secret), readWith(api, credential.secret)];
  let rest: ReturnType<typeof readWith>[] = [];
  try {
    await twoEntered.promise;
    rest = Array.from({ length: 3 }, () => readWith(api, credential.secret));
    await Promise.race([Promise.all(rest), fiveEntered.promise]);
  } finally {
    release.open();
  }
  const answers = await Promise.all([...first, ...rest]).finally(async () => await pool.close());
  expect(
    answers.every((answer) => answer.code === 'ok' || answer.code === 'AGENT_QUOTA_EXCEEDED'),
  ).toBe(true);
  expect(
    answers.filter((answer) => answer.code === 'ok'),
    'each successful answer exports one real task',
  ).toHaveLength(2);
  expect(answers.filter((answer) => answer.code === 'AGENT_QUOTA_EXCEEDED')).toHaveLength(3);
});

it('task search exports contribute their record count to the security detector', async () => {
  const created = await harness.asPerson('task.create', {
    fields: { title: `solsearchcanary ${randomUUID()}` },
  });
  expect(created.code).toBe('ok');
  const signals: SecuritySignal[] = [];
  const api = apiWith({ observe: (signal) => signals.push(signal) });
  const searched = await call(
    api,
    personPath('alpha', '/task/search'),
    {
      query: 'solsearchcanary',
    },
    bearer(harness.world.ada.token),
  );
  expect(searched.code).toBe('ok');
  expect(searched.body['hits']).toEqual([
    expect.objectContaining({ id: created.body['recordId'] }),
  ]);
  expect(signals.filter((signal) => signal.kind === 'export')).toEqual([
    expect.objectContaining({ kind: 'export', business: 'alpha', items: 1 }),
  ]);
});

it('invitation list exports contribute their record count to the security detector', async () => {
  // Sol PRV-oa-1018-R1.2: names and addresses handed out by invitation.list
  // count toward the export-volume threshold like any other list.
  const created = await harness.asPerson('invitation.create', {
    name: 'Ivy Invitee',
    email: `ivy-${randomUUID()}@example.test`,
    role: 'member',
  });
  expect(created.code).toBe('ok');
  const signals: SecuritySignal[] = [];
  const api = apiWith({ observe: (signal) => signals.push(signal) });
  const listed = await call(
    api,
    personPath('alpha', '/invitation/list'),
    {},
    bearer(harness.world.ada.token),
  );
  expect(listed.code).toBe('ok');
  const invitations = listed.body['invitations'] as readonly { invitationId: string }[];
  expect(invitations.map((one) => one.invitationId)).toContain(created.body['invitationId']);
  expect(signals.filter((signal) => signal.kind === 'export')).toEqual([
    expect.objectContaining({ kind: 'export', business: 'alpha', items: invitations.length }),
  ]);
});
