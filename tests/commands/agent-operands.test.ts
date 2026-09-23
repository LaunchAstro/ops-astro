// SPDX-License-Identifier: AGPL-3.0-only
//
// An agent's operands are parsed, not coerced.
//
// A `leaseSeconds` or `report` that is present and the wrong shape is a typed
// refusal. It is never replaced by the default, and a report is never dropped
// or reshaped into an object with numeric keys. Absence keeps the default.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { isCommandRefusal } from '../../packages/core-records/src/commands/refusal.ts';
import { agentWorld, codeOf, detailOf, type AgentWorld } from './agent-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('agent operands', () => {
  let world: AgentWorld;

  beforeAll(async () => {
    world = await agentWorld('o', 'agent-operands');
  }, 90_000);

  afterAll(async () => {
    await world?.drop();
  });

  const leasesFor = async (reservationId: string): Promise<number> => {
    const rows = await world.db.admin.execute<{ readonly n: string }>(
      `select count(*)::text as n from public.leases where business_id = $1 and reservation_id = $2`,
      [world.business, reservationId],
    );
    return Number(rows[0]?.n ?? '0');
  };

  it.each([['60'], [-60], [60.5], [null], [[60]]])(
    'refuses a pickup whose leaseSeconds is %j, and claims nothing',
    async (leaseSeconds) => {
      const refused = await world.asAgent({
        command: 'task.pickup',
        operationId: randomUUID(),
        reservationId: randomUUID(),
        leaseSeconds,
      });
      expect(codeOf(refused)).toBe('FIELD_VALUE_INVALID');
      expect(isCommandRefusal(refused) ? refused.names : []).toStrictEqual(['leaseSeconds']);
    },
  );

  it('refuses a heartbeat whose leaseSeconds is a string', async () => {
    const refused = await world.asAgent({
      command: 'task.heartbeat',
      operationId: randomUUID(),
      leaseId: randomUUID(),
      fence: 1,
      leaseSeconds: '60',
    });
    expect(codeOf(refused)).toBe('FIELD_VALUE_INVALID');
  });

  it('keeps the default lease when leaseSeconds is absent', async () => {
    const picked = await world.pickUp(await world.decider('defaulted'), 'a default lease');
    expect(await leasesFor(picked.reservationId)).toBe(1);
    const expires = Date.parse(String(picked.detail['expiresAt']));
    expect(expires).toBeGreaterThan(Date.now());
  });

  it.each([['a string report'], [['an', 'array']], [7]])(
    'refuses a handback whose report is %j, leaving the lease live',
    async (report) => {
      const picked = await world.pickUp(await world.decider('reporter'), 'a malformed report');
      const refused = await world.asAgent(
        {
          command: 'task.handback',
          operationId: randomUUID(),
          leaseId: String(picked.detail['leaseId']),
          fence: Number(picked.detail['fence']),
          outcome: 'completed',
          report,
        },
        picked.credential,
      );
      expect(codeOf(refused)).toBe('FIELD_VALUE_INVALID');
      expect(isCommandRefusal(refused) ? refused.names : []).toStrictEqual(['report']);
      const reports = await world.db.admin.execute<{ readonly n: string }>(
        `select count(*)::text as n from public.handback_reports where business_id = $1 and lease_id = $2`,
        [world.business, String(picked.detail['leaseId'])],
      );
      expect(Number(reports[0]?.n)).toBe(0);
      // Still live, so a well-formed handback settles it.
      const settled = await world.asAgent(
        {
          command: 'task.handback',
          operationId: randomUUID(),
          leaseId: String(picked.detail['leaseId']),
          fence: Number(picked.detail['fence']),
          outcome: 'completed',
          report: { wrote: 'a draft' },
        },
        picked.credential,
      );
      expect(isCommandRefusal(settled)).toBe(false);
      expect(detailOf(settled)['reportId']).toBeDefined();
    },
  );
});
