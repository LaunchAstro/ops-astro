// SPDX-License-Identifier: AGPL-3.0-only

import { expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { createControls, detailOf, PROPOSAL } from './controls-fixture.ts';

it.skipIf(databaseUrlFromEnvironment() === undefined)(
  'an open envelope currency offered by task.read can be approved',
  async () => {
    const controls = await createControls('solcq7cap');
    try {
      const { business, db } = controls.fixture;
      const task = await controls.createTask('proposal against an existing envelope');
      const caps = await db.admin.execute<{ readonly id: string; readonly currency: string }>(
        `select id, currency from public.budget_caps where business_id = $1 and key = 'local'`,
        [business],
      );
      const cap = caps[0];
      expect(cap).toBeDefined();
      if (cap === undefined) return;
      expect(cap.currency).toBe('AUD');

      await db.admin.execute(
        `update public.budget_caps set key = 'previous' where business_id = $1 and id = $2`,
        [business, cap.id],
      );
      await db.admin.execute(
        `insert into public.budget_caps (business_id, id, key, limit_minor, currency)
         values ($1, gen_random_uuid(), 'local', 500000, 'USD')`,
        [business],
      );
      await db.admin.execute(
        `insert into public.task_envelopes
           (business_id, id, cap_id, task_id, maximum_minor, currency)
         values ($1, gen_random_uuid(), $2, $3, 100000, $4)`,
        [business, cap.id, task.id, cap.currency],
      );

      const read = await controls.asPerson('task.read', { recordId: task.id });
      expect(read.status).toBe(200);
      const detail = read.body['task'];
      expect(detail).toMatchObject({ capCurrency: 'AUD' });

      const proposed = await controls.asPerson('task.propose', {
        recordId: task.id,
        expectedRevision: task.revision,
        ...PROPOSAL,
        currency: 'AUD',
      });
      expect(proposed.status).toBe(200);
      const proposal = detailOf(proposed);
      const decided = await controls.asPerson('task.decide', {
        gateId: proposal['gateId'],
        versionId: proposal['versionId'],
        decision: 'approve',
        note: 'approve in the currency task.read offered',
      });
      expect(decided.body['code']).not.toBe('CAP_BINDING_MISMATCH');
      expect(decided.status).toBe(200);
    } finally {
      await controls.drop();
    }
  },
  120_000,
);
