// SPDX-License-Identifier: AGPL-3.0-only
//
// The fixed server maximum on a gate's expiry: seven days, on both paths that
// name one.
//
// Owner decision (d), 23 September 2026: "Fixed server maximum of seven days
// (Recommended)", for new proposals and successor gates. `task.propose`'s
// `expiresInSeconds` and `task.handback`'s `successor.expiresInSeconds` both
// read through `expiryFrom`, so the bound is one rule. 604800 is accepted,
// 604801 is refused `FIELD_VALUE_INVALID` naming the field and the maximum,
// zero and a fraction stay refused, and a refused request writes nothing but
// its refused audit row. Existing gates are not rewritten.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { createControls, detailOf, PROPOSAL, type Controls } from './controls-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();
const SEVEN_DAYS = 604_800;

/** A successor's caller-supplied half, asking for its gate to stay open this long. */
const successor = (expiresInSeconds: number): Record<string, unknown> => ({
  ...PROPOSAL,
  purpose: 'second_pass',
  expiresInSeconds,
});

describe.skipIf(serverUrl === undefined)('the seven-day maximum on gate expiry', () => {
  let c: Controls;

  beforeAll(async () => {
    c = await createControls('expbd');
  }, 120_000);

  afterAll(async () => {
    await c?.drop();
  });

  const lineagesOn = async (taskId: string): Promise<number> =>
    await c.count(`select count(*)::text as n from public.proposal_lineages where task_id = $1`, [
      taskId,
    ]);

  const refusedAudits = async (command: string, operationId: string): Promise<number> =>
    await c.count(
      `select count(*)::text as n from public.audit_events
        where command = $1 and operation_id = $2 and outcome = 'refused'
          and refusal_code = 'FIELD_VALUE_INVALID'`,
      [command, operationId],
    );

  describe('task.propose', () => {
    it('accepts exactly seven days, and the gate closes seven days out', async () => {
      const task = await c.createTask('a proposal open for the full week');
      const answer = await c.asPerson('task.propose', {
        recordId: task.id,
        expectedRevision: task.revision,
        ...PROPOSAL,
        expiresInSeconds: SEVEN_DAYS,
      });
      expect(answer.status).toBe(200);
      expect(
        await c.count(
          `select count(*)::text as n from public.gates
            where id = $1 and expires_at between now() + interval '6 days 23 hours'
                                             and now() + interval '7 days'`,
          [detailOf(answer)['gateId']],
        ),
      ).toBe(1);
    });

    it('refuses one second more, and zero and a fraction, writing nothing but the audit', async () => {
      const task = await c.createTask('a proposal that asks for too long');
      for (const expiresInSeconds of [SEVEN_DAYS + 1, 0, 1.5]) {
        const operationId = `expiry-${String(expiresInSeconds)}-${task.id}`;
        // eslint-disable-next-line no-await-in-loop
        const answer = await c.asPerson('task.propose', {
          operationId,
          recordId: task.id,
          expectedRevision: task.revision,
          ...PROPOSAL,
          expiresInSeconds,
        });
        expect(answer.status, String(expiresInSeconds)).toBe(422);
        expect(answer.body['code']).toBe('FIELD_VALUE_INVALID');
        expect(answer.body['names']).toStrictEqual(['expiresInSeconds']);
        expect(JSON.stringify(answer.body['fixes'])).toContain('604800');
        // eslint-disable-next-line no-await-in-loop
        expect(await refusedAudits('task.propose', operationId)).toBe(1);
      }
      expect(await lineagesOn(task.id)).toBe(0);
    });
  });

  describe('task.handback successor', () => {
    async function pickedUp(purpose: string): Promise<{
      taskId: string;
      picked: Record<string, unknown>;
    }> {
      const task = await c.createTask(`a task handed back with a successor (${purpose})`);
      const reservationId = await c.approve(await c.propose(task.id, task.revision, purpose));
      return { taskId: task.id, picked: await c.pickup(reservationId) };
    }

    it('refuses a successor gate one second past seven days, and settles nothing', async () => {
      const { taskId, picked } = await pickedUp('successor_too_long');
      const operationId = `handback-too-long-${taskId}`;
      const answer = await c.asAgent(
        'task.handback',
        {
          operationId,
          leaseId: picked['leaseId'],
          fence: picked['fence'],
          outcome: 'completed',
          successor: successor(SEVEN_DAYS + 1),
        },
        String(picked['credential']),
      );
      expect(answer.status).toBe(422);
      expect(answer.body['code']).toBe('FIELD_VALUE_INVALID');
      expect(answer.body['names']).toStrictEqual(['successor.expiresInSeconds']);
      expect(JSON.stringify(answer.body['fixes'])).toContain('604800');
      expect(await refusedAudits('task.handback', operationId)).toBe(1);
      // Nothing settled and nothing proposed: the lease is still live and the
      // lineage has only the version the person approved.
      expect(
        await c.count(
          `select count(*)::text as n from public.leases where id = $1 and state = 'live'`,
          [picked['leaseId']],
        ),
      ).toBe(1);
      expect(
        await c.count(
          `select count(*)::text as n from public.proposal_versions v
             join public.proposal_lineages l on l.id = v.lineage_id
            where l.task_id = $1`,
          [taskId],
        ),
      ).toBe(1);
    });

    it('accepts a successor gate of exactly seven days', async () => {
      const { picked } = await pickedUp('successor_full_week');
      const answer = await c.asAgent(
        'task.handback',
        {
          leaseId: picked['leaseId'],
          fence: picked['fence'],
          outcome: 'completed',
          successor: successor(SEVEN_DAYS),
        },
        String(picked['credential']),
      );
      expect(answer.status).toBe(200);
    });
  });
});
