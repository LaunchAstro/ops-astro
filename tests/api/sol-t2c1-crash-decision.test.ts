// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CRASH_POINT_VARIABLE } from '../../packages/core-runtime/src/crash-point.ts';
import { pathOf } from '../../packages/core-wire/src/surface.ts';
import { authorised, BUSINESS_KEY, createApiFixture, post, tokenFor } from './fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('T2c1 reservation crash seam', () => {
  it('Sol proof, criterion 2: a rejected decision returns after commit without a reservation', async () => {
    const fixture = await createApiFixture('sol_t2c1_reject');
    const previous = process.env[CRASH_POINT_VARIABLE];
    try {
      const api = fixture.compose();
      const headers = authorised(await tokenFor(fixture.member.presented.subject));
      const call = async (name: Parameters<typeof pathOf>[0], body: object) =>
        await post(api, `/api/b/${BUSINESS_KEY}${pathOf(name)}`, body, headers);
      const created = await call('task.create', {
        operationId: randomUUID(),
        fields: { title: 'a proposal to reject' },
      });
      expect(created.status).toBe(200);
      const proposed = await call('task.propose', {
        operationId: randomUUID(),
        recordId: created.body['recordId'],
        expectedRevision: created.body['revision'],
        purpose: 'reject_without_reservation',
        maximumMinor: 100,
        currency: 'AUD',
        payload: { change: 'a team-only comment' },
        step: { kind: 'synthetic_comment', payload: {} },
      });
      expect(proposed.status).toBe(200);
      const detail = proposed.body['detail'] as { gateId: string; versionId: string };
      process.env[CRASH_POINT_VARIABLE] = 'reservation_committed';
      const answer = call('task.decide', {
        operationId: randomUUID(),
        gateId: detail.gateId,
        versionId: detail.versionId,
        decision: 'reject',
        note: 'reject this version',
      });

      let committed = false;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop -- the commit must be visible before timing the response
        const rows = await fixture.db.admin.execute<{ state: string }>(
          'select state from public.gates where business_id = $1 and id = $2',
          [fixture.business, detail.gateId],
        );
        if (rows[0]?.state === 'rejected') {
          committed = true;
          break;
        }
        // eslint-disable-next-line no-await-in-loop -- bounded polling of the committed gate
        await new Promise<void>((done) => {
          setTimeout(done, 100);
        });
      }
      expect(committed).toBe(true);
      const response = await Promise.race([
        answer,
        new Promise<null>((done) => {
          setTimeout(() => {
            done(null);
          }, 1_000);
        }),
      ]);
      expect(response).not.toBeNull();
      if (response !== null) {
        expect(response.status).toBe(200);
        expect(response.body['detail']).toMatchObject({ decision: 'reject' });
        expect(response.body['detail']).not.toHaveProperty('reservationId');
      }
    } finally {
      if (previous === undefined) delete process.env[CRASH_POINT_VARIABLE];
      else process.env[CRASH_POINT_VARIABLE] = previous;
      await fixture.drop();
    }
  }, 120_000);
});
