// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createControls, detailOf } from '../api/controls-fixture.ts';
import { grantTo } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { expectAudited, type AuditRow } from './ident-audit-rows.ts';

it.skipIf(databaseUrlFromEnvironment() === undefined)(
  'the existing audit acceptance check accepts onboarding task creation events',
  async () => {
    const controls = await createControls('sol1403audit');
    try {
      const { db, business } = controls.fixture;
      await db.app.withBusiness(business, async (tx) => {
        await grantTo(
          tx,
          controls.manager,
          'write',
          { kind: 'business', id: null },
          false,
          'record',
        );
      });
      const made = await controls.asPerson('record.create', {
        type: 'client',
        fields: { name: 'Synthetic audit proof client' },
      });
      expect(made.status).toBe(200);
      const operationId = randomUUID();
      const body = { operationId, clientId: detailOf(made)['recordId'], templateKey: 'standard' };
      const started = await controls.asPerson('onboarding.start', body);
      expect(started.status, JSON.stringify(started.body)).toBe(200);
      const rows = await db.admin.execute<AuditRow>(
        `select business_id, seq::text as seq, actor_id, command, operation_id, outcome,
                refusal_code, subject_record_id::text as subject_record_id, payload_digest, attempted
           from public.audit_events where operation_id = $1 order by business_id, seq`,
        [operationId],
      );
      expectAudited('onboarding.start', rows, {
        businessId: business,
        actorId: controls.manager.actorId,
        command: 'onboarding.start',
        operationId,
        outcome: 'applied',
        refusalCode: null,
        body,
      });
    } finally {
      await controls.drop();
    }
  },
  180_000,
);
